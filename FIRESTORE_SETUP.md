# Firestore setup — per-user dashboard

Each user gets a **private dashboard** backed by Firestore. Data is stored under:

```
users/{uid}                          ← user profile (auto-created on first visit)
users/{uid}/expenses/{expenseId}   ← manual, scanned, and recurring charges
users/{uid}/recurring_expenses/{id}← subscription definitions (Netflix, Gym, etc.)
users/{uid}/chat_history/{msgId}   ← AI Coach conversation
```

`{uid}` is the Firebase Auth user ID from **Google Sign-In**. The same Google account always maps to the same dashboard on every device.

---

## Step 1 — Enable Google Sign-In

1. Open [Firebase Console](https://console.firebase.google.com) → your project (**tgwebhub**).
2. Go to **Build → Authentication → Sign-in method**.
3. Click **Google** → **Enable** → set a support email → **Save**.

### Authorized domains (important for deploy)

Under **Authentication → Settings → Authorized domains**, confirm:
- `localhost` (for local dev)
- Your production domain (e.g. `your-app.onrender.com`) — add it before deploying

---

## Step 2 — Create Firestore database

1. Go to **Build → Firestore Database**.
2. Click **Create database**.
3. Choose **Start in production mode** (we'll paste rules next).
4. Pick a region close to your users (e.g. `us-central1`).

---

## Step 3 — Deploy security rules

1. In Firestore, open the **Rules** tab.
2. Replace everything with the contents of `firestore.rules` in this project:

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

3. Click **Publish**.

These rules ensure **user A can never read or write user B's data**.

---

## Step 4 — Verify in the app

1. Run the app: `npm run dev`
2. Open http://localhost:3000 — you'll see **Continue with Google**.
3. Sign in with your Google account.
4. DevTools → Console should show: `[FinAdvi] Signed in as you@gmail.com`
5. Add an expense from the Dashboard → check Firestore:
   - **Firestore → Data → users → {that uid} → expenses**
   - A new document should appear.
6. Sign out (tap avatar) → sign in again on another browser with the same Google account — your data should appear.

---

## How the dashboard works now

| Action | Firestore path | Dashboard update |
|--------|----------------|------------------|
| Add Expense (modal) | `users/{uid}/expenses` | Live listener refreshes list |
| Scan Receipt (OCR) | `users/{uid}/expenses` | Same |
| Add Subscription | `users/{uid}/recurring_expenses` | No immediate charge |
| Subscription due date | Creates row in `expenses` | Listener picks it up |
| AI Coach chat | `users/{uid}/chat_history` | Chat UI only |

**Total Spent** = sum of this month's expenses for **your** uid only.  
**Tax Reserved** = 25% of that month's spending (estimate).

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Missing or insufficient permissions` | Publish the rules from Step 3 |
| `auth/popup-closed-by-user` | User closed the Google popup — try again |
| Google sign-in fails on deploy | Add your production URL to **Authorized domains** |
| Dashboard empty after adding expense | Check Console for errors; confirm you're on `http://localhost:3000` |

---

## Optional: Firebase CLI deploy

If you install the [Firebase CLI](https://firebase.google.com/docs/cli):

```bash
npm install -g firebase-tools
firebase login
firebase init firestore   # select your project, use firestore.rules
firebase deploy --only firestore:rules
```
