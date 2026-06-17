# Deploy FinAdvi securely

This guide covers security checks, Firebase hardening, and hosting on **Render** (free tier works for testing).

---

## Security audit summary

| Area | Status | Notes |
|------|--------|-------|
| Gemini API key | ✅ Server-only | Lives in `GEMINI_API_KEY` env var, never in browser |
| `.env` file | ✅ Gitignored | Never push to GitHub |
| Firestore data | ✅ Per-user rules | Only `users/{your-uid}/...` accessible when signed in |
| AI chat API | ✅ Auth required (prod) | `/api/chat` verifies Firebase ID token |
| Rate limiting | ✅ 20 req/min/IP | Stops Gemini API abuse |
| Static files | ✅ Hardened | `/server`, `/node_modules`, dotfiles blocked |
| Firebase client key | ⚠️ Public by design | Normal for web apps — lock down with rules + domain restrictions (below) |

---

## Before you deploy — do these 5 things

### 1. Publish Firestore rules

Firebase Console → **Firestore** → **Rules** → paste `firestore.rules` → **Publish**.

Or with Firebase CLI:
```bash
firebase deploy --only firestore:rules
```

### 2. Enable Google Sign-In + authorized domains

**Authentication** → **Sign-in method** → **Google** → Enable.

**Authentication** → **Settings** → **Authorized domains** → add your production URL:
```
finadvi.onrender.com
```
(Render gives you a `*.onrender.com` subdomain.)

### 3. Restrict Firebase API key (recommended)

[Google Cloud Console](https://console.cloud.google.com) → select project **tgwebhub** → **APIs & Services** → **Credentials** → your browser API key:

- **Application restrictions** → HTTP referrers:
  ```
  http://localhost:3000/*
  https://finadvi.onrender.com/*
  https://*.onrender.com/*
  ```
- **API restrictions** → restrict to:
  - Identity Toolkit API
  - Token Service API
  - Cloud Firestore API

### 4. Create a Firebase service account (for secure AI chat)

Firebase Console → **Project settings** → **Service accounts** → **Generate new private key**.

You'll get a `.json` file. **Never commit this file.**

For Render, minify it to **one line** and paste as the `FIREBASE_SERVICE_ACCOUNT` environment variable.

### 5. Push code to GitHub (without secrets)

```bash
git init
git add .
git status   # confirm .env is NOT listed
git commit -m "FinAdvi initial deploy"
git remote add origin https://github.com/YOUR_USER/finadvi.git
git push -u origin main
```

---

## Host on Render (recommended)

### Step 1 — Create Web Service

1. Go to [render.com](https://render.com) → **New** → **Web Service**
2. Connect your GitHub repo
3. Settings:
   | Field | Value |
   |-------|-------|
   | **Name** | `finadvi` |
   | **Region** | closest to you |
   | **Branch** | `main` |
   | **Runtime** | Node |
   | **Build Command** | `npm install` |
   | **Start Command** | `npm start` |
   | **Instance type** | Free (or Starter for always-on) |

### Step 2 — Environment variables

In Render → your service → **Environment**:

| Key | Value |
|-----|-------|
| `NODE_ENV` | `production` |
| `GEMINI_API_KEY` | your key from [Google AI Studio](https://aistudio.google.com/apikey) |
| `ALLOWED_ORIGIN` | `https://finadvi.onrender.com` (your exact Render URL) |
| `FIREBASE_SERVICE_ACCOUNT` | entire service account JSON on one line |

Optional:
| Key | Value |
|-----|-------|
| `GEMINI_MODEL` | `gemini-2.5-flash` |

Click **Save Changes** → Render redeploys.

### Step 3 — Verify

1. Open `https://finadvi.onrender.com`
2. Sign in with Google
3. Check health: `https://finadvi.onrender.com/api/health`
   ```json
   { "ok": true, "authConfigured": true, "geminiConfigured": true }
   ```
4. Add an expense → confirm it appears in Firestore
5. Test AI Coach → should work only when signed in

---

## Local production test

```bash
npm install
# Set NODE_ENV, GEMINI_API_KEY, FIREBASE_SERVICE_ACCOUNT in .env
npm start
```

---

## What protects your data

```
User's browser
  ├── Google Sign-In → Firebase Auth (unique uid)
  ├── Firestore reads/writes → blocked by security rules unless uid matches
  └── AI chat → sends Firebase ID token → server verifies → calls Gemini

Secrets never in browser:
  ├── GEMINI_API_KEY (server env only)
  └── Firebase service account (server env only)

Public in browser (normal for Firebase web apps):
  └── firebaseConfig apiKey — safe IF Firestore rules + API key restrictions are set
```

---

## If something breaks after deploy

| Problem | Fix |
|---------|-----|
| Google sign-in fails | Add Render URL to Firebase **Authorized domains** |
| `Permission denied` on expenses | Republish `firestore.rules` |
| AI Coach: "Sign in required" | Set `FIREBASE_SERVICE_ACCOUNT` on Render |
| AI Coach: 503 auth not configured | Same — service account missing or invalid JSON |
| CORS error | Set `ALLOWED_ORIGIN` to your exact `https://` URL |
| Free Render sleeps | First visit takes ~30s to wake — upgrade to Starter for always-on |

---

## Rotate keys if exposed

If you ever committed `.env` or shared API keys:

1. **Gemini** — [AI Studio](https://aistudio.google.com/apikey) → delete old key → create new → update Render env
2. **Firebase service account** — Google Cloud → IAM → delete old key → generate new JSON
3. **Firebase client API key** — Google Cloud → Credentials → regenerate

---

## Optional upgrades

- **Custom domain** — Render → Settings → Custom Domains → add domain → also add to Firebase authorized domains
- **Firebase App Check** — extra bot protection (advanced)
- **Always-on hosting** — Render Starter ($7/mo) or Railway
