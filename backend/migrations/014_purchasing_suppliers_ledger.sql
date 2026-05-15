-- Ledger accounts for purchasing / inventory capitalization
INSERT INTO ledger_accounts (code, name, type)
VALUES
  ('1200', 'Inventory', 'asset'),
  ('2200', 'Accounts Payable', 'liability'),
  ('3100', 'Opening Balance Clearing', 'equity')
ON CONFLICT (code) DO NOTHING;

-- Supplier profile extensions
ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS company_name TEXT NULL,
  ADD COLUMN IF NOT EXISTS contact_person TEXT NULL,
  ADD COLUMN IF NOT EXISTS address TEXT NULL,
  ADD COLUMN IF NOT EXISTS tax_ntn TEXT NULL,
  ADD COLUMN IF NOT EXISTS opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0;

UPDATE suppliers SET company_name = name WHERE company_name IS NULL OR company_name = '';

ALTER TABLE suppliers
  ALTER COLUMN company_name SET NOT NULL;

CREATE TABLE IF NOT EXISTS supplier_ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  entry_kind TEXT NOT NULL CHECK (
    entry_kind IN (
      'opening_balance',
      'purchase_post',
      'supplier_payment',
      'purchase_return',
      'full_reversal'
    )
  ),
  amount NUMERIC(14,2) NOT NULL,
  reference_type TEXT NULL,
  reference_id UUID NULL,
  memo TEXT NULL,
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_supplier_ledger_supplier_created
  ON supplier_ledger_entries (supplier_id, created_at DESC);

CREATE TABLE IF NOT EXISTS supplier_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('cash', 'bank_transfer')),
  reference TEXT NULL,
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  branch_id UUID NULL REFERENCES branches(id) ON DELETE SET NULL,
  invoice_number TEXT NOT NULL,
  reference_number TEXT NULL,
  purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_terms TEXT NOT NULL CHECK (payment_terms IN ('cash', 'credit', 'bank_transfer')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'posted', 'partially_returned', 'reversed')) DEFAULT 'draft',
  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes TEXT NULL,
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (supplier_id, invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_purchase_invoices_supplier ON purchase_invoices (supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_status ON purchase_invoices (status);
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_date ON purchase_invoices (purchase_date DESC);

CREATE TABLE IF NOT EXISTS purchase_invoice_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  variant_id UUID NULL REFERENCES product_variants(id) ON DELETE SET NULL,
  qty NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  unit_cost NUMERIC(14,2) NOT NULL CHECK (unit_cost >= 0),
  tax_rate_pct NUMERIC(8,4) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  line_total NUMERIC(14,2) NOT NULL,
  qty_returned NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (qty_returned >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (qty_returned <= qty)
);

CREATE INDEX IF NOT EXISTS idx_purchase_invoice_lines_invoice ON purchase_invoice_lines (invoice_id);

CREATE TABLE IF NOT EXISTS purchase_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_invoice_id UUID NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  reason_code TEXT NOT NULL CHECK (
    reason_code IN ('damaged', 'wrong_item', 'overstock', 'invoice_error', 'other')
  ),
  notes TEXT NULL,
  total_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  is_full_reversal BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_return_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_return_id UUID NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  purchase_invoice_line_id UUID NOT NULL REFERENCES purchase_invoice_lines(id) ON DELETE CASCADE,
  qty_returned NUMERIC(14,3) NOT NULL CHECK (qty_returned > 0)
);

CREATE INDEX IF NOT EXISTS idx_purchase_returns_invoice ON purchase_returns (purchase_invoice_id);
