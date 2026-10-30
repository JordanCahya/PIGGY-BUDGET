"""Automated Test Suite for PiggyNest calculations and data models.
Can run locally via `python tests/run_tests.py` or in GitHub Actions CI.
"""

import math
import os
import re
import unittest

# Helpers to mirror/evaluate js/calc.js and js/savings.js pure logic in Python test harness

def calculate_savings_progress(savings_goal, month_budget, spent):
    goal = float(savings_goal or 0)
    budget = float(month_budget or 0)
    total_spent = float(spent or 0)
    current_saved = max(0.0, budget - total_spent)
    progress_pct = (current_saved / goal * 100.0) if goal > 0 else 0.0
    remaining = max(0.0, goal - current_saved)
    is_achieved = goal > 0 and current_saved >= goal
    has_goal = goal > 0
    return {
        "goal": goal,
        "currentSaved": current_saved,
        "progressPct": min(progress_pct, 100.0),
        "rawPct": progress_pct,
        "remaining": remaining,
        "isAchieved": is_achieved,
        "hasGoal": has_goal,
    }


def calc_budget(b):
    inc1 = float(b.get("income", {}).get("p1") or 0)
    inc2 = float(b.get("income", {}).get("p2") or 0)
    total = inc1 + inc2
    r1 = (inc1 / total) if total > 0 else 0.5
    pct_sum = 0.0
    cats = []
    for c in b.get("categories", []):
        percent = float(c.get("percent") or 0)
        pct_sum += percent
        yearly = (total * percent) / 100.0
        ratio1 = (float(c.get("p1Share", 50)) / 100.0) if c.get("splitMode") == "custom" else r1
        monthly = yearly / 12.0
        cats.append({
            "id": c.get("id"),
            "percent": percent,
            "yearly": yearly,
            "monthly": monthly,
            "ratio1": ratio1,
            "monthly1": monthly * ratio1,
            "monthly2": monthly * (1.0 - ratio1),
            "yearly1": yearly * ratio1,
            "yearly2": yearly * (1.0 - ratio1),
        })
    return {"inc1": inc1, "inc2": inc2, "total": total, "r1": r1, "cats": cats, "pctSum": pct_sum}


def spend_index(year, expenses):
    by_cat = {}
    months = [{"p1": 0.0, "p2": 0.0, "total": 0.0} for _ in range(12)]
    year_prefix = f"{year}-"
    for e in expenses:
        date = e.get("date", "")
        if not date.startswith(year_prefix):
            continue
        try:
            mi = int(date[5:7]) - 1
        except (ValueError, IndexError):
            continue
        if mi < 0 or mi > 11:
            continue
        amt = float(e.get("amount") or 0)
        paid_by = e.get("paidBy", "p1")
        if paid_by == "both":
            shares = {"p1": amt / 2.0, "p2": amt / 2.0}
        elif paid_by == "p2":
            shares = {"p1": 0.0, "p2": amt}
        else:
            shares = {"p1": amt, "p2": 0.0}
        cat_id = e.get("categoryId")
        if cat_id not in by_cat:
            by_cat[cat_id] = [{"p1": 0.0, "p2": 0.0, "total": 0.0} for _ in range(12)]
        for k in ("p1", "p2"):
            by_cat[cat_id][mi][k] += shares[k]
            months[mi][k] += shares[k]
        by_cat[cat_id][mi]["total"] += amt
        months[mi]["total"] += amt
    return {"byCat": by_cat, "months": months}


def used_status(pct):
    if pct > 100:
        return "over"
    if pct >= 80:
        return "warn"
    return ""


class TestSavingsLogic(unittest.TestCase):
    def test_no_goal(self):
        res = calculate_savings_progress(0, 3000, 2000)
        self.assertFalse(res["hasGoal"])
        self.assertEqual(res["currentSaved"], 1000)
        self.assertEqual(res["progressPct"], 0)
        self.assertFalse(res["isAchieved"])

    def test_in_progress(self):
        res = calculate_savings_progress(500, 3000, 2700)
        self.assertTrue(res["hasGoal"])
        self.assertEqual(res["currentSaved"], 300)
        self.assertAlmostEqual(res["progressPct"], 60.0)
        self.assertEqual(res["remaining"], 200)
        self.assertFalse(res["isAchieved"])

    def test_goal_achieved(self):
        res = calculate_savings_progress(400, 2000, 1500)
        self.assertTrue(res["hasGoal"])
        self.assertEqual(res["currentSaved"], 500)
        self.assertEqual(res["progressPct"], 100.0)
        self.assertAlmostEqual(res["rawPct"], 125.0)
        self.assertEqual(res["remaining"], 0)
        self.assertTrue(res["isAchieved"])

    def test_over_budget_zero_savings(self):
        res = calculate_savings_progress(500, 2000, 2500)
        self.assertEqual(res["currentSaved"], 0)
        self.assertEqual(res["progressPct"], 0)
        self.assertEqual(res["remaining"], 500)
        self.assertFalse(res["isAchieved"])


