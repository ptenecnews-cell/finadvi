/* ============================================================
   FinAdvi — Firebase v10 (Auth + Firestore) + local OCR pipeline
   ------------------------------------------------------------
   Flow:  upload image -> Tesseract.js OCR -> parse text
          -> save to  users/{uid}/expenses  in Firestore
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ------------------------------------------------------------
   1. Firebase configuration
   Replace the placeholder values below with your project's
   config from the Firebase console (Project settings → SDK setup).
   ------------------------------------------------------------ */
const firebaseConfig = {
  apiKey: "AIzaSyCoO_zS9DwB4PrASfXwM58PQ5kbvhyzdnc",
  authDomain: "tgwebhub.firebaseapp.com",
  projectId: "tgwebhub",
  storageBucket: "tgwebhub.firebasestorage.app",
  messagingSenderId: "878111126406",
  appId: "1:878111126406:web:fe62cfbecb6cb59033f207",
  measurementId: "G-1PB5YZJ5KQ"
};

const isConfigured = !firebaseConfig.apiKey.startsWith("YOUR_");

let auth = null;
let db = null;

// Callbacks to run once the user is authenticated (login on the dashboard).
const readyCallbacks = [];
let signedIn = false;

function flushReady(user) {
  signedIn = true;
  while (readyCallbacks.length) {
    const cb = readyCallbacks.shift();
    try {
      cb(user);
    } catch (err) {
      console.error("[FinAdvi] onReady callback failed:", err);
    }
  }
  document.dispatchEvent(
    new CustomEvent("finadvi:ready", {
      detail: {
        uid: user.uid,
        displayName: user.displayName,
        email: user.email,
        photoURL: user.photoURL,
      },
    })
  );
}

function flushSignedOut() {
  signedIn = false;
  stopExpensesListener();
  stopProfileListener();
  document.dispatchEvent(new CustomEvent("finadvi:signed-out"));
}

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

export async function signInWithGoogle() {
  if (!auth) throw new Error("Firebase is not configured.");
  return signInWithPopup(auth, googleProvider);
}

export async function signOutUser() {
  if (!auth) throw new Error("Firebase is not configured.");
  await signOut(auth);
}

if (isConfigured) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      console.info("[FinAdvi] Signed in as", user.email || user.uid);
      try {
        await ensureUserProfile(user);
      } catch (err) {
        console.warn("[FinAdvi] Could not init user profile:", err);
      }
      flushReady(user);
    } else {
      flushSignedOut();
    }
  });
} else {
  console.warn(
    "[FinAdvi] Firebase is not configured. OCR will run, but expenses " +
      "won't sync until you add your firebaseConfig in firebase.js."
  );
}

/* ------------------------------------------------------------
   2. Receipt text parsing (total, merchant, date)
   ------------------------------------------------------------ */

// Matches money like 12.50 / 1,234.56 / 1 234.56 (global flag required for matchAll)
const AMOUNT_RE = /(\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{2})|\d+[.,]\d{2})/g;

const TOTAL_KEYWORDS = /\b(grand\s*total|total\s*due|amount\s*due|balance\s*due|total\s*paid|you\s*paid)\b/i;
const SIMPLE_TOTAL_RE = /\btotal\b/i;
const SUBTOTAL_RE = /\bsub[\s-]*total\b/i;
const TAX_LINE_RE = /\b(sales\s*)?tax\b/i;

const DATE_RE = new RegExp(
  [
    "\\b\\d{1,2}[\\/\\-.]\\d{1,2}[\\/\\-.]\\d{2,4}\\b", // 03/12/2026, 3-12-26
    "\\b\\d{4}[\\/\\-.]\\d{1,2}[\\/\\-.]\\d{1,2}\\b", // 2026-03-12
    "\\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{2,4}\\b", // Mar 12, 2026
  ].join("|"),
  "i"
);

