import { createDb } from "./db.js";
import { calculateSavingsProgress } from "./savings.js";
import { firebaseConfig } from "../firebase-config.js";
import {
  PERSON_KEYS,
  PALETTE,
  PAYMENT_METHODS,
  THEMES,
  MASCOTS,
  isAdmin,
  isPro,
  isProUser,
  canAccessProFeature,
  getProRemainingDays,
  PRO_PRICE,
  PAYPAL_PLAN_ID,
  PAYPAL_CLIENT_ID,
  getTheme,
  getMascot,
  defaultCategories,
  defaultBudget,
  normalizeBudget,
  normalizeRecurringBills,
  findPendingRecurringBills,
  getDueRecurringAlerts,
  generateWrappedData,
  calculateJarProgress,
  calculateJarPace,
  calculateCategoryCap,
  calculateCompoundGrowth,
  generateExpensesCSV,
  generateInvestmentsCSV,
  buildReceiptPrompt,
  parseReceiptResponse,
  calc,
  spendIndex as calcSpendIndex,
  usedStatus,
  createBackupPayload,
  validateBackupPayload,
} from "./calc.js";

/* ================================================================== */
/* Helpers                                                             */
/* ================================================================== */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function formatNumberInput(val) {
  if (val === "" || val == null) return "";
  const clean = String(val).replace(/[^0-9.]/g, "");
  const parts = clean.split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return parts.slice(0, 2).join(".");
}

function parseFormattedNumber(val) {
  return Number(String(val || "").replace(/,/g, "")) || 0;
}

function handleFormattedNumberInput(input) {
  const origVal = input.value;
  const cursor = input.selectionStart || 0;
  const digitsBefore = (origVal.slice(0, cursor).match(/\d/g) || []).length;

  const formatted = formatNumberInput(origVal);
  if (origVal !== formatted) {
    input.value = formatted;
    let newCursor = 0;
    let seenDigits = 0;
    while (newCursor < formatted.length && seenDigits < digitsBefore) {
      if (/\d/.test(formatted[newCursor])) {
        seenDigits++;
      }
      newCursor++;
    }
    input.setSelectionRange(newCursor, newCursor);
  }
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = (n) => String(n).padStart(2, "0");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const CURRENCIES = ["USD", "EUR", "GBP", "IDR", "SGD", "MYR", "AUD", "CAD", "JPY", "KRW", "INR", "PHP", "THB", "VND", "CNY"];
const ZERO_DECIMAL = new Set(["IDR", "JPY", "KRW", "VND"]);

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

/* ================================================================== */
/* State + defaults                                                    */
/* ================================================================== */
const now = new Date();
const state = {
  db: null,
  user: null,
  settings: null,
  budgets: {},
  expenses: [],
  investments: [],
  invId: null,
  recurring: [],
  recId: null,
  loaded: { settings: false, budgets: false, expenses: false, recurring: false },
  tab: "home",
  year: now.getFullYear(),
  month: now.getMonth(),
  draft: null, // { year, b } — the budget being edited
  dirty: false,
  editingId: null,
  lastCat: null,
  lastPaidBy: "p1",
  lastPaymentMethod: "cash",
  lastCardName: "",
  jars: [],
  feed: [],
  feedOpen: true,
  compound: { principal: 0, monthly: 500, rate: 8, years: 10 },
};

let notifiedDDayToday = false;
let checkedPwaPrompt = false;

function isStandalonePwa() {
  return Boolean(
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    navigator.standalone
  );
}

async function sendBrowserNotification(title, options = {}) {
  const opts = {
    icon: "icons/icon-192.svg",
    badge: "icons/icon-192.svg",
    ...options,
  };
  if ("serviceWorker" in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && typeof reg.showNotification === "function") {
        await reg.showNotification(title, opts);
        return true;
      }
    } catch (e) {
      console.warn("ServiceWorker showNotification failed, trying fallback:", e);
    }
  }
  if ("Notification" in window) {
    try {
      new Notification(title, opts);
      return true;
    } catch (e) {
      console.warn("Notification constructor failed:", e);
    }
  }
  return false;
}

async function checkDDayNotifications() {
  if (!state.loaded.recurring || !state.loaded.expenses) return;
  const todayKey = new Date().toISOString().slice(0, 10);
  const lastNotifDate = localStorage.getItem("piggynest_last_dday_notif");
  if (lastNotifDate === todayKey) return;

  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const alerts = getDueRecurringAlerts(state.recurring, state.expenses, new Date());
  const hasDDay = alerts.dDay && alerts.dDay.length > 0;
  const upcomingNear = (alerts.upcoming || []).filter((b) => b.diff <= 2);
  const hasUpcoming = upcomingNear.length > 0;

  if (hasDDay) {
    try {
      await sendBrowserNotification("PiggyNest: Bill Due Today! 📅", {
        body: "Due today: " + alerts.dDay.map((b) => b.name).join(", "),
        tag: "piggynest-due-today",
      });
      localStorage.setItem("piggynest_last_dday_notif", todayKey);
      notifiedDDayToday = true;
    } catch (e) {
      console.warn("Notification error:", e);
    }
  } else if (hasUpcoming) {
    try {
      await sendBrowserNotification("PiggyNest: Upcoming Bill Reminder ⏳", {
        body: "Due soon: " + upcomingNear.map((b) => `${b.name} (${fmt(b.amount)})`).join(", "),
        tag: "piggynest-due-upcoming",
      });
      localStorage.setItem("piggynest_last_dday_notif", todayKey);
      notifiedDDayToday = true;
    } catch (e) {
      console.warn("Notification error:", e);
    }
  }
}

window.addEventListener("focus", () => { checkDDayNotifications(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    checkDDayNotifications();
  }
});

function openNotifPromptDialog() {
  const dlg = $("#settingsDialog");
  if (!dlg) return;
  dlg.innerHTML = `
    <div class="dlg-body notif-setup-dlg">
      <div style="font-size:2.4rem;margin-bottom:8px;">🔔</div>
      <h2 style="margin:0 0 8px;">🔔 Stay on top of your bills!</h2>
      <p style="color:var(--ink-soft);font-size:0.92rem;line-height:1.45;margin:0 0 20px;">PiggyNest can notify you on D-Day when recurring bills and subscriptions are due so you never miss a payment.</p>
      <div class="notif-setup-actions">
        <button type="button" class="btn btn-primary" id="btnEnableNotif" data-act="enable-notif-prompt">Enable reminders</button>
        <button type="button" class="btn btn-ghost sm" id="btnDismissNotif" data-act="dismiss-notif-prompt">Maybe later</button>
      </div>
    </div>`;
  if (!dlg.open) dlg.showModal();
}

function checkPwaNotificationPrompt() {
  if (checkedPwaPrompt) return;
  if (!("Notification" in window)) return;
  if (Notification.permission !== "default") return;
  if (!isStandalonePwa()) return;
  if (localStorage.getItem("piggynest_notif_prompted")) return;

  checkedPwaPrompt = true;
  setTimeout(() => {
    const dlg = $("#settingsDialog");
    if (!dlg || dlg.open) return;
    openNotifPromptDialog();
  }, 600);
}

async function saveJars(jars) {
  state.jars = jars;
  localStorage.setItem("piggynest_jars", JSON.stringify(jars));
  if (state.db?.saveSettings && state.settings) {
    state.settings.jars = jars;
    await state.db.saveSettings({ ...state.settings, jars });
  }
}

async function logActivity(text, emoji = "💬") {
  const item = {
    id: uid(),
    text,
    emoji,
    time: Date.now(),
  };
  state.feed = [item, ...(state.feed || [])].slice(0, 30);
  localStorage.setItem("piggynest_activity_feed", JSON.stringify(state.feed));
  if (state.db?.saveSettings && state.settings) {
    state.settings.feed = state.feed;
    await state.db.saveSettings({ ...state.settings, feed: state.feed });
  }
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return "Recently";
  const seconds = Math.floor((Date.now() - Number(timestamp)) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function getCapState() {
  const { b } = budgetFor(state.year);
  const c = calc(b);
  return {
    annualBudget: c.total,
    categories: b.categories,
    year: state.year,
    expenses: state.expenses,
  };
}

function updateExpenseFormCapHint() {
  const f = $("#expForm");
  const alertEl = $("#catCapAlert");
  if (!f || !alertEl) return;

  if (!isPro(settings(), state.user)) {
    alertEl.innerHTML = `<span class="chip pro-lock-hint" data-act="open-pro" title="Unlock Smart Anomaly & Budget Cap Alerts with Pro">✨ PRO Cap Alerts</span>`;
    alertEl.classList.remove("hide");
    return;
  }

  const catId = f.categoryId?.value;
  if (!catId) {
    alertEl.classList.add("hide");
    return;
  }
  const capState = getCapState();
  const cap = calculateCategoryCap(catId, capState, state.month);
  if (cap.ratio >= 1.0) {
    alertEl.className = "cat-cap-hint-box cap-danger";
    alertEl.innerHTML = `🚨 Budget exceeded! (${fmt(cap.spent)} spent of ${fmt(cap.monthlyBudget)} monthly cap)`;
    alertEl.classList.remove("hide");
  } else if (cap.ratio >= 0.8) {
    alertEl.className = "cat-cap-hint-box cap-warn";
    alertEl.innerHTML = `⚠️ ${Math.round(cap.ratio * 100)}% of monthly budget used (${fmt(cap.spent)} / ${fmt(cap.monthlyBudget)})`;
    alertEl.classList.remove("hide");
  } else if (cap.ratio > 0) {
    alertEl.className = "cat-cap-hint-box cap-ok";
    alertEl.innerHTML = `✅ ${Math.round(cap.ratio * 100)}% of monthly budget used (${fmt(cap.spent)} / ${fmt(cap.monthlyBudget)})`;
    alertEl.classList.remove("hide");
  } else {
    alertEl.classList.add("hide");
  }
}

function downloadCsvFile(csvContent, filename) {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`📥 ${filename} downloaded!`);
}

function jarsSectionHtml() {
  const pro = isPro(settings(), state.user);
  if (!pro) {
    return `
      <section class="card jar-locked-section">
        <div class="jar-locked-overlay">
          <div class="pro-lock-badge">🏺 ✨ PIGGY PRO</div>
          <h3>Sinking Funds & Goal Jars</h3>
          <p>Create visual buckets for Bali trips, car maintenance, holiday gifts, and emergency reserves with automatic monthly pace planning.</p>
          <div class="jar-mock-row">
            <div class="jar-mock-pill">✈️ Bali Trip · 65%</div>
            <div class="jar-mock-pill">🚗 Car Service · $250/mo pace</div>
            <div class="jar-mock-pill">🛡️ Emergency Fund · $10k</div>
          </div>
          <button type="button" class="btn btn-primary pro-upgrade-btn" data-act="open-pro">
            ✨ Unlock Piggy Jars with Pro
          </button>
        </div>
      </section>`;
  }

  const jars = state.jars || [];
  const jarsList = jars.map((jar) => {
    const prog = calculateJarProgress(jar);
    const pace = calculateJarPace(jar, jar.targetDate);
    return `
      <article class="card jar-card">
        <div class="jar-card-head">
          <div class="jar-badge">${esc(jar.icon || "🏺")}</div>
          <div class="jar-info">
            <h3 class="jar-name">${esc(jar.name)}</h3>
            ${jar.targetDate ? `<small class="jar-target-date">📅 Target: ${esc(jar.targetDate)}</small>` : ""}
          </div>
          <div class="jar-card-tools">
            <button type="button" class="icon-btn sm" data-act="edit-jar" data-id="${esc(jar.id)}" title="Edit jar">✏️</button>
            <button type="button" class="icon-btn sm" data-act="del-jar" data-id="${esc(jar.id)}" title="Delete jar">🗑️</button>
          </div>
        </div>
        <div class="jar-amounts">
          <span class="jar-saved"><b>${fmt(prog.current)}</b> saved</span>
          <small class="jar-target">of ${fmt(prog.target)} target</small>
          <span class="chip ${prog.isCompleted ? "gain-pos" : ""}">${Math.round(prog.percentage)}%</span>
        </div>
        <div class="meter"><i class="${prog.isCompleted ? "goal-done" : ""}" style="width:${prog.percentage}%"></i></div>
        <div class="jar-footer">
          <small class="jar-pace ${prog.isCompleted ? "pos" : ""}">${prog.isCompleted ? "🎉 Goal reached!" : `${fmt(prog.remaining)} left · Need ${fmt(pace.monthlyPace)}/mo (${pace.monthsRemaining} mos)`}</small>
        </div>
        <div class="jar-actions">
          <button type="button" class="btn btn-soft sm" data-act="add-jar-money" data-id="${esc(jar.id)}">➕ Add Money</button>
          <button type="button" class="btn btn-ghost sm" data-act="withdraw-jar-money" data-id="${esc(jar.id)}">➖ Withdraw</button>
        </div>
      </article>`;
  }).join("");

  return `
    <section class="card jars-section">
      <div class="jars-head">
        <div class="jars-title">
          <span class="jars-icon">🏺</span>
          <h2>Piggy Jars (Goal Buckets)</h2>
        </div>
        <button type="button" class="btn btn-primary sm" data-act="new-jar">＋ New Jar</button>
      </div>
      <p class="jars-sub">Separate sinking funds for dream vacations, car repairs, rainy days & couple goals.</p>
      ${jars.length ? `<div class="jars-grid">${jarsList}</div>` : `<div class="empty-jars"><p>No goal jars created yet. Tap "+ New Jar" to create a bucket for vacations, gifts, or emergencies!</p></div>`}
    </section>`;
}

function activityFeedHtml() {
  const pro = isPro(settings(), state.user);
  if (!pro) {
    return `
      <section class="card feed-card feed-locked-card">
        <div class="feed-head" data-act="open-pro">
          <div class="feed-title">
            <span>💬</span>
            <h3>Partner Activity Feed</h3>
            <span class="chip pro-chip">✨ PRO</span>
          </div>
          <button type="button" class="btn btn-ghost sm" data-act="open-pro" style="font-size:0.75rem;">Unlock</button>
        </div>
        <div class="feed-locked-preview">
          <p>Get real-time updates when your partner logs spending, tops up a piggy jar, or reacts to an expense.</p>
        </div>
      </section>`;
  }

  const feed = state.feed || [];
  const isOpen = state.feedOpen !== false;
  return `
    <section class="card feed-card">
      <div class="feed-head" data-act="toggle-feed">
        <div class="feed-title">
          <span>💬</span>
          <h3>Partner Activity Feed</h3>
          <span class="chip">${feed.length} updates</span>
        </div>
        <span class="feed-toggle-icon">${isOpen ? "▲" : "▼"}</span>
      </div>
      ${isOpen ? `
        <div class="feed-list">
          ${feed.length ? feed.slice(0, 8).map((item) => `
            <div class="feed-item">
              <span class="feed-item-icon">${item.emoji || "💬"}</span>
              <div class="feed-item-main">
                <p>${esc(item.text)}</p>
                <small>${formatTimeAgo(item.time)}</small>
              </div>
            </div>
          `).join("") : `<small style="color:var(--ink-soft);padding:8px 0;display:block;">No activity logged yet. Add an expense or update a jar to see real-time partner activity!</small>`}
        </div>
      ` : ""}
    </section>`;
}

function openJarModal(jarId = null) {
  const jar = jarId ? (state.jars || []).find((j) => j.id === jarId) : null;
  const dlg = $("#settingsDialog");
  if (!dlg) return;
  dlg.innerHTML = `
    <div class="dlg-body">
      <h2>${jar ? "Edit Piggy Jar" : "New Piggy Jar 🏺"}</h2>
      <p style="color:var(--ink-soft);font-size:0.9rem;margin-top:-4px;">Create a goal bucket for a specific purchase, trip, or emergency fund.</p>
      <form id="jarForm" data-id="${esc(jar?.id || "")}" autocomplete="off">
        <label>Jar Name
          <input name="name" maxlength="40" required placeholder="e.g. Bali Vacation, Car Service, Emergency Fund" value="${esc(jar?.name || "")}">
        </label>
        <div class="two-col-inline">
          <label>Emoji / Icon
            <input name="icon" maxlength="4" style="text-align:center;" value="${esc(jar?.icon || "🏺")}">
          </label>
          <label>Target Date <small>(optional)</small>
            <input name="targetDate" type="date" value="${jar?.targetDate || ""}">
          </label>
        </div>
        <div class="two-col-inline">
          <label>Target Amount
            <input name="targetAmount" type="text" inputmode="decimal" required placeholder="0" value="${jar ? formatNumberInput(jar.targetAmount) : ""}">
          </label>
          <label>Current Saved
            <input name="currentAmount" type="text" inputmode="decimal" placeholder="0" value="${jar ? formatNumberInput(jar.currentAmount) : "0"}">
          </label>
        </div>
        <div class="dlg-actions">
          <button type="button" class="btn btn-ghost" data-act="close-settings">Cancel</button>
          <button type="submit" class="btn btn-primary">${jar ? "Save Jar" : "Create Jar"}</button>
        </div>
      </form>
    </div>`;
  if (!dlg.open) dlg.showModal();
}

function openJarMoneyModal(jarId, mode = "add") {
  const jar = (state.jars || []).find((j) => j.id === jarId);
  if (!jar) return;
  const dlg = $("#settingsDialog");
  if (!dlg) return;
  const isAdd = mode === "add";
  dlg.innerHTML = `
    <div class="dlg-body">
      <h2>${isAdd ? "➕ Add Money to Jar" : "➖ Withdraw from Jar"}</h2>
      <p style="color:var(--ink-soft);font-size:0.9rem;margin-top:-4px;">${esc(jar.icon || "🏺")} <b>${esc(jar.name)}</b> (Currently saved: <b>${fmt(jar.currentAmount || 0)}</b> of ${fmt(jar.targetAmount || 0)})</p>
      <form id="jarMoneyForm" data-id="${esc(jar.id)}" data-mode="${mode}" autocomplete="off">
        <label>Amount to ${isAdd ? "add" : "withdraw"}
          <input name="amount" type="text" inputmode="decimal" required placeholder="0" autofocus>
        </label>
        <div class="dlg-actions">
          <button type="button" class="btn btn-ghost" data-act="close-settings">Cancel</button>
          <button type="submit" class="btn btn-primary">${isAdd ? "Add to Jar" : "Withdraw"}</button>
        </div>
      </form>
    </div>`;
  if (!dlg.open) dlg.showModal();
}

function openReactionPicker(expenseId) {
  const exp = state.expenses.find((x) => x.id === expenseId);
  if (!exp) return;
  const emojis = ["❤️", "👏", "😂", "😱", "💸"];
  const dlg = $("#settingsDialog");
  if (!dlg) return;
  const s = settings();
  const myKey = state.lastPaidBy === "p2" ? "p2" : "p1";
  const myName = myKey === "p2" ? s.persons[1].name : s.persons[0].name;
  dlg.innerHTML = `
    <div class="dlg-body" style="text-align:center;max-width:320px;">
      <h3 style="margin:0 0 4px;">React as ${esc(myName)}</h3>
      <p style="color:var(--ink-soft);font-size:0.85rem;margin:0 0 16px;">${esc(exp.note || "Expense")} (${fmt(exp.amount)})</p>
      <div class="reaction-emoji-bar">
        ${emojis.map((em) => `
          <button type="button" class="reaction-emoji-btn ${(exp.reactions?.[myKey] === em) ? "active" : ""}" data-act="select-reaction" data-id="${esc(exp.id)}" data-emoji="${em}">
            ${em}
          </button>
        `).join("")}
      </div>
      <div style="margin-top:16px;">
        <button type="button" class="btn btn-ghost sm" data-act="close-settings">Close</button>
      </div>
    </div>`;
  if (!dlg.open) dlg.showModal();
}

function paymentBadgeHtml(e) {
  const pm = e.paymentMethod || "cash";
  if (pm === "credit_card") {
    return `<span class="chip exp-pm-tag pm-credit">💳 ${esc(e.cardName || "Credit Card")}</span>`;
  }
  if (pm === "installment") {
    const c = e.installmentCurrent || 1;
    const m = e.installmentMonths || 12;
    const namePrefix = e.cardName ? `${esc(e.cardName)} ` : "";
    return `<span class="chip exp-pm-tag pm-installment">⏳ ${namePrefix}${c}/${m} mo</span>`;
  }
  return `<span class="chip exp-pm-tag pm-cash">💵 Cash</span>`;
}

function updateKnownCardNames() {
  const dl = $("#knownCardNames");
  if (!dl) return;
  const set = new Set();
  (state.expenses || []).forEach((e) => { if (e.cardName) set.add(e.cardName.trim()); });
  (state.recurring || []).forEach((r) => { if (r.cardName) set.add(r.cardName.trim()); });
  dl.innerHTML = [...set].sort().map((name) => `<option value="${esc(name)}">`).join("");
}
let unsubscribe = null;

function detectCurrency() {
  const lang = navigator.language || "en-US";
  const region = (lang.split("-")[1] || "").toUpperCase();
  const map = { ID: "IDR", GB: "GBP", AU: "AUD", CA: "CAD", SG: "SGD", MY: "MYR", JP: "JPY", KR: "KRW", IN: "INR", PH: "PHP", TH: "THB", VN: "VND", CN: "CNY",
    DE: "EUR", FR: "EUR", ES: "EUR", IT: "EUR", NL: "EUR", PT: "EUR", IE: "EUR", AT: "EUR", BE: "EUR", FI: "EUR" };
  if (map[region]) return map[region];
  if (lang.toLowerCase() === "id") return "IDR";
  return "USD";
}

const DEFAULT_SETTINGS = {
  familyName: "Our Cozy Family",
  currency: detectCurrency(),
  savingsGoal: 0,
  theme: "default",
  mascot: "piggy",
  pro: false,
  proUntil: null,
  subscriptionId: null,
  trialUsed: false,
  persons: [
    { id: "p1", name: "Mommy", emoji: "🌸" },
    { id: "p2", name: "Daddy", emoji: "🌿" },
  ],
};

function settings() {
  const s = state.settings || {};
  const persons = Array.isArray(s.persons) && s.persons.length === 2 ? s.persons : DEFAULT_SETTINGS.persons;
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    savingsGoal: Number(s.savingsGoal) || 0,
    theme: s.theme || "default",
    mascot: s.mascot || "piggy",
    pro: Boolean(s.pro || false),
    proUntil: s.proUntil || null,
    subscriptionId: s.subscriptionId || null,
    trialUsed: Boolean(s.trialUsed || false),
    persons,
  };
}

function triggerConfetti() {
  const emojis = ["🎉", "✨", "👑", "💖", "🪙", "⭐", "💎", "🌸"];
  const count = 35;
  for (let i = 0; i < count; i++) {
    const el = document.createElement("div");
    el.className = "confetti-particle";
    el.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    el.style.left = `${50 + (Math.random() * 20 - 10)}vw`;
    el.style.top = `${50 + (Math.random() * 20 - 10)}vh`;
    const angle = Math.random() * 2 * Math.PI;
    const dist = 120 + Math.random() * 280;
    const tx = Math.cos(angle) * dist;
    const ty = Math.sin(angle) * dist - 80;
    const rot = `${Math.random() * 720 - 360}deg`;
    el.style.setProperty("--tx", `${tx}px`);
    el.style.setProperty("--ty", `${ty}px`);
    el.style.setProperty("--rot", rot);
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2400);
  }
}

function proBadgeHtml(s) {
  if (isAdmin(state.user)) {
    return `<span class="pro-badge admin" data-act="open-pro" role="button" tabindex="0">👑 ADMIN</span>`;
  }
  if (isPro(s, state.user)) {
    const days = getProRemainingDays(s);
    if (days !== null && days > 0 && !s.subscriptionId) {
      return `<button type="button" class="pro-badge active" data-act="open-pro">👑 PRO MEMBER (${days}d)</button>`;
    }
    return `<button type="button" class="pro-badge active" data-act="open-pro">👑 PRO MEMBER</button>`;
  }
  return `<button type="button" class="pro-badge upgrade-trigger" data-act="open-pro">✨ Upgrade to Pro</button>`;
}

function applyTheme(themeId) {
  const theme = themeId || "default";
  document.documentElement.dataset.theme = theme;
}


// The budget for a year. If that year has no saved plan yet, carry over the latest earlier year.
function budgetFor(year) {
  const saved = state.budgets[String(year)];
  if (saved) return { b: normalizeBudget(saved), exists: true, carried: null };
  const prev = Object.keys(state.budgets).map(Number).filter((y) => y < year).sort((a, b) => b - a)[0];
  if (prev !== undefined) {
    const b = normalizeBudget(state.budgets[String(prev)]);
    b.year = year;
    return { b, exists: false, carried: prev };
  }
  return { b: defaultBudget(year), exists: false, carried: null };
}

function getDraft() {
  if (!state.draft || state.draft.year !== state.year) {
    state.draft = { year: state.year, b: clone(budgetFor(state.year).b) };
    state.dirty = false;
  }
  return state.draft;
}

/* ================================================================== */
/* Money + calculations                                                */
/* ================================================================== */
const fmtCache = {};
function fmt(n) {
  const cur = settings().currency;
  fmtCache[cur] ??= new Intl.NumberFormat(undefined, {
    style: "currency", currency: cur, minimumFractionDigits: 0, maximumFractionDigits: ZERO_DECIMAL.has(cur) ? 0 : 2,
  });
  return fmtCache[cur].format(Number(n) || 0);
}
const compactFmt = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const compact = (n) => (n ? compactFmt.format(n) : "·");

const spendIndex = (year) => calcSpendIndex(year, state.expenses);

/* ================================================================== */
/* Rendering: shell                                                    */
/* ================================================================== */
// Navigation tabs:
// - home: Dashboard overview with remaining monthly budget and category cards
// - expenses: Log, view, search, edit, and delete expense transactions
// - budget: Configure yearly income, category percentage allocations, and split ratios
// - invest: Track investment holdings and family assets
// - year: Annual financial charts and month-by-month spending breakdown
const TABS = [
  ["home", "🏡", "Home"],
  ["expenses", "🧾", "Expenses"],
  ["budget", "🎯", "Budget"],
  ["invest", "📈", "Invest"],
  ["year", "📅", "Year"],
];

const ready = () => state.loaded.settings && state.loaded.budgets && state.loaded.expenses && state.loaded.recurring;

function render() {
  const root = $("#app");
  if (!state.db) {
    const mascot = getMascot(settings().mascot);
    root.innerHTML = splash(mascot.emoji, `Waking up ${mascot.name}…`);
  } else if (!state.user) {
    root.innerHTML = authHtml();
  } else if (!ready()) {
    root.innerHTML = splash("🪙", "Counting coins…");
  } else {
    root.innerHTML = shellHtml();
    renderView();
  }
}

const splash = (emoji, text) => `<div class="splash"><div class="big">${emoji}</div><p>${esc(text)}</p></div>`;

function yearOptions() {
  const years = new Set([now.getFullYear() - 2, now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1, state.year]);
  Object.keys(state.budgets).forEach((y) => years.add(Number(y)));
  state.expenses.forEach((e) => e.date && years.add(Number(e.date.slice(0, 4))));
  return [...years].filter(Boolean).sort().map((y) => `<option value="${y}" ${y === state.year ? "selected" : ""}>${y}</option>`).join("");
}

