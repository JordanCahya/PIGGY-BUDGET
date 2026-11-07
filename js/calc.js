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

export function generateWrappedData({
  year,
  budget,
  expenses = [],
  settings = {},
  investments = [],
  asOfDate = new Date(),
} = {}) {
  const targetYear = Number(year) || (budget && Number(budget.year)) || new Date().getFullYear();

  // 1. Determine YTD timeframe (elapsed months)
  const refDate = asOfDate instanceof Date ? asOfDate : new Date(asOfDate);
  const currentYear = refDate.getFullYear();
  const currentMonthIndex = refDate.getMonth(); // 0 = Jan, 10 = Nov, 11 = Dec

  let endMonthIndex = 11;
  let isYtd = false;

  if (targetYear < currentYear) {
    endMonthIndex = 11;
    isYtd = false;
  } else if (targetYear === currentYear) {
    endMonthIndex = Math.min(11, Math.max(0, currentMonthIndex));
    isYtd = endMonthIndex < 11;
  } else {
    endMonthIndex = 0;
    isYtd = true;
  }

  const elapsedMonths = endMonthIndex + 1;

  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const MONTH_SHORT = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];

  const endMonthName = MONTH_NAMES[endMonthIndex];
  const endMonthShortName = MONTH_SHORT[endMonthIndex];

  // 2. Budget calculation (annual and YTD)
  const normBudget = normalizeBudget(budget);
  const calculatedBudget = (budget && Array.isArray(budget.cats) && typeof budget.total === "number")
    ? budget
    : calc(normBudget);
  const totalBudget = Math.max(0, Number(calculatedBudget.total) || 0);
  const monthBudget = totalBudget > 0 ? totalBudget / 12 : 0;
  const ytdBudget = monthBudget * elapsedMonths;

  // 3. Spending aggregation via spendIndex filtered up to endMonthIndex
  const safeExpenses = Array.isArray(expenses) ? expenses : [];
  const { byCat, months } = spendIndex(targetYear, safeExpenses);

  // Filter valid expenses for that year up to endMonthIndex
  const yearExpenses = safeExpenses.filter((e) => {
    if (!e || typeof e !== "object") return false;
    if (typeof e.date !== "string" || !e.date.startsWith(`${targetYear}-`)) return false;
    const mi = Number(e.date.slice(5, 7)) - 1;
    return mi >= 0 && mi <= endMonthIndex;
  });

  // Total spent in YTD period
  let p1Paid = 0;
  let p2Paid = 0;
  let bothPaid = 0;
  const activeMonthIndices = new Set();

  for (const e of yearExpenses) {
    const amt = Math.max(0, Number(e.amount) || 0);
    const mi = Number(e.date.slice(5, 7)) - 1;
    activeMonthIndices.add(mi);

    if (e.paidBy === "both") {
      bothPaid += amt;
    } else if (e.paidBy === "p2") {
      p2Paid += amt;
    } else {
      p1Paid += amt;
    }
  }

  const totalSpent = p1Paid + p2Paid + bothPaid;
  const totalSaved = Math.max(0, ytdBudget - totalSpent);

  // 4. Happy Months: number of elapsed months (0 <= mi <= endMonthIndex) where month total spent <= monthBudget
  let happyMonthsCount = 0;
  if (monthBudget > 0) {
    for (let mi = 0; mi <= endMonthIndex; mi++) {
      if (months[mi].total <= monthBudget) {
        happyMonthsCount++;
      }
    }
  }

  // 5. Top Categories (ranked by spend in elapsed months)
  const catMetaMap = new Map();
  for (const c of calculatedBudget.cats || []) {
    if (c && c.id) {
      catMetaMap.set(String(c.id), {
        id: c.id,
        emoji: c.emoji || "✨",
        name: c.name || "Untitled",
        color: c.color,
      });
    }
  }

  const topCategories = [];
  for (const [catId, monthRows] of Object.entries(byCat)) {
    const catSpent = monthRows.slice(0, endMonthIndex + 1).reduce((sum, m) => sum + m.total, 0);
    if (catSpent <= 0) continue;
    const meta = catMetaMap.get(String(catId)) || {
      id: catId,
      emoji: "📦",
      name: "Other",
    };
    topCategories.push({
      id: meta.id,
      emoji: meta.emoji,
      name: meta.name,
      color: meta.color,
      totalSpent: catSpent,
      amount: catSpent,
      percentage: totalSpent > 0 ? (catSpent / totalSpent) * 100 : 0,
    });
  }
  topCategories.sort((a, b) => b.totalSpent - a.totalSpent);

  // 6. Partner Shares & Generosity Award
  const p1Person = (settings && Array.isArray(settings.persons) && settings.persons[0])
    ? settings.persons[0]
    : { id: "p1", name: "Partner 1", emoji: "🌸" };
  const p2Person = (settings && Array.isArray(settings.persons) && settings.persons[1])
    ? settings.persons[1]
    : { id: "p2", name: "Partner 2", emoji: "🌿" };

  const p1Effective = p1Paid + (bothPaid / 2);
  const p2Effective = p2Paid + (bothPaid / 2);
  const p1Percent = totalSpent > 0 ? (p1Effective / totalSpent) * 100 : 0;
  const p2Percent = totalSpent > 0 ? (p2Effective / totalSpent) * 100 : 0;
  const bothPercent = totalSpent > 0 ? (bothPaid / totalSpent) * 100 : 0;

  let generosityWinner = "tie";
  let generosityName = "Both";
  let generosityEmoji = "🤝";

  if (p1Paid > p2Paid) {
    generosityWinner = "p1";
    generosityName = p1Person.name;
    generosityEmoji = p1Person.emoji;
  } else if (p2Paid > p1Paid) {
    generosityWinner = "p2";
    generosityName = p2Person.name;
    generosityEmoji = p2Person.emoji;
  } else if (totalSpent === 0) {
    generosityWinner = "none";
    generosityName = "Neither";
    generosityEmoji = "🐷";
  }

  const generosityAward = {
    winner: generosityWinner,
    name: generosityName,
    emoji: generosityEmoji,
  };

  const partnerShares = {
    p1: p1Paid,
    p2: p2Paid,
    both: bothPaid,
    p1Total: p1Paid,
    p2Total: p2Paid,
    bothTotal: bothPaid,
    p1Effective,
    p2Effective,
    p1Percent,
    p2Percent,
    bothPercent,
    p1Pct: p1Percent,
    p2Pct: p2Percent,
    bothPct: bothPercent,
    generosityAward,
    generosityWinner,
    generosityName,
    generosityEmoji,
  };

  // 7. Top Month (highest savings or lowest spend among elapsed active months)
  let bestMi = 0;
  let lowestSpend = Infinity;

  if (activeMonthIndices.size > 0) {
    for (const mi of activeMonthIndices) {
      if (mi > endMonthIndex) continue;
      const spent = months[mi].total;
      if (spent < lowestSpend) {
        lowestSpend = spent;
        bestMi = mi;
      }
    }
  } else {
    lowestSpend = 0;
  }

  const bestMonthSpent = lowestSpend === Infinity ? 0 : lowestSpend;
  const topMonth = {
    monthIndex: bestMi,
    month: bestMi + 1,
    name: MONTH_NAMES[bestMi],
    monthName: MONTH_NAMES[bestMi],
    shortName: MONTH_SHORT[bestMi],
    spent: bestMonthSpent,
    saved: Math.max(0, monthBudget - bestMonthSpent),
  };

  // 8. Investment Stats for the year
  const safeInvestments = Array.isArray(investments) ? investments : [];
  let totalInvested = 0;
  let portfolioValue = 0;
  let totalGain = 0;

  for (const inv of safeInvestments) {
    if (!inv || typeof inv !== "object") continue;

    if (Array.isArray(inv.entries) && inv.entries.length > 0) {
      let invVal = 0, invPut = 0, invOut = 0, flowSeen = false;
      const sortedEntries = [...inv.entries].sort((a, b) =>
        (a.date || "").localeCompare(b.date || "") || (a.kind === "add" ? -1 : 1)
      );
      for (const e of sortedEntries) {
        const a = Math.max(0, Number(e.amount) || 0);
        if (e.kind === "add") {
          invVal += a;
          invPut += a;
          flowSeen = true;
        } else if (e.kind === "withdraw") {
          invVal -= a;
          invOut += a;
          flowSeen = true;
        } else if (e.kind === "value") {
          if (!flowSeen) {
            invPut += a;
            flowSeen = true;
          }
          invVal = a;
        }
      }
      const invNet = invPut - invOut;
      const invGain = invVal - invNet;
      totalInvested += Math.max(0, invPut);
      portfolioValue += Math.max(0, invVal);
      totalGain += invGain;
    } else {
      // Direct / flat holding attributes
      const put = Number(inv.totalInvested ?? inv.invested ?? inv.put ?? inv.amount ?? 0);
      const val = Number(inv.portfolioValue ?? inv.value ?? inv.currentValue ?? put);
      const gain = Number(inv.totalGain ?? inv.gain ?? (val - put));
      totalInvested += Math.max(0, put);
      portfolioValue += Math.max(0, val);
      totalGain += gain;
    }
  }

  if (totalInvested === 0 && portfolioValue > 0) {
    totalInvested = portfolioValue;
  }

  const hasInvestments = Boolean(safeInvestments.length > 0 && totalInvested > 0);
  const investmentStats = {
    hasInvestments,
    totalInvested,
    totalGain,
    portfolioValue,
  };

  // 9. Couple Archetype
  const makeArchetype = (id, name, emoji, description) => ({
    id,
    name,
    title: name,
    emoji,
    description,
    toString() { return this.name; },
    [Symbol.toPrimitive]() { return this.name; },
  });

  let archetype;
  const topCatName = topCategories.length > 0 ? (topCategories[0].name || "").toLowerCase() : "";
  const topCatEmoji = topCategories.length > 0 ? topCategories[0].emoji : "";

  if (ytdBudget > 0 && (totalSaved / ytdBudget) >= 0.2) {
    archetype = makeArchetype(
      "goal_crushers",
      "The Goal Crushers",
      "🏆",
      "You crushed your savings goals this year! Over 20% of your budget was saved."
    );
  } else if (
    hasInvestments &&
    totalInvested > 0 &&
    (totalGain > 0 || totalInvested >= (totalSpent * 0.1) || totalInvested >= (ytdBudget * 0.1) || !topCategories.length)
  ) {
    archetype = makeArchetype(
      "wealth_builders",
      "The Wealth Builders",
      "📈",
      "Growing your future together! You actively invested and built your family wealth."
    );
  } else if (
    topCatName.includes("food") ||
    topCatName.includes("grocer") ||
    topCatName.includes("dining") ||
    topCatEmoji === "🍙" ||
    topCatEmoji === "🍔"
  ) {
    archetype = makeArchetype(
      "savvy_foodies",
      "The Savvy Foodies",
      "🍙",
      "Good food is your shared love language! Food & groceries topped your spending charts."
    );
  } else if (hasInvestments && totalInvested > 0) {
    archetype = makeArchetype(
      "wealth_builders",
      "The Wealth Builders",
      "📈",
      "Growing your future together! You actively invested and built your family wealth."
    );
  } else if (totalSpent > 0 && Math.abs(p1Percent - p2Percent) <= 5) {
    archetype = makeArchetype(
      "balanced_duo",
      "The Balanced Duo",
      "⚖️",
      "Perfect harmony! You and your partner shared expenses almost 50/50."
    );
  } else if (
    topCatName.includes("home") ||
    topCatName.includes("rent") ||
    topCatName.includes("bill") ||
    topCatName.includes("util") ||
    topCatEmoji === "🏠" ||
    topCatEmoji === "💡"
  ) {
    archetype = makeArchetype(
      "nest_builders",
      "The Nest Builders",
      "🏡",
      "Home is where the heart is! You invested most into making your cozy nest comfortable."
    );
  } else if (
    topCatName.includes("fun") ||
    topCatName.includes("entertain") ||
    topCatName.includes("travel") ||
    topCatEmoji === "🎈" ||
    topCatEmoji === "✈️"
  ) {
    archetype = makeArchetype(
      "joy_seekers",
      "The Joy Seekers",
      "🎈",
      "Life is an adventure! You made sure to budget for happiness, fun, and memorable experiences."
    );
  } else {
    archetype = makeArchetype(
      "cozy_partners",
      "The Cozy Partners",
      "🐷",
      "Building a brighter financial future together, step by cozy step."
    );
  }

  // 10. Active Mascot
  const mascot = getMascot(settings?.mascot);

  return {
    year: targetYear,
    isYtd,
    elapsedMonths,
    endMonthIndex,
    endMonthName,
    endMonthShortName,
    ytdBudget,
    totalBudget,
    totalSpent,
    ytdSpent: totalSpent,
    totalSaved,
    ytdSaved: totalSaved,
    happyMonthsCount,
    happyMonthsTotal: elapsedMonths,
    topCategories,
    partnerShares,
    generosityAward,
    topMonth,
    archetype,
    mascot,
    investments: investmentStats,
  };
}

