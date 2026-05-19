-- Classify expenses for personal / business / charity tracking and reporting.

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS expense_type TEXT NOT NULL DEFAULT 'business'
    CHECK (expense_type IN ('personal', 'business', 'charity'));

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS expense_date DATE NOT NULL DEFAULT CURRENT_DATE;

UPDATE expenses SET expense_type = 'business' WHERE expense_type IS NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_expense_date ON expenses (expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_expense_type ON expenses (expense_type);