function shellHtml() {
  const s = settings();
  const showMonth = state.tab === "home" || state.tab === "expenses";
  return `
    ${state.db.mode === "local" ? `<div class="demo-bar">🧸 Demo mode: your data stays in this browser. Add your Firebase config to sync across devices.</div>` : ""}
    <header class="topbar">
      <div class="brand">
        <span class="brand-pig">${esc(getMascot(s.mascot).emoji)}</span>
        <div><b>${esc(s.familyName)}</b><small>PiggyNest</small></div>
        ${proBadgeHtml(s)}
      </div>
      <div class="controls">
        <select id="yearSel" aria-label="Year">${yearOptions()}</select>
        <select id="monthSel" aria-label="Month" class="${showMonth ? "" : "hide"}">
          ${MONTHS_LONG.map((m, i) => `<option value="${i}" ${i === state.month ? "selected" : ""}>${m}</option>`).join("")}
        </select>
        <button class="icon-btn" data-act="open-settings" title="Family settings" aria-label="Family settings">⚙️</button>
        ${state.db.mode === "firebase" ? `<button class="icon-btn" data-act="signout" title="Sign out" aria-label="Sign out">👋</button>` : ""}
      </div>
    </header>
    <nav class="tabs" aria-label="Sections">
      ${TABS.map(([id, emoji, label]) => `<button class="tab ${state.tab === id ? "active" : ""}" data-act="tab" data-tab="${id}"><span>${emoji}</span><span>${label}</span>${id === "budget" && state.dirty ? `<i class="dot" title="Unsaved changes"></i>` : ""}</button>`).join("")}
    </nav>
    <main id="view" class="view"></main>`;
}

function autosize(t) {
  t.style.height = "auto";
  t.style.height = t.scrollHeight + 2 + "px";
}

function renderView() {
  const v = $("#view");
  if (!v) return;
  const builders = { home: homeHtml, expenses: expensesHtml, budget: budgetHtml, invest: investHtml, year: yearHtml };
  v.innerHTML = builders[state.tab]();
  if (state.tab === "expenses") {
    initExpenseForm();
    updateExpenseList();
  }
  if (state.tab === "budget") {
    updateBudgetDerived();
    $$(".name-in").forEach(autosize);
  }
}

