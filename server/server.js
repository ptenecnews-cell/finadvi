/* ============================================================
   FinAdvi — backend proxy (hardened for production)
   ============================================================ */

import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import admin from "firebase-admin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..");

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === "production";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";

const app = express();

// --- Security headers ---
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=()");
  next();
});

// --- CORS: restrict in production ---
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || !IS_PROD || !ALLOWED_ORIGIN) return cb(null, true);
      if (origin === ALLOWED_ORIGIN) return cb(null, true);
      cb(new Error("Not allowed by CORS"));
    },
  })
);

app.use(express.json({ limit: "64kb" }));

// --- Firebase Admin (verify signed-in users on /api/chat) ---
let adminAuth = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    adminAuth = admin.auth();
    console.info("[FinAdvi] Firebase Admin initialized — /api/chat requires auth.");
  } catch (err) {
    console.error("[FinAdvi] FIREBASE_SERVICE_ACCOUNT is invalid JSON:", err.message);
  }
} else if (IS_PROD) {
  console.warn(
    "[FinAdvi] WARNING: FIREBASE_SERVICE_ACCOUNT not set — /api/chat will reject requests in production."
  );
}

async function requireFirebaseUser(req, res, next) {
  if (!adminAuth) {
    if (IS_PROD) {
      return res.status(503).json({ error: "Server auth is not configured." });
    }
    return next();
  }
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Sign in required." });
  }
  try {
    req.firebaseUser = await adminAuth.verifyIdToken(header.slice(7));
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session." });
  }
}

// --- Simple rate limit for /api/chat (per IP) ---
const rateBuckets = new Map();
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

function rateLimitChat(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.start > RATE_WINDOW_MS) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  if (bucket.count > RATE_LIMIT) {
    return res.status(429).json({ error: "Too many requests. Please wait a minute." });
  }
  next();
}

// Block access to server internals and dependencies
app.use((req, res, next) => {
  const blocked = ["/server", "/node_modules", "/.env", "/package-lock.json"];
  if (blocked.some((p) => req.path.startsWith(p))) {
    return res.status(404).end();
  }
  next();
});

// Static frontend only (dotfiles like .env are ignored by default)
app.use(
  express.static(PROJECT_ROOT, {
    dotfiles: "deny",
    index: "index.html",
  })
);

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    authConfigured: Boolean(adminAuth),
    geminiConfigured: Boolean(GEMINI_API_KEY),
  });
});

app.post("/api/chat", rateLimitChat, requireFirebaseUser, async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "AI service is not configured." });
    }

    const { message, expenses = [], subscriptions = [] } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "A message is required." });
    }
    if (message.length > 2000) {
      return res.status(400).json({ error: "Message is too long." });
    }

    const today = new Date().toISOString().slice(0, 10);
    const systemContext = [
      "You are FinAdvi, a personal financial assistant for a user based in the United States.",
      `Today's date is ${today}. All monetary amounts are in US dollars (USD).`,
      "Give concise, practical, and friendly advice. Reply in the same language the user writes in.",
      "Base your answers on the user's financial data below (JSON).",
      "",
      `EXPENSES_JSON: ${JSON.stringify(expenses).slice(0, 12000)}`,
      `RECURRING_SUBSCRIPTIONS_JSON: ${JSON.stringify(subscriptions).slice(0, 6000)}`,
    ].join("\n");

    const geminiRes = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemContext }] },
        contents: [{ role: "user", parts: [{ text: message }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
      }),
    });

    if (!geminiRes.ok) {
      console.error("[FinAdvi] Gemini API error:", geminiRes.status);
      return res.status(502).json({ error: "The AI service returned an error." });
    }

    const data = await geminiRes.json();
    const reply =
      data?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text)
        .join("")
        .trim() || "Sorry, I couldn't generate a response right now.";

    res.json({ reply });
  } catch (err) {
    console.error("[FinAdvi] /api/chat failed:", err);
    res.status(500).json({ error: "Internal server error." });
  }
});

app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(path.join(PROJECT_ROOT, "index.html"));
});

app.listen(PORT, () => {
  console.log(`FinAdvi running at http://localhost:${PORT}`);
  console.log(`[FinAdvi] Environment: ${IS_PROD ? "production" : "development"}`);
  console.log(`[FinAdvi] Gemini model: ${GEMINI_MODEL}`);
});