/* ------------------------------------------------------------------ */
/* Phase 5 Expansion: Sinking Funds, Category Caps, Compound Growth, CSV */
/* ------------------------------------------------------------------ */

export function calculateJarProgress(jar) {
  const current = Math.max(0, Number(jar?.current ?? jar?.currentAmount ?? jar?.saved ?? jar?.balance ?? 0) || 0);
  const target = Math.max(0, Number(jar?.target ?? jar?.targetAmount ?? jar?.goal ?? 0) || 0);
  const remaining = Math.max(0, target - current);
  const rawPct = target > 0 ? (current / target) * 100 : 0;
  const percentage = Math.min(100, Math.max(0, rawPct));
  const isCompleted = target > 0 ? current >= target : false;

  return {
    percentage,
    remaining,
    isCompleted,
    current,
    target,
  };
}

export function calculateJarPace(jar, targetDateStr, fromDate = new Date()) {
  const { remaining } = calculateJarProgress(jar);
  if (!targetDateStr) {
    return { monthsRemaining: 1, pace: remaining, monthlyPace: remaining, remaining };
  }
  const target = targetDateStr instanceof Date ? targetDateStr : new Date(targetDateStr);
  const now = fromDate instanceof Date ? fromDate : new Date(fromDate);

  const yearDiff = target.getFullYear() - now.getFullYear();
  const monthDiff = target.getMonth() - now.getMonth();
  const totalMonths = yearDiff * 12 + monthDiff;
  const monthsRemaining = Math.max(1, totalMonths);
  const pace = remaining / monthsRemaining;

  return {
    monthsRemaining,
    pace,
    monthlyPace: pace,
    remaining,
  };
}

