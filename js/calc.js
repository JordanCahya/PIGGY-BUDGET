// Pure financial math, budget models, and expense indexing

export const PERSON_KEYS = ["p1", "p2"];
export const PALETTE = ["#ff9ebb", "#6fd6b8", "#78b8ff", "#ffd56b", "#c4b2ff", "#ffb48a", "#9be37a", "#f5a3e4"];

export const PAYMENT_METHODS = [
  { id: "cash", name: "Cash", emoji: "💵" },
  { id: "credit_card", name: "Credit Card", emoji: "💳" },
  { id: "installment", name: "Installment", emoji: "⏳" },
];

export const THEMES = [
  { id: "default", name: "Cozy Pink", emoji: "🌸", color: "#ff8fb1", pro: false },
  { id: "mocha", name: "Dark Mocha", emoji: "☕", color: "#d4a373", pro: true },
  { id: "matcha", name: "Matcha Sage", emoji: "🍵", color: "#7cb587", pro: true },
  { id: "lavender", name: "Lavender Dream", emoji: "🪻", color: "#a688fa", pro: true },
  { id: "honey", name: "Honey Cream", emoji: "🍯", color: "#f4b251", pro: true },
];

export const MASCOTS = [
  { id: "piggy", name: "Piggy Bank", emoji: "🐷", pro: false },
  { id: "cat", name: "Mochi the Cat", emoji: "🐱", pro: true },
  { id: "bear", name: "Boba the Bear", emoji: "🐻", pro: true },
  { id: "bunny", name: "Bunny the Rabbit", emoji: "🐰", pro: true },
];

export const PRO_PRICE = "$2.00 / month";
export const PAYPAL_PLAN_ID = "P-0TR67131SL0448510NLVTYGI";
export const PAYPAL_CLIENT_ID = "BAAHSPhp62grKR7PYtxRFB1-GtBotGFDT3_LbQ-eKExdQNvLDyAkpDmY9_WQHethJN7amo5N7arDDoaYRY";

export const ADMIN_EMAILS = [
  "jordancahya1@gmail.com",
  "jordancahya@gmail.com",
];

export function isAdmin(user) {
  if (!user || typeof user !== "object") return false;
  const email = String(user.email || "").trim().toLowerCase();
  return Boolean(email && ADMIN_EMAILS.includes(email));
}

export function isPro(settings, user = null) {
  if (isAdmin(user)) return true;
  if (settings?.pro === true) return true;
  if (settings?.proUntil && new Date(settings.proUntil) > new Date()) return true;
  return false;
}

export function getProRemainingDays(settings) {
  if (!settings || typeof settings !== "object") return 0;
  if (!settings.proUntil) {
    return settings.pro === true ? null : 0;
  }
  const until = new Date(settings.proUntil);
  if (isNaN(until.getTime())) {
    return settings.pro === true ? null : 0;
  }
  const now = new Date();
  const diffMs = until.getTime() - now.getTime();
  if (diffMs <= 0) return 0;
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

export function getTheme(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

export function getMascot(id) {
  return MASCOTS.find((m) => m.id === id) || MASCOTS[0];
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export function defaultCategories() {
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
    id: uid() + i,
    emoji,
    name,
    percent,
    color: PALETTE[i % PALETTE.length],
    splitMode: "income",
    p1Share: 50,
  }));
}

export function defaultBudget(year) {
  return { year, income: { p1: 0, p2: 0 }, categories: defaultCategories() };
}

