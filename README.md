# FinAdvi

A mobile-first personal finance web app: spending dashboard, OCR receipt scanning (Tesseract.js), recurring subscriptions, and an AI Coach powered by **Google Gemini 1.5 Flash**. Data is stored in **Firebase (Auth + Firestore)**, and the Gemini key is kept safe behind a small **Node/Express proxy**.

## Architecture

```
Browser (index.html + app.js + firebase.js)
  ├── Firebase Web SDK  ──►  Firestore (expenses, recurring_expenses, chat_history)
  └── fetch /api/chat   ──►  Express proxy (server/server.js)  ──►  Gemini 1.5 Flash
                                   (holds GEMINI_API_KEY)
```

The Express server also serves the static frontend, so a single deployment hosts both the site and the API.

## Prerequisites

- [Node.js](https://nodejs.org) **18 or newer**
- A **Firebase** project (Auth + Firestore enabled)
- A **Gemini API key** from [Google AI Studio](https://aistudio.google.com/apikey)

## 1. Configure Firebase (client)

In the [Firebase console](https://console.firebase.google.com): create a project, enable **Authentication → Anonymous**, and create a **Firestore** database.

Copy your web app config into `firebase.js` (replace the `YOUR_*` placeholders):

```js
const firebaseConfig = {
  apiKey: "…",
  authDomain: "…",
  projectId: "…",
  storageBucket: "…",
  messagingSenderId: "…",
  appId: "…",
};
```

Set Firestore security rules so each user can only access their own data. **Full step-by-step guide:** see [`FIRESTORE_SETUP.md`](FIRESTORE_SETUP.md).

Quick version — paste into Firestore → Rules → Publish:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
      match /{subcollection}/{docId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
    }
  }
}
```

Also enable **Google** sign-in under Authentication → Sign-in method.

## 2. Configure the server (Gemini key)

```bash
cp .env.example .env
```

Edit `.env` and paste your key:

```
GEMINI_API_KEY=your_key_from_google_ai_studio
PORT=3000
```

## 3. Run locally

```bash
npm install
npm run dev      # or: npm start
```

Open <http://localhost:3000>. The server serves the site and proxies `/api/chat`.

> Health check: <http://localhost:3000/api/health> should return `{ "ok": true, "geminiConfigured": true }`.

## 4. Deploy

The whole app is one Node web service. Any Node host works. **Set `GEMINI_API_KEY` as an environment variable in the host's dashboard — never commit `.env`.**

### Option A — Render / Railway (simplest)
1. Push this repo to GitHub.
2. Create a new **Web Service** from the repo.
3. Build command: `npm install` · Start command: `npm start`.
4. Add an environment variable `GEMINI_API_KEY`.
5. Deploy. The provided URL serves both site and API.

### Option B — Google Cloud Run
```bash
gcloud run deploy finadvi \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY=your_key
```

### Option C — Firebase Hosting + Cloud Run/Functions
Host the static files on Firebase Hosting and route the API to the server with a rewrite in `firebase.json`:

```json
{
  "hosting": {
    "public": ".",
    "ignore": ["server/**", "node_modules/**", "**/.*"],
    "rewrites": [{ "source": "/api/**", "run": { "serviceId": "finadvi" } }]
  }
}
```

Then `firebase deploy --only hosting`.

## Project structure

```
finadvi/
├── index.html        # UI: Dashboard, Scan, AI Coach + modals
├── styles.css        # Stitch-inspired dark-slate theme
├── app.js            # UI logic, modals, subscriptions job, chat → /api/chat
├── firebase.js       # Firebase v10 init, Firestore data layer, OCR pipeline
├── server/
│   └── server.js     # Express proxy: /api/chat → Gemini, serves static site
├── package.json
├── .env.example
└── .gitignore
```

## Notes
- The frontend calls `/api/chat` on the same origin by default. For split local dev (e.g. a separate static server), set `API_BASE` at the top of `app.js`.
- Receipt OCR runs fully in the browser (Tesseract.js) — images are never uploaded.
