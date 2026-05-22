/** SQL fragments for net/gross sales and profit after returns. */

export const SQL_NET_SALES_SUM = `COALESCE(SUM(i.total_amount - i.return_total), 0)::numeric(14,2)`;
export const SQL_GROSS_SALES_SUM = `COALESCE(SUM(i.total_amount), 0)::numeric(14,2)`;
export const SQL_RETURN_TOTAL_SUM = `COALESCE(SUM(i.return_total), 0)::numeric(14,2)`;

export const SQL_INVOICE_GROSS_PROFIT_SUBQUERY = `
  SELECT
    ii.invoice_id,
    COALESCE(SUM(ii.pre_tax_amount - ii.qty * p.cost_price), 0)::numeric(14,2) AS gross_profit
  FROM invoice_items ii
  JOIN products p ON p.id = ii.product_id
  GROUP BY ii.invoice_id
`;

export const SQL_INVOICE_RETURNED_PROFIT_SUBQUERY = `
  SELECT
    sr.invoice_id,
    COALESCE(SUM(sri.pre_tax_amount - sri.qty * p.cost_price), 0)::numeric(14,2) AS returned_profit
  FROM sales_return_items sri
  JOIN sales_returns sr ON sr.id = sri.sales_return_id
  JOIN invoice_items ii ON ii.id = sri.invoice_item_id
  JOIN products p ON p.id = ii.product_id
  GROUP BY sr.invoice_id
`;

export const SQL_NET_GROSS_PROFIT_SUM = `
  COALESCE(SUM(ip.gross_profit - COALESCE(rp.returned_profit, 0)), 0)::numeric(14,2)
`;
