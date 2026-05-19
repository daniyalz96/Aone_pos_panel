export const EXPENSE_TYPES = ['personal', 'business', 'charity'] as const
export type ExpenseType = (typeof EXPENSE_TYPES)[number]

export const EXPENSE_TYPE_LABELS: Record<ExpenseType, string> = {
  personal: 'Personal',
  business: 'Business',
  charity: 'Charity'
}

export const EXPENSE_CATEGORIES: Record<ExpenseType, { value: string; label: string }[]> = {
  personal: [
    { value: 'grocery', label: 'Grocery' },
    { value: 'utility', label: 'Utility' },
    { value: 'fuel', label: 'Fuel' },
    { value: 'installments', label: 'Installments' },
    { value: 'healthcare', label: 'Healthcare' },
    { value: 'education', label: 'Education' },
    { value: 'other', label: 'Other' }
  ],
  business: [
    { value: 'rent', label: 'Rent' },
    { value: 'utilities', label: 'Utilities' },
    { value: 'salaries', label: 'Salaries' },
    { value: 'supplies', label: 'Supplies' },
    { value: 'marketing', label: 'Marketing' },
    { value: 'maintenance', label: 'Maintenance' },
    { value: 'taxes', label: 'Taxes' },
    { value: 'other', label: 'Other' }
  ],
  charity: [
    { value: 'zakat', label: 'Zakat' },
    { value: 'sadaqah', label: 'Sadaqah' },
    { value: 'donation', label: 'Donation' },
    { value: 'other', label: 'Other' }
  ]
}

export function categoryLabel(type: ExpenseType, value: string) {
  return EXPENSE_CATEGORIES[type].find((c) => c.value === value)?.label ?? value
}