function setTab(tab) {
  state.tab = tab;
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  $("#monthSel")?.classList.toggle("hide", !(tab === "home" || tab === "expenses"));
  renderView();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function refreshDirtyDot() {
  const btn = $(`.tab[data-tab="budget"]`);
  if (!btn) return;
  let dot = $(".dot", btn);
  if (state.dirty && !dot) btn.insertAdjacentHTML("beforeend", `<i class="dot" title="Unsaved changes"></i>`);
  if (!state.dirty && dot) dot.remove();
}

/* ================================================================== */
/* Rendering: Home (monthly dashboard)                                 */
/* ================================================================== */
function piggySvg(level, mad = false) {
  const lv = Math.max(0, Math.min(1, level));
  const y = (137 - lv * 104).toFixed(1);
  const ya = (y - 7).toFixed(1);
  const skin = mad ? "#ff9ea6" : "#ff9ebb";
  const outline = mad ? "#f2535f" : "#ff8fb1";
  const label = mad ? "Angry piggy bank: this month is over budget" : `Piggy bank, ${Math.round(lv * 100)}% of this month's budget left`;
  const fill = mad ? "" : `<g clip-path="url(#pigBody)"><path d="M0 ${y} Q25 ${ya} 50 ${y} T100 ${y} T150 ${y} T200 ${y} V160 H0 Z" fill="${skin}"/></g>`;
  const steam = mad ? `
    <g class="steam"><circle cx="50" cy="4" r="6"/><circle cx="40" cy="-8" r="4"/></g>
    <g class="steam s2"><circle cx="128" cy="0" r="6"/><circle cx="138" cy="-11" r="4"/></g>
    <text x="156" y="46" font-size="22">💢</text>` : "";
  const face = mad
    ? `<ellipse cx="132" cy="92" rx="11" ry="7" fill="#f2535f" opacity=".45"/>
       <circle cx="142" cy="73" r="4.6" fill="#4f3d5c"/>
       <path d="M129 60 L153 69" stroke="#4f3d5c" stroke-width="4.5" stroke-linecap="round"/>`
    : `<circle cx="142" cy="72" r="5" fill="#4f3d5c"/><circle cx="143.6" cy="70.4" r="1.7" fill="#fff"/>
       <ellipse cx="132" cy="92" rx="9" ry="6" fill="#ff7a9c" opacity=".4"/>`;
  const mouth = mad ? `<path d="M162 104 q8 -7 16 0" fill="none" stroke="#7a5a8a" stroke-width="3.5" stroke-linecap="round"/>` : "";
  return `
  <svg class="piggy ${mad ? "mad" : ""}" viewBox="0 -16 220 176" role="img" aria-label="${label}">
    <defs><clipPath id="pigBody"><ellipse cx="100" cy="86" rx="72" ry="52"/></clipPath></defs>
    ${steam}
    <path d="M62 50 L54 16 Q76 20 90 40 Z" fill="${skin}"/>
    <path d="M108 38 L124 12 Q142 22 140 48 Z" fill="${skin}"/>
    <rect x="52" y="120" width="26" height="30" rx="11" fill="${skin}"/>
    <rect x="118" y="120" width="26" height="30" rx="11" fill="${skin}"/>
    <path d="M30 80 q-22 -6 -15 -23 q7 -12 15 -2" fill="none" stroke="${skin}" stroke-width="6" stroke-linecap="round"/>
    <ellipse cx="100" cy="86" rx="72" ry="52" fill="${mad ? "#ffd3d8" : "#ffeef4"}"/>
    ${fill}
    <ellipse cx="100" cy="86" rx="72" ry="52" fill="none" stroke="${outline}" stroke-width="4"/>
    <rect x="80" y="38" width="40" height="7" rx="3.5" fill="#7a5a8a"/>
    <ellipse cx="170" cy="92" rx="20" ry="16" fill="${mad ? "#ff9ea6" : "#ffb3cb"}" stroke="${outline}" stroke-width="4"/>
    <circle cx="164" cy="92" r="3" fill="#7a5a8a"/><circle cx="176" cy="92" r="3" fill="#7a5a8a"/>
    ${mouth}
    ${face}
  </svg>`;
}

function catSvg(level, mad = false) {
  const lv = Math.max(0, Math.min(1, level));
  const y = (137 - lv * 104).toFixed(1);
  const ya = (y - 7).toFixed(1);
  const skin = mad ? "#ffb4ba" : "#fbe5d8";
  const outline = mad ? "#f2535f" : "#e09f67";
  const label = mad ? "Angry Mochi the Cat: this month is over budget" : `Mochi the Cat, ${Math.round(lv * 100)}% of this month's budget left`;
  const fill = mad ? "" : `<g clip-path="url(#catBody)"><path d="M0 ${y} Q25 ${ya} 50 ${y} T100 ${y} T150 ${y} T200 ${y} V160 H0 Z" fill="${skin}"/></g>`;
  const steam = mad ? `
    <g class="steam"><circle cx="50" cy="4" r="6"/><circle cx="40" cy="-8" r="4"/></g>
    <g class="steam s2"><circle cx="128" cy="0" r="6"/><circle cx="138" cy="-11" r="4"/></g>
    <text x="156" y="46" font-size="22">💢</text>` : "";
  const face = mad
    ? `<ellipse cx="130" cy="92" rx="10" ry="6" fill="#f2535f" opacity=".45"/>
       <ellipse cx="166" cy="92" rx="10" ry="6" fill="#f2535f" opacity=".45"/>
       <circle cx="136" cy="74" r="4.6" fill="#4f3d5c"/>
       <circle cx="160" cy="74" r="4.6" fill="#4f3d5c"/>
       <path d="M124 64 L144 71" stroke="#4f3d5c" stroke-width="4" stroke-linecap="round"/>
       <path d="M172 64 L152 71" stroke="#4f3d5c" stroke-width="4" stroke-linecap="round"/>
       <path d="M148 94 q-4 6 -8 2" fill="none" stroke="#7a5a8a" stroke-width="3" stroke-linecap="round"/>
       <path d="M148 94 q4 6 8 2" fill="none" stroke="#7a5a8a" stroke-width="3" stroke-linecap="round"/>`
    : `<ellipse cx="128" cy="92" rx="9" ry="6" fill="#ff7a9c" opacity=".4"/>
       <ellipse cx="168" cy="92" rx="9" ry="6" fill="#ff7a9c" opacity=".4"/>
       <circle cx="136" cy="74" r="5" fill="#4f3d5c"/><circle cx="137.6" cy="72.4" r="1.7" fill="#fff"/>
       <circle cx="160" cy="74" r="5" fill="#4f3d5c"/><circle cx="161.6" cy="72.4" r="1.7" fill="#fff"/>
       <polygon points="145,86 151,86 148,90" fill="#ff7a9c"/>
       <path d="M144 91 q4 4 4 1 q0 3 4 -1" fill="none" stroke="#7a5a8a" stroke-width="3" stroke-linecap="round"/>`;
  const whiskers = `
    <path d="M120 86 L98 83 M120 92 L96 95" stroke="#4f3d5c" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M176 86 L198 83 M176 92 L200 95" stroke="#4f3d5c" stroke-width="2.5" stroke-linecap="round"/>`;
  return `
  <svg class="piggy ${mad ? "mad" : ""}" viewBox="0 -16 220 176" role="img" aria-label="${label}">
    <defs><clipPath id="catBody"><ellipse cx="100" cy="86" rx="72" ry="52"/></clipPath></defs>
    ${steam}
    <polygon points="52,56 42,12 80,36" fill="${skin}"/>
    <polygon points="54,50 48,22 74,38" fill="#ffb4cb"/>
    <polygon points="106,34 144,12 134,56" fill="${skin}"/>
    <polygon points="112,38 138,22 132,50" fill="#ffb4cb"/>
    <rect x="52" y="120" width="26" height="30" rx="11" fill="${skin}"/>
    <rect x="118" y="120" width="26" height="30" rx="11" fill="${skin}"/>
    <path d="M30 84 q-20 -10 -14 -28 q6 -14 16 -4" fill="none" stroke="${skin}" stroke-width="8" stroke-linecap="round"/>
    <ellipse cx="100" cy="86" rx="72" ry="52" fill="${mad ? "#ffd3d8" : "#fff6f0"}"/>
    ${fill}
    <ellipse cx="100" cy="86" rx="72" ry="52" fill="none" stroke="${outline}" stroke-width="4"/>
    <polygon points="52,56 42,12 80,36" fill="none" stroke="${outline}" stroke-width="3.5" stroke-linejoin="round"/>
    <polygon points="106,34 144,12 134,56" fill="none" stroke="${outline}" stroke-width="3.5" stroke-linejoin="round"/>
    <rect x="80" y="38" width="40" height="7" rx="3.5" fill="#7a5a8a"/>
    ${whiskers}
    ${face}
  </svg>`;
}

function bearSvg(level, mad = false) {
  const lv = Math.max(0, Math.min(1, level));
  const y = (137 - lv * 104).toFixed(1);
  const ya = (y - 7).toFixed(1);
  const skin = mad ? "#e29587" : "#c69c6d";
  const outline = mad ? "#d04f44" : "#996b42";
  const label = mad ? "Angry Boba the Bear: this month is over budget" : `Boba the Bear, ${Math.round(lv * 100)}% of this month's budget left`;
  const fill = mad ? "" : `<g clip-path="url(#bearBody)"><path d="M0 ${y} Q25 ${ya} 50 ${y} T100 ${y} T150 ${y} T200 ${y} V160 H0 Z" fill="${skin}"/></g>`;
  const steam = mad ? `
    <g class="steam"><circle cx="50" cy="4" r="6"/><circle cx="40" cy="-8" r="4"/></g>
    <g class="steam s2"><circle cx="128" cy="0" r="6"/><circle cx="138" cy="-11" r="4"/></g>
    <text x="156" y="46" font-size="22">💢</text>` : "";
  const face = mad
    ? `<ellipse cx="128" cy="90" rx="9" ry="6" fill="#f2535f" opacity=".45"/>
       <circle cx="140" cy="73" r="4.6" fill="#4f3d5c"/>
       <path d="M128 62 L148 70" stroke="#4f3d5c" stroke-width="4.5" stroke-linecap="round"/>
       <ellipse cx="160" cy="90" rx="18" ry="14" fill="#faeed9"/>
       <ellipse cx="162" cy="85" rx="6" ry="4" fill="#4f3d5c"/>
       <path d="M162 89 v4 m-5 1 q5 4 10 0" fill="none" stroke="#4f3d5c" stroke-width="2.5" stroke-linecap="round"/>`
    : `<ellipse cx="128" cy="90" rx="8" ry="5" fill="#ff7a9c" opacity=".4"/>
       <circle cx="140" cy="72" r="5" fill="#4f3d5c"/><circle cx="141.6" cy="70.4" r="1.7" fill="#fff"/>
       <ellipse cx="160" cy="90" rx="18" ry="14" fill="#faeed9"/>
       <ellipse cx="162" cy="85" rx="6" ry="4" fill="#4f3d5c"/>
       <path d="M162 89 v3 m-4 2 q4 3 8 0" fill="none" stroke="#4f3d5c" stroke-width="2.5" stroke-linecap="round"/>`;
  return `
  <svg class="piggy ${mad ? "mad" : ""}" viewBox="0 -16 220 176" role="img" aria-label="${label}">
    <defs><clipPath id="bearBody"><ellipse cx="100" cy="86" rx="72" ry="52"/></clipPath></defs>
    ${steam}
    <circle cx="60" cy="38" r="22" fill="${skin}"/>
    <circle cx="60" cy="38" r="13" fill="#faeed9"/>
    <circle cx="120" cy="34" r="22" fill="${skin}"/>
    <circle cx="120" cy="34" r="13" fill="#faeed9"/>
    <circle cx="60" cy="38" r="22" fill="none" stroke="${outline}" stroke-width="4"/>
    <circle cx="120" cy="34" r="22" fill="none" stroke="${outline}" stroke-width="4"/>
    <rect x="52" y="120" width="26" height="30" rx="11" fill="${skin}"/>
    <rect x="118" y="120" width="26" height="30" rx="11" fill="${skin}"/>
    <circle cx="32" cy="86" r="12" fill="${skin}" stroke="${outline}" stroke-width="4"/>
    <ellipse cx="100" cy="86" rx="72" ry="52" fill="${mad ? "#ffd7cf" : "#f5e8d8"}"/>
    ${fill}
    <ellipse cx="100" cy="86" rx="72" ry="52" fill="none" stroke="${outline}" stroke-width="4"/>
    <rect x="80" y="38" width="40" height="7" rx="3.5" fill="#7a5a8a"/>
    ${face}
  </svg>`;
}

function bunnySvg(level, mad = false) {
  const lv = Math.max(0, Math.min(1, level));
  const y = (137 - lv * 104).toFixed(1);
  const ya = (y - 7).toFixed(1);
  const skin = mad ? "#ffb6be" : "#e6d7ed";
  const outline = mad ? "#f2535f" : "#bca0c9";
  const label = mad ? "Angry Bunny: this month is over budget" : `Bunny, ${Math.round(lv * 100)}% of this month's budget left`;
  const fill = mad ? "" : `<g clip-path="url(#bunnyBody)"><path d="M0 ${y} Q25 ${ya} 50 ${y} T100 ${y} T150 ${y} T200 ${y} V160 H0 Z" fill="${skin}"/></g>`;
  const steam = mad ? `
    <g class="steam"><circle cx="50" cy="4" r="6"/><circle cx="40" cy="-8" r="4"/></g>
    <g class="steam s2"><circle cx="128" cy="0" r="6"/><circle cx="138" cy="-11" r="4"/></g>
    <text x="156" y="46" font-size="22">💢</text>` : "";
  const face = mad
    ? `<ellipse cx="130" cy="92" rx="10" ry="6" fill="#f2535f" opacity=".45"/>
       <circle cx="140" cy="73" r="4.6" fill="#4f3d5c"/>
       <path d="M128 62 L148 70" stroke="#4f3d5c" stroke-width="4.5" stroke-linecap="round"/>
       <polygon points="160,86 166,86 163,90" fill="#f2535f"/>
       <path d="M163 90 v3 m-3 2 q3 3 6 0" fill="none" stroke="#7a5a8a" stroke-width="2.5" stroke-linecap="round"/>`
    : `<ellipse cx="130" cy="92" rx="9" ry="6" fill="#ff7a9c" opacity=".4"/>
       <circle cx="140" cy="72" r="5" fill="#4f3d5c"/><circle cx="141.6" cy="70.4" r="1.7" fill="#fff"/>
       <polygon points="160,86 166,86 163,90" fill="#ff7a9c"/>
       <path d="M163 90 v3 m-4 2 q4 3 8 0" fill="none" stroke="#7a5a8a" stroke-width="2.5" stroke-linecap="round"/>`;
  return `
  <svg class="piggy ${mad ? "mad" : ""}" viewBox="0 -16 220 176" role="img" aria-label="${label}">
    <defs><clipPath id="bunnyBody"><ellipse cx="100" cy="86" rx="72" ry="52"/></clipPath></defs>
    ${steam}
    <ellipse cx="68" cy="14" rx="13" ry="34" transform="rotate(-8 68 14)" fill="${skin}"/>
    <ellipse cx="68" cy="14" rx="7" ry="24" transform="rotate(-8 68 14)" fill="#ffb4cb"/>
    <ellipse cx="114" cy="12" rx="13" ry="34" transform="rotate(8 114 12)" fill="${skin}"/>
    <ellipse cx="114" cy="12" rx="7" ry="24" transform="rotate(8 114 12)" fill="#ffb4cb"/>
    <ellipse cx="68" cy="14" rx="13" ry="34" transform="rotate(-8 68 14)" fill="none" stroke="${outline}" stroke-width="3.5"/>
    <ellipse cx="114" cy="12" rx="13" ry="34" transform="rotate(8 114 12)" fill="none" stroke="${outline}" stroke-width="3.5"/>
    <rect x="52" y="120" width="26" height="30" rx="11" fill="${skin}"/>
    <rect x="118" y="120" width="26" height="30" rx="11" fill="${skin}"/>
    <circle cx="30" cy="86" r="13" fill="${skin}" stroke="${outline}" stroke-width="3.5"/>
    <ellipse cx="100" cy="86" rx="72" ry="52" fill="${mad ? "#ffd3d8" : "#faf5fb"}"/>
    ${fill}
    <ellipse cx="100" cy="86" rx="72" ry="52" fill="none" stroke="${outline}" stroke-width="4"/>
    <rect x="80" y="38" width="40" height="7" rx="3.5" fill="#7a5a8a"/>
    ${face}
  </svg>`;
}

function renderMascotSvg(mascotId = "piggy", level = 0, mad = false) {
  if (mascotId === "cat") return catSvg(level, mad);
  if (mascotId === "bear") return bearSvg(level, mad);
  if (mascotId === "bunny") return bunnySvg(level, mad);
  return piggySvg(level, mad);
}

function homeHtml() {
  const s = settings();
  const { b, exists, carried } = budgetFor(state.year);
  const c = calc(b);
  const idx = spendIndex(state.year);
  const m = state.month;
  const monthBudget = c.total / 12;
  const spent = idx.months[m].total;
  const left = monthBudget - spent;
  const pct = monthBudget > 0 ? (spent / monthBudget) * 100 : 0;
  const mad = monthBudget > 0 && spent > monthBudget + 0.005;
  const mascot = getMascot(s.mascot);

  let msg;
  if (c.total <= 0) msg = "Add your yearly income in Budget and I'll split it into months for you.";
  else if (spent === 0) msg = "A fresh month. Nothing spent yet.";
  else if (pct < 70) msg = "Looking good. You're well within this month's budget.";
  else if (pct <= 100) msg = "Getting close to the monthly limit. Spend gently.";
  else msg = `Grr! Over budget by ${fmt(spent - monthBudget)}. ${mascot.name} is not happy.`;

  const notice = !exists
    ? `<div class="notice"><span>${carried ? `No saved plan for ${state.year} yet. Showing ${carried}'s plan.` : `No budget saved for ${state.year} yet.`}</span><button class="btn btn-soft" data-act="tab" data-tab="budget">Set up ${state.year} budget</button></div>`
    : "";

  const sampleBtn = state.db.mode === "local" && !state.expenses.length && !Object.keys(state.budgets).length
    ? `<div class="notice"><span>Want a quick look around? Fill the app with sample data.</span><button class="btn btn-primary" data-act="sample">Load sample data</button></div>` : "";

  const pending = findPendingRecurringBills(state.recurring, state.expenses, state.year, state.month);
  const totalPending = pending.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const recurringBanner = pending.length > 0
    ? `
      <div class="notice notice-recurring">
        <div class="notice-recurring-info">
          <b>📅 ${pending.length} recurring bill${pending.length > 1 ? "s" : ""} pending for this month</b>
          <small>Total ${fmt(totalPending)} (${pending.map((p) => esc(p.name)).join(", ")})</small>
        </div>
        <div class="notice-recurring-actions">
          <button class="btn btn-primary sm" data-act="log-recurring-all">Log all bills</button>
        </div>
      </div>`
    : "";

  const dueAlerts = getDueRecurringAlerts(state.recurring, state.expenses, new Date());
  const dueTotalCount = (dueAlerts.dDay?.length || 0) + (dueAlerts.upcoming?.length || 0) + (dueAlerts.overdue?.length || 0);

  let dueAlertCard = "";
  if (dueTotalCount > 0) {
    const notifBtn = ("Notification" in window && Notification.permission === "default")
      ? `<button type="button" class="btn btn-ghost sm" data-act="req-notifications" style="font-size:0.78rem;">🔔 Remind me</button>`
      : "";
    const items = [
      ...dueAlerts.dDay.map((b) => `
        <div class="due-alert-item due-alert-today">
          <div class="due-alert-info">
            <span class="due-alert-badge badge-today">🔴 Due Today</span>
            <b>${esc(b.name)}</b>
            <span class="due-alert-amt">${fmt(b.amount)}</span>
          </div>
          <button type="button" class="btn btn-primary sm" data-act="log-due-bill" data-id="${esc(b.id)}">Log as Paid</button>
        </div>`),
      ...dueAlerts.upcoming.map((b) => `
        <div class="due-alert-item due-alert-upcoming">
          <div class="due-alert-info">
            <span class="due-alert-badge badge-upcoming">🟡 Due in ${b.diff}d</span>
            <b>${esc(b.name)}</b>
            <span class="due-alert-amt">${fmt(b.amount)}</span>
          </div>
          <button type="button" class="btn btn-soft sm" data-act="log-due-bill" data-id="${esc(b.id)}">Pay early</button>
        </div>`),
      ...dueAlerts.overdue.map((b) => `
        <div class="due-alert-item due-alert-overdue">
          <div class="due-alert-info">
            <span class="due-alert-badge badge-overdue">⚠️ Past Due (${b.daysOverdue}d)</span>
            <b>${esc(b.name)}</b>
            <span class="due-alert-amt">${fmt(b.amount)}</span>
          </div>
          <button type="button" class="btn btn-soft sm" data-act="log-due-bill" data-id="${esc(b.id)}">Log as Paid</button>
        </div>`),
    ].join("");

    dueAlertCard = `
      <section class="card due-alert-card">
        <div class="due-alert-head">
          <div class="due-alert-title">
            <span>📅</span>
            <h3>Bill Due Reminders</h3>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            ${notifBtn}
            <span class="chip">${dueTotalCount} pending</span>
          </div>
        </div>
        <div class="due-alert-list">
          ${items}
        </div>
      </section>`;
  }

  const progress = calculateSavingsProgress(s.savingsGoal, monthBudget, spent);

  let savingsFeedback = "";
  if (progress.isAchieved) {
    savingsFeedback = "🎉 Goal reached this month!";
  } else if (spent > monthBudget && monthBudget > 0) {
    savingsFeedback = `Over budget this month · ${fmt(progress.remaining)} to go`;
  } else if (progress.currentSaved > 0) {
    savingsFeedback = `${fmt(progress.remaining)} to go`;
  } else {
    savingsFeedback = `No savings yet this month · ${fmt(progress.remaining)} to go`;
  }

  const savingsGoalCard = !progress.hasGoal
    ? `
      <section class="card savings-card empty-goal">
        <div class="savings-head">
          <div class="savings-title"><span class="savings-badge">🎯</span><h2>Monthly Savings Goal</h2></div>
        </div>
        <p class="savings-prompt">Set a monthly savings goal to track your progress together.</p>
        <div>
          <button class="btn btn-soft sm" data-act="set-goal-prompt">🎯 Set goal</button>
        </div>
      </section>`
    : `
      <section class="card savings-card ${progress.isAchieved ? "achieved" : ""}">
        <div class="savings-head">
          <div class="savings-title"><span class="savings-badge">🎯</span><h2>Monthly Savings Goal</h2></div>
          <button class="btn btn-soft sm" data-act="set-goal-prompt">Edit</button>
        </div>
        <div class="savings-numbers">
          <div class="savings-amt-col">
            <span class="savings-saved"><b>${fmt(progress.currentSaved)}</b> saved</span>
            <small class="savings-goal-target">of ${fmt(progress.goal)} target</small>
          </div>
          <span class="chip ${progress.isAchieved ? "gain-pos" : ""}">${Math.round(progress.rawPct)}%</span>
        </div>
        <div class="meter"><i class="${progress.isAchieved ? "goal-done" : ""}" style="width:${progress.progressPct}%"></i></div>
        <div class="savings-footer">
          <small class="${progress.isAchieved ? "pos" : ""}">${esc(savingsFeedback)}</small>
        </div>
      </section>`;

  // category cards
  let catSpentTotal = 0;
  const cards = c.cats.map((cat) => {
    const sp = (idx.byCat[cat.id] || [])[m] || { p1: 0, p2: 0, total: 0 };
    catSpentTotal += sp.total;
    const used = cat.monthly > 0 ? (sp.total / cat.monthly) * 100 : sp.total > 0 ? 101 : 0;
    const remaining = cat.monthly - sp.total;
    return `
      <article class="card cat-card" style="--c:${esc(cat.color)}">
        <div class="cat-top">
          <div class="cat-emoji">${esc(cat.emoji)}</div>
          <div class="cat-name"><b>${esc(cat.name)}</b><small>${cat.percent}% of income</small></div>
          <div style="display:flex;align-items:center;gap:4px;">
            ${(() => {
              if (!isPro(s, state.user)) return "";
              const capState = { annualBudget: c.total, categories: b.categories, year: state.year, expenses: state.expenses };
              const cap = calculateCategoryCap(cat.id, capState, m);
              if (cap.status === "exceeded") return `<span class="chip cat-cap-badge cap-danger">🚨 Exceeded</span>`;
              if (cap.status === "warning") return `<span class="chip cat-cap-badge cap-warn">⚠️ ${Math.round(cap.ratio * 100)}%</span>`;
              return "";
            })()}
            <span class="chip">${Math.round(used)}%</span>
          </div>
        </div>
        <div class="meter"><i class="${usedStatus(used)}" style="width:${Math.min(used, 100)}%"></i></div>
        <div class="cat-amounts"><span><b>${fmt(sp.total)}</b> of ${fmt(cat.monthly)}</span><span class="${remaining < 0 ? "neg" : ""}">${remaining < 0 ? `${fmt(-remaining)} over` : `${fmt(remaining)} left`}</span></div>
        <div class="cat-split">
          <span class="chip who-p1">${esc(s.persons[0].emoji)} ${fmt(sp.p1)} / ${fmt(cat.monthly1)}</span>
          <span class="chip who-p2">${esc(s.persons[1].emoji)} ${fmt(sp.p2)} / ${fmt(cat.monthly2)}</span>
        </div>
      </article>`;
  });
  const other = spent - catSpentTotal;
  if (other > 0.005) {
    cards.push(`
      <article class="card cat-card" style="--c:#cfc4d8">
        <div class="cat-top"><div class="cat-emoji">✨</div><div class="cat-name"><b>Other</b><small>Categories no longer in your plan</small></div></div>
        <div class="cat-amounts"><span><b>${fmt(other)}</b> spent</span></div>
      </article>`);
  }

  // people cards
  const people = PERSON_KEYS.map((k, i) => {
    const p = s.persons[i];
    const income = (k === "p1" ? c.inc1 : c.inc2) / 12;
    const share = c.cats.reduce((a, x) => a + (k === "p1" ? x.monthly1 : x.monthly2), 0);
    const paid = idx.months[m][k];
    const diff = paid - share;
    return `
      <article class="card person">
        <div class="person-head"><div class="avatar ${k}">${esc(p.emoji)}</div><div><h3>${esc(p.name)}</h3><small>${Math.round((k === "p1" ? c.r1 : 1 - c.r1) * 100)}% of household income</small></div></div>
        <div class="stat-row"><span>Monthly income</span><b>${fmt(income)}</b></div>
        <div class="stat-row"><span>Budget share</span><b>${fmt(share)}</b></div>
        <div class="stat-row"><span>Paid this month</span><b>${fmt(paid)}</b></div>
        <span class="chip ${k === "p1" ? "who-p1" : "who-p2"}">${share <= 0 && paid <= 0 ? "No share set yet" : diff > 0.005 ? `${fmt(diff)} above share` : `${fmt(-diff)} within share`}</span>
      </article>`;
  }).join("");

  return `
    ${notice}${sampleBtn}${recurringBanner}
    <section class="card hero">
      <div class="hero-pig">${renderMascotSvg(s.mascot, monthBudget > 0 ? left / monthBudget : 0, mad)}</div>
      <div class="hero-text">
        <h1>${MONTHS_LONG[m]} ${state.year}</h1>
        <p class="hero-left"><b class="${left < 0 ? "neg" : ""}">${fmt(left)}</b> ${left < 0 ? "over budget" : "left to spend"}</p>
        <div class="meter"><i class="${usedStatus(pct)}" style="width:${Math.min(pct, 100)}%"></i></div>
        <p class="hero-sub">${fmt(spent)} spent of ${fmt(monthBudget)} (yearly budget ÷ 12)</p>
        <p class="bubble ${mad ? "mad" : ""}">${esc(msg)}</p>
      </div>
    </section>
    ${dueAlertCard}
    ${savingsGoalCard}
    <div class="section-title"><h2>Where the money goes</h2><small>Monthly budgets come from your yearly plan</small></div>
    <section class="grid">${cards.join("") || `<div class="card empty">🎯<p>No categories yet. Add some in Budget.</p></div>`}</section>
    <div class="section-title"><h2>Who's paying</h2><small>Together expenses count 50:50 for each of you</small></div>
    <section class="grid-2 people">${people}</section>
    ${jarsSectionHtml()}
    ${activityFeedHtml()}
    <button class="fab" data-act="quick-add" aria-label="Add expense">＋</button>`;
}

/* ================================================================== */
/* Rendering: Expenses                                                 */
/* ================================================================== */
function expensesHtml() {
  const s = settings();
  return `
    <div class="two-col">
      <section class="card form-card">
        <div class="form-header-row">
          <h2 id="expFormTitle" style="margin:0;">Add an expense</h2>
          <div class="form-header-actions">
            <button type="button" class="btn btn-soft sm" id="btnScanReceipt" data-act="scan-receipt">📷 Scan receipt</button>
            <button type="button" class="btn btn-soft sm" data-act="open-recurring">📅 Recurring bills</button>
          </div>
          <input type="file" id="receiptFileInput" accept="image/*" capture="environment" style="display:none">
        </div>
        <form id="expForm" autocomplete="off">
          <label>Date<input type="date" name="date" required></label>
          <label>Amount<input type="text" name="amount" inputmode="decimal" placeholder="0" required></label>
          <label>Category<select name="categoryId" required></select></label>
          <div id="catCapAlert" class="cat-cap-hint-box hide"></div>
          <fieldset class="who">
            <legend>Paid by</legend>
            ${PERSON_KEYS.map((k, i) => `<label class="who-pill"><input type="radio" name="paidBy" value="${k}" ${k === state.lastPaidBy ? "checked" : ""}><span>${esc(s.persons[i].emoji)} ${esc(s.persons[i].name)}</span></label>`).join("")}
            <label class="who-pill"><input type="radio" name="paidBy" value="both" ${state.lastPaidBy === "both" ? "checked" : ""}><span>💞 Together</span></label>
          </fieldset>
          <fieldset class="who payment-method-group">
            <legend>Payment method</legend>
            ${PAYMENT_METHODS.map((pm) => `
              <label class="who-pill payment-pill">
                <input type="radio" name="paymentMethod" value="${pm.id}" ${pm.id === (state.lastPaymentMethod || "cash") ? "checked" : ""}>
                <span>${pm.emoji} ${esc(pm.name)}</span>
              </label>
            `).join("")}
          </fieldset>
          <div id="creditCardDetails" class="payment-extra ${(state.lastPaymentMethod === "credit_card" || state.lastPaymentMethod === "installment") ? "" : "hide"}">
            <label>Card name / Bank <small>(optional)</small>
              <input type="text" name="cardName" list="knownCardNames" placeholder="e.g. BCA Card, Mandiri, Chase" maxlength="30" value="${esc(state.lastCardName || "")}">
              <datalist id="knownCardNames"></datalist>
            </label>
          </div>
          <div id="installmentDetails" class="payment-extra ${state.lastPaymentMethod === "installment" ? "" : "hide"}">
            <div class="two-col-inline">
              <label>Total months (tenure)
                <select name="installmentMonths">
                  <option value="3">3 months</option>
                  <option value="6">6 months</option>
                  <option value="12" selected>12 months</option>
                  <option value="24">24 months</option>
                  <option value="36">36 months</option>
                </select>
              </label>
              <label>Current month
                <input type="number" name="installmentCurrent" min="1" max="36" value="1">
              </label>
            </div>
          </div>
          <label>Note <small>(optional)</small><input type="text" name="note" maxlength="80" placeholder="e.g. weekly groceries"></label>
          <div class="form-actions">
            <button class="btn btn-primary" type="submit" id="expSubmit">Add expense</button>
            <button class="btn btn-soft hide" type="button" id="expCancel" data-act="cancel-edit">Cancel</button>
          </div>
        </form>
      </section>
      <section class="card">
        <div class="list-head"><h2>${MONTHS_LONG[state.month]} ${state.year}</h2><span class="chip" id="expTotal"></span></div>
        <div id="expList"></div>
      </section>
    </div>`;
}

function fillExpenseSelects() {
  const sel = $("#expForm select[name=categoryId]");
  if (!sel) return;
  const keep = sel.value || state.lastCat;
  const cats = budgetFor(state.year).b.categories;
  sel.innerHTML = cats.map((c) => `<option value="${esc(c.id)}">${esc(c.emoji)} ${esc(c.name)}</option>`).join("");
  if (keep && cats.some((c) => c.id === keep)) sel.value = keep;
}

function initExpenseForm() {
  const f = $("#expForm");
  if (!f) return;
  fillExpenseSelects();
  updateKnownCardNames();
  const ym = `${state.year}-${pad(state.month + 1)}`;
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  f.date.value = today.startsWith(ym) ? today : `${ym}-01`;
  state.editingId = null;
  const pm = state.lastPaymentMethod || "cash";
  $$("input[name=paymentMethod]", f).forEach((r) => (r.checked = r.value === pm));
  if (f.cardName) f.cardName.value = state.lastCardName || "";
  const cc = $("#creditCardDetails", f);
  const inst = $("#installmentDetails", f);
  if (cc) cc.classList.toggle("hide", pm === "cash");
  if (inst) inst.classList.toggle("hide", pm !== "installment");
}

function updateExpenseList() {
  const el = $("#expList");
  if (!el) return;
  fillExpenseSelects();
  const s = settings();
  const ym = `${state.year}-${pad(state.month + 1)}`;
  const cats = Object.fromEntries(budgetFor(state.year).b.categories.map((c) => [c.id, c]));
  const list = state.expenses.filter((e) => (e.date || "").startsWith(ym)).sort((a, b) => b.date.localeCompare(a.date));
  const total = list.reduce((a, e) => a + (Number(e.amount) || 0), 0);
  $("#expTotal").textContent = `Total ${fmt(total)}`;
  el.innerHTML = list.length
    ? list.map((e) => {
        const cat = cats[e.categoryId];
        const pi = e.paidBy === "p2" ? 1 : 0;
        return `
        <div class="exp-row" style="--c:${esc(cat?.color || "#ddd")}">
          <div class="exp-emoji">${esc(cat?.emoji || "✨")}</div>
          <div class="exp-main">
            <b>${esc(e.note || cat?.name || "Other")}</b>
            <small>${Number(e.date.slice(8, 10))} ${MONTHS[state.month]} · ${esc(cat?.name || "Other")}</small>
            ${(() => {
              const reactions = e.reactions || {};
              const entries = Object.entries(reactions);
              if (!entries.length) return "";
              return `<div class="exp-reactions">${entries.map(([k, em]) => `<span class="exp-reaction-chip" data-act="open-reactions" data-id="${esc(e.id)}" title="${k === "p1" ? s.persons[0].name : s.persons[1].name}: ${em}">${em}</span>`).join("")}</div>`;
            })()}
          </div>
          ${paymentBadgeHtml(e)}
          ${e.paidBy === "both"
            ? `<span class="chip who-both">💞 Together</span>`
            : `<span class="chip who-${PERSON_KEYS[pi]}">${esc(s.persons[pi].emoji)} ${esc(s.persons[pi].name)}</span>`}
          <b class="exp-amt">${fmt(e.amount)}</b>
          <div class="row-actions">
            ${isPro(s, state.user)
              ? `<button type="button" class="icon-btn sm exp-react-trigger" data-act="open-reactions" data-id="${esc(e.id)}" title="React with emoji">❤️+</button>`
              : `<button type="button" class="icon-btn sm exp-react-trigger pro-react-locked" data-act="open-pro" title="Partner Reactions (✨ PRO)">✨</button>`
            }
            <button class="icon-btn sm" data-act="edit-exp" data-id="${esc(e.id)}" aria-label="Edit expense">✏️</button>
            <button class="icon-btn sm" data-act="del-exp" data-id="${esc(e.id)}" aria-label="Delete expense">🗑️</button>
          </div>
        </div>`;
      }).join("")
    : `<div class="empty">🌱<p>No expenses yet this month.<br>Add the first one on the left.</p></div>`;
}

async function submitExpense(form) {
  const fd = new FormData(form);
  const amount = parseFormattedNumber(fd.get("amount"));
  const date = String(fd.get("date") || "");
  const categoryId = String(fd.get("categoryId") || "");
  if (!(amount > 0) || !date || !categoryId) {
    toast("Enter a date, an amount and a category.");
    return;
  }
  const pm = fd.get("paymentMethod") || "cash";
  const cardName = String(fd.get("cardName") || "").trim();
  const instMonths = Number(fd.get("installmentMonths")) || null;
  const instCurr = Number(fd.get("installmentCurrent")) || null;

  const data = {
    date,
    amount,
    categoryId,
    paidBy: ["p1", "p2", "both"].includes(fd.get("paidBy")) ? fd.get("paidBy") : "p1",
    note: String(fd.get("note") || "").trim(),
    paymentMethod: ["cash", "credit_card", "installment"].includes(pm) ? pm : "cash",
    cardName,
    installmentMonths: pm === "installment" ? instMonths : null,
    installmentCurrent: pm === "installment" ? instCurr : null,
  };
  state.lastCat = categoryId;
  state.lastPaidBy = data.paidBy;
  state.lastPaymentMethod = data.paymentMethod;
  if (cardName) state.lastCardName = cardName;
  try {
    if (state.editingId) await state.db.updateExpense(state.editingId, data);
    else await state.db.addExpense(data);
  } catch (err) {
    toast("Couldn't save: " + (err.message || err));
    return;
  }
  const wasEditing = !!state.editingId;
  toast(wasEditing ? "Expense updated" : "Expense added");
  const paidPerson = data.paidBy === "both" ? "Together" : (data.paidBy === "p2" ? settings().persons[1].name : settings().persons[0].name);
  logActivity(`${paidPerson} logged "${data.note || "Expense"}" for ${fmt(data.amount)}`, "🧾");
  const y = Number(date.slice(0, 4));
  const mo = Number(date.slice(5, 7)) - 1;
  if (y !== state.year || mo !== state.month) {
    state.year = y;
    state.month = mo;
    render();
    return;
  }
  state.editingId = null;
  form.amount.value = "";
  form.note.value = "";
  $("#expSubmit").textContent = "Add expense";
  $("#expCancel").classList.add("hide");
  $("#expFormTitle").textContent = "Add an expense";
  form.amount.focus();
}

function startEdit(id) {
  const e = state.expenses.find((x) => x.id === id);
  const f = $("#expForm");
  if (!e || !f) return;
  state.editingId = id;
  f.date.value = e.date;
  f.amount.value = formatNumberInput(e.amount);
  f.categoryId.value = e.categoryId;
  f.note.value = e.note || "";
  const who = ["p1", "p2", "both"].includes(e.paidBy) ? e.paidBy : "p1";
  $$("input[name=paidBy]", f).forEach((r) => (r.checked = r.value === who));

  const pm = ["cash", "credit_card", "installment"].includes(e.paymentMethod) ? e.paymentMethod : "cash";
  $$("input[name=paymentMethod]", f).forEach((r) => (r.checked = r.value === pm));
  if (f.cardName) f.cardName.value = e.cardName || "";
  if (f.installmentMonths) f.installmentMonths.value = String(e.installmentMonths || 12);
  if (f.installmentCurrent) f.installmentCurrent.value = String(e.installmentCurrent || 1);

  const cc = $("#creditCardDetails", f);
  const inst = $("#installmentDetails", f);
  if (cc) cc.classList.toggle("hide", pm === "cash");
  if (inst) inst.classList.toggle("hide", pm !== "installment");

  $("#expSubmit").textContent = "Save changes";
  $("#expCancel").classList.remove("hide");
  $("#expFormTitle").textContent = "Edit expense";
  f.scrollIntoView({ behavior: "smooth", block: "center" });
}

function cancelEdit() {
  state.editingId = null;
  initExpenseForm();
  const f = $("#expForm");
  f.amount.value = "";
  f.note.value = "";
  const pm = state.lastPaymentMethod || "cash";
  $$("input[name=paymentMethod]", f).forEach((r) => (r.checked = r.value === pm));
  if (f.cardName) f.cardName.value = state.lastCardName || "";
  const cc = $("#creditCardDetails", f);
  const inst = $("#installmentDetails", f);
  if (cc) cc.classList.toggle("hide", pm === "cash");
  if (inst) inst.classList.toggle("hide", pm !== "installment");
  $("#expSubmit").textContent = "Add expense";
  $("#expCancel").classList.add("hide");
  $("#expFormTitle").textContent = "Add an expense";
}

/* ================================================================== */
/* Rendering: Budget (yearly plan editor)                              */
/* ================================================================== */
function budgetHtml() {
  const s = settings();
  const d = getDraft();
  const { exists, carried } = budgetFor(state.year);
  const rows = d.b.categories.map((cat) => `
    <div class="brow" data-id="${esc(cat.id)}" style="--c:${esc(cat.color)}">
      <div class="brow-main">
        <input class="emoji-in" data-f="emoji" value="${esc(cat.emoji)}" maxlength="4" aria-label="Emoji">
        <textarea class="name-in" data-f="name" rows="1" maxlength="40" placeholder="Category name" aria-label="Category name">${esc(cat.name)}</textarea>
        <label class="pct-in"><input type="number" data-f="percent" min="0" max="100" step="0.5" value="${cat.percent}" aria-label="Percent of income"><span>%</span></label>
        <button type="button" class="icon-btn sm drag-handle" aria-label="Drag to reorder ${esc(cat.name)}" title="Drag to reorder (or focus and press ↑ ↓)">${GRIP}</button>
        <button class="icon-btn sm" data-act="del-cat" data-id="${esc(cat.id)}" aria-label="Remove category">🗑️</button>
      </div>
      <div class="brow-split">
        <select data-f="splitMode" aria-label="How to split between people">
          <option value="income" ${cat.splitMode === "income" ? "selected" : ""}>Split by income</option>
          <option value="custom" ${cat.splitMode === "custom" ? "selected" : ""}>Custom split</option>
        </select>
        ${cat.splitMode === "custom" ? `<input type="range" data-f="p1Share" min="0" max="100" step="5" value="${cat.p1Share ?? 50}" aria-label="${esc(s.persons[0].name)}'s share">` : `<span></span>`}
        <span class="split-label"></span>
      </div>
      <div class="brow-derived">
        <span>Yearly <b class="d-yearly"></b></span>
        <span>Monthly <b class="d-monthly"></b></span>
        <span class="chip who-p1 d-p1"></span>
        <span class="chip who-p2 d-p2"></span>
      </div>
    </div>`).join("");

  return `
    ${!exists ? `<div class="notice"><span>${carried ? `${state.year} has no saved plan yet. This one starts from ${carried}.` : `Set up your ${state.year} plan, then press Save.`}</span></div>` : ""}
    <section class="card">
      <h2>Yearly income 💰</h2>
      <small>Enter what each of you expects to earn in ${state.year}. Monthly budgets are the yearly amounts ÷ 12.</small>
      <div class="income-grid">
        ${PERSON_KEYS.map((k, i) => `
          <div class="income-box ${k}">
            <label>${esc(s.persons[i].emoji)} ${esc(s.persons[i].name)}'s yearly income
              <input type="text" inputmode="decimal" data-income="${k}" value="${formatNumberInput(d.b.income[k])}" placeholder="0">
            </label>
            <small id="inc-m-${k}"></small>
          </div>`).join("")}
      </div>
    </section>
    <section class="card">
      <div class="plan-top">
        <div class="donut" id="donut"><div class="donut-label"><span id="donutMonthly"></span><small>per month</small></div></div>
        <div>
          <h2>Household budget</h2>
          <p id="incTotal" style="margin:6px 0 10px"></p>
          <span class="pct-status" id="pctSum"></span>
        </div>
      </div>
    </section>
    <section class="card">
      <h2>Categories 🎯</h2>
      <small>Give each category a percentage of your total income. Each one can be split between you by income, or with a custom split. Drag the grip ⠿ to change the order.</small>
      <div class="budget-list" id="budgetList">${rows}</div>
      <div class="budget-actions">
        <button class="btn btn-soft" data-act="add-cat">Add category</button>
        <button class="btn btn-soft" data-act="balance">Balance to 100%</button>
        <span class="spacer"></span>
        <small id="dirtyNote"></small>
        <button class="btn btn-primary" id="saveBudgetBtn" data-act="save-budget">Save ${state.year} plan</button>
      </div>
    </section>`;
}

function updateBudgetDerived() {
  const d = getDraft();
  const c = calc(d.b);
  const s = settings();
  c.cats.forEach((cat) => {
    const row = $(`.brow[data-id="${cat.id}"]`);
    if (!row) return;
    const r1 = Math.round(cat.ratio1 * 100);
    $(".d-yearly", row).textContent = fmt(cat.yearly);
    $(".d-monthly", row).textContent = fmt(cat.monthly);
    $(".d-p1", row).textContent = `${s.persons[0].emoji} ${fmt(cat.monthly1)}/mo`;
    $(".d-p2", row).textContent = `${s.persons[1].emoji} ${fmt(cat.monthly2)}/mo`;
    $(".split-label", row).textContent = `${s.persons[0].emoji} ${r1}% · ${s.persons[1].emoji} ${100 - r1}%`;
  });
  PERSON_KEYS.forEach((k) => {
    const el = $(`#inc-m-${k}`);
    if (el) el.textContent = `${fmt((k === "p1" ? c.inc1 : c.inc2) / 12)} per month`;
  });
  $("#incTotal").innerHTML = `Total yearly income <b>${fmt(c.total)}</b><br>Monthly budget <b>${fmt(c.total / 12)}</b>`;
  $("#donutMonthly").textContent = compact(c.total / 12);

  // donut
  let start = 0;
  const stops = c.cats.map((cat) => {
    const end = Math.min(100, start + cat.percent);
    const seg = `${cat.color} ${start}% ${end}%`;
    start = end;
    return seg;
  });
  if (start < 100) stops.push(`#f7eaf0 ${start}% 100%`);
  $("#donut").style.background = `conic-gradient(${stops.join(", ")})`;

  const ok = Math.abs(c.pctSum - 100) < 0.05;
  const pill = $("#pctSum");
  const rounded = Math.round(c.pctSum * 100) / 100;
  pill.className = "pct-status " + (ok ? "ok" : c.pctSum > 100 ? "bad" : "");
  pill.textContent = ok ? "Allocated 100% ✓" : c.pctSum > 100 ? `Allocated ${rounded}% (${Math.round((c.pctSum - 100) * 100) / 100}% too much)` : `Allocated ${rounded}% (${Math.round((100 - c.pctSum) * 100) / 100}% left to assign)`;
  $("#saveBudgetBtn").disabled = !ok || !d.b.categories.length;
  $("#dirtyNote").textContent = state.dirty ? "Unsaved changes" : "";
  refreshDirtyDot();
}

function markDirty() {
  state.dirty = true;
  updateBudgetDerived();
}

// ---- drag to reorder categories (mouse, touch and keyboard) ----
const GRIP = `<svg viewBox="0 0 12 18" width="12" height="18" fill="currentColor" aria-hidden="true"><circle cx="3" cy="3" r="1.7"/><circle cx="9" cy="3" r="1.7"/><circle cx="3" cy="9" r="1.7"/><circle cx="9" cy="9" r="1.7"/><circle cx="3" cy="15" r="1.7"/><circle cx="9" cy="15" r="1.7"/></svg>`;
let drag = null;

document.addEventListener("pointerdown", (ev) => {
  const h = ev.target.closest?.(".drag-handle");
  if (!h || state.tab !== "budget" || drag) return;
  if (ev.pointerType === "mouse" && ev.button !== 0) return;
  const row = h.closest(".brow");
  if (!row) return;
  ev.preventDefault();
  const rect = row.getBoundingClientRect();
  const ph = document.createElement("div");
  ph.className = "brow-placeholder";
  ph.style.height = rect.height + "px";
  row.after(ph); // keeps the gap open while the row is lifted
  row.classList.add("dragging");
  Object.assign(row.style, { left: rect.left + "px", top: rect.top + "px", width: rect.width + "px" });
  drag = { row, list: row.parentElement, ph, h, id: row.dataset.id, offset: ev.clientY - rect.top, y: ev.clientY, pointerId: ev.pointerId, raf: 0 };
  try { h.setPointerCapture(ev.pointerId); } catch (e) { /* not critical */ }
  document.addEventListener("pointermove", onDragMove);
  document.addEventListener("pointerup", onDragEnd);
  document.addEventListener("pointercancel", onDragEnd);
  drag.raf = requestAnimationFrame(dragTick);
});

function onDragMove(ev) {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  drag.y = ev.clientY;
  ev.preventDefault();
}

function dragTick() {
  if (!drag) return;
  const d = drag;
  const top = d.y - d.offset;
  d.row.style.top = top + "px";
  // scroll the page when dragging near the top or bottom edge
  const vh = window.innerHeight;
  if (d.y < 90) window.scrollBy(0, -Math.min(18, (90 - d.y) / 4 + 4));
  else if (d.y > vh - 150) window.scrollBy(0, Math.min(18, (d.y - (vh - 150)) / 4 + 4));
  // move the gap to where the row's centre is
  const center = top + d.row.offsetHeight / 2;
  let before = null;
  for (const c of d.list.children) {
    if (c === d.row || c === d.ph) continue;
    const r = c.getBoundingClientRect();
    if (center < r.top + r.height / 2) { before = c; break; }
  }
  if (before ? d.ph.nextElementSibling !== before : d.list.lastElementChild !== d.ph) d.list.insertBefore(d.ph, before);
  d.raf = requestAnimationFrame(dragTick);
}

function onDragEnd(ev) {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  const d = drag;
  drag = null;
  cancelAnimationFrame(d.raf);
  document.removeEventListener("pointermove", onDragMove);
  document.removeEventListener("pointerup", onDragEnd);
  document.removeEventListener("pointercancel", onDragEnd);
  try { d.h.releasePointerCapture(d.pointerId); } catch (e) { /* not critical */ }
  if (ev.type !== "pointercancel") {
    const order = [];
    for (const el of d.list.children) {
      if (el === d.ph) order.push(d.id);
      else if (el !== d.row) order.push(el.dataset.id);
    }
    const draft = getDraft();
    const byId = new Map(draft.b.categories.map((c) => [c.id, c]));
    const next = order.map((id) => byId.get(id)).filter(Boolean);
    if (next.length === draft.b.categories.length && next.some((c, i) => c !== draft.b.categories[i])) {
      draft.b.categories = next;
      state.dirty = true;
    }
  }
  renderView();
}

// keyboard: focus the grip and press ↑ / ↓
document.addEventListener("keydown", (ev) => {
  const h = ev.target.closest?.(".drag-handle");
  if (!h || (ev.key !== "ArrowUp" && ev.key !== "ArrowDown")) return;
  ev.preventDefault();
  const id = h.closest(".brow").dataset.id;
  const cats = getDraft().b.categories;
  const i = cats.findIndex((c) => c.id === id);
  const j = i + (ev.key === "ArrowUp" ? -1 : 1);
  if (i < 0 || j < 0 || j >= cats.length) return;
  [cats[i], cats[j]] = [cats[j], cats[i]];
  state.dirty = true;
  renderView();
  $(`.brow[data-id="${id}"] .drag-handle`)?.focus();
});

function balanceToHundred() {
  const cats = getDraft().b.categories;
  if (!cats.length) return;
  const sum = cats.reduce((a, c) => a + (Number(c.percent) || 0), 0);
  if (sum <= 0) {
    const each = Math.floor((1000 / cats.length)) / 10;
    cats.forEach((c) => (c.percent = each));
  } else {
    cats.forEach((c) => (c.percent = Math.round(((Number(c.percent) || 0) * 1000) / sum) / 10));
  }
  const newSum = cats.reduce((a, c) => a + c.percent, 0);
  const biggest = cats.reduce((a, c) => (c.percent > a.percent ? c : a), cats[0]);
  biggest.percent = Math.round((biggest.percent + (100 - newSum)) * 10) / 10;
  state.dirty = true;
  renderView();
}

async function saveBudget() {
  const d = getDraft();
  const c = calc(d.b);
  if (Math.abs(c.pctSum - 100) >= 0.05) {
    toast("Categories need to add up to 100%.");
    return;
  }
  const clean = {
    year: state.year,
    income: { p1: Number(d.b.income.p1) || 0, p2: Number(d.b.income.p2) || 0 },
    categories: d.b.categories.map((x) => ({
      id: x.id,
      emoji: (x.emoji || "✨").trim() || "✨",
      name: (x.name || "").trim() || "Untitled",
      percent: Math.round((Number(x.percent) || 0) * 100) / 100,
      color: x.color,
      splitMode: x.splitMode === "custom" ? "custom" : "income",
      p1Share: Number(x.p1Share ?? 50),
    })),
    updatedAt: Date.now(),
  };
  try {
    await state.db.saveBudget(state.year, clean);
  } catch (err) {
    toast("Couldn't save: " + (err.message || err));
    return;
  }
  state.dirty = false;
  state.draft = { year: state.year, b: clone(clean) };
  toast(`${state.year} plan saved`);
  updateBudgetDerived();
}

/* ================================================================== */
/* Rendering: Year overview                                            */
/* ================================================================== */
function yearHtml() {
  const { b, exists } = budgetFor(state.year);
  const c = calc(b);
  const idx = spendIndex(state.year);
  const monthly = c.total / 12;
  const spentYear = idx.months.reduce((a, x) => a + x.total, 0);
  const monthsWithSpend = idx.months.filter((x) => x.total > 0).length;
  const max = Math.max(monthly, ...idx.months.map((x) => x.total), 1) * 1.15;

  const now = new Date();
  const currentYear = now.getFullYear();
  const isFinalReview = (currentYear > state.year) || (currentYear === state.year && now.getMonth() === 11 && now.getDate() >= 31);
  const bannerTitle = isFinalReview ? `${state.year} Piggy Wrapped` : `${state.year} Year-to-Date Wrapped`;
  const bannerBtnText = isFinalReview ? `Open ${state.year} Wrapped ✨` : `View ${state.year} Year-to-Date Wrapped ✨`;
  const bannerDesc = isFinalReview
    ? "Your couple financial journey, celebratory milestones, and superpower archetype."
    : "Your couple financial journey so far, progress milestones, and superpower archetype.";

  const wrappedBanner = `
    <section class="card wrapped-banner">
      <div class="wrapped-banner-content">
        <span class="wrapped-banner-icon">🎁</span>
        <div>
          <h2>${bannerTitle}</h2>
          <p>${bannerDesc}</p>
        </div>
      </div>
      <button class="btn btn-primary" data-act="open-wrapped">${bannerBtnText}</button>
    </section>`;

  const bars = idx.months.map((mth, i) => `
    <button class="bar-col ${i === state.month ? "sel" : ""}" data-act="goto-month" data-m="${i}" aria-label="${MONTHS_LONG[i]}: ${fmt(mth.total)} spent">
      <div class="bar ${monthly > 0 && mth.total > monthly ? "over" : ""}" style="height:${(mth.total / max) * 100}%"></div>
    </button>`).join("");

  const rows = c.cats.map((cat) => {
    const row = idx.byCat[cat.id] || [];
    const total = row.reduce((a, x) => a + x.total, 0);
    const cells = Array.from({ length: 12 }, (_, i) => {
      const v = row[i]?.total || 0;
      const cls = v === 0 ? "zero" : cat.monthly > 0 && v > cat.monthly ? "over" : cat.monthly > 0 && v >= cat.monthly * 0.8 ? "warn" : "";
      return `<td class="${cls}">${compact(v)}</td>`;
    }).join("");
    return `<tr><td>${esc(cat.emoji)} ${esc(cat.name)}</td><td>${fmt(cat.yearly)}</td><td>${fmt(total)}</td><td class="${cat.yearly - total < 0 ? "over" : ""}">${fmt(cat.yearly - total)}</td>${cells}</tr>`;
  }).join("");

  return `
    ${wrappedBanner}
    ${!exists ? `<div class="notice"><span>No saved plan for ${state.year} yet.</span><button class="btn btn-soft" data-act="tab" data-tab="budget">Set up ${state.year} budget</button></div>` : ""}
    <section class="stats">
      <div class="card stat"><small>Yearly budget</small><b>${fmt(c.total)}</b></div>
      <div class="card stat"><small>Spent so far</small><b>${fmt(spentYear)}</b></div>
      <div class="card stat"><small>Left this year</small><b class="${c.total - spentYear < 0 ? "neg" : ""}">${fmt(c.total - spentYear)}</b></div>
      <div class="card stat"><small>Average per month</small><b>${fmt(monthsWithSpend ? spentYear / monthsWithSpend : 0)}</b></div>
    </section>
    <section class="card">
      <div class="list-head"><h2>${state.year} month by month</h2><small>Dashed line is your monthly budget. Tap a bar to open that month.</small></div>
      <div class="chart">
        <div class="chart-plot">
          ${bars}
          ${monthly > 0 ? `<div class="budget-line" style="bottom:${(monthly / max) * 100}%"><span>${fmt(monthly)}</span></div>` : ""}
        </div>
        <div class="chart-labels">${MONTHS.map((m) => `<span>${m}</span>`).join("")}</div>
      </div>
    </section>
    <section class="card">
      <h2>Categories across the year</h2>
      <small>Yellow means a month used 80% or more of the category budget. Red means over.</small>
      <small class="table-hint">👉 Swipe horizontally to view all months</small>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Category</th><th>Year budget</th><th>Spent</th><th>Left</th>${MONTHS.map((m) => `<th>${m}</th>`).join("")}</tr></thead>
          <tbody>${rows || `<tr><td colspan="16">No categories yet.</td></tr>`}</tbody>
        </table>
      </div>
    </section>
    ${invReviewHtml()}`;
}

/* ================================================================== */
/* Investments                                                         */
/* ================================================================== */
const INV_TYPES = [
  ["stocks", "📈", "Stocks / ETF"],
  ["fund", "🏦", "Mutual fund"],
  ["gold", "🪙", "Gold"],
  ["crypto", "₿", "Crypto"],
  ["bonds", "📜", "Bonds"],
  ["deposit", "🏧", "Deposit"],
  ["property", "🏡", "Property"],
  ["other", "🌱", "Other"],
];
const typeInfo = (k) => INV_TYPES.find((t) => t[0] === k) || INV_TYPES[INV_TYPES.length - 1];
const typeColor = (k) => PALETTE[Math.max(0, INV_TYPES.findIndex((t) => t[0] === k)) % PALETTE.length];
const KIND_LABEL = { add: "➕ Added money", withdraw: "➖ Withdrew money", value: "🏷️ Value update" };
const KIND_ORDER = { add: 0, withdraw: 0, value: 1 };
const todayYmd = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const closeDlg = () => $("#settingsDialog").close();
const ownerShares = (o) => (o === "both" ? { p1: 0.5, p2: 0.5 } : o === "p2" ? { p1: 0, p2: 1 } : { p1: 1, p2: 0 });
function ownerLabel(o) {
  if (o === "both") return "💞 Together";
  const p = settings().persons[o === "p2" ? 1 : 0];
  return `${p.emoji} ${p.name}`;
}
const fmtPct = (x) => (Math.abs(x) < 0.00005 ? "0.0%" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}%`);

function gainChip(gain, ret) {
  if (Math.abs(gain) < 0.005) return `<span class="chip">No change yet</span>`;
  const up = gain > 0;
  return `<span class="chip ${up ? "gain-pos" : "gain-neg"}">${up ? "▲" : "▼"} ${fmt(Math.abs(gain))}${ret != null ? ` · ${fmtPct(ret)}` : ""}</span>`;
}

const sortedEntries = (inv) =>
  [...(inv.entries || [])].sort((a, b) => (a.date || "").localeCompare(b.date || "") || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

// Replay the history: adding money raises the value, withdrawing lowers it, a "value update" resets it.
function invReplay(inv, untilYmd) {
  let value = 0, put = 0, out = 0, flowSeen = false;
  for (const e of sortedEntries(inv)) {
    if (untilYmd && e.date > untilYmd) break;
    const a = Number(e.amount) || 0;
    if (e.kind === "add") { value += a; put += a; flowSeen = true; }
    else if (e.kind === "withdraw") { value -= a; out += a; flowSeen = true; }
    else if (e.kind === "value") {
      if (!flowSeen) { put += a; flowSeen = true; } // first worth entered = the starting amount
      value = a;
    }
  }
  const net = put - out;
  return { value, put, out, net, gain: value - net };
}

function portfolio() {
  const t = { value: 0, put: 0, out: 0, gain: 0, byType: {}, rows: [], people: { p1: { value: 0, net: 0, gain: 0 }, p2: { value: 0, net: 0, gain: 0 } } };
  for (const inv of state.investments) {
    const r = invReplay(inv);
    t.value += r.value; t.put += r.put; t.out += r.out; t.gain += r.gain;
    t.byType[inv.type] = (t.byType[inv.type] || 0) + Math.max(0, r.value);
    const sh = ownerShares(inv.owner);
    for (const k of PERSON_KEYS) {
      t.people[k].value += r.value * sh[k];
      t.people[k].net += r.net * sh[k];
      t.people[k].gain += r.gain * sh[k];
    }
    t.rows.push({ inv, ...r });
  }
  t.net = t.put - t.out;
  t.ret = t.put > 0 ? t.gain / t.put : null;
  return t;
}

// Money going into (+) or out of (−) a holding. A first "worth now" entry counts as the starting amount.
function invFlows(inv) {
  const out = [];
  let seen = false;
  for (const e of sortedEntries(inv)) {
    const a = Number(e.amount) || 0;
    if (e.kind === "add") { out.push({ date: e.date, amt: a }); seen = true; }
    else if (e.kind === "withdraw") { out.push({ date: e.date, amt: -a }); seen = true; }
    else if (e.kind === "value" && !seen) { out.push({ date: e.date, amt: a }); seen = true; }
  }
  return out;
}

const daysBetween = (a, b) => {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
};

// Annualised rate that makes all dated cash flows add up to zero (a.k.a. XIRR).
function xirr(flows) {
  const f = (r) => flows.reduce((a, x) => a + x.amt / Math.pow(1 + r, x.t), 0);
  let lo = -0.99, hi = 10;
  let flo = f(lo);
  const fhi = f(hi);
  if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (Math.abs(fm) < 1e-9) return mid;
    if (flo * fm < 0) hi = mid;
    else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

// How the chosen holdings did during one year (up to today for the current year).
function periodStats(invs, year) {
  const start = `${year - 1}-12-31`;
  const today = todayYmd();
  let end = `${year}-12-31`;
  if (end > today) end = today;
  if (end <= start) return null;
  const D = daysBetween(start, end);
  let v0 = 0, v1 = 0, added = 0, withdrawn = 0, weighted = 0, first = null;
  const cf = [];
  for (const inv of invs) {
    v0 += invReplay(inv, start).value;
    v1 += invReplay(inv, end).value;
    for (const fl of invFlows(inv)) {
      if (fl.date > end) continue;
      if (first === null || fl.date < first) first = fl.date;
      cf.push({ date: fl.date, amt: -fl.amt });
      if (fl.date > start) {
        if (fl.amt > 0) added += fl.amt; else withdrawn += -fl.amt;
        weighted += fl.amt * ((D - daysBetween(start, fl.date)) / D);
      }
    }
  }
  const net = added - withdrawn;
  const gain = v1 - v0 - net;
  const base = v0 + weighted; // money at work, weighted by how long it was invested
  const dietz = base > 0 ? gain / base : null;
  let cagr = null;
  if (first) {
    const span = daysBetween(first, end);
    if (span >= 365 && v1 > 0) {
      const flows = cf.map((x) => ({ t: daysBetween(first, x.date) / 365, amt: x.amt }));
      flows.push({ t: span / 365, amt: v1 });
      cagr = xirr(flows);
    }
  }
  return { start, end, v0, v1, added, withdrawn, net, gain, dietz, cagr };
}

const signed = (g) =>
  `<span class="${g > 0.005 ? "pos" : g < -0.005 ? "neg" : ""}">${g > 0.005 ? "+" : g < -0.005 ? "−" : ""}${fmt(Math.abs(g))}</span>`;
const pctText = (x) => (x == null ? "–" : `<span class="${x > 0.00005 ? "pos" : x < -0.00005 ? "neg" : ""}">${fmtPct(x)}</span>`);

function invReviewHtml() {
  if (!state.investments.length) return "";
  const head = (note) => `<div class="section-title"><h2>Investment review ${state.year} 📈</h2><small>${note}</small></div>`;
  const tot = periodStats(state.investments, state.year);
  if (!tot) return `${head("")}<section class="card"><div class="empty">⏳<p>${state.year} hasn't started yet.</p></div></section>`;
  const live = state.year === now.getFullYear();
  const rows = state.investments
    .map((inv) => ({ inv, st: periodStats([inv], state.year) }))
    .filter((r) => r.st && (r.st.v0 > 0 || r.st.v1 > 0 || r.st.added > 0 || r.st.withdrawn > 0))
    .sort((a, b) => b.st.v1 - a.st.v1);
  const body = rows.map(({ inv, st }) => `
    <tr>
      <td>${typeInfo(inv.type)[1]} ${esc(inv.name)}</td>
      <td>${fmt(st.v0)}</td><td>${fmt(st.added)}</td><td>${fmt(st.withdrawn)}</td><td>${fmt(st.v1)}</td>
      <td>${signed(st.gain)}</td><td>${pctText(st.dietz)}</td><td>${pctText(st.cagr)}</td>
    </tr>`).join("");
  return `
    ${head(live ? "Year to date, as of today" : `1 Jan to 31 Dec ${state.year}`)}
    <section class="stats">
      <div class="card stat"><small>Worth ${live ? "today" : `end of ${state.year}`}</small><b>${fmt(tot.v1)}</b></div>
      <div class="card stat"><small>Started the year with</small><b>${fmt(tot.v0)}</b></div>
      <div class="card stat"><small>Money added</small><b>${fmt(tot.added)}</b>${tot.withdrawn > 0 ? `<small>${fmt(tot.withdrawn)} withdrawn</small>` : ""}</div>
      <div class="card stat"><small>Money grown</small><b>${signed(tot.gain)}</b></div>
      <div class="card stat"><small>Growth</small><b>${pctText(tot.dietz)}</b></div>
      <div class="card stat"><small>CAGR</small><b>${pctText(tot.cagr)}</b>${tot.cagr == null ? `<small>Shows after 1 year of history</small>` : `<small>Per year since the first entry</small>`}</div>
    </section>
    <section class="card">
      <h2>By holding</h2>
      <small class="table-hint">👉 Swipe horizontally to view all holding details</small>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Holding</th><th>Start of year</th><th>Added</th><th>Withdrawn</th><th>Worth</th><th>Grown</th><th>Growth</th><th>CAGR</th></tr></thead>
          <tbody>${body || `<tr><td colspan="8">Nothing invested in ${state.year} yet.</td></tr>`}</tbody>
        </table>
      </div>
      <p class="review-note"><small>Grown is what your money earned, without the money you added. Growth weighs each deposit by how long it was invested. CAGR is the average yearly growth since the first entry. Values only change when you update them in the Invest tab.</small></p>
    </section>`;
}

