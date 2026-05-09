CREATE TABLE IF NOT EXISTS branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE products
ADD COLUMN IF NOT EXISTS category_id UUID NULL REFERENCES categories(id),
ADD COLUMN IF NOT EXISTS low_stock_threshold NUMERIC(14,3) NOT NULL DEFAULT 5;

CREATE TABLE IF NOT EXISTS product_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku TEXT NOT NULL UNIQUE,
  barcode TEXT NULL UNIQUE,
  name TEXT NOT NULL,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  sale_price NUMERIC(14,2) NULL,
  cost_price NUMERIC(14,2) NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id UUID NULL REFERENCES product_variants(id) ON DELETE SET NULL,
  branch_id UUID NULL REFERENCES branches(id) ON DELETE SET NULL,
  batch_code TEXT NOT NULL,
  expiry_date DATE NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, variant_id, branch_id, batch_code)
);

CREATE TABLE IF NOT EXISTS branch_inventory_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id UUID NULL REFERENCES product_variants(id) ON DELETE SET NULL,
  batch_id UUID NULL REFERENCES inventory_batches(id) ON DELETE SET NULL,
  qty_on_hand NUMERIC(14,3) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_branch_inventory_balances
ON branch_inventory_balances (branch_id, product_id, variant_id, batch_id);

CREATE TABLE IF NOT EXISTS branch_inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id UUID NULL REFERENCES product_variants(id) ON DELETE SET NULL,
  batch_id UUID NULL REFERENCES inventory_batches(id) ON DELETE SET NULL,
  movement_type TEXT NOT NULL CHECK (
    movement_type IN ('stock_in', 'stock_out', 'sale_out', 'return_in', 'adjustment', 'transfer_in', 'transfer_out')
  ),
  qty NUMERIC(14,3) NOT NULL,
  unit_cost NUMERIC(14,2) NULL,
  reference_type TEXT NULL,
  reference_id UUID NULL,
  reason TEXT NULL,
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_branch_inventory_balances_lookup
ON branch_inventory_balances (branch_id, product_id);

CREATE INDEX IF NOT EXISTS idx_branch_inventory_movements_lookup
ON branch_inventory_movements (branch_id, product_id, created_at DESC);
