-- Opening balance: set on first global stock receipt; editable later from inventory.
ALTER TABLE inventory_balances
ADD COLUMN IF NOT EXISTS opening_balance NUMERIC(14,3) NULL;

COMMENT ON COLUMN inventory_balances.opening_balance IS
  'Initial / declared opening quantity; first stock-in from zero sets this; editable with qty adjustments.';
