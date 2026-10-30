// Savings goal calculations and business logic

export function calculateSavingsProgress(savingsGoal, monthBudget, spent) {
  const goal = Number(savingsGoal) || 0;
  const budget = Number(monthBudget) || 0;
  const totalSpent = Number(spent) || 0;
  const currentSaved = Math.max(0, budget - totalSpent);
  const progressPct = goal > 0 ? (currentSaved / goal) * 100 : 0;
  const remaining = Math.max(0, goal - currentSaved);
  const isAchieved = goal > 0 && currentSaved >= goal;
  const hasGoal = goal > 0;

  return {
    goal,
    currentSaved,
    progressPct: Math.min(progressPct, 100),
    rawPct: progressPct,
    remaining,
    isAchieved,
    hasGoal,
  };
}
