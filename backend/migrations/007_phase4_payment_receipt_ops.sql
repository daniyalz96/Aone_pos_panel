CREATE TABLE IF NOT EXISTS payment_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  total_amount NUMERIC(14,2) NOT NULL,
  received_cash NUMERIC(14,2) NOT NULL DEFAULT 0,
  change_due NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending', 'partial', 'paid', 'failed')) DEFAULT 'paid',
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE payments
ADD COLUMN IF NOT EXISTS payment_collection_id UUID NULL REFERENCES payment_collections(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS tendered_amount NUMERIC(14,2) NULL DEFAULT NULL,
ADD COLUMN IF NOT EXISTS change_amount NUMERIC(14,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'payments_status_check'
  ) THEN
    ALTER TABLE payments DROP CONSTRAINT payments_status_check;
  END IF;
END $$;

ALTER TABLE payments
ADD CONSTRAINT payments_status_check
CHECK (status IN ('pending', 'paid', 'failed', 'refunded'));

CREATE TABLE IF NOT EXISTS receipt_dispatches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('print', 'email', 'whatsapp')),
  destination TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed')) DEFAULT 'queued',
  payload JSONB NULL,
  error_message TEXT NULL,
  sent_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
