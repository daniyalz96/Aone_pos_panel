DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'orders_status_check'
  ) THEN
    ALTER TABLE orders DROP CONSTRAINT orders_status_check;
  END IF;
END $$;

ALTER TABLE orders
ADD CONSTRAINT orders_status_check
CHECK (status IN ('draft', 'held', 'posted', 'canceled'));

ALTER TABLE orders
ADD COLUMN IF NOT EXISTS canceled_reason TEXT NULL,
ADD COLUMN IF NOT EXISTS canceled_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ NULL;

ALTER TABLE invoices
ADD COLUMN IF NOT EXISTS invoice_status TEXT NOT NULL DEFAULT 'posted',
ADD COLUMN IF NOT EXISTS void_reason TEXT NULL,
ADD COLUMN IF NOT EXISTS voided_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ NULL,
ADD COLUMN IF NOT EXISTS branch_id UUID NULL REFERENCES branches(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS return_total NUMERIC(14,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'invoices_invoice_status_check'
  ) THEN
    ALTER TABLE invoices DROP CONSTRAINT invoices_invoice_status_check;
  END IF;
END $$;

ALTER TABLE invoices
ADD CONSTRAINT invoices_invoice_status_check
CHECK (invoice_status IN ('posted', 'voided', 'partially_returned', 'returned'));

CREATE TABLE IF NOT EXISTS approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type TEXT NOT NULL CHECK (action_type IN ('order_cancel', 'invoice_void')),
  action_payload JSONB NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sales_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  refund_method TEXT NOT NULL CHECK (refund_method IN ('cash', 'bank', 'card', 'wallet', 'qr')),
  subtotal NUMERIC(14,2) NOT NULL,
  tax_total NUMERIC(14,2) NOT NULL,
  total_amount NUMERIC(14,2) NOT NULL,
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sales_return_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_return_id UUID NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
  invoice_item_id UUID NOT NULL REFERENCES invoice_items(id) ON DELETE RESTRICT,
  qty NUMERIC(14,3) NOT NULL,
  pre_tax_amount NUMERIC(14,2) NOT NULL,
  tax_amount NUMERIC(14,2) NOT NULL,
  line_total NUMERIC(14,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
