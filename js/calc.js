// Pure financial math, budget models, and expense indexing

export const PERSON_KEYS = ["p1", "p2"];
export const PALETTE = ["#ff9ebb", "#6fd6b8", "#78b8ff", "#ffd56b", "#c4b2ff", "#ffb48a", "#9be37a", "#f5a3e4"];

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
