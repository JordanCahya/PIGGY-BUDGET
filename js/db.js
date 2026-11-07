// Data layer. Same API for Firebase and for the local "demo mode".
//
// Firestore layout (everything lives under the signed-in family account):
//   families/{uid}/meta/settings      -> family name, currency, the two people
//   families/{uid}/budgets/{year}     -> yearly income per person + category percentages
//   families/{uid}/expenses/{id}      -> one document per expense

import { firebaseConfig } from "../firebase-config.js";

const FIREBASE_VERSION = "10.12.2";

const isConfigured =
  firebaseConfig &&
  typeof firebaseConfig.apiKey === "string" &&
  firebaseConfig.apiKey.length > 0 &&
  !firebaseConfig.apiKey.startsWith("YOUR_") &&
  !String(firebaseConfig.projectId || "").startsWith("YOUR_");

function evaluateProCode(rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) return { valid: false, message: "Please enter an activation code." };

  const masterVipCodes = [];
  if (masterVipCodes.includes(code)) {
    return {
      valid: true,
      isPro: true,
      proUntil: null,
      message: "PiggyNest Pro VIP Lifetime Access Activated! 🐷✨",
    };
  }

  return { valid: false, message: "Invalid activation code." };
}

function sanitizeExpense(e) {
  const out = { ...e };
  if (out.paymentMethod !== undefined) {
    out.paymentMethod = ["cash", "credit_card", "installment"].includes(out.paymentMethod) ? out.paymentMethod : "cash";
  }
  if (out.cardName !== undefined) {
    out.cardName = String(out.cardName || "").trim();
  }
  if (out.installmentMonths !== undefined) {
    out.installmentMonths = Number(out.installmentMonths) || null;
  }
  if (out.installmentCurrent !== undefined) {
    out.installmentCurrent = Number(out.installmentCurrent) || null;
  }
  return out;
}

function sanitizeRecurring(bill) {
  const out = { ...bill };
  if (out.paymentMethod !== undefined) {
    out.paymentMethod = ["cash", "credit_card", "installment"].includes(out.paymentMethod) ? out.paymentMethod : "cash";
  }
  if (out.cardName !== undefined) {
    out.cardName = String(out.cardName || "").trim();
  }
  if (out.installmentMonths !== undefined) {
    out.installmentMonths = Number(out.installmentMonths) || null;
  }
  return out;
}

export async function createDb() {
  return isConfigured ? createFirebaseDb() : createLocalDb();
}

