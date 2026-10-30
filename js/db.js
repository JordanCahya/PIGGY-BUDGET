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

    subscribe({ settings, budgets, expenses, investments, error }) {
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
      return () => {
        u1();
        u2();
        u3();
        u4();
      };
    },

    saveSettings: (s) => fs.setDoc(settingsRef(), s),
    saveSavingsGoal: (amount) => fs.setDoc(settingsRef(), { savingsGoal: Number(amount) || 0 }, { merge: true }),
    saveBudget: (year, b) => fs.setDoc(fs.doc(budgetsCol(), String(year)), b),
    addExpense: async (e) => {
      const ref = await fs.addDoc(expensesCol(), { ...e, createdAt: fs.serverTimestamp() });
      return ref.id;
    },
    updateExpense: (id, e) => fs.setDoc(fs.doc(expensesCol(), id), e, { merge: true }),
    deleteExpense: (id) => fs.deleteDoc(fs.doc(expensesCol(), id)),

    addInvestment: async (inv) => {
      const ref = await fs.addDoc(investmentsCol(), { ...inv, createdAt: fs.serverTimestamp() });
      return ref.id;
    },
    saveInvestment: (id, inv) => fs.setDoc(fs.doc(investmentsCol(), id), inv, { merge: true }),
    deleteInvestment: (id) => fs.deleteDoc(fs.doc(investmentsCol(), id)),
    async restoreAll(payload) {
      const batch = fs.writeBatch(db);
      if (payload.settings) {
        batch.set(settingsRef(), payload.settings, { merge: true });
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
  const data = { settings: null, budgets: {}, expenses: [], investments: [], ...load() };
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

    subscribe({ settings, budgets, expenses, investments }) {
      const notify = () => {
        settings(data.settings);
        budgets({ ...data.budgets });
        expenses(data.expenses.map((e) => ({ ...e })));
        if (investments) investments(JSON.parse(JSON.stringify(data.investments || [])));
      };
      subs.add(notify);
      queueMicrotask(notify);
      return () => subs.delete(notify);
    },

    async saveSettings(s) {
      data.settings = s;
      persist();
    },
    async saveSavingsGoal(amount) {
      data.settings = { ...(data.settings || {}), savingsGoal: Number(amount) || 0 };
      persist();
    },
    async saveBudget(year, b) {
      data.budgets[String(year)] = b;
      persist();
    },
    async addExpense(e) {
      const id = newId();
      data.expenses.push({ ...e, id });
      persist();
      return id;
    },
    async updateExpense(id, e) {
      const i = data.expenses.findIndex((x) => x.id === id);
      if (i >= 0) data.expenses[i] = { ...data.expenses[i], ...e };
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
    async restoreAll(payload) {
      if (payload.settings) {
        data.settings = { ...(data.settings || {}), ...payload.settings };
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
      persist();
    },
  };
}