// Budget category that funds investing (chosen in the Invest tab, or guessed from the name).
function investCategory() {
  const cats = budgetFor(state.year).b.categories;
  const stored = settings().investCategoryId;
  if (stored === "none") return null;
  return cats.find((c) => c.id === stored) || cats.find((c) => /sav|invest|tabung/i.test(c.name)) || null;
}

function compoundCalcHtml(startingPrincipal = 0) {
  const s = settings();
  const pro = isPro(s, state.user);
  const initPrincipal = state.compound?.principal ?? startingPrincipal;
  const initMonthly = state.compound?.monthly ?? (s.savingsGoal || 500);
  const initRate = state.compound?.rate ?? 8;
  const initYears = state.compound?.years ?? 10;
  const growth = calculateCompoundGrowth(initPrincipal, initMonthly, initRate, initYears);
  let milestone = "🌱 Compounding in Action";
  if (growth.futureValue >= 1000000) milestone = "🎉 Millionaire Nest Projected!";
  else if (growth.totalInterest > growth.totalContributed) milestone = "🚀 Interest Outearns Contributions!";

  if (!pro) {
    return `
      <section class="card compound-calc-card pro-locked-wrapper" id="compoundCalcCard">
        <div class="pro-lock-overlay">
          <div class="pro-lock-badge">🚀 ✨ PIGGY PRO</div>
          <h3>Future Nest Compound Wealth Projector</h3>
          <p>Simulate compounding portfolio growth, dividend reinvestment, and celebrate future millionaire milestones together.</p>
          <button type="button" class="btn btn-primary pro-upgrade-btn" data-act="open-pro">
            ✨ Unlock Future Nest Projector with Pro
          </button>
        </div>
        <div style="filter:blur(4px);pointer-events:none;opacity:0.55;">
          <div class="compound-calc-head">
            <div class="compound-calc-title">
              <span>🚀</span>
              <h2>Future Nest Compound Calculator</h2>
            </div>
            <span class="chip">${esc(milestone)}</span>
          </div>
          <div class="compound-hero-stat">
            <span class="compound-hero-label">Projected Future Nest Egg</span>
            <b class="compound-hero-num">${fmt(growth.futureValue)}</b>
            <span class="compound-hero-sub">in ${initYears} years at ${initRate}% annual return</span>
          </div>
          <div class="compound-dual-breakdown">
            <div class="compound-mini-stat">
              <span>Total Contributed</span>
              <b>${fmt(growth.totalContributed)}</b>
            </div>
            <div class="compound-mini-stat">
              <span>Growth Earned</span>
              <b class="pos">+${fmt(growth.totalInterest)}</b>
            </div>
          </div>
        </div>
      </section>`;
  }

  return `
    <section class="card compound-calc-card" id="compoundCalcCard">
      <div class="compound-calc-head">
        <div class="compound-calc-title">
          <span>🚀</span>
          <h2>Future Nest Compound Calculator</h2>
        </div>
        <span class="chip" id="compoundMilestone">${esc(milestone)}</span>
      </div>
      <p class="compound-calc-desc">See how your current portfolio and regular couple contributions grow over time with compound interest.</p>

      <div class="compound-hero-stat">
        <span class="compound-hero-label">Projected Future Nest Egg</span>
        <b class="compound-hero-num" id="compoundFutureVal">${fmt(growth.futureValue)}</b>
        <span class="compound-hero-sub" id="compoundYearsSub">in ${initYears} years at ${initRate}% annual return</span>
      </div>

      <div class="compound-dual-breakdown">
        <div class="compound-mini-stat">
          <span>Total Money Contributed</span>
          <b id="compoundContributed">${fmt(growth.totalContributed)}</b>
        </div>
        <div class="compound-mini-stat">
          <span>Compound Growth Earned</span>
          <b class="pos" id="compoundInterest">+${fmt(growth.totalInterest)}</b>
        </div>
      </div>

      <div class="compound-controls">
        <div class="compound-field">
          <div class="compound-field-label">
            <span>Timeline (Years)</span>
            <b id="compoundYearsLabel">${initYears} years</b>
          </div>
          <input type="range" id="compoundYearsRange" min="1" max="30" step="1" value="${initYears}">
          <div class="compound-quick-pills">
            <button type="button" class="btn btn-soft btn-xs compound-year-btn ${initYears === 5 ? "active" : ""}" data-act="set-compound-years" data-years="5">5y</button>
            <button type="button" class="btn btn-soft btn-xs compound-year-btn ${initYears === 10 ? "active" : ""}" data-act="set-compound-years" data-years="10">10y</button>
            <button type="button" class="btn btn-soft btn-xs compound-year-btn ${initYears === 15 ? "active" : ""}" data-act="set-compound-years" data-years="15">15y</button>
            <button type="button" class="btn btn-soft btn-xs compound-year-btn ${initYears === 20 ? "active" : ""}" data-act="set-compound-years" data-years="20">20y</button>
            <button type="button" class="btn btn-soft btn-xs compound-year-btn ${initYears === 30 ? "active" : ""}" data-act="set-compound-years" data-years="30">30y</button>
          </div>
        </div>

        <div class="grid-2" style="margin-top:12px;">
          <label>Monthly Contribution
            <input type="number" id="compoundMonthlyInput" min="0" step="10" value="${initMonthly}">
          </label>
          <label>Expected Return (%/year)
            <input type="number" id="compoundRateInput" min="0" max="30" step="0.5" value="${initRate}">
          </label>
        </div>
        <label style="margin-top:8px;">Starting Principal
          <input type="number" id="compoundPrincipalInput" min="0" step="100" value="${Math.round(initPrincipal)}">
        </label>
      </div>
    </section>`;
}

function investHtml() {
  const s = settings();
  const header = `<div class="section-title"><h2>Investments 📈</h2><button class="btn btn-primary" data-act="inv-new">＋ Add investment</button></div>`;
  if (!state.investments.length) {
    return `${header}
      <section class="card"><div class="empty">🌱
        <p>No investments yet.<br>Track gold, stocks, funds, deposits and more, and watch your savings grow together.</p>
        <div><button class="btn btn-primary" data-act="inv-new">Add your first investment</button></div>
      </div></section>
      ${compoundCalcHtml(0)}`;
  }

  const P = portfolio();
  const { b } = budgetFor(state.year);
  const c = calc(b);
  const link = investCategory();
  const linkCalc = link ? c.cats.find((x) => x.id === link.id) : null;
  const thisYear = state.year === now.getFullYear();
  const mPrefix = `${state.year}-${pad(now.getMonth() + 1)}`;
  let contribYear = 0, contribMonth = 0;
  for (const inv of state.investments) {
    for (const e of inv.entries || []) {
      if (e.kind !== "add" || !(e.date || "").startsWith(`${state.year}-`)) continue;
      contribYear += Number(e.amount) || 0;
      if (e.date.startsWith(mPrefix)) contribMonth += Number(e.amount) || 0;
    }
  }

  // allocation donut
  const types = Object.entries(P.byType).filter(([, v]) => v > 0).sort((a, b2) => b2[1] - a[1]);
  const allocTotal = types.reduce((a, [, v]) => a + v, 0);
  let st = 0;
  const stops = types.map(([k, v]) => {
    const end = st + (v / allocTotal) * 100;
    const seg = `${typeColor(k)} ${st}% ${end}%`;
    st = end;
    return seg;
  });
  const donutBg = stops.length ? `conic-gradient(${stops.join(", ")})` : "#f7eaf0";
  const legend = types.length
    ? types.map(([k, v]) => `<div><i style="background:${typeColor(k)}"></i><span>${typeInfo(k)[1]} ${esc(typeInfo(k)[2])}</span><b>${Math.round((v / allocTotal) * 100)}%</b></div>`).join("")
    : `<small>Add a current value to see your mix.</small>`;

  // people
  const people = PERSON_KEYS.map((k, i) => {
    const p = s.persons[i];
    const x = P.people[k];
    return `
      <article class="card person">
        <div class="person-head"><div class="avatar ${k}">${esc(p.emoji)}</div><div><h3>${esc(p.name)}</h3><small>Together investments count half each</small></div></div>
        <div class="stat-row"><span>Worth now</span><b>${fmt(x.value)}</b></div>
        <div class="stat-row"><span>Money invested</span><b>${fmt(x.net)}</b></div>
        <div class="stat-row"><span>Gain / loss</span><b class="${x.gain < 0 ? "neg" : x.gain > 0 ? "pos" : ""}">${x.gain > 0 ? "+" : x.gain < 0 ? "−" : ""}${fmt(Math.abs(x.gain))}</b></div>
      </article>`;
  }).join("");

  // month-end chart for the selected year
  const today = todayYmd();
  const pts = Array.from({ length: 12 }, (_, i) => {
    if (`${state.year}-${pad(i + 1)}-01` > today) return null;
    const end = `${state.year}-${pad(i + 1)}-31`;
    const until = end > today ? today : end;
    return state.investments.reduce((a, inv) => a + invReplay(inv, until).value, 0);
  });
  const maxV = Math.max(1, ...pts.map((v) => v || 0)) * 1.15;
  const bars = pts.map((v) => `<div class="bar-col static">${v != null ? `<div class="bar" style="height:${(Math.max(0, v) / maxV) * 100}%"></div>` : ""}</div>`).join("");
  const labels = pts.map((v, i) => `<span>${MONTHS[i]}<br><small>${v != null ? compact(v) : ""}</small></span>`).join("");

  // holdings
  const cards = P.rows.sort((a, b2) => b2.value - a.value).map((r) => {
    const inv = r.inv;
    const [, emoji, tname] = typeInfo(inv.type);
    const ret = r.put > 0 ? r.gain / r.put : null;
    return `
      <article class="card inv-card" style="--c:${typeColor(inv.type)}">
        <div class="cat-top">
          <div class="cat-emoji">${emoji}</div>
          <div class="cat-name"><b>${esc(inv.name)}</b><small>${esc(tname)} · ${esc(ownerLabel(inv.owner))}</small></div>
        </div>
        <div class="inv-value">${fmt(r.value)}</div>
        <div class="cat-amounts"><span>Invested <b>${fmt(r.net)}</b></span>${gainChip(r.gain, ret)}</div>
        ${inv.note ? `<small class="inv-note">${esc(inv.note)}</small>` : ""}
        <div class="inv-actions">
          <button class="btn btn-soft" data-act="inv-open" data-id="${esc(inv.id)}" data-kind="add">＋ Money</button>
          <button class="btn btn-soft" data-act="inv-open" data-id="${esc(inv.id)}" data-kind="value">🏷️ Value</button>
          <button class="btn btn-ghost" data-act="inv-open" data-id="${esc(inv.id)}" data-kind="add">Details</button>
        </div>
      </article>`;
  }).join("");

  return `
    ${header}
    <section class="stats">
      <div class="card stat"><small>Worth now</small><b>${fmt(P.value)}</b></div>
      <div class="card stat"><small>Money invested</small><b>${fmt(P.net)}</b></div>
      <div class="card stat"><small>Gain / loss</small><b class="${P.gain < 0 ? "neg" : P.gain > 0 ? "pos" : ""}">${P.gain > 0 ? "+" : P.gain < 0 ? "−" : ""}${fmt(Math.abs(P.gain))}</b></div>
      <div class="card stat"><small>Return</small><b class="${P.ret != null && P.ret < 0 ? "neg" : P.ret > 0 ? "pos" : ""}">${P.ret == null ? "–" : fmtPct(P.ret)}</b></div>
    </section>
    <section class="grid-2">
      <div class="card">
        <h2>Mix</h2>
        <div class="alloc">
          <div class="donut" style="background:${donutBg}"><div class="donut-label"><span>${state.investments.length}</span><small>${state.investments.length === 1 ? "holding" : "holdings"}</small></div></div>
          <div class="legend">${legend}</div>
        </div>
      </div>
      <div class="card">
        <h2>Savings plan ${state.year}</h2>
        <small>Choose the budget category that funds your investing.</small>
        <label style="margin-top:10px">Funded from
          <select id="invCat">
            <option value="none">Not linked</option>
            ${b.categories.map((x) => `<option value="${esc(x.id)}" ${link && link.id === x.id ? "selected" : ""}>${esc(x.emoji)} ${esc(x.name)}</option>`).join("")}
          </select>
        </label>
        ${linkCalc
          ? `<div class="plan-line">
              <div class="cat-amounts"><span><b>${fmt(contribYear)}</b> put in during ${state.year}</span><span>of ${fmt(linkCalc.yearly)} planned</span></div>
              <div class="meter"><i style="width:${linkCalc.yearly > 0 ? Math.min(100, (contribYear / linkCalc.yearly) * 100) : 0}%"></i></div>
              <small>${fmt(linkCalc.monthly)} per month${thisYear ? ` · ${fmt(contribMonth)} this month` : ""}</small>
            </div>`
          : `<p class="plan-line"><small>Link a category to compare your investing with your yearly budget.</small></p>`}
      </div>
    </section>
    <section class="grid-2 people">${people}</section>
    <section class="card">
      <div class="list-head"><h2>Worth at month-end · ${state.year}</h2></div>
      <div class="chart"><div class="chart-plot">${bars}</div><div class="chart-labels">${labels}</div></div>
    </section>
    <div class="section-title"><h2>Holdings</h2><small>Update the value now and then to track growth</small></div>
    <section class="grid">${cards}</section>
    ${compoundCalcHtml(P.value)}`;
}

