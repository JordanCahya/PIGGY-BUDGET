import { createDb } from "./db.js";

/* ================================================================== */
/* Helpers                                                             */
/* ================================================================== */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = (n) => String(n).padStart(2, "0");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const PALETTE = ["#ff9ebb", "#6fd6b8", "#78b8ff", "#ffd56b", "#c4b2ff", "#ffb48a", "#9be37a", "#f5a3e4"];
const PERSON_KEYS = ["p1", "p2"];
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
  loaded: { settings: false, budgets: false, expenses: false },
  tab: "home",
  year: now.getFullYear(),
  month: now.getMonth(),
  draft: null, // { year, b } — the budget being edited
  dirty: false,
  editingId: null,
  lastCat: null,
  lastPaidBy: "p1",
};
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
  persons: [
    { id: "p1", name: "Mommy", emoji: "🌸" },
    { id: "p2", name: "Daddy", emoji: "🌿" },
  ],
};

function settings() {
  const s = state.settings || {};
  const persons = Array.isArray(s.persons) && s.persons.length === 2 ? s.persons : DEFAULT_SETTINGS.persons;
  return { ...DEFAULT_SETTINGS, ...s, persons };
}

function defaultCategories() {
  const base = [
    ["🏠", "Home & rent", 28],
    ["🍙", "Food & groceries", 20],
    ["🚌", "Transport", 10],
    ["💡", "Bills & utilities", 10],
    ["🎒", "Kids & school", 8],
    ["💊", "Health", 5],
    ["🎈", "Fun & dining out", 9],
    ["🐷", "Savings", 10],
  ];
  return base.map(([emoji, name, percent], i) => ({
    id: uid() + i, emoji, name, percent, color: PALETTE[i % PALETTE.length], splitMode: "income", p1Share: 50,
  }));
}

function defaultBudget(year) {
  return { year, income: { p1: 0, p2: 0 }, categories: defaultCategories() };
}

