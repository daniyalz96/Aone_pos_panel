-- Alert when 4 or fewer units remain (was 5).
ALTER TABLE products
  ALTER COLUMN low_stock_threshold SET DEFAULT 4;

UPDATE products
SET low_stock_threshold = 4
WHERE low_stock_threshold = 5;
