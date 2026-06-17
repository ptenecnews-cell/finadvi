/* ============================================================
   FinAdvi — app logic: navigation, dashboard, scan, AI coach
   ============================================================ */

const fmt = (n) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const fbReady = () => typeof window.FinAdvi !== "undefined" && window.FinAdvi.isConfigured;

const CATEGORY_ICONS = {
  Groceries: "🛒", Dining: "🍽️", Transport: "🚗", Shopping: "🛍️",
  Health: "💊", Entertainment: "🎬", Streaming: "📺", Software: "💻",
  "Cloud Storage": "☁️", Fitness: "🏋️", Utilities: "💡",
  "News & Media": "📰", Other: "💸", Uncategorized: "💸", Supplies: "📦",
};

/* ---------- Dashboard (per-user Firestore data) ---------- */
let userExpenses = [];
let userProfile = { monthlySpendingCap: null };
let capExceededNotified = false;

const tsToDate = (ts) =>
  ts && typeof ts.toDate === "function"
    ? ts.toDate().toISOString().slice(0, 10)
    : ts || null;

function parseExpenseDate(expense) {
  const raw = expense.date || tsToDate(expense.createdAt);
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d) ? null : d;
}

function formatMetaDate(date) {
  if (!date) return "Unknown date";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const diff = Math.round((today - d) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function expenseToTransaction(expense) {
  const date = parseExpenseDate(expense);
  const sourceLabel =
    expense.source === "recurring"
      ? "Recurring"
      : expense.source === "ocr"
        ? "Scanned"
        : "Manual";
  return {
    id: expense.id,
    name: expense.merchant || "Unknown",
    meta: `${expense.category || "Other"} · ${sourceLabel} · ${formatMetaDate(date)}`,
    amount: -Math.abs(Number(expense.amount) || 0),
    icon: CATEGORY_ICONS[expense.category] || "💸",
    sortTime: date ? date.getTime() : 0,
  };
}

function renderSpendingCapUI(totalSpent) {
  const cap = Number(userProfile.monthlySpendingCap) || 0;
  const capDisplay = document.getElementById("cap-display");
  const meta = document.getElementById("stat-spent-meta");
  const progress = document.getElementById("cap-progress");
  const progressFill = document.getElementById("cap-progress-fill");
  const alert = document.getElementById("spending-alert");
  const alertText = document.getElementById("spending-alert-text");

  if (capDisplay) capDisplay.textContent = cap > 0 ? fmt(cap) : "Not set";

  if (cap <= 0) {
    if (meta) meta.textContent = "This month";
    if (progress) progress.hidden = true;
    if (alert) alert.hidden = true;
    capExceededNotified = false;
    return;
  }

  const pct = Math.min((totalSpent / cap) * 100, 100);
  if (meta) meta.textContent = `${fmt(totalSpent)} of ${fmt(cap)} cap`;
  if (progress) {
    progress.hidden = false;
    progressFill.style.width = `${pct}%`;
    progressFill.classList.toggle("cap-progress__fill--over", totalSpent > cap);
  }

  if (totalSpent > cap) {
    const over = totalSpent - cap;
    if (alertText) {
      alertText.innerHTML =
        `You've exceeded your monthly spending cap by <strong>${fmt(over)}</strong> ` +
        `(${fmt(totalSpent)} spent of ${fmt(cap)}).`;
    }
    if (alert) alert.hidden = false;

    if (!capExceededNotified) {
      capExceededNotified = true;
      pushCapNotification(totalSpent, cap, over);
    }
  } else {
    if (alert) alert.hidden = true;
    capExceededNotified = false;
  }
}

function pushCapNotification(spent, cap, over) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    new Notification("FinAdvi — Spending cap exceeded", {
      body: `You've spent ${fmt(spent)} of your ${fmt(cap)} monthly cap (${fmt(over)} over).`,
    });
  } catch (_) {
    /* ignore — some browsers block without user gesture */
  }
}

