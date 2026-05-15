CREATE TABLE IF NOT EXISTS supplier_categories (
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (supplier_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_supplier_categories_category
  ON supplier_categories (category_id);

CREATE TABLE IF NOT EXISTS supplier_products (
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (supplier_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_supplier_products_product
  ON supplier_products (product_id);