export function normalizeBudget(b) {
  const out = clone(b || {});
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

// Yearly income -> yearly budget per category -> monthly (÷ 12), plus the split per person.
export function calc(b) {
  const inc1 = Number(b?.income?.p1) || 0;
  const inc2 = Number(b?.income?.p2) || 0;
  const total = inc1 + inc2;
  const r1 = total > 0 ? inc1 / total : 0.5;
  let pctSum = 0;
  const cats = (b?.categories || []).map((c) => {
    const percent = Number(c.percent) || 0;
    pctSum += percent;
    const yearly = (total * percent) / 100;
    const ratio1 = c.splitMode === "custom" ? (Number(c.p1Share ?? 50) || 0) / 100 : r1;
    return {
      ...c,
      percent,
      yearly,
      monthly: yearly / 12,
      ratio1,
      monthly1: (yearly / 12) * ratio1,
      monthly2: (yearly / 12) * (1 - ratio1),
      yearly1: yearly * ratio1,
      yearly2: yearly * (1 - ratio1),
    };
  });
  return { inc1, inc2, total, r1, cats, pctSum };
}

// Spending for one year: byCat[categoryId][monthIndex] and months[monthIndex]
export function spendIndex(year, expenses = []) {
  const blank = () => Array.from({ length: 12 }, () => ({ p1: 0, p2: 0, total: 0 }));
  const byCat = {};
  const months = blank();
  for (const e of expenses) {
    if (!e.date || !e.date.startsWith(`${year}-`)) continue;
    const mi = Number(e.date.slice(5, 7)) - 1;
    if (mi < 0 || mi > 11) continue;
    const amt = Number(e.amount) || 0;
    // "both" = paid together, counted 50:50 for each person
    const shares =
      e.paidBy === "both"
        ? { p1: amt / 2, p2: amt / 2 }
        : e.paidBy === "p2"
        ? { p1: 0, p2: amt }
        : { p1: amt, p2: 0 };
    const row = (byCat[e.categoryId] ??= blank());
    for (const k of PERSON_KEYS) {
      row[mi][k] += shares[k];
      months[mi][k] += shares[k];
    }
    row[mi].total += amt;
    months[mi].total += amt;
  }
  return { byCat, months };
}

export const usedStatus = (pct) => (pct > 100 ? "over" : pct >= 80 ? "warn" : "");

export function normalizeRecurringBills(bills) {
  if (!Array.isArray(bills)) return [];
  return bills.map((b, i) => {
    const day = parseInt(b?.dayOfMonth, 10);
    const dayOfMonth = Number.isFinite(day) ? Math.min(31, Math.max(1, day)) : 1;
    return {
      id: String(b?.id || uid() + i),
      name: String(b?.name ?? "Untitled Bill").trim() || "Untitled Bill",
      amount: Math.max(0, Number(b?.amount) || 0),
      categoryId: String(b?.categoryId || ""),
      paidBy: b?.paidBy === "both" || b?.paidBy === "p2" ? b.paidBy : "p1",
      dayOfMonth,
      active: b?.active !== false,
      paymentMethod: ["cash", "credit_card", "installment"].includes(b?.paymentMethod)
        ? b.paymentMethod
        : "cash",
      cardName: String(b?.cardName || "").trim(),
      installmentMonths: Number(b?.installmentMonths) || null,
    };
  });
}

export function getDueRecurringAlerts(recurringBills, expenses = [], targetDate = new Date()) {
  const d = targetDate instanceof Date ? targetDate : new Date(targetDate);
  const targetYear = d.getFullYear();
  const targetMonth = d.getMonth();
  const targetDay = d.getDate();

  const unloggedBills = findPendingRecurringBills(recurringBills, expenses, targetYear, targetMonth);

  const dDay = [];
  const upcoming = [];
  const overdue = [];

  for (const b of unloggedBills) {
    const diff = b.dayOfMonth - targetDay;
    if (diff === 0) {
      dDay.push({ ...b, diff, status: "d_day" });
    } else if (diff > 0 && diff <= 3) {
      upcoming.push({ ...b, diff, status: "upcoming" });
    } else if (diff < 0) {
      const daysOverdue = Math.abs(diff);
      overdue.push({ ...b, diff: daysOverdue, daysOverdue, status: "overdue" });
    }
  }

  upcoming.sort((a, b) => a.diff - b.diff);
  overdue.sort((a, b) => b.daysOverdue - a.daysOverdue);

  return { dDay, upcoming, overdue };
}

export function findPendingRecurringBills(recurringBills, expenses = [], year, month) {
  const normBills = normalizeRecurringBills(recurringBills);
  const targetYear = Number(year);
  const targetMonth = Number(month); // 0-indexed (0 = Jan, 11 = Dec)
  const prefix = `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}`;

  const monthExpenses = (expenses || []).filter((e) => {
    if (!e || !e.date) return false;
    if (typeof e.date === "string" && e.date.startsWith(prefix)) return true;
    const parts = String(e.date).split("-");
    if (parts.length >= 2) {
      return Number(parts[0]) === targetYear && (Number(parts[1]) - 1) === targetMonth;
    }
    return false;
  });

  return normBills.filter((bill) => {
    if (!bill.active) return false;

    const isLogged = monthExpenses.some((exp) => {
      // 1. Direct match by recurringId
      if (exp.recurringId && String(exp.recurringId) === String(bill.id)) {
        return true;
      }
      const expNote = String(exp.note || "").trim().toLowerCase();
      const expTitle = String(exp.name || exp.title || "").trim().toLowerCase();
      const billName = String(bill.name || "").trim().toLowerCase();
      const billCat = String(bill.categoryId || "").trim().toLowerCase();
      const expCat = String(exp.categoryId || "").trim().toLowerCase();

      // 2. Note or Title matches bill name
      if (billName && (expNote === billName || expTitle === billName)) {
        return true;
      }

      // 3. Matching category and bill name in note (e.g., "Netflix Subscription")
      if (billName && expNote && expCat === billCat && expNote.includes(billName)) {
        return true;
      }

      return false;
    });

    return !isLogged;
  });
}

export function buildReceiptPrompt(categories = []) {
  const catList = (Array.isArray(categories) ? categories : [])
    .map((c) => `- ID: "${c.id}", Name: "${c.emoji ? c.emoji + " " : ""}${c.name}"`)
    .join("\n");

  return [
    "You are a receipt scanning assistant for a personal budget application.",
    "Analyze the provided receipt image and extract the following information in JSON format:",
    "1. Merchant or store name (merchant).",
    "2. Transaction date in YYYY-MM-DD format (date). If not found, use today's date.",
    "3. Total transaction amount as a numeric value without currency symbols (amount).",
    "4. Suggested category ID from the list below that best matches the purchase (suggestedCategoryId).",
    "",
    "Available Categories:",
    catList || "(No categories provided, set suggestedCategoryId to null)",
    "",
    "Respond ONLY with a valid JSON object in the following format with no markdown and no extra text:",
    "{",
    '  "merchant": "Store Name",',
    '  "date": "YYYY-MM-DD",',
    '  "amount": 0.00,',
    '  "suggestedCategoryId": "id_or_null"',
    "}",
  ].join("\n");
}

export function parseReceiptResponse(geminiJsonText) {
  if (!geminiJsonText || typeof geminiJsonText !== "string") {
    return {
      merchant: "",
      date: "",
      amount: 0,
      suggestedCategoryId: null,
    };
  }

  let text = geminiJsonText.trim();

  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch) {
    text = codeBlockMatch[1].trim();
  } else {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      text = text.slice(firstBrace, lastBrace + 1).trim();
    }
  }

  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    try {
      const sanitized = text.replace(/,\s*([}\]])/g, "$1");
      parsed = JSON.parse(sanitized);
    } catch (e) {
      parsed = {};
    }
  }

  const merchant = typeof parsed.merchant === "string" ? parsed.merchant.trim() : "";
  let date = typeof parsed.date === "string" ? parsed.date.trim() : "";
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const d = new Date(date);
    if (!isNaN(d.getTime())) {
      date = d.toISOString().slice(0, 10);
    }
  }

  let amount = 0;
  if (typeof parsed.amount === "number") {
    amount = isNaN(parsed.amount) ? 0 : Math.max(0, parsed.amount);
  } else if (typeof parsed.amount === "string") {
    const cleaned = parsed.amount.replace(/[^0-9.-]/g, "");
    amount = Math.max(0, parseFloat(cleaned) || 0);
  }

  const suggestedCategoryId =
    parsed.suggestedCategoryId && typeof parsed.suggestedCategoryId === "string"
      ? parsed.suggestedCategoryId.trim()
      : null;

  return {
    merchant,
    date,
    amount,
    suggestedCategoryId,
  };
}