function renderDashboard() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const monthExpenses = userExpenses.filter((e) => {
    const d = parseExpenseDate(e);
    return d && d >= monthStart;
  });

  const totalSpent = monthExpenses.reduce(
    (sum, e) => sum + Math.abs(Number(e.amount) || 0),
    0
  );
  const taxReserved = totalSpent * 0.25;

  document.getElementById("stat-total-spent").textContent = fmt(totalSpent);
  document.getElementById("stat-tax-reserved").textContent = fmt(taxReserved);
  renderSpendingCapUI(totalSpent);

  const transactions = userExpenses
    .map(expenseToTransaction)
    .sort((a, b) => b.sortTime - a.sortTime)
    .slice(0, 20);

  const list = document.getElementById("txn-list");
  list.innerHTML = "";

  if (!transactions.length) {
    list.innerHTML =
      '<li class="txn txn--empty"><div class="txn__body"><p class="txn__name">No expenses yet</p><p class="txn__meta">Add one manually or scan a receipt</p></div></li>';
    return;
  }

  transactions.forEach((t, i) => {
    const li = document.createElement("li");
    li.className = "txn";
    li.style.animationDelay = `${i * 0.05}s`;
    li.innerHTML = `
      <div class="txn__icon">${t.icon}</div>
      <div class="txn__body">
        <p class="txn__name">${escapeHtml(t.name)}</p>
        <p class="txn__meta">${escapeHtml(t.meta)}</p>
      </div>
      <span class="txn__amount">−${fmt(Math.abs(t.amount))}</span>
      <button class="txn__delete" type="button" data-id="${t.id}" aria-label="Delete ${escapeHtml(t.name)}">×</button>`;
    list.appendChild(li);
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function handleDeleteExpense(expenseId, merchant) {
  if (!fbReady() || !window.FinAdvi.isReady()) return;
  const label = merchant || "this expense";
  if (!confirm(`Delete ${label}? This cannot be undone.`)) return;

  const btn = document.querySelector(`.txn__delete[data-id="${expenseId}"]`);
  if (btn) btn.disabled = true;

  try {
    await window.FinAdvi.deleteExpense(expenseId);
  } catch (err) {
    console.error("[FinAdvi] Failed to delete expense:", err);
    alert("Could not delete expense. Try again.");
    if (btn) btn.disabled = false;
  }
}

function personalizeHeader(user) {
  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const greetingEl = document.querySelector(".app-header__greeting");
  const titleEl = document.querySelector("#view-dashboard .app-header__title");

  const name = user?.displayName?.split(" ")[0];
  if (greetingEl) greetingEl.textContent = name ? `${greeting}, ${name}` : greeting;
  if (titleEl) titleEl.textContent = "Dashboard";

  const avatar = document.getElementById("sign-out-btn");
  if (!avatar) return;

  if (user?.photoURL) {
    avatar.innerHTML = `<img src="${user.photoURL}" alt="" />`;
  } else {
    const initials = user?.displayName
      ? user.displayName.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()
      : user?.uid?.slice(0, 2).toUpperCase() || "?";
    avatar.textContent = initials;
  }
}

function initUserDashboard(user) {
  personalizeHeader(user);
  if (!fbReady()) {
    renderDashboard();
    return;
  }

  window.FinAdvi.listenExpenses((expenses) => {
    userExpenses = expenses;
    renderDashboard();
  });

  window.FinAdvi.listenUserProfile((profile) => {
    userProfile = profile || {};
    renderDashboard();
  });
}

function clearUserDashboard() {
  userExpenses = [];
  userProfile = { monthlySpendingCap: null };
  capExceededNotified = false;
  renderDashboard();
}

function showAuthGate(show) {
  const gate = document.getElementById("auth-gate");
  if (gate) gate.hidden = !show;
}

function setAuthError(msg) {
  const el = document.getElementById("auth-error");
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

/* ---------- Navigation ---------- */
const views = document.querySelectorAll(".view");
const navItems = document.querySelectorAll(".nav-item");

function switchView(target) {
  views.forEach((v) =>
    v.classList.toggle("view--active", v.dataset.view === target)
  );
  navItems.forEach((n) =>
    n.classList.toggle("nav-item--active", n.dataset.target === target)
  );
  if (target === "coach") {
    setTimeout(() => document.getElementById("chat-field").focus(), 300);
  }
}

navItems.forEach((item) =>
  item.addEventListener("click", () => switchView(item.dataset.target))
);

/* ---------- Scan simulation removed — real OCR lives in firebase.js ---------- */

/* ---------- AI Coach chat (Google Gemini) ---------- */

// The Gemini API key now lives on the backend proxy (see the /server folder),
// so it is never shipped to the browser. The client only calls our own endpoint.
// For split local dev (static site + server on different ports) set API_BASE to
// e.g. "http://localhost:3000". Empty string = same origin (single deploy).
const API_BASE = "";
const CHAT_ENDPOINT = `${API_BASE}/api/chat`;

// NOTE: the markup uses #chat-form / #chat-field / #chat-log. The form's
// submit fires on both the Send button (#chat-send) and the Enter key.
const chatLog = document.getElementById("chat-log");
const chatForm = document.getElementById("chat-form");
const chatField = document.getElementById("chat-field");

function addBubble(text, who) {
  const b = document.createElement("div");
  b.className = `bubble bubble--${who}`;
  b.textContent = text;
  chatLog.appendChild(b);
  chatLog.scrollTop = chatLog.scrollHeight;
  return b;
}

function showTyping() {
  const t = document.createElement("div");
  t.className = "bubble bubble--ai typing";
  t.innerHTML = "<span></span><span></span><span></span>";
  chatLog.appendChild(t);
  chatLog.scrollTop = chatLog.scrollHeight;
  return t;
}

/**
 * Pull the user's financial data and send it with the message to our backend
 * proxy. The proxy attaches the US-finance system context (current date 2026)
 * and the Gemini API key server-side before calling Gemini.
 */
async function sendMessageToGemini(userMessage) {
  // 1. Gather expenses + recurring subscriptions from Firestore (authed client).
  let expenses = [];
  let subscriptions = [];
  if (fbReady() && window.FinAdvi.getUid()) {
    try {
      [expenses, subscriptions] = await Promise.all([
        window.FinAdvi.fetchExpenses(),
        window.FinAdvi.fetchSubscriptions(),
      ]);
    } catch (err) {
      console.warn("[FinAdvi] Could not load financial data for Gemini:", err);
    }
  }

  const expensesJson = expenses.map((e) => ({
    merchant: e.merchant,
    amount: e.amount,
    category: e.category,
    date: e.date || tsToDate(e.createdAt),
    source: e.source,
  }));
  const subscriptionsJson = subscriptions.map((s) => ({
    name: s.name,
    amount: s.amount,
    category: s.category,
    billingDay: s.billingDay,
    nextBillingDate: tsToDate(s.nextBillingDate),
  }));

  // 2. Send to our backend proxy (requires Firebase auth token in production).
  const headers = { "Content-Type": "application/json" };
  if (fbReady() && window.FinAdvi.isReady()) {
    try {
      headers.Authorization = `Bearer ${await window.FinAdvi.getIdToken()}`;
    } catch (err) {
      console.warn("[FinAdvi] Could not get auth token for chat:", err);
    }
  }

  const res = await fetch(CHAT_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message: userMessage,
      expenses: expensesJson,
      subscriptions: subscriptionsJson,
    }),
  });

  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || `Proxy error ${res.status}`);
  }

  const data = await res.json();
  return data.reply || "Sorry, I couldn't generate a response right now.";
}

