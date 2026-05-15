/** Appended after `s.*` in `SELECT s.*, … FROM suppliers s` */
export const supplierBalanceAndCatalogSelect = `
        COALESCE((SELECT SUM(CASE WHEN e.amount > 0 THEN e.amount ELSE 0 END)
                  FROM supplier_ledger_entries e WHERE e.supplier_id = s.id), 0)::float8 AS total_balance,
        COALESCE((SELECT SUM(spm.amount) FROM supplier_payments spm WHERE spm.supplier_id = s.id), 0)::float8 AS paid_balance,
        COALESCE((SELECT SUM(e.amount) FROM supplier_ledger_entries e WHERE e.supplier_id = s.id), 0)::float8 AS current_balance,
        COALESCE((SELECT SUM(e.amount) FROM supplier_ledger_entries e WHERE e.supplier_id = s.id), 0)::float8 AS ledger_balance,
        COALESCE(
          (SELECT json_agg(json_build_object('id', c.id::text, 'name', c.name))
           FROM supplier_categories sc
           JOIN categories c ON c.id = sc.category_id
           WHERE sc.supplier_id = s.id),
          '[]'::json
        ) AS linked_categories,
        COALESCE(
          (SELECT json_agg(json_build_object('id', p.id::text, 'name', p.name, 'sku', p.sku))
           FROM supplier_products sp
           JOIN products p ON p.id = sp.product_id
           WHERE sp.supplier_id = s.id),
          '[]'::json
        ) AS linked_products
`;