const needDbUpdate = () => {
  if (state.db.addInvestment) return false;
  toast("Please also upload the new js/db.js file.");
  return true;
};

function openInvForm(id) {
  const s = settings();
  const inv = id ? state.investments.find((i) => i.id === id) : null;
  const dlg = $("#settingsDialog");
  dlg.innerHTML = `
    <form id="invForm" class="dlg-body" data-id="${esc(id || "")}">
      <h2>${inv ? "Edit investment" : "New investment"}</h2>
      <label>Name<input name="name" maxlength="40" required value="${esc(inv?.name || "")}" placeholder="e.g. Gold savings"></label>
      <label>Type
        <select name="type">${INV_TYPES.map((t) => `<option value="${t[0]}" ${inv?.type === t[0] ? "selected" : ""}>${t[1]} ${esc(t[2])}</option>`).join("")}</select>
      </label>
      <label>Owner
        <select name="owner">
          <option value="p1" ${inv?.owner === "p1" ? "selected" : ""}>${esc(s.persons[0].emoji)} ${esc(s.persons[0].name)}</option>
          <option value="p2" ${inv?.owner === "p2" ? "selected" : ""}>${esc(s.persons[1].emoji)} ${esc(s.persons[1].name)}</option>
          <option value="both" ${!inv || inv.owner === "both" ? "selected" : ""}>💞 Together</option>
        </select>
      </label>
      ${inv ? "" : `
        <label>Money put in so far <small>(optional)</small><input type="text" name="put" inputmode="decimal" placeholder="0"></label>
        <label>Worth right now <small>(optional)</small><input type="text" name="worth" inputmode="decimal" placeholder="0"></label>
        <label>As of<input type="date" name="date" value="${todayYmd()}"></label>`}
      <label>Note <small>(optional)</small><input name="note" maxlength="80" value="${esc(inv?.note || "")}" placeholder="e.g. bought at the bank"></label>
      <div class="dlg-actions">
        ${inv ? `<button type="button" class="btn btn-ghost" data-act="inv-open" data-id="${esc(id)}" data-kind="add">Cancel</button>` : `<button type="button" class="btn btn-ghost" data-act="close-settings">Cancel</button>`}
        <button class="btn btn-primary" type="submit">Save</button>
      </div>
    </form>`;
  if (!dlg.open) dlg.showModal();
}

async function submitInvForm(form) {
  if (needDbUpdate()) return;
  const fd = new FormData(form);
  const id = form.dataset.id;
  const base = {
    name: String(fd.get("name") || "").trim(),
    type: String(fd.get("type") || "other"),
    owner: ["p1", "p2", "both"].includes(fd.get("owner")) ? fd.get("owner") : "both",
    note: String(fd.get("note") || "").trim(),
  };
  if (!base.name) { toast("Give it a name."); return; }
  try {
    if (id) {
      const inv = state.investments.find((i) => i.id === id);
      await state.db.saveInvestment(id, { ...base, entries: inv?.entries || [] });
      toast("Saved");
      renderInvDialog(id);
      return;
    }
    const date = String(fd.get("date") || todayYmd());
    const put = parseFormattedNumber(fd.get("put"));
    const worthRaw = fd.get("worth");
    const worth = worthRaw === "" || worthRaw == null ? null : parseFormattedNumber(worthRaw);
    const entries = [];
    if (put > 0) entries.push({ id: uid(), date, kind: "add", amount: put });
    if (worth != null && worth >= 0 && !(put > 0 && worth === put)) entries.push({ id: uid(), date, kind: "value", amount: worth });
    const newId = await state.db.addInvestment({ ...base, entries });
    toast("Investment added");
    if (newId && state.investments.some((i) => i.id === newId)) renderInvDialog(newId);
    else closeDlg();
  } catch (err) {
    toast("Couldn't save: " + (err.message || err));
  }
}

function renderInvDialog(id, kind = "add") {
  const inv = state.investments.find((i) => i.id === id);
  const dlg = $("#settingsDialog");
  if (!inv) { if (dlg.open) dlg.close(); return; }
  state.invId = id;
  const [, emoji, tname] = typeInfo(inv.type);
  const link = investCategory();
  dlg.innerHTML = `
    <div class="dlg-body">
      <div class="inv-dlg-head">
        <div class="cat-emoji" style="--c:${typeColor(inv.type)}">${emoji}</div>
        <div class="cat-name"><h2>${esc(inv.name)}</h2><small>${esc(tname)} · ${esc(ownerLabel(inv.owner))}</small></div>
      </div>
      <div id="invDlgStats"></div>
      <form id="entryForm" class="entry-form" autocomplete="off" data-link="${link ? esc(link.id) : ""}">
        <label>What happened?
          <select name="kind" id="entryKind">
            <option value="add" ${kind === "add" ? "selected" : ""}>➕ I added money</option>
            <option value="withdraw" ${kind === "withdraw" ? "selected" : ""}>➖ I withdrew money</option>
            <option value="value" ${kind === "value" ? "selected" : ""}>🏷️ Update what it's worth now</option>
          </select>
        </label>
        <div class="row2">
          <label>Date<input type="date" name="date" value="${todayYmd()}" required></label>
          <label><span id="amtLabel">Amount added</span><input type="text" name="amount" inputmode="decimal" placeholder="0" required></label>
        </div>
        ${link ? `<label class="check" id="alsoRow"><input type="checkbox" name="alsoExpense" checked><span>Also count it as spending in ${esc(link.emoji)} ${esc(link.name)}</span></label>` : ""}
        <button class="btn btn-primary" type="submit">Save entry</button>
      </form>
      <h3>History</h3>
      <div id="invDlgEntries"></div>
      <div class="dlg-actions">
        <button class="btn btn-ghost" data-act="inv-del" data-id="${esc(id)}">Delete</button>
        <button class="btn btn-soft" data-act="inv-edit" data-id="${esc(id)}">Edit details</button>
        <button class="btn btn-primary" data-act="close-settings">Done</button>
      </div>
    </div>`;
  fillInvDialogDynamic(inv);
  syncEntryForm();
  if (!dlg.open) dlg.showModal();
}

function fillInvDialogDynamic(inv) {
  const stats = $("#invDlgStats");
  const list = $("#invDlgEntries");
  if (!stats || !list) return;
  const r = invReplay(inv);
  stats.innerHTML = `
    <div class="inv-dlg-stats">
      <div><small>Worth now</small><b>${fmt(r.value)}</b></div>
      <div><small>Invested</small><b>${fmt(r.net)}</b></div>
      <div><small>Gain / loss</small>${gainChip(r.gain, r.put > 0 ? r.gain / r.put : null)}</div>
    </div>`;
  const entries = sortedEntries(inv).reverse();
  list.innerHTML = entries.length
    ? entries.map((e) => `
        <div class="entry-row">
          <div><b>${KIND_LABEL[e.kind] || "Entry"}</b><small>${esc(e.date)}${e.expenseId ? " · counted as spending" : ""}</small></div>
          <b>${fmt(e.amount)}</b>
          <button class="icon-btn sm" data-act="entry-del" data-id="${esc(e.id)}" aria-label="Delete entry">🗑️</button>
        </div>`).join("")
    : `<small>No entries yet. Add money or set its current value above.</small>`;
}

function refreshInvDialog() {
  const dlg = $("#settingsDialog");
  if (!dlg || !dlg.open || !state.invId || !$("#invDlgStats")) return;
  const inv = state.investments.find((i) => i.id === state.invId);
  if (!inv) { dlg.close(); return; }
  fillInvDialogDynamic(inv);
}

function syncEntryForm() {
  const f = $("#entryForm");
  if (!f) return;
  const k = f.elements.kind.value;
  $("#amtLabel").textContent = k === "value" ? "Worth now" : k === "withdraw" ? "Amount withdrawn" : "Amount added";
  $("#alsoRow")?.classList.toggle("hide", k !== "add");
}

async function saveEntry(form) {
  if (needDbUpdate()) return;
  const inv = state.investments.find((i) => i.id === state.invId);
  if (!inv) return;
  const fd = new FormData(form);
  const kind = ["add", "withdraw", "value"].includes(fd.get("kind")) ? fd.get("kind") : "add";
  const amount = parseFormattedNumber(fd.get("amount"));
  const date = String(fd.get("date") || todayYmd());
  if (!(amount >= 0) || (kind !== "value" && amount === 0)) { toast("Enter an amount."); return; }
  const entry = { id: uid(), date, kind, amount };
  try {
    const catId = form.dataset.link;
    if (kind === "add" && catId && fd.get("alsoExpense")) {
      const expId = await state.db.addExpense({ date, amount, categoryId: catId, paidBy: inv.owner, note: `Invest: ${inv.name}` });
      if (expId) entry.expenseId = expId;
    }
    await state.db.saveInvestment(inv.id, { name: inv.name, type: inv.type, owner: inv.owner, note: inv.note || "", entries: [...(inv.entries || []), entry] });
    form.elements.amount.value = "";
    toast(kind === "value" ? "Value updated" : kind === "add" ? "Money added" : "Withdrawal saved");
  } catch (err) {
    toast("Couldn't save: " + (err.message || err));
  }
}

async function deleteEntry(entryId) {
  if (needDbUpdate()) return;
  const inv = state.investments.find((i) => i.id === state.invId);
  const e = inv?.entries?.find((x) => x.id === entryId);
  if (!inv || !e) return;
  if (!confirm("Delete this entry?")) return;
  try {
    if (e.expenseId) await state.db.deleteExpense(e.expenseId).catch(() => {});
    await state.db.saveInvestment(inv.id, { name: inv.name, type: inv.type, owner: inv.owner, note: inv.note || "", entries: inv.entries.filter((x) => x.id !== entryId) });
    toast("Entry deleted");
  } catch (err) {
    toast("Couldn't delete: " + (err.message || err));
  }
}

async function deleteInvestment(id) {
  if (needDbUpdate()) return;
  const inv = state.investments.find((i) => i.id === id);
  if (!inv) return;
  if (!confirm(`Delete "${inv.name}" and all its history?`)) return;
  try {
    for (const e of inv.entries || []) if (e.expenseId) await state.db.deleteExpense(e.expenseId).catch(() => {});
    await state.db.deleteInvestment(id);
    closeDlg();
    toast("Investment deleted");
  } catch (err) {
    toast("Couldn't delete: " + (err.message || err));
  }
}

/* ================================================================== */
/* Piggy Wrapped (Couple Year in Review)                               */
/* ================================================================== */
let currentWrappedSlide = 0;
let currentWrappedData = null;

function handleWrappedKeyDown(e) {
  if (e.key === "Escape") {
    closeWrappedStory();
  } else if (e.key === "ArrowRight" || e.key === " ") {
    advanceWrappedSlide(1);
  } else if (e.key === "ArrowLeft") {
    advanceWrappedSlide(-1);
  }
}

function getWrappedSlideKeys(w) {
  const keys = ["welcome", "savings"];
  if (w?.investments?.hasInvestments) {
    keys.push("investments");
  }
  keys.push("categories", "generosity", "mascot", "archetype");
  return keys;
}

function openWrappedStory() {
  const s = settings();
  currentWrappedData = generateWrappedData({
    year: state.year,
    budget: budgetFor(state.year).b,
    expenses: state.expenses,
    investments: state.investments || [],
    settings: s,
  });
  currentWrappedSlide = 0;
  window.addEventListener("keydown", handleWrappedKeyDown);
  renderWrappedStory();
}

function closeWrappedStory() {
  window.removeEventListener("keydown", handleWrappedKeyDown);
  const el = $("#wrappedModal");
  if (el) {
    el.classList.add("closing");
    setTimeout(() => el.remove(), 200);
  }
}

function advanceWrappedSlide(delta) {
  if (!currentWrappedData) return;
  const slideKeys = getWrappedSlideKeys(currentWrappedData);
  const next = currentWrappedSlide + delta;
  if (next < 0) return;
  if (next >= slideKeys.length) {
    closeWrappedStory();
    return;
  }
  currentWrappedSlide = next;
  renderWrappedStory();
}

function renderWrappedStory() {
  if (!currentWrappedData) return;
  const w = currentWrappedData;
  const s = settings();
  const topCat = w.topCategories?.[0] || null;
  const runners = (w.topCategories || []).slice(1, 3);
  const { b } = budgetFor(state.year);
  const idx = spendIndex(state.year);
  const slideKeys = getWrappedSlideKeys(w);
  const activeSlideKey = slideKeys[currentWrappedSlide] || "welcome";

  let slideHtml = "";
  switch (activeSlideKey) {
    case "welcome":
      slideHtml = `
        <div class="story-slide slide-welcome">
          <div class="story-badge">🎁 ${w.isYtd ? `${w.year} Year-to-Date Wrapped` : `Piggy Wrapped ${w.year}`}</div>
          <div class="story-mascot-hero">${w.mascot.emoji}</div>
          <h1 class="story-title">${esc(s.familyName)}'s ${w.year}</h1>
          <p class="story-subtitle">${w.isYtd ? `January – ${w.endMonthName} ${w.year} (Year-to-Date)` : `Ready to see how you handled your money together in ${w.year}?`}</p>
          <div class="story-hint">Tap anywhere on the right to continue →</div>
        </div>`;
      break;
    case "savings":
      slideHtml = `
        <div class="story-slide slide-savings">
          <div class="story-badge">🌱 The Big Picture</div>
          <div class="story-stat-hero">
            <span class="story-stat-label">TOTAL SAVED (${w.isYtd ? `JAN – ${w.endMonthShortName.toUpperCase()}` : w.year})</span>
            <b class="story-stat-number saved-glow">${fmt(w.totalSaved)}</b>
            <span class="story-stat-sub">toward your shared future!</span>
          </div>
          <div class="story-dual-stats">
            <div class="story-dual-card">
              <small>Spent so far</small>
              <b>${fmt(w.totalSpent)}</b>
            </div>
            <div class="story-dual-card">
              <small>${w.isYtd ? `YTD Budget (${w.elapsedMonths} mos)` : "Annual Budget"}</small>
              <b>${fmt(w.isYtd ? w.ytdBudget : w.totalBudget)}</b>
            </div>
          </div>
          ${(w.isYtd ? w.ytdBudget : w.totalBudget) > 0 ? `<div class="story-pill-tag">✨ ${((w.totalSaved / (w.isYtd ? w.ytdBudget : w.totalBudget)) * 100).toFixed(0)}% of budget saved</div>` : ""}
        </div>`;
      break;
    case "investments": {
      const invNetGain = w.investments?.totalGain || 0;
      const invGainPct = (w.investments?.totalInvested || 0) > 0 ? (invNetGain / w.investments.totalInvested) * 100 : 0;
      slideHtml = `
        <div class="story-slide slide-investments">
          <div class="story-badge">📈 Wealth & Investments</div>
          <div class="story-stat-hero">
            <span class="story-stat-label">Portfolio Value</span>
            <b class="story-stat-number saved-glow">${fmt(w.investments?.portfolioValue || 0)}</b>
            <span class="story-stat-sub">Growing your nest egg together!</span>
          </div>
          <div class="story-dual-stats">
            <div class="story-dual-card">
              <small>Total Invested</small>
              <b>${fmt(w.investments?.totalInvested || 0)}</b>
            </div>
            <div class="story-dual-card">
              <small>Net Return</small>
              <b style="color:${invNetGain >= 0 ? '#4ade80' : '#f87171'}">${invNetGain >= 0 ? "+" : ""}${fmt(invNetGain)} <small>(${invGainPct >= 0 ? "+" : ""}${invGainPct.toFixed(1)}%)</small></b>
            </div>
          </div>
          <div class="story-pill-tag">🌱 Compounding for your future</div>
        </div>`;
      break;
    }
    case "categories":
      slideHtml = `
        <div class="story-slide slide-categories">
          <div class="story-badge">📊 Spending Spotlight</div>
          ${topCat ? `
            <div class="story-ranked-hero">
              <div class="story-ranked-medal">🥇 #1 Category</div>
              <div class="story-cat-emoji">${topCat.emoji}</div>
              <h2 class="story-cat-name">${esc(topCat.name)}</h2>
              <b class="story-cat-amount">${fmt(topCat.totalSpent)}</b>
              <span class="story-cat-pct">${topCat.percentage.toFixed(1)}% of all spending</span>
            </div>
            ${runners.length > 0 ? `
              <div class="story-runners-box">
                <small class="story-runners-title">Runner Ups</small>
                ${runners.map((r, i) => `
                  <div class="story-runner-item">
                    <span>#${i + 2} ${r.emoji} ${esc(r.name)}</span>
                    <b>${fmt(r.totalSpent)} <small>(${r.percentage.toFixed(0)}%)</small></b>
                  </div>
                `).join("")}
              </div>
            ` : ""}
          ` : `
            <div class="story-empty-notice">
              <div style="font-size:3rem;margin-bottom:12px;">📝</div>
              <p>No expenses logged for ${w.year} yet!</p>
            </div>
          `}
        </div>`;
      break;
    case "generosity":
      slideHtml = `
        <div class="story-slide slide-generosity">
          <div class="story-badge">💖 The Generosity Award</div>
          <div class="story-award-hero">
            <div class="story-award-crown">👑</div>
            <div class="story-award-winner">${w.generosityAward.emoji} ${esc(w.generosityAward.name)}</div>
            <p class="story-award-tagline">${w.generosityAward.winner === "tie" ? "You shared the financial load equally!" : `won the Generosity Award for ${w.year}!`}</p>
          </div>
          <div class="story-partner-split">
            <div class="story-partner-col">
              <span class="partner-avatar">${esc(s.persons[0].emoji)}</span>
              <b>${esc(s.persons[0].name)}</b>
              <span class="partner-pct">${w.partnerShares.p1Percent.toFixed(0)}%</span>
              <small class="partner-amt">${fmt(w.partnerShares.p1)}</small>
            </div>
            <div class="story-partner-vs">vs</div>
            <div class="story-partner-col">
              <span class="partner-avatar">${esc(s.persons[1].emoji)}</span>
              <b>${esc(s.persons[1].name)}</b>
              <span class="partner-pct">${w.partnerShares.p2Percent.toFixed(0)}%</span>
              <small class="partner-amt">${fmt(w.partnerShares.p2)}</small>
            </div>
          </div>
          ${w.partnerShares.both > 0 ? `<div class="story-shared-note">🤝 Plus ${fmt(w.partnerShares.both)} shared together 50/50</div>` : ""}
        </div>`;
      break;
    case "mascot":
      slideHtml = `
        <div class="story-slide slide-mascot">
          <div class="story-badge">🐾 Mascot Happiness</div>
          <div class="story-mascot-score">
            <div class="story-mascot-big">${w.mascot.emoji}</div>
            <h2 class="story-mascot-headline">${esc(w.mascot.name)} was happy ${w.happyMonthsCount} out of ${w.happyMonthsTotal} months so far! ✨</h2>
            <div class="story-month-dots">
              ${Array.from({ length: 12 }, (_, i) => {
                if (i >= w.happyMonthsTotal) {
                  return `<span class="story-dot dot-future" title="${MONTHS[i]} (upcoming)"></span>`;
                }
                const monthBudget = b.total > 0 ? b.total / 12 : 0;
                const isHappy = monthBudget > 0 && (idx.months[i]?.total || 0) <= monthBudget;
                return `<span class="story-dot ${isHappy ? "dot-happy" : "dot-missed"}" title="${MONTHS[i]}"></span>`;
              }).join("")}
            </div>
          </div>
          <div class="story-best-month-card">
            <span class="best-month-label">🌟 Best Month</span>
            <b class="best-month-name">${esc(w.topMonth.name)}</b>
            <span class="best-month-stat">${w.topMonth.saved > 0 ? `${fmt(w.topMonth.saved)} saved!` : `Lowest spending (${fmt(w.topMonth.spent)})`}</span>
          </div>
        </div>`;
      break;
    case "archetype":
    default:
      slideHtml = `
        <div class="story-slide slide-archetype">
          <div class="story-badge">✨ Your Financial Superpower</div>
          <div class="story-archetype-card">
            <div class="archetype-emoji-badge">${w.archetype.emoji}</div>
            <h2 class="archetype-title">${esc(w.archetype.title)}</h2>
            <p class="archetype-desc">${esc(w.archetype.description)}</p>
          </div>
          <div class="story-summary-chips">
            <span class="story-chip">🌱 Saved: ${fmt(w.totalSaved)}</span>
            <span class="story-chip">👑 Generosity: ${esc(w.generosityAward.name)}</span>
            <span class="story-chip">🐾 ${w.happyMonthsCount}/12 Happy</span>
            ${w.investments?.hasInvestments ? `<span class="story-chip">📈 Wealth: ${fmt(w.investments.portfolioValue)}</span>` : ""}
          </div>
          <div class="story-final-actions">
            <button type="button" class="btn btn-primary" id="btnDownloadWrappedCard" data-act="download-wrapped">📸 Save Story Card</button>
            <button type="button" class="btn btn-ghost" data-act="close-wrapped">Back to Dashboard</button>
          </div>
        </div>`;
      break;
  }

  let el = $("#wrappedModal");
  if (!el) {
    el = document.createElement("div");
    el.id = "wrappedModal";
    el.className = "wrapped-modal";
    document.body.appendChild(el);
  }

  el.innerHTML = `
    <div class="wrapped-modal-inner">
      <div class="story-progress-bar">
        ${slideKeys.map((_, i) => `
          <div class="story-progress-seg ${i <= currentWrappedSlide ? "filled" : ""}"></div>
        `).join("")}
      </div>
      <div class="story-header">
        <div class="story-brand">
          <span>${w.mascot.emoji}</span>
          <span>Piggy Wrapped ${w.year}</span>
        </div>
        <button type="button" class="story-close-btn" data-act="close-wrapped" aria-label="Close">✕</button>
      </div>

      <div class="story-tap-zone tap-prev" data-act="wrapped-prev"></div>
      <div class="story-tap-zone tap-next" data-act="wrapped-next"></div>

      <div class="story-content-area">
        ${slideHtml}
      </div>

      <div class="story-bottom-nav">
        ${currentWrappedSlide > 0 ? `
          <button type="button" class="btn btn-ghost sm story-nav-btn" data-act="wrapped-prev">‹ Back</button>
        ` : `<div style="width:55px;"></div>`}

        <span class="story-slide-counter">${currentWrappedSlide + 1} / ${slideKeys.length}</span>

        ${currentWrappedSlide < slideKeys.length - 1 ? `
          <button type="button" class="btn btn-soft sm story-nav-btn" data-act="wrapped-next">Next ›</button>
        ` : `<div style="width:55px;"></div>`}
      </div>
    </div>`;
}

function wrapCanvasText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = String(text || "").split(" ");
  let line = "";
  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + " ";
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && n > 0) {
      ctx.fillText(line.trim(), x, y);
      line = words[n] + " ";
      y += lineHeight;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line.trim(), x, y);
  return y;
}