function toNumber(raw) {
  // Normalize "1,234.56" / "1.234,56" / "1 234.56" -> 1234.56
  let s = raw.replace(/\s/g, "");
  if (/,\d{2}$/.test(s)) {
    // comma is the decimal separator
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

const CATEGORY_RULES = [
  ["Groceries", /\b(whole\s*foods|walmart|target|kroger|safeway|trader|grocery|supermarket|costco|aldi)\b/i],
  ["Dining", /\b(restaurant|cafe|coffee|starbucks|mcdonald|burger|pizza|kitchen|grill|diner|bistro|tavern)\b/i],
  ["Transport", /\b(uber|lyft|shell|chevron|exxon|bp|gas|fuel|parking|metro|transit|taxi)\b/i],
  ["Shopping", /\b(amazon|ebay|mall|retail|store|boutique|nike|gap|zara)\b/i],
  ["Health", /\b(pharmacy|cvs|walgreens|medical|clinic|hospital|dental|health)\b/i],
  ["Entertainment", /\b(netflix|cinema|theater|spotify|game|entertainment)\b/i],
  ["Supplies", /\b(office\s*depot|staples|hardware|supply|depot)\b/i],
];

function guessCategory(merchant, text) {
  const hay = `${merchant} ${text}`.toLowerCase();
  for (const [cat, re] of CATEGORY_RULES) {
    if (re.test(hay)) return cat;
  }
  return "Other";
}

function normalizeDate(raw) {
  if (!raw) return new Date().toISOString().slice(0, 10);
  const d = new Date(raw);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  const m = raw.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    let y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    const parsed = new Date(y, parseInt(m[1], 10) - 1, parseInt(m[2], 10));
    if (!isNaN(parsed)) return parsed.toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

function extractAmounts(text) {
  const found = [];
  for (const m of text.matchAll(/(?:\$|\bUSD\b)?\s*(\d{1,3}(?:[,\s]\d{3})*(?:\.\d{2})|\d+\.\d{2})/gi)) {
    const n = toNumber(m[1]);
    if (n !== null && n >= 0.5 && n <= 50000) found.push(n);
  }
  return found;
}

function amountFromLine(line) {
  const amounts = [];
  for (const m of line.matchAll(AMOUNT_RE)) {
    const n = toNumber(m[1]);
    if (n !== null) amounts.push(n);
  }
  return amounts.length ? amounts[amounts.length - 1] : null;
}

export function parseReceipt(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const skipLine = /^(receipt|invoice|tel|phone|www\.|http|thank|welcome|store\s*#|cashier)/i;

  const merchant =
    lines.find((l) => {
      if (skipLine.test(l) || l.length < 3 || l.length > 50) return false;
      const letters = (l.match(/[A-Za-z]/g) || []).length;
      return letters >= 3 && letters >= l.length * 0.45;
    })?.slice(0, 60) || "Unknown Merchant";

  let subtotal = null;
  let taxAmount = null;
  const grandTotals = [];
  const totalLineAmounts = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (SUBTOTAL_RE.test(line)) {
      const a = amountFromLine(line);
      if (a !== null) subtotal = a;
      continue;
    }

    if (TAX_LINE_RE.test(line) && !TOTAL_KEYWORDS.test(line) && !SIMPLE_TOTAL_RE.test(line)) {
      const a = amountFromLine(line);
      if (a !== null) taxAmount = a;
      continue;
    }

    if (TOTAL_KEYWORDS.test(line)) {
      const a = amountFromLine(line);
      if (a !== null) grandTotals.push(a);
      continue;
    }

    if (SIMPLE_TOTAL_RE.test(line) && !SUBTOTAL_RE.test(line) && !/\btip\b/i.test(line)) {
      const a = amountFromLine(line);
      if (a !== null) totalLineAmounts.push({ i, amount: a });
    }
  }

  let total = null;
  if (grandTotals.length) {
    total = Math.max(...grandTotals);
  } else if (totalLineAmounts.length) {
    // Last TOTAL line is usually the final amount after tax
    total = totalLineAmounts[totalLineAmounts.length - 1].amount;
  } else if (subtotal !== null && taxAmount !== null) {
    total = Math.round((subtotal + taxAmount) * 100) / 100;
  } else if (subtotal !== null) {
    total = subtotal;
  } else {
    const amounts = extractAmounts(text);
    if (amounts.length) total = Math.max(...amounts);
  }

  const dateMatch = text.match(DATE_RE);
  const date = normalizeDate(dateMatch ? dateMatch[0] : null);
  const category = guessCategory(merchant, text);

  return { merchant, total, subtotal, tax: taxAmount, date, category };
}

/** Enhance image contrast for better OCR on phone photos. */
async function preprocessImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const maxDim = 1800;
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h);
      for (let i = 0; i < data.data.length; i += 4) {
        const gray = 0.299 * data.data[i] + 0.587 * data.data[i + 1] + 0.114 * data.data[i + 2];
        const boosted = Math.min(255, Math.max(0, (gray - 128) * 1.4 + 128));
        data.data[i] = data.data[i + 1] = data.data[i + 2] = boosted;
      }
      ctx.putImageData(data, 0, 0);
      canvas.toBlob(
        (blob) => {
          URL.revokeObjectURL(url);
          resolve(blob || file);
        },
        "image/jpeg",
        0.92
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not load image."));
    };
    img.src = url;
  });
}

