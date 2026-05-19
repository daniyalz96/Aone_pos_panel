export const EXPENSE_TYPES = ["personal", "business", "charity"] as const;
export type ExpenseType = (typeof EXPENSE_TYPES)[number];

export const EXPENSE_CATEGORIES: Record<ExpenseType, readonly string[]> = {
  personal: ["grocery", "utility", "fuel", "installments", "healthcare", "education", "other"],
  business: ["rent", "utilities", "salaries", "supplies", "marketing", "maintenance", "taxes", "other"],
  charity: ["zakat", "sadaqah", "donation", "other"],
};

export function isValidExpenseCategory(type: ExpenseType, category: string): boolean {
  return EXPENSE_CATEGORIES[type].includes(category);
}