let isSending = false;
chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = chatField.value.trim();
  if (!text || isSending) return;

  isSending = true;
  addBubble(text, "user");
  chatField.value = "";

  // Persist the user message to chat_history.
  if (fbReady() && window.FinAdvi.getUid()) {
    window.FinAdvi.saveChatMessage("user", text).catch((err) =>
      console.error("[FinAdvi] Failed to save user message:", err)
    );
  }

  const typing = showTyping();
  try {
    const reply = await sendMessageToGemini(text);
    typing.remove();
    addBubble(reply, "ai");

    // Persist the assistant reply to chat_history.
    if (fbReady() && window.FinAdvi.getUid()) {
      window.FinAdvi.saveChatMessage("assistant", reply).catch((err) =>
        console.error("[FinAdvi] Failed to save assistant message:", err)
      );
    }
  } catch (err) {
    typing.remove();
    addBubble(
      "⚠️ I couldn't reach the AI Coach right now. Make sure the backend server is running, then try again.",
      "ai"
    );
    console.error("[FinAdvi] Gemini request failed:", err);
  } finally {
    isSending = false;
  }
});

/* ---------- Add Expense / Subscription modals ---------- */

function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.hidden = false;
  document.body.style.overflow = "hidden";
  const firstInput = modal.querySelector("input, select");
  if (firstInput) setTimeout(() => firstInput.focus(), 250);
}