/* ------------------------------------------------------------
   3. OCR: image -> text -> parsed fields
   ------------------------------------------------------------ */
export async function processReceiptImage(file, onProgress) {
  if (!window.Tesseract) {
    throw new Error("Tesseract.js failed to load.");
  }
  const processed = await preprocessImage(file);
  const { data } = await window.Tesseract.recognize(processed, "eng", {
    logger: (m) => {
      if (m.status === "recognizing text" && typeof onProgress === "function") {
        onProgress(m.progress);
      }
    },
  });

  const text = (data.text || "").trim();
  if (text.length < 8) {
    throw new Error("Not enough text detected. Try a clearer, flatter photo.");
  }
  const parsed = parseReceipt(text);
  return { ...parsed, rawText: text };
}

/* ------------------------------------------------------------
   4. Firestore data layer
   Per-user, secure subcollections:
     users/{uid}/expenses           — every spend (manual, OCR, recurring)
     users/{uid}/recurring_expenses — subscription definitions
   ------------------------------------------------------------ */
function requireUid() {
  if (!isConfigured || !auth || !db) {
    throw new Error("Firebase is not configured.");
  }
  const user = auth.currentUser;
  if (!user) throw new Error("No authenticated user.");
  return user.uid;
}

const expensesCol = (uid) => collection(db, "users", uid, "expenses");
const recurringCol = (uid) => collection(db, "users", uid, "recurring_expenses");

/** Create or update the user root doc (one dashboard per Google account). */
async function ensureUserProfile(user) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  const profile = {
    displayName: user.displayName || null,
    email: user.email || null,
    photoURL: user.photoURL || null,
    lastSeenAt: serverTimestamp(),
  };
  if (!snap.exists()) {
    await setDoc(ref, { ...profile, createdAt: serverTimestamp(), taxRate: 0.25 });
  } else {
    await updateDoc(ref, profile);
  }
}

let expensesUnsubscribe = null;
let profileUnsubscribe = null;

function stopExpensesListener() {
  if (expensesUnsubscribe) {
    expensesUnsubscribe();
    expensesUnsubscribe = null;
  }
}

function stopProfileListener() {
  if (profileUnsubscribe) {
    profileUnsubscribe();
    profileUnsubscribe = null;
  }
}

/** Live listener for user profile (spending cap, etc.). */
export function listenUserProfile(onChange) {
  const uid = requireUid();
  stopProfileListener();

  profileUnsubscribe = onSnapshot(
    doc(db, "users", uid),
    (snap) => onChange(snap.exists() ? snap.data() : {}),
    (err) => console.error("[FinAdvi] Profile listener error:", err)
  );

  return profileUnsubscribe;
}

/** Set or clear the user's monthly spending cap (null/0 removes it). */
export async function updateSpendingCap(cap) {
  const uid = requireUid();
  const value = cap > 0 ? Number(cap) : null;
  await updateDoc(doc(db, "users", uid), { monthlySpendingCap: value });
}

/** Live listener — pushes this user's expenses to the dashboard callback. */
export function listenExpenses(onChange) {
  const uid = requireUid();
  if (expensesUnsubscribe) expensesUnsubscribe();

  expensesUnsubscribe = onSnapshot(
    expensesCol(uid),
    (snap) => {
      const expenses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      onChange(expenses);
    },
    (err) => console.error("[FinAdvi] Expenses listener error:", err)
  );

  return expensesUnsubscribe;
}