export function calculateCategoryCap(categoryKey, state = {}, monthIndex = new Date().getMonth()) {
  let annualBudget = Number(state?.annualBudget ?? state?.totalBudget ?? 0);
  if (!annualBudget && state?.budget) {
    annualBudget = Number(state.budget.income?.p1 || 0) + Number(state.budget.income?.p2 || 0);
  }

  let category = null;
  if (state?.categories) {
    if (Array.isArray(state.categories)) {
      category = state.categories.find(
        (c) => String(c.id) === String(categoryKey) || String(c.name).toLowerCase() === String(categoryKey).toLowerCase()
      );
    } else if (typeof state.categories === "object") {
      category = state.categories[categoryKey];
    }
  }

  const catPercentage = Number(category?.percentage ?? category?.percent ?? 0);
  const monthlyBudget = annualBudget > 0 ? (annualBudget * (catPercentage / 100)) / 12 : 0;

  const mIdx = typeof monthIndex === "number" ? monthIndex : new Date().getMonth();
  const currentYear = state?.year ?? new Date().getFullYear();

  let spent = 0;
  for (const e of state?.expenses || []) {
    if (!e) continue;
    const eCat = String(e.categoryId ?? e.category ?? e.categoryKey ?? "");
    const eCatName = String(e.name ?? e.categoryName ?? "");
    const isMatch =
      eCat === String(categoryKey) ||
      (category && eCat === String(category.id)) ||
      (category && eCatName === String(category.name));
    if (!isMatch) continue;

    if (e.date && typeof e.date === "string") {
      const parts = e.date.split("-");
      const eMonth = Number(parts[1]) - 1;
      const eYear = Number(parts[0]);
      if (eMonth === mIdx && (!eYear || eYear === currentYear)) {
        spent += Math.max(0, Number(e.amount) || 0);
      }
    } else {
      spent += Math.max(0, Number(e.amount) || 0);
    }
  }

  const ratio = monthlyBudget > 0 ? spent / monthlyBudget : (spent > 0 ? 1.0 : 0);
  const status = ratio >= 1.0 ? "exceeded" : ratio >= 0.8 ? "warning" : "ok";

  return {
    monthlyBudget,
    spent,
    ratio,
    status,
  };
}