class TestBudgetCalculation(unittest.TestCase):
    def test_income_ratio_and_monthly_derived(self):
        b = {
            "income": {"p1": 60000, "p2": 40000},
            "categories": [
                {"id": "c1", "percent": 30, "splitMode": "income"},
                {"id": "c2", "percent": 20, "splitMode": "custom", "p1Share": 70},
            ],
        }
        res = calc_budget(b)
        self.assertEqual(res["total"], 100000)
        self.assertAlmostEqual(res["r1"], 0.6)
        self.assertEqual(res["pctSum"], 50)

        # Category 1: 30% of 100k = 30k yearly, 2500 monthly
        c1 = res["cats"][0]
        self.assertEqual(c1["yearly"], 30000)
        self.assertEqual(c1["monthly"], 2500)
        self.assertAlmostEqual(c1["monthly1"], 1500)  # 60%
        self.assertAlmostEqual(c1["monthly2"], 1000)  # 40%

        # Category 2: custom 70% share
        c2 = res["cats"][1]
        self.assertEqual(c2["yearly"], 20000)
        self.assertAlmostEqual(c2["monthly1"], (20000 / 12) * 0.7)
        self.assertAlmostEqual(c2["monthly2"], (20000 / 12) * 0.3)


class TestSpendIndex(unittest.TestCase):
    def test_expense_splits_and_month_indexing(self):
        expenses = [
            {"date": "2026-03-15", "amount": 100, "categoryId": "groceries", "paidBy": "p1"},
            {"date": "2026-03-20", "amount": 200, "categoryId": "groceries", "paidBy": "both"},
            {"date": "2026-03-25", "amount": 50, "categoryId": "utilities", "paidBy": "p2"},
            {"date": "2025-03-10", "amount": 999, "categoryId": "groceries", "paidBy": "p1"},  # different year
        ]
        idx = spend_index(2026, expenses)
        m3 = idx["months"][2]  # March is month index 2
        self.assertEqual(m3["total"], 350)
        self.assertEqual(m3["p1"], 200)  # 100 + 100
        self.assertEqual(m3["p2"], 150)  # 100 + 50

        # Check category split
        cat_m3 = idx["byCat"]["groceries"][2]
        self.assertEqual(cat_m3["total"], 300)
        self.assertEqual(cat_m3["p1"], 200)
        self.assertEqual(cat_m3["p2"], 100)


class TestUsedStatus(unittest.TestCase):
    def test_thresholds(self):
        self.assertEqual(used_status(50), "")
        self.assertEqual(used_status(79.9), "")
        self.assertEqual(used_status(80), "warn")
        self.assertEqual(used_status(99), "warn")
        self.assertEqual(used_status(100.1), "over")


class TestFileIntegrity(unittest.TestCase):
    def test_crlf_line_endings_preserved(self):
        paths = ["js/app.js", "js/calc.js", "js/savings.js", "js/db.js", "styles.css", "index.html"]
        for p in paths:
            if not os.path.exists(p):
                continue
            with open(p, "rb") as f:
                raw = f.read()
            self.assertIn(b"\r\n", raw, f"{p} should have CRLF line endings")
            self.assertNotIn(b"\n", raw.replace(b"\r\n", b""), f"{p} should not have standalone LF")

    def test_imports_and_exports_match(self):
        with open("js/calc.js", "r", encoding="utf-8") as f:
            calc_src = f.read()
        with open("js/app.js", "r", encoding="utf-8") as f:
            app_src = f.read()

        exported_symbols = ["calc", "spendIndex", "usedStatus", "defaultBudget", "defaultCategories", "normalizeBudget", "PALETTE", "PERSON_KEYS"]
        for sym in exported_symbols:
            self.assertIn(f"export function {sym}" if sym not in ("PALETTE", "PERSON_KEYS", "usedStatus") else f"export const {sym}", calc_src)
            self.assertIn(sym, app_src)


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromModule(__import__(__name__))
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    if not result.wasSuccessful():
        exit(1)
