CREATE INDEX IF NOT EXISTS idx_invoices_created_at
ON invoices (created_at);

CREATE INDEX IF NOT EXISTS idx_invoices_posted_by_created_at
ON invoices (posted_by, created_at);

CREATE INDEX IF NOT EXISTS idx_payments_invoice_id_created_at
ON payments (invoice_id, created_at);

CREATE INDEX IF NOT EXISTS idx_payments_method_created_at
ON payments (method, created_at);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id
ON invoice_items (invoice_id);

CREATE INDEX IF NOT EXISTS idx_journal_entries_created_at
ON journal_entries (created_at);