function normalizeBudget(b) {
  const out = clone(b);
  out.income = { p1: Number(out.income?.p1) || 0, p2: Number(out.income?.p2) || 0 };
  out.categories = (out.categories || []).map((c, i) => ({
    id: c.id || uid(),
    emoji: c.emoji || "✨",
    name: c.name || "Untitled",
    percent: Number(c.percent) || 0,
    color: c.color || PALETTE[i % PALETTE.length],
    splitMode: c.splitMode === "custom" ? "custom" : "income",
    p1Share: c.p1Share ?? 50,
  }));
  return out;
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

// Yearly income -> yearly budget per category -> monthly (÷ 12), plus the split per person.
function calc(b) {
  const inc1 = Number(b.income.p1) || 0;
  const inc2 = Number(b.income.p2) || 0;
  const total = inc1 + inc2;
  const r1 = total > 0 ? inc1 / total : 0.5;
  let pctSum = 0;
  const cats = b.categories.map((c) => {
    const percent = Number(c.percent) || 0;
    pctSum += percent;
    const yearly = (total * percent) / 100;
    const ratio1 = c.splitMode === "custom" ? (Number(c.p1Share ?? 50) || 0) / 100 : r1;
    return {
      ...c, percent, yearly, monthly: yearly / 12, ratio1,
      monthly1: (yearly / 12) * ratio1, monthly2: (yearly / 12) * (1 - ratio1),
      yearly1: yearly * ratio1, yearly2: yearly * (1 - ratio1),
    };
  });
  return { inc1, inc2, total, r1, cats, pctSum };
}

// Spending for one year: byCat[categoryId][monthIndex] and months[monthIndex]
function spendIndex(year) {
  const blank = () => Array.from({ length: 12 }, () => ({ p1: 0, p2: 0, total: 0 }));
  const byCat = {};
  const months = blank();
  for (const e of state.expenses) {
    if (!e.date || !e.date.startsWith(`${year}-`)) continue;
    const mi = Number(e.date.slice(5, 7)) - 1;
    if (mi < 0 || mi > 11) continue;
    const amt = Number(e.amount) || 0;
    const who = e.paidBy === "p2" ? "p2" : "p1";
    const row = (byCat[e.categoryId] ??= blank());
    row[mi][who] += amt;
    row[mi].total += amt;
    months[mi][who] += amt;
    months[mi].total += amt;
  }
  return { byCat, months };
}

const usedStatus = (pct) => (pct > 100 ? "over" : pct >= 80 ? "warn" : "");

/* ================================================================== */
/* Rendering: shell                                                    */
/* ================================================================== */
const TABS = [
  ["home", "🏡", "Home"],
  ["expenses", "🧾", "Expenses"],
  ["budget", "🎯", "Budget"],
  ["year", "📅", "Year"],
];

const ready = () => state.loaded.settings && state.loaded.budgets && state.loaded.expenses;

function render() {
  const root = $("#app");
  if (!state.db) {
    root.innerHTML = splash("🐷", "Waking up the piggy…");
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
        <span class="brand-pig">🐷</span>
        <div><b>${esc(s.familyName)}</b><small>PiggyNest</small></div>
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

function renderView() {
  const v = $("#view");
  if (!v) return;
  const builders = { home: homeHtml, expenses: expensesHtml, budget: budgetHtml, year: yearHtml };
  v.innerHTML = builders[state.tab]();
  if (state.tab === "expenses") {
    initExpenseForm();
    updateExpenseList();
  }
  if (state.tab === "budget") updateBudgetDerived();
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
function piggySvg(level) {
  const lv = Math.max(0, Math.min(1, level));
  const y = (137 - lv * 104).toFixed(1);
  const ya = (y - 7).toFixed(1);
  return `
  <svg class="piggy" viewBox="0 0 220 160" role="img" aria-label="Piggy bank, ${Math.round(lv * 100)}% of this month's budget left">
    <defs><clipPath id="pigBody"><ellipse cx="100" cy="86" rx="72" ry="52"/></clipPath></defs>
    <path d="M62 50 L54 16 Q76 20 90 40 Z" fill="#ff9ebb"/>
    <path d="M108 38 L124 12 Q142 22 140 48 Z" fill="#ff9ebb"/>
    <rect x="52" y="120" width="26" height="30" rx="11" fill="#ff9ebb"/>
    <rect x="118" y="120" width="26" height="30" rx="11" fill="#ff9ebb"/>
    <path d="M30 80 q-22 -6 -15 -23 q7 -12 15 -2" fill="none" stroke="#ff9ebb" stroke-width="6" stroke-linecap="round"/>
    <ellipse cx="100" cy="86" rx="72" ry="52" fill="#ffeef4"/>
    <g clip-path="url(#pigBody)"><path d="M0 ${y} Q25 ${ya} 50 ${y} T100 ${y} T150 ${y} T200 ${y} V160 H0 Z" fill="#ff9ebb"/></g>
    <ellipse cx="100" cy="86" rx="72" ry="52" fill="none" stroke="#ff8fb1" stroke-width="4"/>
    <rect x="80" y="38" width="40" height="7" rx="3.5" fill="#7a5a8a"/>
    <ellipse cx="170" cy="92" rx="20" ry="16" fill="#ffb3cb" stroke="#ff8fb1" stroke-width="4"/>
    <circle cx="164" cy="92" r="3" fill="#7a5a8a"/><circle cx="176" cy="92" r="3" fill="#7a5a8a"/>
    <circle cx="142" cy="72" r="5" fill="#4f3d5c"/><circle cx="143.6" cy="70.4" r="1.7" fill="#fff"/>
    <ellipse cx="132" cy="92" rx="9" ry="6" fill="#ff7a9c" opacity=".4"/>
  </svg>`;
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

  let msg;
  if (c.total <= 0) msg = "Add your yearly income in Budget and I'll split it into months for you.";
  else if (spent === 0) msg = "A fresh month. Nothing spent yet.";
  else if (pct < 70) msg = "Looking good. You're well within this month's budget.";
  else if (pct <= 100) msg = "Getting close to the monthly limit. Spend gently.";
  else msg = `Over budget by ${fmt(spent - monthBudget)}. Let's plan the rest of the year carefully.`;

  const notice = !exists
    ? `<div class="notice"><span>${carried ? `No saved plan for ${state.year} yet. Showing ${carried}'s plan.` : `No budget saved for ${state.year} yet.`}</span><button class="btn btn-soft" data-act="tab" data-tab="budget">Set up ${state.year} budget</button></div>`
    : "";

  const sampleBtn = state.db.mode === "local" && !state.expenses.length && !Object.keys(state.budgets).length
    ? `<div class="notice"><span>Want a quick look around? Fill the app with sample data.</span><button class="btn btn-primary" data-act="sample">Load sample data</button></div>` : "";

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
          <span class="chip">${Math.round(used)}%</span>
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
    ${notice}${sampleBtn}
    <section class="card hero">
      <div class="hero-pig">${piggySvg(monthBudget > 0 ? left / monthBudget : 0)}</div>
      <div class="hero-text">
        <h1>${MONTHS_LONG[m]} ${state.year}</h1>
        <p class="hero-left"><b class="${left < 0 ? "neg" : ""}">${fmt(left)}</b> ${left < 0 ? "over budget" : "left to spend"}</p>
        <div class="meter"><i class="${usedStatus(pct)}" style="width:${Math.min(pct, 100)}%"></i></div>
        <p class="hero-sub">${fmt(spent)} spent of ${fmt(monthBudget)} (yearly budget ÷ 12)</p>
        <p class="bubble">${esc(msg)}</p>
      </div>
    </section>
    <div class="section-title"><h2>Where the money goes</h2><small>Monthly budgets come from your yearly plan</small></div>
    <section class="grid">${cards.join("") || `<div class="card empty">🎯<p>No categories yet. Add some in Budget.</p></div>`}</section>
    <div class="section-title"><h2>Who's paying</h2></div>
    <section class="grid-2 people">${people}</section>`;
}

/* ================================================================== */
/* Rendering: Expenses                                                 */
/* ================================================================== */
function expensesHtml() {
  const s = settings();
  return `
    <div class="two-col">
      <section class="card form-card">
        <h2 id="expFormTitle">Add an expense</h2>
        <form id="expForm" autocomplete="off">
          <label>Date<input type="date" name="date" required></label>
          <label>Amount<input type="number" name="amount" min="0" step="any" inputmode="decimal" placeholder="0" required></label>
          <label>Category<select name="categoryId" required></select></label>
          <fieldset class="who">
            <legend>Paid by</legend>
            ${PERSON_KEYS.map((k, i) => `<label class="who-pill"><input type="radio" name="paidBy" value="${k}" ${k === state.lastPaidBy ? "checked" : ""}><span>${esc(s.persons[i].emoji)} ${esc(s.persons[i].name)}</span></label>`).join("")}
          </fieldset>
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
  const ym = `${state.year}-${pad(state.month + 1)}`;
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  f.date.value = today.startsWith(ym) ? today : `${ym}-01`;
  state.editingId = null;
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
          <div class="exp-main"><b>${esc(e.note || cat?.name || "Other")}</b><small>${Number(e.date.slice(8, 10))} ${MONTHS[state.month]} · ${esc(cat?.name || "Other")}</small></div>
          <span class="chip who-${PERSON_KEYS[pi]}">${esc(s.persons[pi].emoji)} ${esc(s.persons[pi].name)}</span>
          <b class="exp-amt">${fmt(e.amount)}</b>
          <div class="row-actions">
            <button class="icon-btn sm" data-act="edit-exp" data-id="${esc(e.id)}" aria-label="Edit expense">✏️</button>
            <button class="icon-btn sm" data-act="del-exp" data-id="${esc(e.id)}" aria-label="Delete expense">🗑️</button>
          </div>
        </div>`;
      }).join("")
    : `<div class="empty">🌱<p>No expenses yet this month.<br>Add the first one on the left.</p></div>`;
}

async function submitExpense(form) {
  const fd = new FormData(form);
  const amount = Number(fd.get("amount"));
  const date = String(fd.get("date") || "");
  const categoryId = String(fd.get("categoryId") || "");
  if (!(amount > 0) || !date || !categoryId) {
    toast("Enter a date, an amount and a category.");
    return;
  }
  const data = { date, amount, categoryId, paidBy: fd.get("paidBy") === "p2" ? "p2" : "p1", note: String(fd.get("note") || "").trim() };
  state.lastCat = categoryId;
  state.lastPaidBy = data.paidBy;
  try {
    if (state.editingId) await state.db.updateExpense(state.editingId, data);
    else await state.db.addExpense(data);
  } catch (err) {
    toast("Couldn't save: " + (err.message || err));
    return;
  }
  const wasEditing = !!state.editingId;
  toast(wasEditing ? "Expense updated" : "Expense added");
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
  f.amount.value = e.amount;
  f.categoryId.value = e.categoryId;
  f.note.value = e.note || "";
  $$("input[name=paidBy]", f).forEach((r) => (r.checked = r.value === (e.paidBy === "p2" ? "p2" : "p1")));
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
        <input data-f="name" value="${esc(cat.name)}" maxlength="30" placeholder="Category name" aria-label="Category name">
        <label class="pct-in"><input type="number" data-f="percent" min="0" max="100" step="0.5" value="${cat.percent}" aria-label="Percent of income"><span>%</span></label>
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
              <input type="number" min="0" step="any" inputmode="decimal" data-income="${k}" value="${d.b.income[k] || ""}" placeholder="0">
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
      <small>Give each category a percentage of your total income. Each one can be split between you by income, or with a custom split.</small>
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
      <div class="table-wrap">
        <table>
          <thead><tr><th>Category</th><th>Year budget</th><th>Spent</th><th>Left</th>${MONTHS.map((m) => `<th>${m}</th>`).join("")}</tr></thead>
          <tbody>${rows || `<tr><td colspan="16">No categories yet.</td></tr>`}</tbody>
        </table>
      </div>
    </section>`;
}

/* ================================================================== */
/* Settings dialog                                                     */
/* ================================================================== */
function openSettings() {
  const s = settings();
  const dlg = $("#settingsDialog");
  dlg.innerHTML = `
    <div class="dlg-body">
      <h2>Family settings</h2>
      <label>Family name<input id="setFamily" value="${esc(s.familyName)}" maxlength="30"></label>
      <label>Currency
        <select id="setCurrency">${CURRENCIES.map((cur) => `<option ${cur === s.currency ? "selected" : ""}>${cur}</option>`).join("")}</select>
      </label>
      ${PERSON_KEYS.map((k, i) => `
        <div class="dlg-people">
          <label>Emoji<input id="setEmoji${i}" value="${esc(s.persons[i].emoji)}" maxlength="4" style="text-align:center"></label>
          <label>Person ${i + 1}<input id="setName${i}" value="${esc(s.persons[i].name)}" maxlength="20"></label>
        </div>`).join("")}
      <button class="btn btn-soft" data-act="export-csv">Download expenses (CSV)</button>
      <div class="dlg-actions">
        <button class="btn btn-ghost" data-act="close-settings">Cancel</button>
        <button class="btn btn-primary" data-act="save-settings">Save</button>
      </div>
    </div>`;
  dlg.showModal();
}

async function saveSettings() {
  const next = {
    familyName: $("#setFamily").value.trim() || "Our Cozy Family",
    currency: $("#setCurrency").value,
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
  $("#settingsDialog").close();
  toast("Settings saved");
}

function exportCsv() {
  const s = settings();
  const cats = {};
  Object.values(state.budgets).forEach((b) => (b.categories || []).forEach((c) => (cats[c.id] = c.name)));
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["Date", "Category", "Paid by", "Amount", "Note"].map(q).join(",")];
  [...state.expenses].sort((a, b) => a.date.localeCompare(b.date)).forEach((e) =>
    lines.push([e.date, cats[e.categoryId] || "Other", s.persons[e.paidBy === "p2" ? 1 : 0].name, e.amount, e.note].map(q).join(","))
  );
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: "piggynest-expenses.csv" });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
          paidBy: Math.random() < c.r1 ? "p1" : "p2",
          note: "",
        });
      }
    }
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
/* Events                                                              */
/* ================================================================== */
document.addEventListener("click", async (ev) => {
  const el = ev.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  switch (act) {
    case "tab": setTab(el.dataset.tab); break;
    case "open-settings": openSettings(); break;
    case "close-settings": $("#settingsDialog").close(); break;
    case "save-settings": saveSettings(); break;
    case "export-csv": exportCsv(); break;
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

document.addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (ev.target.id === "expForm") submitExpense(ev.target);
  if (ev.target.id === "authForm") doAuth("signin");
});

document.addEventListener("input", (ev) => {
  const t = ev.target;
  if (state.tab !== "budget" || !$("#view")?.contains(t)) return;
  const d = getDraft();
  if (t.dataset.income) {
    d.b.income[t.dataset.income] = t.value === "" ? 0 : Number(t.value);
    markDirty();
    return;
  }
  const row = t.closest(".brow");
  const f = t.dataset.f;
  if (!row || !f || f === "splitMode") return;
  const cat = d.b.categories.find((c) => c.id === row.dataset.id);
  if (!cat) return;
  if (f === "percent" || f === "p1Share") cat[f] = t.value === "" ? 0 : Number(t.value);
  else cat[f] = t.value;
  markDirty();
});

document.addEventListener("change", (ev) => {
  const t = ev.target;
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
  const name = $(".brand b");
  if (name) name.textContent = settings().familyName;
  const ys = $("#yearSel");
  if (ys) ys.innerHTML = yearOptions();
}

function onData() {
  if (!state.user || !ready()) return;
  if (!$("#view")) {
    render();
    return;
  }
  refreshChrome();
  if (state.tab === "expenses") updateExpenseList();
  else if (state.tab === "budget") {
    if (!state.dirty) {
      state.draft = null;
      renderView();
    }
  } else renderView();
}

async function boot() {
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
    state.loaded = { settings: false, budgets: false, expenses: false };
    state.settings = null;
    state.budgets = {};
    state.expenses = [];
    state.draft = null;
    state.dirty = false;
    if (user) {
      unsubscribe = state.db.subscribe({
        settings: (s) => { state.settings = s; state.loaded.settings = true; onData(); },
        budgets: (b) => { state.budgets = b; state.loaded.budgets = true; onData(); },
        expenses: (e) => { state.expenses = e; state.loaded.expenses = true; onData(); },
        error: (e) => toast(e.code === "permission-denied" ? "No permission. Check your Firestore rules." : "Sync problem: " + e.message),
      });
    }
    render();
  });
}

boot();