/** Create an expense record (manual entry, OCR scan, or applied subscription). */
export async function createExpense(data) {
  const uid = requireUid();
  const docRef = await addDoc(expensesCol(uid), {
    merchant: data.merchant ?? "Unknown Merchant",
    amount: Number(data.amount) || 0,
    category: data.category ?? "Uncategorized",
    date: data.date ?? null,
    rawText: data.rawText ?? "",
    source: data.source ?? "manual",
    includesTax: data.includesTax === true,
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}

/** Delete an expense by document id. */
export async function deleteExpense(expenseId) {
  const uid = requireUid();
  if (!expenseId) throw new Error("Missing expense id.");
  await deleteDoc(doc(db, "users", uid, "expenses", expenseId));
}

/** Backwards-compatible alias used by the OCR scan flow. */
export async function saveExpense(expense) {
  return createExpense({
    merchant: expense.merchant,
    amount: expense.total ?? expense.amount,
    category: expense.category ?? "Uncategorized",
    date: expense.date,
    rawText: expense.rawText,
    source: "ocr",
  });
}

/** Create a recurring subscription and seed its first nextBillingDate. */
export async function createSubscription(data) {
  const uid = requireUid();
  const billingDay = Math.min(31, Math.max(1, Number(data.billingDay) || 1));
  const next = computeNextBillingDate(billingDay);
  const docRef = await addDoc(recurringCol(uid), {
    name: data.name ?? data.merchant ?? "Subscription",
    amount: Number(data.amount) || 0,
    category: data.category ?? "Other",
    billingDay,
    nextBillingDate: Timestamp.fromDate(next),
    createdAt: serverTimestamp(),
  });
  return { id: docRef.id, nextBillingDate: next };
}

/** Fetch all subscription definitions for the current user. */
export async function fetchSubscriptions() {
  const uid = requireUid();
  const snap = await getDocs(recurringCol(uid));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Fetch all expense records for the current user. */
export async function fetchExpenses() {
  const uid = requireUid();
  const snap = await getDocs(expensesCol(uid));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Append a chat message to users/{uid}/chat_history. */
export async function saveChatMessage(role, text) {
  const uid = requireUid();
  const docRef = await addDoc(collection(db, "users", uid, "chat_history"), {
    role,
    text,
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}

/** Advance a subscription's nextBillingDate (Date object). */
export async function updateSubscriptionNextBilling(id, nextDate) {
  const uid = requireUid();
  await updateDoc(doc(db, "users", uid, "recurring_expenses", id), {
    nextBillingDate: Timestamp.fromDate(nextDate),
  });
}

/* ---- Billing-date helpers ---- */
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Day of the given month, clamped to the last valid day (e.g. 31 → 28/30). */
function dateForBillingDay(year, month, billingDay) {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(billingDay, lastDay));
}

/** Next billing date on/after today for a given day-of-month. */
function computeNextBillingDate(billingDay, from = startOfToday()) {
  let candidate = dateForBillingDay(from.getFullYear(), from.getMonth(), billingDay);
  if (candidate < from) {
    candidate = dateForBillingDay(from.getFullYear(), from.getMonth() + 1, billingDay);
  }
  return candidate;
}

/** One month after the given date, preserving the billing day. */
export function nextMonthFrom(date, billingDay) {
  return dateForBillingDay(date.getFullYear(), date.getMonth() + 1, billingDay);
}

/* ------------------------------------------------------------
   5b. Public API for app.js (classic script)
   ------------------------------------------------------------ */
window.FinAdvi = {
  isConfigured,
  isReady: () => signedIn,
  getUid: () => (auth && auth.currentUser ? auth.currentUser.uid : null),
  getUser: () => (auth && auth.currentUser ? auth.currentUser : null),
  getIdToken: async () => {
    if (!auth?.currentUser) throw new Error("Not signed in.");
    return auth.currentUser.getIdToken();
  },
  signInWithGoogle,
  signOut: signOutUser,
  onReady(cb) {
    if (signedIn && auth && auth.currentUser) cb(auth.currentUser);
    else readyCallbacks.push(cb);
  },
  createExpense,
  deleteExpense,
  createSubscription,
  fetchSubscriptions,
  fetchExpenses,
  listenExpenses,
  listenUserProfile,
  updateSpendingCap,
  saveChatMessage,
  updateSubscriptionNextBilling,
  nextMonthFrom,
  resetScanUI,
  ensureScanTabVisible,
};

/* ------------------------------------------------------------
   5. Wire up the "Scan Receipt" UI
   ------------------------------------------------------------ */
let pendingScan = null;

function setScanButtonsDisabled(disabled) {
  ["camera-btn", "upload-btn"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
}

function setActionsVisible(visible) {
  const actions = document.getElementById("scan-actions");
  if (actions) actions.hidden = !visible;
}

/** Prevent blank scan tab when capture/actions were left hidden without review. */
function ensureScanTabVisible() {
  const result = document.getElementById("scan-result");
  const capture = document.getElementById("scan-capture");
  const actions = document.getElementById("scan-actions");
  const inReview = result && !result.hidden;
  if (!inReview && (capture?.hidden || actions?.hidden)) {
    resetScanUI();
  }
}

function localTodayISO() {
  const n = new Date();
  const y = n.getFullYear();
  const m = String(n.getMonth() + 1).padStart(2, "0");
  const d = String(n.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function resetScanUI() {
  const stage = document.getElementById("scan-stage");
  const frame = document.getElementById("scan-frame");
  const hint = document.getElementById("scan-hint");
  const corners = document.getElementById("scan-corners");
  const preview = document.getElementById("scan-preview");
  const progress = document.getElementById("scan-progress");
  const result = document.getElementById("scan-result");
  const saveStatus = document.getElementById("scan-save");
  const note = document.getElementById("scan-note");
  const reviewForm = document.getElementById("scan-review-form");

  stage?.classList.remove("scan-stage--review");
  frame?.classList.remove("is-scanning");
  if (hint) hint.style.display = "flex";
  if (corners) corners.style.display = "";
  if (preview) {
    if (preview.src?.startsWith("blob:")) URL.revokeObjectURL(preview.src);
    preview.hidden = true;
    preview.removeAttribute("src");
  }
  if (progress) progress.hidden = true;
  if (result) result.hidden = true;
  if (reviewForm) reviewForm.reset();
  if (saveStatus) {
    saveStatus.textContent = "";
    saveStatus.className = "scan-save";
  }
  if (note) {
    note.textContent = "Receipts are read on your device with OCR, then saved to your account.";
    note.className = "scan-note";
  }
  pendingScan = null;
  const capture = document.getElementById("scan-capture");
  if (capture) capture.hidden = false;
  setActionsVisible(true);
  setScanButtonsDisabled(false);
}

function scanErrorMessage(err) {
  const msg = err?.message || "";
  if (/matchAll|RegExp/i.test(msg)) {
    return "Couldn't read amounts from this receipt. Try a clearer photo.";
  }
  if (/tesseract|worker|ocr/i.test(msg)) {
    return "Couldn't read that image. Try a clearer photo in good light.";
  }
  return "Couldn't scan this receipt. Try again with a clearer photo.";
}

function showScanError(message) {
  resetScanUI();
  const note = document.getElementById("scan-note");
  if (note) {
    note.textContent = message;
    note.className = "scan-note scan-note--err";
  }
}

function showScanReview(parsed) {
  const result = document.getElementById("scan-result");
  const merchantInput = document.getElementById("scan-merchant-input");
  const amountInput = document.getElementById("scan-amount-input");
  const categoryInput = document.getElementById("scan-category-input");
  const dateInput = document.getElementById("scan-date-input");
  const stage = document.getElementById("scan-stage");
  const hint = document.getElementById("scan-hint");
  const corners = document.getElementById("scan-corners");
  const preview = document.getElementById("scan-preview");
  const capture = document.getElementById("scan-capture");

  if (merchantInput) merchantInput.value = parsed.merchant || "";
  if (amountInput) amountInput.value = parsed.total != null ? parsed.total : "";
  if (categoryInput) categoryInput.value = parsed.category || "Other";
  // Default to today so new scans count toward this month's Total Spent
  if (dateInput) dateInput.value = localTodayISO();

  stage?.classList.add("scan-stage--review");
  if (capture) capture.hidden = false;
  if (preview) preview.hidden = false;
  if (hint) hint.style.display = "none";
  if (corners) corners.style.display = "none";
  setActionsVisible(false);
  if (result) result.hidden = false;

  const note = document.getElementById("scan-note");
  if (note) {
    note.textContent = "Check the receipt photo and details, then save.";
    note.className = "scan-note";
  }
}

async function handleReceiptFile(file) {
  if (!signedIn) {
    document.getElementById("scan-note").textContent =
      "Sign in with Google first to scan and save receipts.";
    return;
  }

  const frame = document.getElementById("scan-frame");
  const hint = document.getElementById("scan-hint");
  const corners = document.getElementById("scan-corners");
  const preview = document.getElementById("scan-preview");
  const progress = document.getElementById("scan-progress");
  const result = document.getElementById("scan-result");
  const note = document.getElementById("scan-note");
  const saveStatus = document.getElementById("scan-save");

  result.hidden = true;
  saveStatus.textContent = "";
  saveStatus.className = "scan-save";
  setActionsVisible(true);
  hint.style.display = "none";
  corners.style.display = "none";
  preview.src = URL.createObjectURL(file);
  preview.hidden = false;
  frame.classList.add("is-scanning");
  progress.hidden = false;
  progress.textContent = "Recognizing text… 0%";
  setScanButtonsDisabled(true);

  try {
    pendingScan = await processReceiptImage(file, (p) => {
      progress.textContent = `Recognizing text… ${Math.round(p * 100)}%`;
    });

    frame.classList.remove("is-scanning");
    progress.hidden = true;
    showScanReview(pendingScan);
  } catch (err) {
    console.error("[FinAdvi] OCR failed:", err);
    showScanError(scanErrorMessage(err));
  } finally {
    setScanButtonsDisabled(false);
  }
}

function initScanUI() {
  const cameraBtn = document.getElementById("camera-btn");
  const uploadBtn = document.getElementById("upload-btn");
  const cameraInput = document.getElementById("ocr-camera");
  const fileInput = document.getElementById("ocr-file");
  const reviewForm = document.getElementById("scan-review-form");
  const retakeBtn = document.getElementById("scan-retake-btn");
  if (!cameraBtn || !uploadBtn || !cameraInput || !fileInput) return;

  cameraBtn.addEventListener("click", () => cameraInput.click());
  uploadBtn.addEventListener("click", () => fileInput.click());

  const onFilePicked = async (input) => {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      document.getElementById("scan-note").textContent = "Please choose an image file.";
      return;
    }
    await handleReceiptFile(file);
  };

  cameraInput.addEventListener("change", () => onFilePicked(cameraInput));
  fileInput.addEventListener("change", () => onFilePicked(fileInput));

  retakeBtn?.addEventListener("click", resetScanUI);

  reviewForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!signedIn) return;

    const merchant = document.getElementById("scan-merchant-input").value.trim();
    const amount = parseFloat(document.getElementById("scan-amount-input").value) || 0;
    const category = document.getElementById("scan-category-input").value;
    const date = document.getElementById("scan-date-input").value;
    const saveStatus = document.getElementById("scan-save");
    const submitBtn = reviewForm.querySelector('[type="submit"]');

    if (!merchant || amount <= 0) {
      saveStatus.textContent = "Enter a merchant name and valid amount.";
      saveStatus.className = "scan-save scan-save--err";
      return;
    }

    submitBtn.disabled = true;
    try {
      const expenseDate = date || localTodayISO();
      const id = await createExpense({
        merchant,
        amount,
        category,
        date: expenseDate,
        rawText: pendingScan?.rawText || "",
        source: "ocr",
        includesTax: true,
      });
      saveStatus.textContent = `Saved to expenses (#${id.slice(0, 6)})`;
      saveStatus.className = "scan-save scan-save--ok";
      resetScanUI();
      document.getElementById("scan-note").textContent =
        "Receipt saved! Opening your Dashboard…";
      document.dispatchEvent(
        new CustomEvent("finadvi:expense-saved", {
          detail: {
            id,
            merchant,
            amount,
            category,
            date: expenseDate,
            source: "ocr",
            includesTax: true,
          },
        })
      );
    } catch (err) {
      console.error("[FinAdvi] Failed to save receipt:", err);
      const msg = err.code === "permission-denied"
        ? "Could not save — check Firestore rules are published."
        : "Could not save — make sure you're signed in.";
      saveStatus.textContent = msg;
      saveStatus.className = "scan-save scan-save--err";
    } finally {
      submitBtn.disabled = false;
    }
  });

  resetScanUI();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initScanUI);
} else {
  initScanUI();
}