function drawCanvasCard(ctx, x, y, w, h, r, fill, stroke) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.rect(x, y, w, h);
  }
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function downloadWrappedCard(w) {
  if (!w) return;
  const s = settings();
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1920;
  const ctx = canvas.getContext("2d");

  // Determine theme colors
  const themeId = s.theme || "default";
  let grad1 = "#251821";
  let grad2 = "#140e13";
  let accent = "#ff8fb1";
  if (themeId === "mocha") {
    grad1 = "#2c211b";
    grad2 = "#17110e";
    accent = "#d4a373";
  } else if (themeId === "matcha") {
    grad1 = "#1d2b1f";
    grad2 = "#0e1710";
    accent = "#7cb587";
  } else if (themeId === "lavender") {
    grad1 = "#251c36";
    grad2 = "#130e1d";
    accent = "#a688fa";
  } else if (themeId === "honey") {
    grad1 = "#32220f";
    grad2 = "#191107";
    accent = "#f4b251";
  }

  // 1. Background gradient
  const bgGrad = ctx.createLinearGradient(0, 0, 0, 1920);
  bgGrad.addColorStop(0, grad1);
  bgGrad.addColorStop(1, grad2);
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, 1080, 1920);

  // 2. Ambient glows
  const glow1 = ctx.createRadialGradient(920, 280, 20, 920, 280, 500);
  glow1.addColorStop(0, accent + "33");
  glow1.addColorStop(1, "transparent");
  ctx.fillStyle = glow1;
  ctx.fillRect(0, 0, 1080, 1920);

  const glow2 = ctx.createRadialGradient(160, 1400, 20, 160, 1400, 500);
  glow2.addColorStop(0, accent + "22");
  glow2.addColorStop(1, "transparent");
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, 1080, 1920);

  // 3. Top pill badge
  const badgeW = w.isYtd ? 500 : 390;
  drawCanvasCard(ctx, 80, 130, badgeW, 56, 28, "rgba(255,255,255,0.12)", "rgba(255,255,255,0.2)");
  ctx.font = "bold 24px Nunito, Fredoka, system-ui, sans-serif";
  ctx.fillStyle = accent;
  ctx.textAlign = "left";
  ctx.fillText(`🎁 PIGGYNEST WRAPPED ${w.isYtd ? `YTD (JAN–${w.endMonthShortName.toUpperCase()})` : w.year}`, 108, 167);

  // 4. Family Name & Title
  ctx.font = "600 38px Nunito, Fredoka, system-ui, sans-serif";
  ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
  ctx.fillText(`${s.familyName || "Our Cozy Family"}'s`, 80, 240);

  ctx.font = "800 76px Nunito, Fredoka, system-ui, sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.fillText("Year in Review", 80, 320);

  // 5. Archetype Hero Box
  drawCanvasCard(ctx, 80, 370, 920, 290, 26, "rgba(255,255,255,0.09)", "rgba(255,255,255,0.16)");
  ctx.font = "92px serif";
  ctx.textAlign = "center";
  ctx.fillText(w.archetype.emoji || "🏆", 170, 510);

  ctx.textAlign = "left";
  ctx.font = "bold 44px Nunito, Fredoka, system-ui, sans-serif";
  ctx.fillStyle = "#fde68a";
  ctx.fillText(w.archetype.title, 260, 460);

  ctx.font = "400 28px Nunito, Fredoka, system-ui, sans-serif";
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  wrapCanvasText(ctx, w.archetype.description, 260, 515, 710, 38);

  const hasInv = Boolean(w.investments?.hasInvestments);
  if (hasInv) {
    // 5 Compact Cards layout to fit investments
    // Card 1: Total Saved
    drawCanvasCard(ctx, 80, 680, 920, 175, 20, "rgba(255,255,255,0.08)", "rgba(255,255,255,0.12)");
    ctx.font = "bold 20px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = accent;
    ctx.fillText(`TOTAL SAVED (${w.isYtd ? `JAN–${w.endMonthShortName.toUpperCase()}` : w.year})`, 120, 725);
    ctx.font = "800 48px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = "#4ade80";
    ctx.fillText(fmt(w.totalSaved), 120, 785);
    ctx.font = "400 22px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.65)";
    ctx.fillText(`${w.isYtd ? `YTD Budget (${w.elapsedMonths} mos): ${fmt(w.ytdBudget)}` : `Annual Budget: ${fmt(w.totalBudget)}`}  •  Total Spent: ${fmt(w.totalSpent)}`, 120, 825);

    // Card 2: Wealth & Investments
    drawCanvasCard(ctx, 80, 875, 920, 175, 20, "rgba(255,255,255,0.08)", "rgba(255,255,255,0.12)");
    ctx.font = "bold 20px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = accent;
    ctx.fillText("WEALTH & INVESTMENTS", 120, 920);
    ctx.font = "800 48px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = "#60a5fa";
    ctx.fillText(fmt(w.investments.portfolioValue), 120, 980);
    ctx.font = "400 22px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.65)";
    const gainStr = `${w.investments.totalGain >= 0 ? "+" : ""}${fmt(w.investments.totalGain)}`;
    ctx.fillText(`Invested: ${fmt(w.investments.totalInvested)}  •  Net Return: ${gainStr}`, 120, 1020);

    // Card 3: Top Spending Category
    drawCanvasCard(ctx, 80, 1070, 920, 175, 20, "rgba(255,255,255,0.08)", "rgba(255,255,255,0.12)");
    ctx.font = "bold 20px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = accent;
    ctx.fillText("TOP SPENDING CATEGORY", 120, 1115);
    const topC = w.topCategories?.[0];
    ctx.font = "800 46px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(`${topC?.emoji || "📦"} ${topC?.name || "None yet"}`, 120, 1175);
    ctx.font = "400 22px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.65)";
    ctx.fillText(topC ? `${fmt(topC.totalSpent)}  (${topC.percentage.toFixed(1)}% of total spend)` : "No expenses recorded", 120, 1215);

    // Card 4: Generosity Award
    drawCanvasCard(ctx, 80, 1265, 920, 175, 20, "rgba(255,255,255,0.08)", "rgba(255,255,255,0.12)");
    ctx.font = "bold 20px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = accent;
    ctx.fillText("THE GENEROSITY AWARD", 120, 1310);
    ctx.font = "800 46px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = "#fef08a";
    ctx.fillText(`👑 ${w.generosityAward.name}`, 120, 1370);
    ctx.font = "400 22px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.65)";
    ctx.fillText(`${s.persons[0].name} (${w.partnerShares.p1Percent.toFixed(0)}%) vs ${s.persons[1].name} (${w.partnerShares.p2Percent.toFixed(0)}%)`, 120, 1410);

    // Card 5: Mascot Happiness & Best Month
    drawCanvasCard(ctx, 80, 1460, 920, 175, 20, "rgba(255,255,255,0.08)", "rgba(255,255,255,0.12)");
    ctx.font = "bold 20px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = accent;
    ctx.fillText(`${w.mascot.name.toUpperCase()} HAPPINESS`, 120, 1505);
    ctx.font = "800 42px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(`${w.mascot.emoji} ${w.happyMonthsCount} / ${w.happyMonthsTotal} Happy Months! ✨`, 120, 1565);
    ctx.font = "400 22px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.65)";
    ctx.fillText(`Best Month: ${w.topMonth.name} (${fmt(w.topMonth.saved)} saved)`, 120, 1605);
  } else {
    // Standard 4 Cards layout
    drawCanvasCard(ctx, 80, 690, 920, 200, 22, "rgba(255,255,255,0.08)", "rgba(255,255,255,0.12)");
    ctx.font = "bold 22px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = accent;
    ctx.fillText(`TOTAL SAVED (${w.isYtd ? `JAN–${w.endMonthShortName.toUpperCase()}` : w.year})`, 120, 740);
    ctx.font = "800 56px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = "#4ade80";
    ctx.fillText(fmt(w.totalSaved), 120, 810);
    ctx.font = "400 24px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.65)";
    ctx.fillText(`${w.isYtd ? `YTD Budget (${w.elapsedMonths} mos): ${fmt(w.ytdBudget)}` : `Annual Budget: ${fmt(w.totalBudget)}`}  •  Total Spent: ${fmt(w.totalSpent)}`, 120, 855);

    drawCanvasCard(ctx, 80, 920, 920, 200, 22, "rgba(255,255,255,0.08)", "rgba(255,255,255,0.12)");
    ctx.font = "bold 22px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = accent;
    ctx.fillText("TOP SPENDING CATEGORY", 120, 970);
    const topC = w.topCategories?.[0];
    ctx.font = "800 50px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(`${topC?.emoji || "📦"} ${topC?.name || "None yet"}`, 120, 1038);
    ctx.font = "400 24px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.65)";
    ctx.fillText(topC ? `${fmt(topC.totalSpent)}  (${topC.percentage.toFixed(1)}% of total spend)` : "No expenses recorded", 120, 1080);

    drawCanvasCard(ctx, 80, 1150, 920, 200, 22, "rgba(255,255,255,0.08)", "rgba(255,255,255,0.12)");
    ctx.font = "bold 22px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = accent;
    ctx.fillText("THE GENEROSITY AWARD", 120, 1200);
    ctx.font = "800 50px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = "#fef08a";
    ctx.fillText(`👑 ${w.generosityAward.name}`, 120, 1268);
    ctx.font = "400 24px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.65)";
    ctx.fillText(`${s.persons[0].name} (${w.partnerShares.p1Percent.toFixed(0)}%) vs ${s.persons[1].name} (${w.partnerShares.p2Percent.toFixed(0)}%) partner split`, 120, 1310);

    drawCanvasCard(ctx, 80, 1380, 920, 190, 22, "rgba(255,255,255,0.08)", "rgba(255,255,255,0.12)");
    ctx.font = "bold 22px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = accent;
    ctx.fillText(`${w.mascot.name.toUpperCase()} HAPPINESS`, 120, 1430);
    ctx.font = "800 44px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(`${w.mascot.emoji} ${w.happyMonthsCount} / ${w.happyMonthsTotal} Happy Months! ✨`, 120, 1492);
    ctx.font = "400 24px Nunito, Fredoka, system-ui, sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.65)";
    ctx.fillText(`Best Month: ${w.topMonth.name} (${fmt(w.topMonth.saved)} saved)`, 120, 1534);
  }

  // 10. Footer
  ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(80, 1680);
  ctx.lineTo(1000, 1680);
  ctx.stroke();

  ctx.font = "600 30px Nunito, Fredoka, system-ui, sans-serif";
  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  ctx.fillText("PiggyNest • Cozy Couple Budgeting", 80, 1750);

  ctx.font = "40px serif";
  ctx.textAlign = "right";
  ctx.fillText(w.mascot.emoji, 1000, 1750);

  // 11. Trigger PNG download with Web Share API and fail-safe preview modal
  const safeFamily = (s.familyName || "PiggyNest").replace(/[^a-zA-Z0-9_-]/g, "_");
  const fileName = `${safeFamily}-${w.year}-Wrapped.png`;
  const dataUrl = canvas.toDataURL("image/png");

  canvas.toBlob(async (blob) => {
    if (blob) {
      const file = new File([blob], fileName, { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            title: `${s.familyName}'s ${w.year} Piggy Wrapped`,
            text: `Check out our ${w.year} PiggyNest Wrapped! 🎁`,
            files: [file],
          });
          toast("📸 Story card shared!");
        } catch (err) {
          if (err.name !== "AbortError") {
            console.warn("navigator.share error:", err);
          }
        }
      }
    }

    // Show fail-safe preview modal for touch & hold on mobile devices
    showStoryCardModal(dataUrl, fileName);

    // Also trigger direct download for desktop & Android browsers
    try {
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      toast("📸 Story card downloaded!");
    } catch (e) {
      console.warn("Direct download link trigger:", e);
    }
  }, "image/png");
}

function showStoryCardModal(dataUrl, fileName) {
  let modal = $("#storyPreviewModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "storyPreviewModal";
    modal.className = "story-preview-modal";
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div class="story-preview-inner">
      <button type="button" class="story-preview-close" data-act="close-story-preview" aria-label="Close">✕</button>
      <h3 style="margin:0 0 4px;color:#fff;font-size:1.15rem;">📸 Your ${state.year} Story Card</h3>
      <div class="story-preview-scroll">
        <img src="${dataUrl}" class="story-preview-img" alt="Story Card">
      </div>
      <p class="story-save-hint">💡 On iPhone & Android: <b>Touch & hold the image</b> to "Save to Photos" or tap Download below.</p>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;width:100%;">
        <a href="${dataUrl}" download="${fileName}" class="btn btn-primary" style="flex:1;min-width:140px;">Download Image</a>
        <button type="button" class="btn btn-ghost" data-act="close-story-preview">Done</button>
      </div>
    </div>`;
}

/* ================================================================== */
/* Settings dialog                                                     */
/* ================================================================== */
function openSettings() {
  const s = settings();
  const dlg = $("#settingsDialog");
  const hasNotif = "Notification" in window;
  const notifPerm = hasNotif ? Notification.permission : "unsupported";
  const notifEnabled = notifPerm === "granted";
  dlg.innerHTML = `
    <div class="dlg-body">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
        <h2 style="margin:0;">Family settings</h2>
        ${proBadgeHtml(s)}
      </div>
      <label>Family name<input id="setFamily" value="${esc(s.familyName)}" maxlength="30"></label>
      <label>Currency
        <select id="setCurrency">${CURRENCIES.map((cur) => `<option ${cur === s.currency ? "selected" : ""}>${cur}</option>`).join("")}</select>
      </label>
      <label>Monthly savings goal<input id="setSavingsGoal" type="number" min="0" step="any" value="${s.savingsGoal || ""}" placeholder="0"></label>
      <label>Theme
        <div class="choice-pills" id="themePicker">
          ${THEMES.map((t) => `<button type="button" class="choice-pill ${t.id === (s.theme || "default") ? "active" : ""}" data-theme-id="${t.id}"><span>${t.emoji}</span><span>${esc(t.name)}</span>${t.pro ? `<span class="pill-pro-tag">PRO</span>` : ""}</button>`).join("")}
        </div>
      </label>
      <label>Mascot
        <div class="choice-pills" id="mascotPicker">
          ${MASCOTS.map((m) => `<button type="button" class="choice-pill ${m.id === (s.mascot || "piggy") ? "active" : ""}" data-mascot-id="${m.id}"><span>${m.emoji}</span><span>${esc(m.name)}</span>${m.pro ? `<span class="pill-pro-tag">PRO</span>` : ""}</button>`).join("")}
        </div>
      </label>
      ${PERSON_KEYS.map((k, i) => `
        <div class="dlg-people">
          <label>Emoji<input id="setEmoji${i}" value="${esc(s.persons[i].emoji)}" maxlength="4" style="text-align:center"></label>
          <label>Person ${i + 1}<input id="setName${i}" value="${esc(s.persons[i].name)}" maxlength="20"></label>
        </div>`).join("")}
      <div class="dlg-notif-row">
        <div>
          <div class="dlg-notif-label">
            <span>🔔</span>
            <b>Bill Due Reminders</b>
            <span class="chip ${notifEnabled ? "chip-notif-on" : "chip-notif-off"}">${notifEnabled ? "Enabled" : "Disabled"}</span>
          </div>
          <small class="dlg-notif-sub">Get notified on D-Day so you never miss a payment</small>
        </div>
        <div>
          ${notifEnabled
            ? `<button type="button" class="btn btn-soft sm" data-act="test-notification">Send test notification</button>`
            : `<button type="button" class="btn btn-primary sm" data-act="req-notifications-settings">Enable notifications</button>`
          }
        </div>
      </div>
      <div class="dlg-pro-box">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:6px;">
            <span>👑</span>
            <b>Piggy Pro Membership</b>
            <span class="chip ${isPro(s, state.user) ? "chip-pro-active" : "chip-pro-free"}">${isPro(s, state.user) ? "PRO ACTIVE" : "FREE MODE"}</span>
          </div>
          <button type="button" class="btn btn-soft sm" data-act="open-pro">${isPro(s, state.user) ? "Manage Subscription" : "✨ Subscribe on PayPal"}</button>
        </div>
        <small style="color:var(--ink-soft);display:block;margin:6px 0 0;">${isPro(s, state.user) ? (s.subscriptionId ? `Subscribed via PayPal (${esc(s.subscriptionId)}). All 5 Phase 5 superpowers unlocked!` : "All 5 Phase 5 superpowers are unlocked on your nest.") : `Subscribe with PayPal (${esc(PRO_PRICE)}) to unlock Piggy Jars, Partner Reactions, Cap Alerts, CSV Export, and Compound Projector.`}</small>
      </div>
      <div class="dlg-backup">
        <small style="font-weight:700;color:var(--ink-soft);text-transform:uppercase;letter-spacing:0.5px;">Backup & Data Export</small>
        <div class="dlg-backup-btns">
          <button type="button" class="btn btn-soft" data-act="export-expenses-csv">📊 Download Expenses CSV <span class="pill-pro-tag">PRO</span></button>
          <button type="button" class="btn btn-soft" data-act="export-investments-csv">📈 Download Investments & Portfolio CSV <span class="pill-pro-tag">PRO</span></button>
          <button type="button" class="btn btn-soft" data-act="export-json">💾 Backup all data (JSON)</button>
          <button type="button" class="btn btn-soft" data-act="restore-json-btn">📥 Restore from JSON</button>
          <input type="file" id="restoreJsonFile" accept=".json,application/json" class="hide">
        </div>
      </div>
      <div class="dlg-actions">
        <button class="btn btn-ghost" data-act="close-settings">Cancel</button>
        <button class="btn btn-primary" data-act="save-settings">Save</button>
      </div>
    </div>`;
  dlg.showModal();
}

async function saveSettings() {
  const curr = settings();
  const goalIn = $("#setSavingsGoal");
  const savingsGoal = goalIn ? (Number(goalIn.value) || 0) : (curr.savingsGoal || 0);
  let selectedTheme = $("#themePicker .choice-pill.active")?.dataset.themeId || curr.theme || "default";
  let selectedMascot = $("#mascotPicker .choice-pill.active")?.dataset.mascotId || curr.mascot || "piggy";

  // Prevent non-pro users from saving pro theme or mascot
  if (!isPro(curr, state.user)) {
    if (getTheme(selectedTheme).pro) selectedTheme = "default";
    if (getMascot(selectedMascot).pro) selectedMascot = "piggy";
  }

  const next = {
    familyName: $("#setFamily").value.trim() || "Our Cozy Family",
    currency: $("#setCurrency").value,
    savingsGoal,
    theme: selectedTheme,
    mascot: selectedMascot,
    pro: Boolean(curr.pro),
    proUntil: curr.proUntil || null,
    subscriptionId: curr.subscriptionId || null,
    trialUsed: Boolean(curr.trialUsed || false),
    persons: PERSON_KEYS.map((k, i) => ({
      id: k,
      name: $(`#setName${i}`).value.trim() || `Person ${i + 1}`,
      emoji: $(`#setEmoji${i}`).value.trim() || (i ? "🌿" : "🌸"),
    })),
  };
  try {
    await state.db.saveSettings(next);
  } catch (err) {
    toast("Couldn't save: " + (err.message || err));
    return;
  }
  applyTheme(selectedTheme);
  updateBackground(selectedMascot);
  $("#settingsDialog").close();
  toast("Settings saved");
}

function openSavingsGoalDialog() {
  const s = settings();
  const dlg = $("#settingsDialog");
  dlg.innerHTML = `
    <div class="dlg-body">
      <h2>🎯 Monthly savings goal</h2>
      <p style="color:var(--ink-soft);font-size:0.92rem;margin-top:-4px;">Set how much you aim to save this month from your budget.</p>
      <form id="savingsGoalForm" autocomplete="off">
        <label>Monthly savings goal
          <input id="setGoalInput" type="number" min="0" step="any" inputmode="decimal" value="${s.savingsGoal || ""}" placeholder="0" autofocus>
        </label>
        <div class="dlg-actions">
          <button type="button" class="btn btn-ghost" data-act="close-settings">Cancel</button>
          <button type="submit" class="btn btn-primary">Save goal</button>
        </div>
      </form>
    </div>`;
  if (!dlg.open) dlg.showModal();
  const input = $("#setGoalInput");
  if (input) {
    input.focus();
    input.select();
  }
}

async function submitSavingsGoal(form) {
  const input = form.querySelector("#setGoalInput");
  const amt = Number(input?.value) || 0;
  try {
    await state.db.saveSavingsGoal(amt);
    $("#settingsDialog").close();
    toast("Savings goal updated");
  } catch (err) {
    toast("Couldn't save: " + (err.message || err));
  }
}

function exportCsv() {
  const s = settings();
  const cats = {};
  Object.values(state.budgets).forEach((b) => (b.categories || []).forEach((c) => (cats[c.id] = c.name)));
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["Date", "Category", "Paid by", "Amount", "Note"].map(q).join(",")];
  [...state.expenses].sort((a, b) => a.date.localeCompare(b.date)).forEach((e) =>
    lines.push([e.date, cats[e.categoryId] || "Other", e.paidBy === "both" ? "Together (50:50)" : s.persons[e.paidBy === "p2" ? 1 : 0].name, e.amount, e.note].map(q).join(","))
  );
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: "piggynest-expenses.csv" });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportJson() {
  const payload = createBackupPayload(state);
  const json = JSON.stringify(payload, null, 2);
  const ymd = new Date().toISOString().slice(0, 10);
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `piggynest-backup-${ymd}.json` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast("Backup file downloaded");
}

async function importJson(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const result = validateBackupPayload(text);
    if (!result.valid) {
      toast("Restore failed: " + result.error);
      return;
    }
    const { summary, data } = result;
    const items = [];
    if (summary.hasSettings) items.push("• Family settings");
    if (summary.budgetsCount) items.push(`• ${summary.budgetsCount} yearly plan(s)`);
    if (summary.expensesCount) items.push(`• ${summary.expensesCount} expense(s)`);
    if (summary.investmentsCount) items.push(`• ${summary.investmentsCount} investment(s)`);
    if (summary.recurringCount) items.push(`• ${summary.recurringCount} recurring bill(s)`);
    const proceed = confirm(`Restore backup containing:\n${items.join("\n")}\n\nExisting items will be merged/updated. Proceed?`);
    if (!proceed) return;

    await state.db.restoreAll(data);
    $("#settingsDialog").close();
    toast("Backup restored successfully!");
  } catch (err) {
    toast("Couldn't restore: " + (err.message || err));
  }
}

/* ================================================================== */
/* Sample data (demo mode only)                                        */
/* ================================================================== */
async function loadSample() {
  const cur = settings().currency;
  const scale = { IDR: 1500, JPY: 100, KRW: 1000, VND: 2500, INR: 60, PHP: 50, THB: 35, CNY: 7, MYR: 4 }[cur] || 1;
  const round = (n) => Math.round(n / (scale >= 100 ? 1000 : 1)) * (scale >= 100 ? 1000 : 1);
  const budget = defaultBudget(state.year);
  budget.income = { p1: round(60000 * scale), p2: round(42000 * scale) };
  await state.db.saveBudget(state.year, budget);
  const c = calc(budget);
  const unit = scale >= 100 ? 1000 : 1;
  for (let mo = Math.max(0, state.month - 2); mo <= state.month; mo++) {
    const maxDay = mo === now.getMonth() && state.year === now.getFullYear() ? Math.max(1, now.getDate()) : 28;
    for (const cat of c.cats) {
      const target = cat.monthly * (0.5 + Math.random() * 0.6);
      const parts = 1 + Math.floor(Math.random() * 3);
      for (let p = 0; p < parts; p++) {
        const day = 1 + Math.floor(Math.random() * Math.min(28, maxDay));
        await state.db.addExpense({
          date: `${state.year}-${pad(mo + 1)}-${pad(day)}`,
          amount: Math.max(unit, Math.round(target / parts / unit) * unit),
          categoryId: cat.id,
          paidBy: (() => { const r = Math.random(); return r < 0.25 ? "both" : r < 0.25 + 0.75 * c.r1 ? "p1" : "p2"; })(),
          note: "",
        });
      }
    }
  }
  if (state.db.addInvestment) {
    const y = state.year;
    const valDate = y === now.getFullYear() ? todayYmd() : `${y}-12-28`;
    await state.db.addInvestment({ name: "Gold savings", type: "gold", owner: "both", note: "", entries: [
      { id: uid(), date: `${y}-01-15`, kind: "add", amount: round(1500 * scale) },
      { id: uid(), date: `${y}-02-15`, kind: "add", amount: round(1500 * scale) },
      { id: uid(), date: valDate, kind: "value", amount: round(3320 * scale) } ] });
    await state.db.addInvestment({ name: "Index fund", type: "stocks", owner: "p1", note: "Monthly plan", entries: [
      { id: uid(), date: `${y}-03-10`, kind: "add", amount: round(2000 * scale) },
      { id: uid(), date: `${y}-06-10`, kind: "add", amount: round(2000 * scale) },
      { id: uid(), date: valDate, kind: "value", amount: round(4410 * scale) } ] });
  }
  toast("Sample data loaded");
}

/* ================================================================== */
/* Auth view                                                           */
/* ================================================================== */
function authHtml() {
  return `
    <main class="auth">
      <div class="card auth-card">
        <div class="big">🐷</div>
        <h1>PiggyNest</h1>
        <p>Cozy money tracking for the whole family.</p>
        <form id="authForm">
          <label>Email<input type="email" name="email" autocomplete="email" required></label>
          <label>Password<input type="password" name="password" autocomplete="current-password" minlength="6" required></label>
          <button class="btn btn-primary" type="submit">Sign in</button>
          <button class="btn btn-soft" type="button" data-act="signup">Create family account</button>
          <button class="btn btn-ghost" type="button" data-act="forgot">Forgot password?</button>
        </form>
        <p class="err" id="authErr" role="alert"></p>
      </div>
    </main>`;
}

function authMessage(err) {
  const code = err?.code || "";
  const map = {
    "auth/invalid-credential": "Email or password is not right.",
    "auth/wrong-password": "Email or password is not right.",
    "auth/user-not-found": "No account with that email. Try Create family account.",
    "auth/email-already-in-use": "That email already has an account. Use Sign in.",
    "auth/weak-password": "Use a password with at least 6 characters.",
    "auth/invalid-email": "That email doesn't look right.",
    "auth/too-many-requests": "Too many tries. Wait a minute and try again.",
    "auth/operation-not-allowed": "Email/password sign-in is off. Turn it on in Firebase Authentication.",
    "auth/unauthorized-domain": "Add this site's domain under Firebase Authentication → Settings → Authorized domains.",
  };
  return map[code] || err?.message || "Something went wrong.";
}

async function doAuth(kind) {
  const f = $("#authForm");
  const err = $("#authErr");
  err.textContent = "";
  if (!f.reportValidity()) return;
  try {
    if (kind === "signup") await state.db.signUp(f.email.value.trim(), f.password.value);
    else await state.db.signIn(f.email.value.trim(), f.password.value);
  } catch (e) {
    err.textContent = authMessage(e);
  }
}

/* ================================================================== */
/* Recurring bills management dialog                                   */
/* ================================================================== */
function openRecurringDialog(editId = null) {
  state.recId = editId;
  const s = settings();
  const dlg = $("#settingsDialog");
  const cats = budgetFor(state.year).b.categories;
  const bills = normalizeRecurringBills(state.recurring);
  const editingBill = editId ? bills.find((b) => b.id === editId) : null;

  const billRows = bills.length
    ? bills
        .map((b) => {
          const cat = cats.find((c) => c.id === b.categoryId) || { emoji: "✨", name: "Other" };
          const pi = b.paidBy === "p2" ? 1 : 0;
          const whoLabel = b.paidBy === "both" ? "💞 Together" : `${esc(s.persons[pi].emoji)} ${esc(s.persons[pi].name)}`;
          const dayLabel = `Day ${b.dayOfMonth || 1}`;
          const isEditing = editingBill && editingBill.id === b.id;

          return `
            <div class="rec-item ${b.active ? "" : "paused"} ${isEditing ? "editing" : ""}">
              <div class="rec-item-main">
                <div class="rec-item-top">
                  <span class="rec-cat-emoji">${esc(cat.emoji)}</span>
                  <b>${esc(b.name)}</b>
                  <span class="rec-amt">${fmt(b.amount)}</span>
                </div>
                <div class="rec-item-meta">
                  <span>${esc(cat.name)}</span>
                  <span>·</span>
                  <span>${whoLabel}</span>
                  <span>·</span>
                  <span>${dayLabel}</span>
                  <span>·</span>
                  ${paymentBadgeHtml(b)}
                </div>
              </div>
              <div class="rec-item-actions">
                <button type="button" class="chip rec-toggle-btn ${b.active ? "rec-active" : "rec-paused"}" data-act="toggle-recurring" data-id="${esc(b.id)}">
                  ${b.active ? "Active" : "Paused"}
                </button>
                <button type="button" class="icon-btn sm" data-act="edit-recurring" data-id="${esc(b.id)}" title="Edit bill">✏️</button>
                <button type="button" class="icon-btn sm" data-act="del-recurring" data-id="${esc(b.id)}" title="Delete bill">🗑️</button>
              </div>
            </div>`;
        })
        .join("")
    : `<div class="empty-recs"><p>No recurring bills configured yet.</p><small>Add rent, subscriptions, or utilities below to track them seamlessly every month.</small></div>`;

  dlg.innerHTML = `
    <div class="dlg-body rec-dlg-body">
      <div class="rec-header">
        <div>
          <h2>📅 Recurring Bills</h2>
          <small>Automate your monthly subscriptions and fixed expenses</small>
        </div>
      </div>

      <form id="recurringForm" class="rec-form" data-id="${esc(editingBill?.id || "")}">
        <div class="rec-form-head">
          <h3>${editingBill ? "✏️ Edit recurring bill" : "＋ Add recurring bill"}</h3>
          ${editingBill ? `<button type="button" class="btn btn-ghost sm" data-act="cancel-rec-edit">Cancel</button>` : ""}
        </div>
        <div class="rec-form-grid">
          <label>Bill name
            <input name="name" type="text" maxlength="60" required placeholder="e.g. Netflix, Rent, Internet" value="${esc(editingBill?.name || "")}">
          </label>
          <label>Amount
            <input name="amount" type="text" inputmode="decimal" required placeholder="0" value="${editingBill ? formatNumberInput(editingBill.amount) : ""}">
          </label>
          <label>Category
            <select name="categoryId" required>
              ${cats.map((c) => `<option value="${esc(c.id)}" ${editingBill?.categoryId === c.id ? "selected" : ""}>${esc(c.emoji)} ${esc(c.name)}</option>`).join("")}
            </select>
          </label>
          <label>Paid by
            <select name="paidBy">
              <option value="p1" ${editingBill?.paidBy === "p1" ? "selected" : ""}>${esc(s.persons[0].emoji)} ${esc(s.persons[0].name)}</option>
              <option value="p2" ${editingBill?.paidBy === "p2" ? "selected" : ""}>${esc(s.persons[1].emoji)} ${esc(s.persons[1].name)}</option>
              <option value="both" ${!editingBill || editingBill.paidBy === "both" ? "selected" : ""}>💞 Together</option>
            </select>
          </label>
          <label>Day of month (1–31)
            <input name="dayOfMonth" type="number" min="1" max="31" required value="${editingBill ? editingBill.dayOfMonth : 1}">
          </label>
          <label>Payment method
            <select name="paymentMethod">
              ${PAYMENT_METHODS.map((pm) => `<option value="${pm.id}" ${editingBill?.paymentMethod === pm.id ? "selected" : ""}>${pm.emoji} ${esc(pm.name)}</option>`).join("")}
            </select>
          </label>
          <div class="credit-card-details payment-extra ${(editingBill?.paymentMethod === "credit_card" || editingBill?.paymentMethod === "installment") ? "" : "hide"}">
            <label>Card name / Bank <small>(optional)</small>
              <input type="text" name="cardName" placeholder="e.g. BCA Card, Mandiri, Chase" maxlength="30" value="${esc(editingBill?.cardName || "")}">
            </label>
          </div>
          <div class="installment-details payment-extra ${editingBill?.paymentMethod === "installment" ? "" : "hide"}">
            <label>Total months (tenure)
              <select name="installmentMonths">
                <option value="3" ${editingBill?.installmentMonths === 3 ? "selected" : ""}>3 months</option>
                <option value="6" ${editingBill?.installmentMonths === 6 ? "selected" : ""}>6 months</option>
                <option value="12" ${!editingBill || editingBill.installmentMonths === 12 ? "selected" : ""}>12 months</option>
                <option value="24" ${editingBill?.installmentMonths === 24 ? "selected" : ""}>24 months</option>
                <option value="36" ${editingBill?.installmentMonths === 36 ? "selected" : ""}>36 months</option>
              </select>
            </label>
          </div>
        </div>
        <div class="rec-form-actions">
          <button type="submit" class="btn btn-primary">${editingBill ? "Save changes" : "Add bill"}</button>
        </div>
      </form>

      <div class="rec-list-section">
        <h3>Configured bills (${bills.length})</h3>
        <div class="rec-list">
          ${billRows}
        </div>
      </div>

      <div class="dlg-actions">
        <button type="button" class="btn btn-soft" data-act="close-settings">Done</button>
      </div>
    </div>`;

  if (!dlg.open) dlg.showModal();
}

