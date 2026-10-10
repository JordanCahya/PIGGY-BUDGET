# 🐷 PiggyNest – Family expense tracker

A cozy, static website (no build step) for tracking family spending with **yearly → monthly budgets**.

## What it does

- **Yearly budget, monthly derived**: enter each person's yearly income. Every category gets a **percentage** of the total, and its monthly budget is simply the yearly amount ÷ 12.
- **Two incomes, split by person**: each category can be split *by income ratio* (automatic) or with a *custom split* slider. The dashboard shows who paid what against their share.
- **Home**: the piggy bank shows how much of this month's budget is left, plus a card per category.
- **Expenses**: add, edit and delete expenses, and choose who paid.
- **Year**: month-by-month chart and a category × month heat table.
- **Firebase**: Email/Password sign-in and Cloud Firestore, with live sync and offline cache.
- **Demo mode**: until you add Firebase keys, the app stores data in your browser so you can try it right away.

## Try it locally

ES modules need a web server (opening the file directly won't work):

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

## 1) Connect Firebase

1. Go to the [Firebase console](https://console.firebase.google.com) and create a project.
2. **Build → Authentication → Sign-in method**: enable **Email/Password**.
3. **Build → Firestore Database**: create a database (production mode).
4. In the Firestore **Rules** tab, paste the contents of `firestore.rules` and publish.
5. **Project settings → Your apps → Web (`</>`)**: register an app and copy the config into `firebase-config.js`.
6. Run the app, press **Create family account**, and sign up once. Both of you then sign in with the same email and password.

> Afterwards, in **Authentication → Settings → User actions**, you can turn off *Enable create (sign-up)* so nobody else can make an account.

## 2) Deploy with GitHub Pages

1. Create a GitHub repository and push these files to the `main` branch.
2. In the repo go to **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The included workflow (`.github/workflows/deploy.yml`) publishes the site on every push to `main`.
4. Your site will be at `https://<your-username>.github.io/<repo-name>/`.
5. Add that domain (`<your-username>.github.io`) in Firebase: **Authentication → Settings → Authorized domains**.

Optional but recommended: in Google Cloud Console → **APIs & Services → Credentials**, restrict the browser API key to your `github.io` domain.

## About the data

```
families/{uid}/meta/settings     family name, currency, the two people
families/{uid}/budgets/{year}    yearly income per person + categories (percent, split)
families/{uid}/expenses/{id}     date, amount, categoryId, paidBy, note
```

The Firebase config in a web app is not a secret. Your data is protected by sign-in and the Firestore rules, so every family account can only reach its own `families/{uid}` data.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css` | Page and cute pastel styling |
| `js/app.js` | All screens and budget maths |
| `js/db.js` | Firebase + local demo storage |
| `firebase-config.js` | Your Firebase keys |
| `firestore.rules` | Security rules |
| `.github/workflows/deploy.yml` | GitHub Pages deployment |