/* ------------------------------------------------------------------ */
/* Firebase                                                            */
/* ------------------------------------------------------------------ */
async function createFirebaseDb() {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const [appMod, authMod, fs] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-auth.js`),
    import(`${base}/firebase-firestore.js`),
  ]);

  const app = appMod.initializeApp(firebaseConfig);
  const auth = authMod.getAuth(app);

  let db;
  try {
    // Keeps working offline and syncs when the connection comes back.
    db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache() });
  } catch (err) {
    db = fs.getFirestore(app);
  }

  let uid = null;
  const settingsRef = () => fs.doc(db, "families", uid, "meta", "settings");
  const budgetsCol = () => fs.collection(db, "families", uid, "budgets");
  const expensesCol = () => fs.collection(db, "families", uid, "expenses");
  const investmentsCol = () => fs.collection(db, "families", uid, "investments");
  const recurringCol = () => fs.collection(db, "families", uid, "recurring");

  return {
    mode: "firebase",

    onAuth(cb) {
      return authMod.onAuthStateChanged(auth, (user) => {
        uid = user ? user.uid : null;
        cb(user ? { email: user.email } : null);
      });
    },
    signIn: (email, password) => authMod.signInWithEmailAndPassword(auth, email, password),
    signUp: (email, password) => authMod.createUserWithEmailAndPassword(auth, email, password),
    resetPassword: (email) => authMod.sendPasswordResetEmail(auth, email),
    signOut: () => authMod.signOut(auth),

    subscribe({ settings, budgets, expenses, investments, recurring, error }) {
      const onErr = (e) => error && error(e);
      const u1 = fs.onSnapshot(settingsRef(), (snap) => settings(snap.exists() ? snap.data() : null), onErr);
      const u2 = fs.onSnapshot(
        budgetsCol(),
        (qs) => budgets(Object.fromEntries(qs.docs.map((d) => [d.id, d.data()]))),
        onErr
      );
      const u3 = fs.onSnapshot(
        expensesCol(),
        (qs) => expenses(qs.docs.map((d) => ({ id: d.id, ...d.data() }))),
        onErr
      );
      const u4 = investments
        ? fs.onSnapshot(investmentsCol(), (qs) => investments(qs.docs.map((d) => ({ id: d.id, ...d.data() }))), onErr)
        : () => {};
      const u5 = recurring
        ? fs.onSnapshot(recurringCol(), (qs) => recurring(qs.docs.map((d) => ({ id: d.id, ...d.data() }))), onErr)
        : () => {};
      return () => {
        u1();
        u2();
        u3();
        u4();
        u5();
      };
    },

    saveSettings: (s) => fs.setDoc(settingsRef(), { ...(s || {}) }, { merge: true }),
    saveSavingsGoal: (amount) => fs.setDoc(settingsRef(), { savingsGoal: Number(amount) || 0 }, { merge: true }),
    saveTheme: (theme) => fs.setDoc(settingsRef(), { theme: String(theme || "default") }, { merge: true }),
    saveMascot: (mascot) => fs.setDoc(settingsRef(), { mascot: String(mascot || "piggy") }, { merge: true }),
    saveProStatus: (isPro, proUntil, subscriptionId, trialUsed) => {
      const update = { pro: Boolean(isPro), proUntil: proUntil || null };
      if (subscriptionId !== undefined) {
        update.subscriptionId = subscriptionId || null;
      }
      if (trialUsed !== undefined) {
        update.trialUsed = Boolean(trialUsed);
      }
      return fs.setDoc(settingsRef(), update, { merge: true });
    },
    cancelProSubscription: () =>
      fs.setDoc(settingsRef(), { pro: false, proUntil: null, subscriptionId: null }, { merge: true }),
    async activateProCode(code) {
      const res = evaluateProCode(code);
      if (!res.valid) return res;
      await fs.setDoc(settingsRef(), { pro: res.isPro, proUntil: res.proUntil }, { merge: true });
      return res;
    },
    saveBudget: (year, b) => fs.setDoc(fs.doc(budgetsCol(), String(year)), b),
    addExpense: async (e) => {
      const ref = await fs.addDoc(expensesCol(), { ...sanitizeExpense(e), createdAt: fs.serverTimestamp() });
      return ref.id;
    },
    updateExpense: (id, e) => fs.setDoc(fs.doc(expensesCol(), id), sanitizeExpense(e), { merge: true }),
    deleteExpense: (id) => fs.deleteDoc(fs.doc(expensesCol(), id)),

    addInvestment: async (inv) => {
      const ref = await fs.addDoc(investmentsCol(), { ...inv, createdAt: fs.serverTimestamp() });
      return ref.id;
    },
    saveInvestment: (id, inv) => fs.setDoc(fs.doc(investmentsCol(), id), inv, { merge: true }),
    deleteInvestment: (id) => fs.deleteDoc(fs.doc(investmentsCol(), id)),

    addRecurring: async (bill) => {
      const ref = await fs.addDoc(recurringCol(), { ...sanitizeRecurring(bill), createdAt: fs.serverTimestamp() });
      return ref.id;
    },
    updateRecurring: (id, bill) => fs.setDoc(fs.doc(recurringCol(), id), sanitizeRecurring(bill), { merge: true }),
    deleteRecurring: (id) => fs.deleteDoc(fs.doc(recurringCol(), id)),
    async restoreAll(payload) {
      const batch = fs.writeBatch(db);
      if (payload.settings) {
        const settingsData = { ...payload.settings };
        if (payload.settings.theme !== undefined) {
          settingsData.theme = String(payload.settings.theme || "default");
        }
        if (payload.settings.mascot !== undefined) {
          settingsData.mascot = String(payload.settings.mascot || "piggy");
        }
        if (payload.settings.pro !== undefined) {
          settingsData.pro = Boolean(payload.settings.pro);
        }
        if (payload.settings.proUntil !== undefined) {
          settingsData.proUntil = payload.settings.proUntil || null;
        }
        if (payload.settings.subscriptionId !== undefined) {
          settingsData.subscriptionId = payload.settings.subscriptionId || null;
        }
        if (payload.settings.trialUsed !== undefined) {
          settingsData.trialUsed = Boolean(payload.settings.trialUsed);
        }
        batch.set(settingsRef(), settingsData, { merge: true });
      }
      if (payload.budgets && typeof payload.budgets === "object") {
        for (const [y, b] of Object.entries(payload.budgets)) {
          batch.set(fs.doc(budgetsCol(), String(y)), b);
        }
      }
      if (Array.isArray(payload.expenses)) {
        for (const exp of payload.expenses) {
          const docId = exp.id || fs.doc(expensesCol()).id;
          const { id: _, ...rest } = exp;
          batch.set(fs.doc(expensesCol(), docId), rest);
        }
      }
      if (Array.isArray(payload.investments)) {
        for (const inv of payload.investments) {
          const docId = inv.id || fs.doc(investmentsCol()).id;
          const { id: _, ...rest } = inv;
          batch.set(fs.doc(investmentsCol(), docId), rest);
        }
      }
      if (Array.isArray(payload.recurring)) {
        for (const item of payload.recurring) {
          const docId = item.id || fs.doc(recurringCol()).id;
          const { id: _, ...rest } = item;
          batch.set(fs.doc(recurringCol(), docId), rest);
        }
      }
      await batch.commit();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Local demo mode (localStorage)                                      */
/* ------------------------------------------------------------------ */
function createLocalDb() {
  const KEY = "piggynest:demo:v1";
  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || {};
    } catch (e) {
      return {};
    }
  };
  const data = { settings: null, budgets: {}, expenses: [], investments: [], recurring: [], ...load() };
  if (!Array.isArray(data.recurring)) data.recurring = [];
  const subs = new Set();
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const persist = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {
      /* storage full or blocked: keep working in memory */
    }
    subs.forEach((notify) => notify());
  };

  return {
    mode: "local",

    onAuth(cb) {
      setTimeout(() => cb({ email: "demo" }), 0);
      return () => {};
    },
    async signIn() {},
    async signUp() {},
    async resetPassword() {},
    async signOut() {},

    subscribe({ settings, budgets, expenses, investments, recurring }) {
      const notify = () => {
        settings(data.settings);
        budgets({ ...data.budgets });
        expenses(data.expenses.map((e) => ({ ...e })));
        if (investments) investments(JSON.parse(JSON.stringify(data.investments || [])));
        if (recurring) recurring(data.recurring.map((r) => ({ ...r })));
      };
      subs.add(notify);
      queueMicrotask(notify);
      return () => subs.delete(notify);
    },

    async saveSettings(s) {
      data.settings = { ...(data.settings || {}), ...s };
      persist();
    },
    async saveSavingsGoal(amount) {
      data.settings = { ...(data.settings || {}), savingsGoal: Number(amount) || 0 };
      persist();
    },
    async saveTheme(theme) {
      data.settings = { ...(data.settings || {}), theme: String(theme || "default") };
      persist();
    },
    async saveMascot(mascot) {
      data.settings = { ...(data.settings || {}), mascot: String(mascot || "piggy") };
      persist();
    },
    async saveProStatus(isPro, proUntil, subscriptionId, trialUsed) {
      data.settings = {
        ...(data.settings || {}),
        pro: Boolean(isPro),
        proUntil: proUntil || null,
        ...(subscriptionId !== undefined ? { subscriptionId: subscriptionId || null } : {}),
        ...(trialUsed !== undefined ? { trialUsed: Boolean(trialUsed) } : {}),
      };
      persist();
    },
    async cancelProSubscription() {
      data.settings = {
        ...(data.settings || {}),
        pro: false,
        proUntil: null,
        subscriptionId: null,
      };
      persist();
    },
    async activateProCode(code) {
      const res = evaluateProCode(code);
      if (!res.valid) return res;
      data.settings = {
        ...(data.settings || {}),
        pro: res.isPro,
        proUntil: res.proUntil,
      };
      persist();
      return res;
    },
    async saveBudget(year, b) {
      data.budgets[String(year)] = b;
      persist();
    },
    async addExpense(e) {
      const id = newId();
      data.expenses.push({ ...sanitizeExpense(e), id });
      persist();
      return id;
    },
    async updateExpense(id, e) {
      const i = data.expenses.findIndex((x) => x.id === id);
      if (i >= 0) data.expenses[i] = { ...data.expenses[i], ...sanitizeExpense(e) };
      persist();
    },
    async deleteExpense(id) {
      data.expenses = data.expenses.filter((x) => x.id !== id);
      persist();
    },

    async addInvestment(inv) {
      const id = newId();
      data.investments.push({ ...inv, id });
      persist();
      return id;
    },
    async saveInvestment(id, inv) {
      const i = data.investments.findIndex((x) => x.id === id);
      if (i >= 0) data.investments[i] = { ...data.investments[i], ...inv, id };
      persist();
    },
    async deleteInvestment(id) {
      data.investments = data.investments.filter((x) => x.id !== id);
      persist();
    },

    async addRecurring(bill) {
      const id = newId();
      data.recurring.push({ ...sanitizeRecurring(bill), id });
      persist();
      return id;
    },
    async updateRecurring(id, bill) {
      const i = data.recurring.findIndex((x) => x.id === id);
      if (i >= 0) data.recurring[i] = { ...data.recurring[i], ...sanitizeRecurring(bill), id };
      persist();
    },
    async deleteRecurring(id) {
      data.recurring = data.recurring.filter((x) => x.id !== id);
      persist();
    },
    async restoreAll(payload) {
      if (payload.settings) {
        const settingsData = { ...payload.settings };
        if (payload.settings.theme !== undefined) {
          settingsData.theme = String(payload.settings.theme || "default");
        }
        if (payload.settings.mascot !== undefined) {
          settingsData.mascot = String(payload.settings.mascot || "piggy");
        }
        if (payload.settings.pro !== undefined) {
          settingsData.pro = Boolean(payload.settings.pro);
        }
        if (payload.settings.proUntil !== undefined) {
          settingsData.proUntil = payload.settings.proUntil || null;
        }
        if (payload.settings.subscriptionId !== undefined) {
          settingsData.subscriptionId = payload.settings.subscriptionId || null;
        }
        if (payload.settings.trialUsed !== undefined) {
          settingsData.trialUsed = Boolean(payload.settings.trialUsed);
        }
        data.settings = { ...(data.settings || {}), ...settingsData };
      }
      if (payload.budgets && typeof payload.budgets === "object") {
        data.budgets = { ...(data.budgets || {}), ...payload.budgets };
      }
      if (Array.isArray(payload.expenses)) {
        const merged = [...data.expenses];
        for (const exp of payload.expenses) {
          const expId = exp.id || newId();
          const item = { ...exp, id: expId };
          const idx = merged.findIndex((x) => x.id === expId);
          if (idx >= 0) merged[idx] = item;
          else merged.push(item);
        }
        data.expenses = merged;
      }
      if (Array.isArray(payload.investments)) {
        const merged = [...data.investments];
        for (const inv of payload.investments) {
          const invId = inv.id || newId();
          const item = { ...inv, id: invId };
          const idx = merged.findIndex((x) => x.id === invId);
          if (idx >= 0) merged[idx] = item;
          else merged.push(item);
        }
        data.investments = merged;
      }
      if (Array.isArray(payload.recurring)) {
        const merged = [...data.recurring];
        for (const item of payload.recurring) {
          const recId = item.id || newId();
          const recItem = { ...item, id: recId };
          const idx = merged.findIndex((x) => x.id === recId);
          if (idx >= 0) merged[idx] = recItem;
          else merged.push(recItem);
        }
        data.recurring = merged;
      }
      persist();
    },
  };
}