function closeModal(modal) {
  modal.classList.add("is-closing");
  setTimeout(() => {
    modal.hidden = true;
    modal.classList.remove("is-closing");
    document.body.style.overflow = "";
  }, 240);
}

document.getElementById("open-expense").addEventListener("click", () =>
  openModal("modal-expense")
);
document.getElementById("open-subscription").addEventListener("click", () =>
  openModal("modal-subscription")
);
document.getElementById("open-cap").addEventListener("click", () => {
  const input = document.querySelector('#form-cap input[name="cap"]');
  if (input && userProfile.monthlySpendingCap) {
    input.value = userProfile.monthlySpendingCap;
  }
  openModal("modal-cap");
});

document.querySelectorAll(".modal").forEach((modal) => {
  modal.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", () => closeModal(modal))
  );
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const open = document.querySelector(".modal:not([hidden])");
  if (open) closeModal(open);
});

// ----- Manual expense: write to users/{uid}/expenses -----
document.getElementById("form-expense").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const merchant = f.get("merchant");
  const amount = parseFloat(f.get("amount")) || 0;
  const category = f.get("category");
  const dateVal = f.get("date");

  e.target.reset();
  closeModal(document.getElementById("modal-expense"));

  if (fbReady()) {
    try {
      await window.FinAdvi.createExpense({
        merchant,
        amount,
        category,
        date: dateVal || new Date().toISOString().slice(0, 10),
        source: "manual",
      });
    } catch (err) {
      console.error("[FinAdvi] Failed to save expense:", err);
      alert("Could not save expense. Check Firestore rules and try again.");
    }
  }
});

// ----- Recurring subscription: write to users/{uid}/recurring_expenses -----
document.getElementById("form-subscription").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const name = f.get("merchant");
  const amount = parseFloat(f.get("amount")) || 0;
  const category = f.get("category");
  const day = Math.min(31, Math.max(1, parseInt(f.get("billingDay"), 10) || 1));

  e.target.reset();
  closeModal(document.getElementById("modal-subscription"));

  if (fbReady()) {
    try {
      await window.FinAdvi.createSubscription({ name, amount, category, billingDay: day });
    } catch (err) {
      console.error("[FinAdvi] Failed to save subscription:", err);
      alert("Could not save subscription. Check Firestore rules and try again.");
    }
  }
});

// ----- Monthly spending cap -----
document.getElementById("form-cap").addEventListener("submit", async (e) => {
  e.preventDefault();
  const cap = parseFloat(new FormData(e.target).get("cap")) || 0;
  if (fbReady()) {
    try {
      await window.FinAdvi.updateSpendingCap(cap);
      if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
      }
    } catch (err) {
      console.error("[FinAdvi] Failed to save spending cap:", err);
      alert("Could not save spending cap.");
      return;
    }
  }
  e.target.reset();
  closeModal(document.getElementById("modal-cap"));
});