export function createBackupPayload(state = {}) {
  let settings = null;
  if (state.settings && typeof state.settings === "object") {
    const { geminiApiKey: _ignored, ...rest } = state.settings;
    settings = {
      ...rest,
      pro: state.settings.pro === true,
      proUntil: state.settings.proUntil || null,
      subscriptionId: state.settings.subscriptionId || null,
      trialUsed: Boolean(state.settings.trialUsed),
    };
  }
  return {
    version: 1,
    app: "piggynest",
    exportedAt: new Date().toISOString(),
    data: {
      settings,
      budgets: state.budgets || {},
      expenses: state.expenses || [],
      investments: state.investments || [],
      recurring: state.recurring || [],
    },
  };
}

export function validateBackupPayload(raw) {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { valid: false, error: "Invalid JSON format" };
    }
  }
  if (!parsed || typeof parsed !== "object") {
    return { valid: false, error: "Backup file is empty or invalid" };
  }
  const data = parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
  const hasSettings = Boolean(data.settings && typeof data.settings === "object");
  const hasBudgets = Boolean(data.budgets && typeof data.budgets === "object" && !Array.isArray(data.budgets));
  const hasExpenses = Array.isArray(data.expenses);
  const hasInvestments = Array.isArray(data.investments);
  const hasRecurring = Array.isArray(data.recurring);

  if (!hasSettings && !hasBudgets && !hasExpenses && !hasInvestments && !hasRecurring) {
    return { valid: false, error: "No recognizable PiggyNest data found in backup" };
  }

  return {
    valid: true,
    data: {
      settings: hasSettings
        ? (() => {
            const { geminiApiKey: _ignored, ...rest } = data.settings;
            return rest;
          })()
        : null,
      budgets: hasBudgets ? data.budgets : null,
      expenses: hasExpenses ? data.expenses : null,
      investments: hasInvestments ? data.investments : null,
      recurring: hasRecurring ? data.recurring : null,
    },
    summary: {
      hasSettings,
      isPro: hasSettings ? isPro(data.settings) : false,
      budgetsCount: hasBudgets ? Object.keys(data.budgets).length : 0,
      expensesCount: hasExpenses ? data.expenses.length : 0,
      investmentsCount: hasInvestments ? data.investments.length : 0,
      recurringCount: hasRecurring ? data.recurring.length : 0,
    },
  };
}