function refreshRecurringDialog() {
  if ($("#recurringForm")) {
    openRecurringDialog(state.recId);
  }
}

async function submitRecurringForm(form) {
  const fd = new FormData(form);
  const id = form.dataset.id;
  const name = String(fd.get("name") || "").trim();
  const amount = parseFormattedNumber(fd.get("amount"));
  const categoryId = String(fd.get("categoryId") || "");
  const paidBy = ["p1", "p2", "both"].includes(fd.get("paidBy")) ? fd.get("paidBy") : "both";
  const dayRaw = parseInt(fd.get("dayOfMonth"), 10);
  const dayOfMonth = Number.isFinite(dayRaw) ? Math.min(31, Math.max(1, dayRaw)) : 1;

  if (!name) {
    toast("Please provide a bill name");
    return;
  }
  if (amount <= 0) {
    toast("Please enter a valid amount");
    return;
  }

  const paymentMethod = fd.get("paymentMethod") || "cash";
  const cardName = String(fd.get("cardName") || "").trim();
  const installmentMonths = paymentMethod === "installment" ? (Number(fd.get("installmentMonths")) || 12) : null;

  const payload = {
    name,
    amount,
    categoryId,
    paidBy,
    dayOfMonth,
    active: true,
    paymentMethod,
    cardName,
    installmentMonths,
  };

  try {
    if (id) {
      const existing = state.recurring.find((r) => r.id === id);
      await state.db.updateRecurring(id, { ...payload, active: existing ? existing.active !== false : true });
      toast("Recurring bill updated");
    } else {
      await state.db.addRecurring(payload);
      toast("Recurring bill added");
    }
    state.recId = null;
    openRecurringDialog(null);
  } catch (err) {
    toast("Couldn't save bill: " + (err.message || err));
  }
}

async function toggleRecurring(id) {
  const bill = state.recurring.find((r) => r.id === id);
  if (!bill) return;
  const nextActive = bill.active === false;
  try {
    await state.db.updateRecurring(id, { active: nextActive });
    toast(nextActive ? "Bill activated" : "Bill paused");
    openRecurringDialog(state.recId);
  } catch (err) {
    toast("Couldn't update status: " + (err.message || err));
  }
}

async function deleteRecurring(id) {
  if (!confirm("Delete this recurring bill?")) return;
  try {
    await state.db.deleteRecurring(id);
    toast("Recurring bill deleted");
    if (state.recId === id) state.recId = null;
    openRecurringDialog(state.recId);
  } catch (err) {
    toast("Couldn't delete bill: " + (err.message || err));
  }
}

async function logAllPendingRecurring() {
  const pending = findPendingRecurringBills(state.recurring, state.expenses, state.year, state.month);
  if (!pending.length) {
    toast("No pending recurring bills for this month");
    return;
  }
  try {
    for (const b of pending) {
      const d = Math.min(Math.max(1, Number(b.dayOfMonth) || 1), 28);
      const date = `${state.year}-${pad(state.month + 1)}-${pad(d)}`;
      await state.db.addExpense({
        date,
        amount: Number(b.amount) || 0,
        categoryId: b.categoryId || "",
        paidBy: b.paidBy || "p1",
        note: b.name || "Recurring bill",
        recurringId: b.id,
        paymentMethod: b.paymentMethod || "cash",
        cardName: b.cardName || "",
        installmentMonths: b.installmentMonths || null,
        installmentCurrent: b.paymentMethod === "installment" ? 1 : null,
      });
    }
    toast(`Logged ${pending.length} recurring bill${pending.length > 1 ? "s" : ""} for this month`);
  } catch (err) {
    toast("Couldn't log bills: " + (err.message || err));
  }
}

/* ================================================================== */
/* PiggyNest Pro Modal & Receipt Scanner                               */
/* ================================================================== */
const GEMINI_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.8-flash",
];
const GEMINI_API_KEY = atob("QVEuQWI4Uk42SnJzUm1faDVVcnp4SV9fS2FVWVAyUTR0SXVPbXEwRGtNT2VWY0JENE5IM1E=");

function loadPayPalSdk(callback) {
  if (window.paypal && typeof window.paypal.Buttons === "function") {
    callback();
    return;
  }
  const existing = document.querySelector('script[src*="paypal.com/sdk/js"]');
  if (existing) {
    existing.addEventListener("load", callback);
    return;
  }
  const script = document.createElement("script");
  script.src = `https://www.paypal.com/sdk/js?client-id=${PAYPAL_CLIENT_ID}&vault=true&intent=subscription`;
  script.onload = callback;
  script.onerror = () => {
    console.error("PayPal SDK failed to load");
    const container = $("#paypal-button-container");
    if (container) {
      container.innerHTML = `<p style="color:var(--ink-soft);font-size:0.85rem;margin:4px 0;">Unable to connect to PayPal. Please check your connection and try again.</p>`;
    }
  };
  document.head.appendChild(script);
}

function renderPayPalButtons(dlg) {
  const container = $("#paypal-button-container", dlg);
  if (!container || !window.paypal || typeof window.paypal.Buttons !== "function") return;
  container.innerHTML = "";
  try {
    window.paypal.Buttons({
      style: {
        shape: "pill",
        color: "gold",
        layout: "vertical",
        label: "subscribe"
      },
      onClick: function(data, actions) {
        // Automatically minimize/close modal so user seamlessly sees PayPal popup/window
        if (dlg && dlg.open) dlg.close();
        toast("Opening PayPal Checkout… 💳");
        return actions ? actions.resolve() : true;
      },
      createSubscription: function(data, actions) {
        return actions.subscription.create({
          plan_id: PAYPAL_PLAN_ID
        });
      },
      onApprove: async function(data, actions) {
        try {
          await state.db.saveProStatus(true, null, data.subscriptionID, true);
          if (state.settings) {
            state.settings.pro = true;
            state.settings.proUntil = null;
            state.settings.subscriptionId = data.subscriptionID;
            state.settings.trialUsed = true;
          }
          if (dlg && dlg.open) dlg.close();
          triggerConfetti();
          toast("✨ Welcome to Piggy Pro! Your subscription is active.");
          render();
        } catch (err) {
          console.error("Error saving Pro status:", err);
          toast("Subscribed on PayPal! Error saving local state: " + err.message);
        }
      },
      onCancel: function(data) {
        toast("PayPal checkout cancelled");
      },
      onError: function(err) {
        console.error("PayPal Error:", err);
        toast("Subscription could not be processed. Please try again.");
      }
    }).render("#paypal-button-container");
  } catch (e) {
    console.error("Error rendering PayPal Buttons:", e);
  }
}

function openProDialog() {
  const s = settings();
  const dlg = $("#settingsDialog");
  const adminUser = isAdmin(state.user);
  const proActive = isPro(s, state.user);
  const days = getProRemainingDays(s);

  let statusSection = "";
  if (adminUser) {
    statusSection = `
      <div class="pro-active-box admin">
        <b>👑 Admin Account</b>
        <p>Logged in as ${esc(state.user?.email || "")}.<br>You have full, permanent Pro access across PiggyNest.</p>
      </div>`;
  } else if (proActive) {
    if (s.subscriptionId) {
      statusSection = `
        <div class="pro-active-box">
          <b>Active PayPal Subscription</b>
          <p>Plan: ${esc(PRO_PRICE)}<br>Subscription ID: <code>${esc(s.subscriptionId)}</code></p>
        </div>
        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:6px;">
          <a href="https://www.paypal.com/myaccount/autopay/" target="_blank" rel="noopener" class="btn btn-soft">Manage on PayPal</a>
          <button type="button" class="btn btn-ghost sm" data-act="cancel-pro-sub">Stop subscription in app</button>
        </div>`;
    } else if (days !== null) {
      statusSection = `
        <div class="pro-active-box">
          <b>Pro Active</b>
          <p>${days} day${days === 1 ? "" : "s"} remaining</p>
        </div>
        <div style="margin-top:6px;">
          <button type="button" class="btn btn-soft" data-act="cancel-pro-sub">Cancel Pro</button>
        </div>`;
    } else {
      statusSection = `
        <div class="pro-active-box">
          <b>Lifetime Pro Active</b>
          <p>All features unlocked forever ✨</p>
        </div>`;
    }
  } else {
    statusSection = `
      <div class="pro-cta-section">
        <div id="paypal-button-container" class="paypal-container">
          <span class="paypal-loading">Loading PayPal checkout…</span>
        </div>
        <small style="color:var(--ink-soft);font-size:0.82rem;display:block;margin-top:6px;">Subscribe securely via PayPal (${esc(PRO_PRICE)} · Cancel anytime)</small>
      </div>`;
  }

  dlg.innerHTML = `
    <div class="dlg-body pro-dlg" tabindex="-1">
      <div style="display:flex;justify-content:flex-end;width:100%;margin-bottom:-10px;">
        <button type="button" class="icon-btn sm" data-act="close-settings" aria-label="Close" autofocus style="background:transparent;border:none;font-size:1.15rem;cursor:pointer;color:var(--ink-soft);padding:4px 8px;line-height:1;">✕</button>
      </div>
      <div class="pro-hero">
        <div class="pro-icon-sparkle">${adminUser ? "👑" : "💎"}</div>
        <h2>${adminUser ? "PiggyNest Admin" : (proActive ? "PiggyNest Pro Active" : "Unlock Piggy Pro ✨")}</h2>
        <p class="pro-tagline">${adminUser ? "Full admin privileges and unlimited Pro access." : (proActive ? "Thank you for supporting PiggyNest!" : "Elevate your couple financial journey with superpowers designed for two.")}</p>
        ${!adminUser ? `
        <div class="pro-price-badge">
          <span class="pro-price">${esc(PRO_PRICE)}</span>
        </div>` : ""}
      </div>

      ${statusSection}

      <div class="pro-features-list">
        <div class="pro-feature-item">
          <span class="pro-feature-icon">🏺</span>
          <div>
            <b>Unlimited Piggy Jars (Goal Buckets)</b>
            <p>Visual sinking funds for vacations, maintenance, and emergency reserves with monthly pace tracking.</p>
          </div>
        </div>
        <div class="pro-feature-item">
          <span class="pro-feature-icon">💬</span>
          <div>
            <b>Partner Activity Feed & Reactions</b>
            <p>Live couple spending feed and interactive emoji reactions (❤️ 👏 😂 😱 💸) on any expense.</p>
          </div>
        </div>
        <div class="pro-feature-item">
          <span class="pro-feature-icon">🚨</span>
          <div>
            <b>Smart Category Cap & Anomaly Alerts</b>
            <p>Proactive budget warnings before you overspend on dining, shopping, and everyday essentials.</p>
          </div>
        </div>
        <div class="pro-feature-item">
          <span class="pro-feature-icon">📊</span>
          <div>
            <b>1-Tap Excel / CSV Data Export</b>
            <p>Export all expense transactions and complete investment portfolio records formatted for Excel.</p>
          </div>
        </div>
        <div class="pro-feature-item">
          <span class="pro-feature-icon">📈</span>
          <div>
            <b>Future Nest Compound Wealth Projector</b>
            <p>Simulate compounding returns and celebrate future millionaire milestones over 1–30 years.</p>
          </div>
        </div>
        <div class="pro-feature-item">
          <span class="pro-feature-icon">📷</span>
          <div>
            <b>Turnkey AI Receipt Scanner</b>
            <p>Snap any receipt — auto-fills amounts, dates, and categories with zero manual effort.</p>
          </div>
        </div>
        <div class="pro-feature-item">
          <span class="pro-feature-icon">🎨</span>
          <div>
            <b>Deluxe Cozy Themes & Companion Mascots</b>
            <p>Dark Mocha, Matcha Sage, Lavender Dream, Mochi the Cat, Boba the Bear, and Bunny the Rabbit.</p>
          </div>
        </div>
      </div>

      <div class="pro-code-section">
        <small class="pro-code-label">Have an activation or promo code?</small>
        <form id="proCodeForm" class="pro-code-form" autocomplete="off">
          <input type="text" id="proCodeInput" placeholder="Enter activation code" maxlength="30" tabindex="-1">
          <button type="submit" class="btn btn-soft sm" id="btnActivateProCode">Activate</button>
        </form>
      </div>

      <div class="dlg-actions" style="margin-top:4px;">
        <button type="button" class="btn btn-ghost" data-act="close-settings">Close</button>
      </div>
    </div>`;

  if (!dlg.open) dlg.showModal();

  dlg.scrollTop = 0;
  const body = dlg.querySelector(".dlg-body");
  if (body) body.scrollTop = 0;
  if (document.activeElement && document.activeElement.tagName === "INPUT") {
    document.activeElement.blur();
  }
  requestAnimationFrame(() => {
    dlg.scrollTop = 0;
    if (body) body.scrollTop = 0;
  });

  if (!proActive && !adminUser) {
    loadPayPalSdk(() => {
      renderPayPalButtons(dlg);
    });
  }
}

function compressImage(file, maxWidth = 1200, maxHeight = 1200, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxWidth || height > maxHeight) {
          const ratio = Math.min(maxWidth / width, maxHeight / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        const base64Data = dataUrl.split(",")[1];
        resolve(base64Data);
      };
      img.onerror = (err) => reject(new Error("Couldn't load image: " + err));
      img.src = e.target.result;
    };
    reader.onerror = (err) => reject(new Error("Couldn't read file: " + err));
    reader.readAsDataURL(file);
  });
}

async function handleReceiptFile(file) {
  if (!file) return;
  if (!isPro(settings(), state.user)) {
    openProDialog();
    return;
  }
  const apiKey = GEMINI_API_KEY;

  const btn = $("#btnScanReceipt");
  const origBtnText = btn ? btn.innerHTML : "📷 Scan receipt";
  if (btn) {
    btn.disabled = true;
    btn.classList.add("scanning");
    btn.innerHTML = `<span class="scan-spinner">✨</span> Scanning…`;
  }

  try {
    const base64Data = await compressImage(file, 1200, 1200, 0.75);
    const categories = budgetFor(state.year).b.categories;
    const promptText = buildReceiptPrompt(categories);

    const payload = {
      contents: [
        {
          parts: [
            { text: promptText },
            { inline_data: { mime_type: "image/jpeg", data: base64Data } },
          ],
        },
      ],
    };

    let data = null;
    let lastError = null;

    for (const model of GEMINI_MODELS) {
      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const json = await res.json();
        if (res.ok) {
          data = json;
          break;
        }

        // Fallback to next model if 404 (not found), 503 (high demand/overloaded), 429 (rate limit), or 500
        if ([404, 429, 500, 502, 503, 504].includes(res.status)) {
          console.warn(`Gemini model ${model} returned HTTP ${res.status}, attempting fallback model...`);
          lastError = new Error(json?.error?.message || `Model ${model} unavailable (HTTP ${res.status})`);
          continue;
        }

        const errDetail = json?.error?.message || `HTTP ${res.status}`;
        throw new Error(errDetail);
      } catch (e) {
        const msg = String(e?.message || "");
        if (msg.includes("404") || msg.includes("503") || msg.includes("429") || msg.includes("unavailable") || msg.includes("overloaded")) {
          lastError = e;
          continue;
        }
        throw e;
      }
    }

    if (!data) {
      throw lastError || new Error("All Gemini Flash models failed to respond");
    }

    const candidateText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!candidateText) {
      throw new Error("No receipt details identified in response");
    }

    const parsed = parseReceiptResponse(candidateText);

    // Auto-fill form
    const form = $("#expForm");
    if (form) {
      if (parsed.date) {
        form.date.value = parsed.date;
      }
      if (parsed.amount > 0) {
        form.amount.value = parsed.amount;
      }
      if (parsed.merchant) {
        form.note.value = parsed.merchant;
      }
      if (parsed.suggestedCategoryId && form.categoryId) {
        const opts = [...form.categoryId.options].map((o) => o.value);
        if (opts.includes(parsed.suggestedCategoryId)) {
          form.categoryId.value = parsed.suggestedCategoryId;
        }
      }
      form.amount?.focus();
    }

    toast("✨ Receipt scanned! Check details and select who paid.");
  } catch (err) {
    console.error("Receipt scan failed:", err);
    toast("Couldn't scan receipt: " + (err.message || err));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("scanning");
      btn.innerHTML = origBtnText;
    }
    const fileIn = $("#receiptFileInput");
    if (fileIn) fileIn.value = "";
  }
}

/* ================================================================== */
/* Events                                                              */
/* ================================================================== */
document.addEventListener("click", async (ev) => {
  const themeBtn = ev.target.closest("[data-theme-id]");
  if (themeBtn) {
    const targetTheme = getTheme(themeBtn.dataset.themeId);
    if (targetTheme.pro && !isPro(settings(), state.user)) {
      openProDialog();
      return;
    }
    $$("#themePicker .choice-pill").forEach((b) => b.classList.remove("active"));
    themeBtn.classList.add("active");
    applyTheme(themeBtn.dataset.themeId);
    return;
  }
  const mascotBtn = ev.target.closest("[data-mascot-id]");
  if (mascotBtn) {
    const targetMascot = getMascot(mascotBtn.dataset.mascotId);
    if (targetMascot.pro && !isPro(settings(), state.user)) {
      openProDialog();
      return;
    }
    $$("#mascotPicker .choice-pill").forEach((b) => b.classList.remove("active"));
    mascotBtn.classList.add("active");
    updateBackground(mascotBtn.dataset.mascotId);
    return;
  }
  const notifPromptBtn = ev.target.closest("#btnEnableNotif, #btnDismissNotif, [data-act='enable-notif-prompt'], [data-act='dismiss-notif-prompt']");
  if (notifPromptBtn) {
    localStorage.setItem("piggynest_notif_prompted", "true");
    const dlg = $("#settingsDialog");
    if (dlg?.open) dlg.close();
    if (notifPromptBtn.id === "btnEnableNotif" || notifPromptBtn.dataset.act === "enable-notif-prompt") {
      if ("Notification" in window) {
        try {
          const res = Notification.requestPermission();
          const perm = res && typeof res.then === "function" ? await res : await new Promise((r) => Notification.requestPermission(r));
          if (perm === "granted") {
            toast("🔔 Reminders enabled!");
            await checkDDayNotifications();
          }
        } catch (e) {
          console.warn("Notification error:", e);
        }
        renderView();
      }
    }
    return;
  }

  if (ev.target.closest("#btnDownloadWrappedCard")) {
    downloadWrappedCard(currentWrappedData);
    return;
  }

  const el = ev.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  switch (act) {
    case "tab": setTab(el.dataset.tab); break;
    case "new-jar": {
      if (!isPro(settings(), state.user)) { openProDialog(); break; }
      openJarModal();
      break;
    }
    case "edit-jar": {
      if (!isPro(settings(), state.user)) { openProDialog(); break; }
      openJarModal(el.dataset.id);
      break;
    }
    case "del-jar": {
      if (!isPro(settings(), state.user)) { openProDialog(); break; }
      if (confirm("Delete this goal jar?")) {
        const remaining = (state.jars || []).filter((j) => j.id !== el.dataset.id);
        await saveJars(remaining);
        toast("Jar deleted");
        renderView();
      }
      break;
    }
    case "add-jar-money": {
      if (!isPro(settings(), state.user)) { openProDialog(); break; }
      openJarMoneyModal(el.dataset.id, "add");
      break;
    }
    case "withdraw-jar-money": {
      if (!isPro(settings(), state.user)) { openProDialog(); break; }
      openJarMoneyModal(el.dataset.id, "withdraw");
      break;
    }
    case "toggle-feed": {
      if (!isPro(settings(), state.user)) { openProDialog(); break; }
      state.feedOpen = !state.feedOpen;
      renderView();
      break;
    }
    case "open-reactions": {
      if (!isPro(settings(), state.user)) { openProDialog(); break; }
      openReactionPicker(el.dataset.id);
      break;
    }
    case "select-reaction": {
      if (!isPro(settings(), state.user)) { openProDialog(); break; }
      const expId = el.dataset.id;
      const emoji = el.dataset.emoji;
      const exp = state.expenses.find((x) => x.id === expId);
      if (exp) {
        exp.reactions = exp.reactions || {};
        const myKey = state.lastPaidBy === "p2" ? "p2" : "p1";
        const myName = myKey === "p2" ? settings().persons[1].name : settings().persons[0].name;
        if (exp.reactions[myKey] === emoji) {
          delete exp.reactions[myKey];
        } else {
          exp.reactions[myKey] = emoji;
          logActivity(`${myName} reacted ${emoji} to "${exp.note || "Expense"}" (${fmt(exp.amount)})`, emoji);
        }
        await state.db.updateExpense(exp.id, { reactions: exp.reactions });
        $("#settingsDialog")?.close();
        renderView();
      }
      break;
    }
    case "set-compound-years": {
      if (!isPro(settings(), state.user)) { openProDialog(); break; }
      const y = Number(el.dataset.years) || 10;
      state.compound = state.compound || {};
      state.compound.years = y;
      const range = $("#compoundYearsRange");
      if (range) range.value = y;
      updateCompoundDisplay();
      break;
    }
    case "export-expenses-csv": {
      if (!isPro(settings(), state.user)) { openProDialog(); break; }
      const csv = generateExpensesCSV(state.expenses);
      const safeFamily = (settings().familyName || "PiggyNest").replace(/[^a-zA-Z0-9_-]/g, "_");
      downloadCsvFile(csv, `${safeFamily}-Expenses.csv`);
      break;
    }
    case "export-investments-csv": {
      if (!isPro(settings(), state.user)) { openProDialog(); break; }
      const csv = generateInvestmentsCSV(state.investments);
      const safeFamily = (settings().familyName || "PiggyNest").replace(/[^a-zA-Z0-9_-]/g, "_");
      downloadCsvFile(csv, `${safeFamily}-Investments.csv`);
      break;
    }
    case "open-wrapped": openWrappedStory(); break;
    case "close-wrapped": closeWrappedStory(); break;
    case "close-story-preview": $("#storyPreviewModal")?.remove(); break;
    case "wrapped-prev": advanceWrappedSlide(-1); break;
    case "wrapped-next": advanceWrappedSlide(1); break;
    case "download-wrapped": downloadWrappedCard(currentWrappedData); break;
    case "quick-add": setTab("expenses"); $("#expForm")?.amount.focus({ preventScroll: true }); break;
    case "open-pro": openProDialog(); break;
    case "cancel-pro-sub": {
      if (confirm("Are you sure you want to stop PiggyNest Pro?")) {
        try {
          await state.db.cancelProSubscription();
          const curr = settings();
          let nextTheme = curr.theme;
          let nextMascot = curr.mascot;
          let needSettingsUpdate = false;
          if (getTheme(nextTheme).pro) {
            nextTheme = "default";
            needSettingsUpdate = true;
          }
          if (getMascot(nextMascot).pro) {
            nextMascot = "piggy";
            needSettingsUpdate = true;
          }
          if (needSettingsUpdate) {
            await state.db.saveSettings({
              ...curr,
              theme: nextTheme,
              mascot: nextMascot,
              pro: false,
              proUntil: null,
              subscriptionId: null,
            });
            applyTheme(nextTheme);
            updateBackground(nextMascot);
          }
          if (state.settings) {
            state.settings.pro = false;
            state.settings.proUntil = null;
            state.settings.subscriptionId = null;
            state.settings.theme = nextTheme;
            state.settings.mascot = nextMascot;
          }
          $("#settingsDialog")?.close();
          toast("PiggyNest Pro ended");
          render();
        } catch (e) {
          toast("Couldn't stop subscription: " + (e.message || e));
        }
      }
      break;
    }
    case "scan-receipt": {
      if (!isPro(settings(), state.user)) {
        openProDialog();
      } else {
        $("#receiptFileInput")?.click();
      }
      break;
    }
    case "log-due-bill": {
      const bill = state.recurring.find((r) => String(r.id) === String(el.dataset.id));
      if (!bill) {
        toast("Bill not found");
        break;
      }
      const today = new Date();
      const dateStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
      const expData = {
        date: dateStr,
        amount: Number(bill.amount) || 0,
        categoryId: bill.categoryId || "",
        paidBy: bill.paidBy || "p1",
        note: bill.name || "Recurring bill",
        recurringId: bill.id,
        paymentMethod: bill.paymentMethod || "cash",
        cardName: bill.cardName || "",
        installmentMonths: bill.installmentMonths || null,
        installmentCurrent: bill.paymentMethod === "installment" ? 1 : null,
      };
      try {
        await state.db.addExpense(expData);
        toast(`Logged ${bill.name} as paid!`);
        render();
      } catch (err) {
        toast("Couldn't log bill: " + (err.message || err));
      }
      break;
    }
    case "req-notifications": {
      if ("Notification" in window) {
        try {
          const res = Notification.requestPermission();
          const perm = res && typeof res.then === "function" ? await res : await new Promise((r) => Notification.requestPermission(r));
          if (perm === "granted") {
            toast("Due date reminders enabled! 🔔");
            localStorage.setItem("piggynest_notif_prompted", "true");
            await checkDDayNotifications();
          }
        } catch (e) {
          console.warn("Notification error:", e);
        }
        renderView();
      }
      break;
    }
    case "req-notifications-settings": {
      if ("Notification" in window) {
        try {
          const res = Notification.requestPermission();
          const perm = res && typeof res.then === "function" ? await res : await new Promise((r) => Notification.requestPermission(r));
          if (perm === "granted") {
            toast("🔔 Reminders enabled!");
            localStorage.setItem("piggynest_notif_prompted", "true");
            await checkDDayNotifications();
          } else if (perm === "denied") {
            toast("Notifications are blocked in your browser settings");
          }
        } catch (e) {
          console.warn("Notification error:", e);
        }
        openSettings();
      } else {
        toast("Notifications are not supported on this browser");
      }
      break;
    }
    case "test-notification": {
      if ("Notification" in window && Notification.permission === "granted") {
        try {
          await sendBrowserNotification("PiggyNest: Test Notification 🔔", {
            body: "Notifications are working great! You'll receive alerts on bill D-Days.",
            tag: "piggynest-test",
          });
          toast("🔔 Test notification sent!");
        } catch (err) {
          console.error("Test notification error:", err);
          toast("Couldn't send notification: " + (err.message || err));
        }
      } else {
        toast("Notifications are not enabled");
      }
      break;
    }
    case "log-recurring-all": {
      if (!isPro(settings(), state.user)) {
        openProDialog();
      } else {
        await logAllPendingRecurring();
      }
      break;
    }
    case "open-recurring": {
      if (!isPro(settings(), state.user)) {
        openProDialog();
      } else {
        openRecurringDialog();
      }
      break;
    }
    case "edit-recurring": openRecurringDialog(el.dataset.id); break;
    case "cancel-rec-edit": openRecurringDialog(null); break;
    case "toggle-recurring": await toggleRecurring(el.dataset.id); break;
    case "del-recurring": await deleteRecurring(el.dataset.id); break;
    case "inv-new": if (!needDbUpdate()) openInvForm(); break;
    case "inv-open": renderInvDialog(el.dataset.id, el.dataset.kind || "add"); break;
    case "inv-edit": openInvForm(el.dataset.id); break;
    case "inv-del": deleteInvestment(el.dataset.id); break;
    case "entry-del": deleteEntry(el.dataset.id); break;
    case "set-goal-prompt": openSavingsGoalDialog(); break;
    case "open-settings": openSettings(); break;
    case "close-settings": applyTheme(settings().theme); updateBackground(settings().mascot); $("#settingsDialog").close(); break;
    case "save-settings": saveSettings(); break;
    case "export-csv": exportCsv(); break;
    case "export-json": exportJson(); break;
    case "restore-json-btn": $("#restoreJsonFile")?.click(); break;
    case "signout": await state.db.signOut(); break;
    case "signup": doAuth("signup"); break;
    case "forgot": {
      const email = $("#authForm").email.value.trim();
      const err = $("#authErr");
      if (!email) { err.textContent = "Type your email above first."; break; }
      try { await state.db.resetPassword(email); err.style.color = "#3b9d82"; err.textContent = "Password reset email sent."; }
      catch (e) { err.style.color = ""; err.textContent = authMessage(e); }
      break;
    }
    case "goto-month": state.month = Number(el.dataset.m); setTab("home"); $("#monthSel").value = String(state.month); break;
    case "edit-exp": startEdit(el.dataset.id); break;
    case "cancel-edit": cancelEdit(); break;
    case "del-exp":
      if (confirm("Delete this expense?")) {
        try { await state.db.deleteExpense(el.dataset.id); toast("Expense deleted"); } catch (e) { toast("Couldn't delete: " + e.message); }
      }
      break;
    case "add-cat": {
      const d = getDraft();
      d.b.categories.push({ id: uid(), emoji: "✨", name: "New category", percent: 0, color: PALETTE[d.b.categories.length % PALETTE.length], splitMode: "income", p1Share: 50 });
      state.dirty = true;
      renderView();
      const inputs = $$(`.brow [data-f="name"]`);
      inputs[inputs.length - 1]?.select();
      break;
    }
    case "del-cat": {
      const d = getDraft();
      d.b.categories = d.b.categories.filter((c) => c.id !== el.dataset.id);
      state.dirty = true;
      renderView();
      break;
    }
    case "balance": balanceToHundred(); break;
    case "save-budget": saveBudget(); break;
    case "sample": await loadSample(); break;
  }
});