document.getElementById("clear-cap").addEventListener("click", async () => {
  if (fbReady()) {
    try {
      await window.FinAdvi.updateSpendingCap(null);
    } catch (err) {
      console.error("[FinAdvi] Failed to clear spending cap:", err);
    }
  }
  closeModal(document.getElementById("modal-cap"));
});

/* ------------------------------------------------------------
   Background job: apply due subscriptions on dashboard login.
   1. Fetch all recurring_expenses.
   2. If nextBillingDate has passed or is today, create an expense.
   3. Advance nextBillingDate to the next month (looping over any
      missed cycles so monthly/weekly reports stay accurate).
   ------------------------------------------------------------ */
async function checkAndApplySubscriptions() {
  if (!fbReady()) return;

  let applied = 0;
  try {
    const subs = await window.FinAdvi.fetchSubscriptions();
    const today = new Date();
    today.setHours(23, 59, 59, 999); // treat anything due today as due

    for (const sub of subs) {
      // Firestore Timestamp -> JS Date
      let nextDate = sub.nextBillingDate?.toDate
        ? sub.nextBillingDate.toDate()
        : new Date(sub.nextBillingDate);
      if (!nextDate || isNaN(nextDate)) continue;

      let changed = false;
      // Apply every billing cycle that is due (handles multiple missed months).
      while (nextDate <= today) {
        await window.FinAdvi.createExpense({
          merchant: sub.name,
          amount: sub.amount,
          category: sub.category,
          date: nextDate.toISOString().slice(0, 10),
          source: "recurring",
        });

        applied++;
        changed = true;
        nextDate = window.FinAdvi.nextMonthFrom(nextDate, sub.billingDay);
      }

      if (changed) {
        await window.FinAdvi.updateSubscriptionNextBilling(sub.id, nextDate);
      }
    }

    if (applied > 0) {
      console.info(`[FinAdvi] Applied ${applied} due subscription charge(s).`);
    }
  } catch (err) {
    console.error("[FinAdvi] checkAndApplySubscriptions failed:", err);
  }
}

/* ---------- Auth (Google Sign-In) ---------- */
document.getElementById("google-sign-in")?.addEventListener("click", async () => {
  if (!fbReady()) {
    setAuthError("Firebase is not configured.");
    return;
  }
  const btn = document.getElementById("google-sign-in");
  setAuthError("");
  btn.disabled = true;
  try {
    await window.FinAdvi.signInWithGoogle();
  } catch (err) {
    console.error("[FinAdvi] Google sign-in failed:", err);
    if (err.code === "auth/popup-closed-by-user") {
      setAuthError("Sign-in was cancelled.");
    } else {
      setAuthError("Could not sign in. Enable Google in Firebase Console → Authentication.");
    }
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("sign-out-btn")?.addEventListener("click", async () => {
  if (!fbReady() || !window.FinAdvi.isReady()) return;
  try {
    await window.FinAdvi.signOut();
  } catch (err) {
    console.error("[FinAdvi] Sign-out failed:", err);
  }
});

/* ---------- Init ---------- */
renderDashboard();
showAuthGate(true);

document.getElementById("txn-list")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".txn__delete");
  if (!btn) return;
  const id = btn.dataset.id;
  const merchant = btn.closest(".txn")?.querySelector(".txn__name")?.textContent;
  handleDeleteExpense(id, merchant);
});

addBubble(
  "Hi! I'm your AI finance coach. Ask me about your spending, taxes, or savings goals. 💡",
  "ai"
);

document.addEventListener("finadvi:ready", async (e) => {
  showAuthGate(false);
  setAuthError("");
  initUserDashboard(e.detail);
  await checkAndApplySubscriptions();
});

document.addEventListener("finadvi:signed-out", () => {
  clearUserDashboard();
  showAuthGate(true);
  personalizeHeader(null);
});