export function calculateCompoundGrowth(
  startingPrincipal = 0,
  monthlyContribution = 0,
  annualRatePercent = 0,
  years = 1
) {
  const p = Math.max(0, Number(startingPrincipal) || 0);
  const pmt = Math.max(0, Number(monthlyContribution) || 0);
  const rate = Number(annualRatePercent) || 0;
  const y = Math.max(0, Number(years) || 0);

  const r = rate / 100;
  const totalMonths = y * 12;
  const r_monthly = r / 12;

  const fvPrincipal = p * Math.pow(1 + r_monthly, totalMonths);
  const fvContributions =
    r_monthly > 0
      ? pmt * ((Math.pow(1 + r_monthly, totalMonths) - 1) / r_monthly)
      : pmt * totalMonths;

  const futureValue = fvPrincipal + fvContributions;
  const totalContributed = p + (pmt * totalMonths);
  const totalInterest = futureValue - totalContributed;

  return {
    futureValue: Math.round(futureValue),
    totalContributed: Math.round(totalContributed),
    totalInterest: Math.round(totalInterest),
  };
}

function escapeCsvCell(val) {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function generateExpensesCSV(expenses = []) {
  const header = "Date,Category,Description,Paid By,Split,Amount\r\n";
  const rows = (Array.isArray(expenses) ? expenses : []).map((e) => {
    const date = escapeCsvCell(e?.date || "");
    const category = escapeCsvCell(e?.category || e?.categoryName || e?.categoryId || "");
    const description = escapeCsvCell(e?.description || e?.note || e?.title || e?.name || "");
    const paidBy = escapeCsvCell(e?.paidBy || "p1");
    const split = escapeCsvCell(e?.split || (e?.paidBy === "both" ? "50/50" : "100/0"));
    const amount = escapeCsvCell(Number(e?.amount) || 0);
    return `${date},${category},${description},${paidBy},${split},${amount}`;
  });
  return "\uFEFF" + header + (rows.length > 0 ? rows.join("\r\n") + "\r\n" : "");
}

export function generateInvestmentsCSV(investments = []) {
  const header = "Asset Name,Category,Money Put In,Worth Right Now,Profit Loss,ROI %\r\n";
  const rows = (Array.isArray(investments) ? investments : []).map((inv) => {
    const name = escapeCsvCell(inv?.name || inv?.assetName || "Untitled");
    const category = escapeCsvCell(inv?.type || inv?.category || "stocks");

    let put = 0;
    let value = 0;
    let gain = 0;

    if (Array.isArray(inv?.entries) && inv.entries.length > 0) {
      let flowSeen = false;
      const sortedEntries = [...inv.entries].sort((a, b) =>
        (a.date || "").localeCompare(b.date || "") || (a.kind === "add" ? -1 : 1)
      );
      for (const e of sortedEntries) {
        const a = Math.max(0, Number(e.amount) || 0);
        if (e.kind === "add") {
          value += a;
          put += a;
          flowSeen = true;
        } else if (e.kind === "withdraw") {
          value -= a;
          flowSeen = true;
        } else if (e.kind === "value") {
          if (!flowSeen) {
            put += a;
            flowSeen = true;
          }
          value = a;
        }
      }
      gain = value - put;
    } else {
      put = Math.max(0, Number(inv?.totalInvested ?? inv?.invested ?? inv?.put ?? inv?.amount ?? 0));
      value = Math.max(0, Number(inv?.portfolioValue ?? inv?.value ?? inv?.currentValue ?? put));
      gain = Number(inv?.totalGain ?? inv?.gain ?? (value - put));
    }

    const roi = put > 0 ? `${((gain / put) * 100).toFixed(2)}%` : "0.00%";

    return [
      name,
      category,
      escapeCsvCell(put),
      escapeCsvCell(value),
      escapeCsvCell(gain),
      escapeCsvCell(roi),
    ].join(",");
  });

  return "\uFEFF" + header + (rows.length > 0 ? rows.join("\r\n") + "\r\n" : "");
}

/* ------------------------------------------------------------------ */
/* Phase 5 Pro Features Gating                                        */
/* ------------------------------------------------------------------ */

export const PRO_FEATURES = {
  JARS: "jars",
  REACTIONS: "reactions",
  ACTIVITY_FEED: "activity_feed",
  CATEGORY_CAPS: "category_caps",
  CSV_EXPORT: "csv_export",
  COMPOUND_CALCULATOR: "compound_calculator",
};

export function isProUser(state) {
  if (!state || typeof state !== "object") return false;
  if (state.isPro === true || state.pro === true) return true;
  const s = state.settings || state;
  if (s && (s.isPro === true || s.pro === true)) return true;
  if (typeof isPro === "function") {
    return isPro(state.settings || state, state.user || null);
  }
  return false;
}

export function canAccessProFeature(featureKey, state) {
  const targetState =
    state && typeof state === "object"
      ? state
      : featureKey && typeof featureKey === "object"
      ? featureKey
      : null;
  return isProUser(targetState);
}
