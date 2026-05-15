-- Retail price captured on purchase lines so posting can sync products even if draft was not saved last.
ALTER TABLE purchase_invoice_lines
  ADD COLUMN IF NOT EXISTS unit_sale_price NUMERIC(14,2) NULL;