document.addEventListener("change", (ev) => {
  if (ev.target.id === "restoreJsonFile" && ev.target.files?.[0]) {
    importJson(ev.target.files[0]);
    ev.target.value = "";
  }
  if (ev.target.name === "paymentMethod") {
    const form = ev.target.closest("form");
    if (!form) return;
    const val = ev.target.value;
    const cc = form.querySelector("#creditCardDetails") || form.querySelector(".credit-card-details");
    const inst = form.querySelector("#installmentDetails") || form.querySelector(".installment-details");
    if (cc) cc.classList.toggle("hide", val === "cash");
    if (inst) inst.classList.toggle("hide", val !== "installment");
  }
  if (ev.target.name === "categoryId" && ev.target.form?.id === "expForm") {
    updateExpenseFormCapHint();
  }
});

document.addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (ev.target.id === "savingsGoalForm") submitSavingsGoal(ev.target);
  if (ev.target.id === "jarForm") {
    const form = ev.target;
    const fd = new FormData(form);
    const id = form.dataset.id || uid();
    const name = String(fd.get("name") || "").trim();
    if (!name) { toast("Please give your jar a name"); return; }
    const icon = String(fd.get("icon") || "🏺").trim() || "🏺";
    const targetAmount = parseFormattedNumber(fd.get("targetAmount"));
    const currentAmount = parseFormattedNumber(fd.get("currentAmount"));
    const targetDate = String(fd.get("targetDate") || "");
    const existing = state.jars || [];
    const isEdit = existing.some((j) => j.id === id);
    let nextJars;
    if (isEdit) {
      nextJars = existing.map((j) => j.id === id ? { ...j, name, icon, targetAmount, currentAmount, targetDate } : j);
    } else {
      nextJars = [...existing, { id, name, icon, targetAmount, currentAmount, targetDate }];
    }
    saveJars(nextJars);
    logActivity(`${isEdit ? "Updated" : "Created"} jar 🏺 "${name}" (${fmt(targetAmount)} goal)`, icon);
    $("#settingsDialog")?.close();
    renderView();
    toast(`Jar "${name}" saved! 🏺`);
    return;
  }
  if (ev.target.id === "jarMoneyForm") {
    const form = ev.target;
    const fd = new FormData(form);
    const id = form.dataset.id;
    const mode = form.dataset.mode || "add";
    const amount = parseFormattedNumber(fd.get("amount"));
    if (amount <= 0) { toast("Please enter a valid amount"); return; }
    const existing = state.jars || [];
    const jar = existing.find((j) => j.id === id);
    if (!jar) return;
    const isWithdraw = mode === "withdraw";
    const newAmount = isWithdraw ? Math.max(0, (jar.currentAmount || 0) - amount) : (jar.currentAmount || 0) + amount;
    const nextJars = existing.map((j) => j.id === id ? { ...j, currentAmount: newAmount } : j);
    saveJars(nextJars);
    logActivity(`${isWithdraw ? "Withdrew" : "Added"} ${fmt(amount)} ${isWithdraw ? "from" : "to"} jar ${jar.icon || "🏺"} "${jar.name}"`, isWithdraw ? "💸" : "💰");
    $("#settingsDialog")?.close();
    renderView();
    toast(`${isWithdraw ? "Withdrew" : "Added"} ${fmt(amount)}!`);
    return;
  }
  if (ev.target.id === "expForm") submitExpense(ev.target);
  if (ev.target.id === "authForm") doAuth("signin");
  if (ev.target.id === "invForm") submitInvForm(ev.target);
  if (ev.target.id === "entryForm") saveEntry(ev.target);
  if (ev.target.id === "recurringForm") submitRecurringForm(ev.target);
  if (ev.target.id === "proCodeForm") {
    const input = ev.target.querySelector("#proCodeInput");
    const code = input?.value.trim() || "";
    if (!code) {
      toast("Please enter an activation code.");
      return;
    }
    state.db.activateProCode(code).then((res) => {
      if (res && res.valid) {
        if (state.settings) {
          state.settings.pro = res.isPro;
          state.settings.proUntil = res.proUntil;
          state.settings.subscriptionId = null;
        }
        $("#settingsDialog")?.close();
        toast(res.message || "💎 PiggyNest Pro activated!");
        render();
      } else {
        toast(res?.message || "Invalid code. Try again.");
      }
    }).catch((err) => {
      toast("Error activating code: " + (err.message || err));
    });
  }
});

document.addEventListener("change", (ev) => {
  if (ev.target.id === "receiptFileInput") {
    const file = ev.target.files?.[0];
    if (file) handleReceiptFile(file);
  }
});

document.addEventListener("input", (ev) => {
  const t = ev.target;

  // Format comma-separated numeric inputs across forms
  const isFormattedNumInput = (
    (t.name === "amount" && (t.form?.id === "expForm" || t.form?.id === "entryForm" || t.form?.id === "recForm")) ||
    (t.name === "put" || t.name === "worth")
  );
  if (isFormattedNumInput) {
    handleFormattedNumberInput(t);
  }

  if (t.form?.id === "expForm" && (t.name === "categoryId" || t.name === "amount")) {
    updateExpenseFormCapHint();
  }

  if (t.id === "compoundYearsRange" || t.id === "compoundRateInput" || t.id === "compoundMonthlyInput" || t.id === "compoundPrincipalInput") {
    state.compound = state.compound || {};
    if (t.id === "compoundYearsRange") state.compound.years = Number(t.value) || 10;
    if (t.id === "compoundRateInput") state.compound.rate = Number(t.value) || 8;
    if (t.id === "compoundMonthlyInput") state.compound.monthly = parseFormattedNumber(t.value);
    if (t.id === "compoundPrincipalInput") state.compound.principal = parseFormattedNumber(t.value);
    updateCompoundDisplay();
  }

  if (state.tab !== "budget" || !$("#view")?.contains(t)) return;
  const d = getDraft();
  if (t.dataset.income) {
    handleFormattedNumberInput(t);
    d.b.income[t.dataset.income] = parseFormattedNumber(t.value);
    markDirty();
    return;
  }
  const row = t.closest(".brow");
  const f = t.dataset.f;
  if (!row || !f || f === "splitMode") return;
  const cat = d.b.categories.find((c) => c.id === row.dataset.id);
  if (!cat) return;
  if (f === "percent" || f === "p1Share") cat[f] = t.value === "" ? 0 : Number(t.value);
  else cat[f] = t.value.replace(/\s+/g, " ");
  if (t.classList.contains("name-in")) autosize(t);
  markDirty();
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && ev.target.classList?.contains("name-in")) {
    ev.preventDefault();
    ev.target.blur();
  }
});

window.addEventListener("resize", () => $$(".name-in").forEach(autosize));

document.addEventListener("change", (ev) => {
  const t = ev.target;
  if (t.id === "entryKind") { syncEntryForm(); return; }
  if (t.id === "invCat") {
    state.db.saveSettings({ ...settings(), investCategoryId: t.value }).catch((e) => toast("Couldn't save: " + e.message));
    return;
  }
  if (t.id === "yearSel") {
    if (state.dirty && !confirm("Discard the unsaved budget changes?")) {
      t.value = String(state.year);
      return;
    }
    state.year = Number(t.value);
    state.draft = null;
    state.dirty = false;
    refreshDirtyDot();
    renderView();
    return;
  }
  if (t.id === "monthSel") {
    state.month = Number(t.value);
    renderView();
    return;
  }
  if (t.dataset.f === "splitMode" && state.tab === "budget") {
    const row = t.closest(".brow");
    const cat = getDraft().b.categories.find((c) => c.id === row.dataset.id);
    if (!cat) return;
    cat.splitMode = t.value;
    state.dirty = true;
    renderView();
  }
});

/* ================================================================== */
/* Data wiring + boot                                                  */
/* ================================================================== */
function refreshChrome() {
  const s = settings();
  const name = $(".brand b");
  if (name) name.textContent = s.familyName;
  const pig = $(".brand-pig");
  if (pig) pig.textContent = getMascot(s.mascot).emoji;
  const ys = $("#yearSel");
  if (ys) ys.innerHTML = yearOptions();
  updateBackground(s.mascot);

  const proSlot = $(".brand .pro-badge");
  if (proSlot) {
    if (isAdmin(state.user)) {
      proSlot.className = "pro-badge admin";
      proSlot.textContent = "👑 ADMIN";
      proSlot.setAttribute("data-act", "open-pro");
    } else if (isPro(s, state.user)) {
      const days = getProRemainingDays(s);
      proSlot.className = "pro-badge active";
      proSlot.textContent = (days !== null && days > 0 && !s.subscriptionId) ? `💎 PRO (${days}d left)` : "💎 PRO";
      proSlot.setAttribute("data-act", "open-pro");
    } else {
      proSlot.className = "pro-badge upgrade-trigger";
      proSlot.textContent = "✨ Upgrade to Pro";
      proSlot.setAttribute("data-act", "open-pro");
    }
  }
}

function updateCompoundDisplay() {
  const card = $("#compoundCalcCard");
  if (!card) return;
  const p = state.compound?.principal || 0;
  const m = state.compound?.monthly ?? 500;
  const r = state.compound?.rate ?? 8;
  const y = state.compound?.years ?? 10;
  const growth = calculateCompoundGrowth(p, m, r, y);

  const fvEl = $("#compoundFutureVal");
  if (fvEl) fvEl.textContent = fmt(growth.futureValue);
  const subEl = $("#compoundYearsSub");
  if (subEl) subEl.textContent = `in ${y} years at ${r}% annual return`;
  const contEl = $("#compoundContributed");
  if (contEl) contEl.textContent = fmt(growth.totalContributed);
  const intEl = $("#compoundInterest");
  if (intEl) intEl.textContent = `+${fmt(growth.totalInterest)}`;
  const yLabel = $("#compoundYearsLabel");
  if (yLabel) yLabel.textContent = `${y} years`;

  $$(".compound-year-btn").forEach((btn) => btn.classList.toggle("active", Number(btn.dataset.years) === y));

  const msEl = $("#compoundMilestone");
  if (msEl) {
    if (growth.futureValue >= 1000000) msEl.textContent = "🎉 Millionaire Nest Projected!";
    else if (growth.totalInterest > growth.totalContributed) msEl.textContent = "🚀 Interest Outearns Contributions!";
    else msEl.textContent = "🌱 Compounding in Action";
  }
}

function onData() {
  if (!state.user || !ready()) return;
  if (state.settings?.jars) {
    state.jars = state.settings.jars;
  } else if (!state.jars.length) {
    state.jars = JSON.parse(localStorage.getItem("piggynest_jars") || "[]");
  }
  if (state.settings?.feed) {
    state.feed = state.settings.feed;
  } else if (!state.feed.length) {
    state.feed = JSON.parse(localStorage.getItem("piggynest_activity_feed") || "[]");
  }
  checkDDayNotifications();
  checkPwaNotificationPrompt();

  // Automatic Year-End / New Year's Eve Wrapped Pop-up
  const now = new Date();
  const isYearEnd = (now.getMonth() === 11 && now.getDate() >= 31) || (now.getMonth() === 0 && now.getDate() <= 3);
  const wrappedAutoKey = `piggynest_wrapped_auto_${now.getFullYear()}`;
  if (isYearEnd && !localStorage.getItem(wrappedAutoKey) && ready()) {
    localStorage.setItem(wrappedAutoKey, "true");
    setTimeout(() => openWrappedStory(), 1000);
  }
  if (!$("#view")) {
    render();
    return;
  }
  refreshChrome();
  if (state.tab === "expenses") updateExpenseList();
  else if (state.tab === "budget") {
    if (!state.dirty && !drag) {
      state.draft = null;
      renderView();
    }
  } else renderView();
  refreshInvDialog();
  refreshRecurringDialog();
}

async function boot() {
  applyTheme(settings().theme);
  render();
  try {
    state.db = await createDb();
  } catch (err) {
    $("#app").innerHTML = splash("😵", "Couldn't load Firebase. Check your connection and firebase-config.js.");
    console.error(err);
    return;
  }
  state.db.onAuth((user) => {
    unsubscribe?.();
    unsubscribe = null;
    state.user = user;
    state.loaded = { settings: false, budgets: false, expenses: false, recurring: false };
    state.settings = null;
    state.budgets = {};
    state.expenses = [];
    state.investments = [];
    state.recurring = [];
    state.recId = null;
    state.draft = null;
    state.dirty = false;
    if (user) {
      unsubscribe = state.db.subscribe({
        settings: (s) => { state.settings = s; state.loaded.settings = true; applyTheme(s?.theme); onData(); },
        budgets: (b) => { state.budgets = b; state.loaded.budgets = true; onData(); },
        expenses: (e) => { state.expenses = e; state.loaded.expenses = true; onData(); },
        investments: (v) => { state.investments = v; onData(); },
        recurring: (r) => { state.recurring = r || []; state.loaded.recurring = true; onData(); },
        error: (e) => toast(e.code === "permission-denied" ? "No permission. Check your Firestore rules." : "Sync problem: " + e.message),
      });
    }
    render();
  });
}

/* ================================================================== */
/* Floating background                                                 */
/* ================================================================== */
function getMiniSymbolId(mascotId) {
  const m = mascotId || settings().mascot || "piggy";
  if (m === "cat") return "mini-cat";
  if (m === "bear") return "mini-bear";
  if (m === "bunny") return "mini-bunny";
  return "mini-pig";
}

function updateBackground(mascotId) {
  const sym = getMiniSymbolId(mascotId);
  const bg = $(".bg-float");
  if (!bg) {
    addBackground(mascotId);
    return;
  }
  bg.querySelectorAll("use.fl-mascot").forEach((u) => {
    u.setAttribute("href", `#${sym}`);
    if (u.hasAttribute("xlink:href")) u.setAttribute("xlink:href", `#${sym}`);
  });
}

function addBackground(mascotId) {
  if ($(".bg-float")) {
    if (mascotId) updateBackground(mascotId);
    return;
  }
  const sym = getMiniSymbolId(mascotId);
  const mascotItem = (x, y, size, dur, delay, op, cls, flip) =>
    `<svg class="fl ${cls}" viewBox="0 0 64 56" style="--x:${x}%;--y:${y}%;--s:${size}px;--d:${dur}s;--delay:${delay}s;--o:${op}"><use class="fl-mascot" href="#${sym}" xlink:href="#${sym}"${flip ? ' transform="translate(64 0) scale(-1 1)"' : ""}/></svg>`;
  const bit = (ch, x, y, size, dur, delay, op, cls) =>
    `<span class="fl emo ${cls}" style="--x:${x}%;--y:${y}%;--s:${size}px;--d:${dur}s;--delay:${delay}s;--o:${op}">${ch}</span>`;
  const items = [
    mascotItem(3, 16, 46, 80, -10, 0.35, "a", false),
    mascotItem(88, 12, 42, 90, -30, 0.32, "b", true),
    mascotItem(5, 74, 40, 85, -50, 0.3, "b", false),
    mascotItem(90, 72, 48, 95, -20, 0.32, "a", true),
    bit("✨", 50, 6, 18, 70, -5, 0.4, "a"),
    bit("✨", 72, 92, 18, 75, -35, 0.4, "b"),
  ];
  const el = document.createElement("div");
  el.className = "bg-float";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = `
    <svg width="0" height="0" style="position:absolute"><defs>
      <symbol id="mini-pig" viewBox="0 0 64 56">
        <path d="M14 14 L10 2 Q20 4 26 12 Z" fill="#ff9ebb"/>
        <path d="M40 10 L48 0 Q56 6 54 16 Z" fill="#ff9ebb"/>
        <rect x="16" y="44" width="9" height="10" rx="4.5" fill="#ff9ebb"/>
        <rect x="38" y="44" width="9" height="10" rx="4.5" fill="#ff9ebb"/>
        <ellipse cx="32" cy="32" rx="26" ry="20" fill="#ffd0de" stroke="#ff8fb1" stroke-width="3"/>
        <ellipse cx="47" cy="36" rx="9" ry="7" fill="#ffb3cb" stroke="#ff8fb1" stroke-width="2.5"/>
        <circle cx="44" cy="36" r="1.6" fill="#7a5a8a"/><circle cx="50" cy="36" r="1.6" fill="#7a5a8a"/>
        <circle cx="37" cy="26" r="2.6" fill="#4f3d5c"/><circle cx="37.9" cy="25.1" r="0.9" fill="#fff"/>
        <ellipse cx="30" cy="38" rx="5" ry="3" fill="#ff7a9c" opacity=".35"/>
      </symbol>
      <symbol id="mini-piggy" viewBox="0 0 64 56">
        <use href="#mini-pig"/>
      </symbol>
      <symbol id="mini-cat" viewBox="0 0 64 56">
        <polygon points="12,24 10,6 26,14" fill="#fbe5d8" stroke="#e09f67" stroke-width="2.5" stroke-linejoin="round"/>
        <polygon points="14,21 13,10 23,15" fill="#ffb4cb"/>
        <polygon points="38,14 54,6 52,24" fill="#fbe5d8" stroke="#e09f67" stroke-width="2.5" stroke-linejoin="round"/>
        <polygon points="41,15 51,10 50,21" fill="#ffb4cb"/>
        <rect x="16" y="44" width="9" height="10" rx="4.5" fill="#fbe5d8" stroke="#e09f67" stroke-width="2"/>
        <rect x="38" y="44" width="9" height="10" rx="4.5" fill="#fbe5d8" stroke="#e09f67" stroke-width="2"/>
        <path d="M10 36 Q2 32 4 24" fill="none" stroke="#e09f67" stroke-width="3" stroke-linecap="round"/>
        <ellipse cx="32" cy="34" rx="25" ry="19" fill="#fbe5d8" stroke="#e09f67" stroke-width="3"/>
        <ellipse cx="28" cy="38" rx="5" ry="3" fill="#ff7a9c" opacity=".35"/>
        <ellipse cx="50" cy="38" rx="5" ry="3" fill="#ff7a9c" opacity=".35"/>
        <circle cx="36" cy="28" r="2.5" fill="#4f3d5c"/><circle cx="36.8" cy="27.2" r="0.9" fill="#fff"/>
        <circle cx="48" cy="28" r="2.5" fill="#4f3d5c"/><circle cx="48.8" cy="27.2" r="0.9" fill="#fff"/>
        <polygon points="41,33 45,33 43,35" fill="#ff7a9c"/>
        <path d="M41 36 q2 2 2 0 q0 2 2 0" fill="none" stroke="#7a5a8a" stroke-width="1.6" stroke-linecap="round"/>
        <path d="M30 34 L22 32 M30 37 L22 38 M54 34 L62 32 M54 37 L62 38" stroke="#4f3d5c" stroke-width="1.4" stroke-linecap="round"/>
      </symbol>
      <symbol id="mini-bear" viewBox="0 0 64 56">
        <circle cx="14" cy="16" r="9" fill="#ddb892" stroke="#936639" stroke-width="2.5"/>
        <circle cx="14" cy="16" r="5" fill="#ede0d4"/>
        <circle cx="50" cy="16" r="9" fill="#ddb892" stroke="#936639" stroke-width="2.5"/>
        <circle cx="50" cy="16" r="5" fill="#ede0d4"/>
        <rect x="16" y="44" width="9" height="10" rx="4.5" fill="#ddb892"/>
        <rect x="38" y="44" width="9" height="10" rx="4.5" fill="#ddb892"/>
        <ellipse cx="32" cy="34" rx="25" ry="19" fill="#ddb892" stroke="#936639" stroke-width="3"/>
        <ellipse cx="44" cy="36" rx="8" ry="6" fill="#ede0d4" stroke="#936639" stroke-width="2"/>
        <ellipse cx="46" cy="33.5" rx="3" ry="2" fill="#582f0e"/>
        <path d="M46 35.5 v2.5 m-2.5 0 q2.5 2 5 0" fill="none" stroke="#582f0e" stroke-width="1.5" stroke-linecap="round"/>
        <circle cx="34" cy="27" r="2.5" fill="#3a2212"/><circle cx="34.8" cy="26.2" r="0.9" fill="#fff"/>
        <ellipse cx="28" cy="38" rx="4.5" ry="2.8" fill="#e07a5f" opacity=".4"/>
      </symbol>
      <symbol id="mini-bunny" viewBox="0 0 64 56">
        <ellipse cx="18" cy="12" rx="6.5" ry="14" transform="rotate(-12 18 12)" fill="#faf5fb" stroke="#dfa6c4" stroke-width="2.5"/>
        <ellipse cx="18" cy="12" rx="3.5" ry="9" transform="rotate(-12 18 12)" fill="#ffb4cb"/>
        <ellipse cx="38" cy="12" rx="6.5" ry="14" transform="rotate(12 38 12)" fill="#faf5fb" stroke="#dfa6c4" stroke-width="2.5"/>
        <ellipse cx="38" cy="12" rx="3.5" ry="9" transform="rotate(12 38 12)" fill="#ffb4cb"/>
        <circle cx="8" cy="36" r="6" fill="#faf5fb" stroke="#dfa6c4" stroke-width="2"/>
        <rect x="16" y="44" width="9" height="10" rx="4.5" fill="#faf5fb" stroke="#dfa6c4" stroke-width="2"/>
        <rect x="38" y="44" width="9" height="10" rx="4.5" fill="#faf5fb" stroke="#dfa6c4" stroke-width="2"/>
        <ellipse cx="32" cy="34" rx="25" ry="19" fill="#faf5fb" stroke="#dfa6c4" stroke-width="3"/>
        <circle cx="36" cy="28" r="2.5" fill="#4f3d5c"/><circle cx="36.8" cy="27.2" r="0.9" fill="#fff"/>
        <ellipse cx="46" cy="33" rx="2" ry="1.5" fill="#ff7a9c"/>
        <path d="M46 34.5 v2 m-2 1 q2 1.5 4 0" fill="none" stroke="#7a5a8a" stroke-width="1.4" stroke-linecap="round"/>
        <ellipse cx="30" cy="38" rx="5" ry="3" fill="#ff7a9c" opacity=".4"/>
        <ellipse cx="50" cy="38" rx="5" ry="3" fill="#ff7a9c" opacity=".4"/>
        <path d="M30 35 L22 34 M30 38 L22 40" stroke="#7a5a8a" stroke-width="1.2" stroke-linecap="round"/>
      </symbol>
    </defs></svg>${items.join("")}`;
  document.body.prepend(el);
}
addBackground();

$("#settingsDialog").addEventListener("close", () => { state.invId = null; state.recId = null; applyTheme(settings().theme); updateBackground(settings().mascot); });

boot();

/* ================================================================== */
/* PWA Service Worker & Auto-update Management                        */
/* ================================================================== */
let swDismissed = false;

function showUpdatePrompt(worker) {
  if (swDismissed || !worker) return;
  let promptEl = $("#pwaUpdatePrompt");
  if (!promptEl) {
    promptEl = document.createElement("div");
    promptEl.id = "pwaUpdatePrompt";
    promptEl.className = "update-prompt";
    promptEl.setAttribute("role", "alert");
    promptEl.setAttribute("aria-live", "polite");
    promptEl.innerHTML = `
      <div class="update-prompt-text">
        <span>✨</span>
        <span>New update available!</span>
      </div>
      <div class="update-prompt-actions">
        <button type="button" class="btn btn-primary sm" id="pwaReloadBtn">Refresh</button>
        <button type="button" class="update-prompt-close" id="pwaDismissBtn" aria-label="Dismiss">✕</button>
      </div>
    `;
    document.body.appendChild(promptEl);

    promptEl.querySelector("#pwaReloadBtn")?.addEventListener("click", () => {
      promptEl.classList.remove("show");
      worker.postMessage({ type: "SKIP_WAITING" });
    });

    promptEl.querySelector("#pwaDismissBtn")?.addEventListener("click", () => {
      swDismissed = true;
      promptEl.classList.remove("show");
    });
  }

  requestAnimationFrame(() => {
    promptEl.classList.add("show");
  });
}

function initPwaUpdates() {
  if (!("serviceWorker" in navigator)) return;

  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("./sw.js");

      // Check if a worker is already waiting
      if (reg.waiting && navigator.serviceWorker.controller) {
        showUpdatePrompt(reg.waiting);
      }

      // Check when a new worker is installed
      reg.addEventListener("updatefound", () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", () => {
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            showUpdatePrompt(newWorker);
          }
        });
      });

      // Check for updates on focus and visibility changes
      const checkUpdate = () => {
        reg.update().catch(() => {});
      };
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") checkUpdate();
      });
      window.addEventListener("focus", checkUpdate);
    } catch (err) {
      console.warn("ServiceWorker registration failed:", err);
    }
  });
}

initPwaUpdates();
