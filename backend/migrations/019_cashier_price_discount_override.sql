-- Allow cashiers to override line sale price and discounts at POS (matches seed).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key IN ('price_override', 'discount_override')
WHERE r.name = 'cashier'
ON CONFLICT DO NOTHING;
