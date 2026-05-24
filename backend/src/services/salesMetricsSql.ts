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

export type ProfitLossGroupBy = "category" | "department" | "day" | "month" | "item";

const SQL_PL_INVOICE_WHERE = `
  i.created_at BETWEEN $1 AND $2
  AND i.invoice_status <> 'voided'
  AND ($3::uuid IS NULL OR i.branch_id = $3::uuid)
  AND ($4::uuid IS NULL OR i.posted_by = $4::uuid)
`;

const SQL_PL_RETURN_DISCOUNT = `(ii.discount_amount * sri.qty / NULLIF(ii.qty, 0))`;

function profitLossGroupConfig(groupBy: ProfitLossGroupBy) {
  switch (groupBy) {
    case "category":
      return {
        extraJoins: `LEFT JOIN categories c ON c.id = p.category_id`,
        groupKey: `COALESCE(c.id::text, '__none__')`,
        groupLabel: `COALESCE(NULLIF(TRIM(c.name), ''), 'Uncategorized')`,
        orderBy: `gross_profit DESC`,
        limit: "",
      };
    case "department":
      return {
        extraJoins: `
          LEFT JOIN categories c ON c.id = p.category_id
          LEFT JOIN departments d ON d.id = c.department_id
        `,
        groupKey: `COALESCE(d.id::text, '__none__')`,
        groupLabel: `COALESCE(NULLIF(TRIM(d.name), ''), 'No department')`,
        orderBy: `gross_profit DESC`,
        limit: "",
      };
    case "day":
      return {
        extraJoins: "",
        groupKey: `to_char(date_trunc('day', i.created_at), 'YYYY-MM-DD')`,
        groupLabel: `to_char(date_trunc('day', i.created_at), 'YYYY-MM-DD')`,
        orderBy: `group_key ASC`,
        limit: "",
      };
    case "month":
      return {
        extraJoins: "",
        groupKey: `to_char(date_trunc('month', i.created_at), 'YYYY-MM')`,
        groupLabel: `to_char(date_trunc('month', i.created_at), 'YYYY-MM')`,
        orderBy: `group_key DESC`,
        limit: "",
      };
    case "item":
      return {
        extraJoins: "",
        groupKey: `ii.product_id::text`,
        groupLabel: `COALESCE(NULLIF(TRIM(p.name), ''), NULLIF(TRIM(ii.product_name), ''), 'Unknown product')`,
        orderBy: `gross_profit DESC`,
        limit: `LIMIT 500`,
      };
  }
}

function buildProfitLossLineMetricsCte(groupBy: ProfitLossGroupBy) {
  const g = profitLossGroupConfig(groupBy);
  return `
    WITH line_metrics AS (
      SELECT
        ${g.groupKey} AS group_key,
        ${g.groupLabel} AS group_label,
        i.id AS invoice_id,
        ii.qty AS qty,
        ii.line_total AS total_sales,
        ii.discount_amount AS discount,
        ii.pre_tax_amount AS revenue_ex_tax,
        ii.qty * p.cost_price AS cogs
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      JOIN products p ON p.id = ii.product_id
      ${g.extraJoins}
      WHERE ${SQL_PL_INVOICE_WHERE}

      UNION ALL

      SELECT
        ${g.groupKey} AS group_key,
        ${g.groupLabel} AS group_label,
        i.id AS invoice_id,
        -sri.qty AS qty,
        -sri.line_total AS total_sales,
        -${SQL_PL_RETURN_DISCOUNT} AS discount,
        -sri.pre_tax_amount AS revenue_ex_tax,
        -(sri.qty * p.cost_price) AS cogs
      FROM sales_return_items sri
      JOIN sales_returns sr ON sr.id = sri.sales_return_id
      JOIN invoice_items ii ON ii.id = sri.invoice_item_id
      JOIN invoices i ON i.id = ii.invoice_id
      JOIN products p ON p.id = ii.product_id
      ${g.extraJoins}
      WHERE ${SQL_PL_INVOICE_WHERE}
    )
  `;
}

/** Profit & loss rows grouped by category/department/day/month/item; returns reduce net figures. */
export function buildProfitLossSummaryQuery(groupBy: ProfitLossGroupBy) {
  const g = profitLossGroupConfig(groupBy);
  return `
    ${buildProfitLossLineMetricsCte(groupBy)}
    SELECT
      group_key,
      MAX(group_label) AS group_label,
      COUNT(DISTINCT invoice_id)::int AS invoice_count,
      COALESCE(SUM(qty), 0)::numeric(14,3) AS qty_sold,
      COALESCE(SUM(total_sales), 0)::numeric(14,2) AS total_sales,
      COALESCE(SUM(discount), 0)::numeric(14,2) AS discount,
      COALESCE(SUM(revenue_ex_tax), 0)::numeric(14,2) AS revenue_ex_tax,
      COALESCE(SUM(cogs), 0)::numeric(14,2) AS cogs,
      COALESCE(SUM(revenue_ex_tax - cogs), 0)::numeric(14,2) AS gross_profit
    FROM line_metrics
    GROUP BY group_key
    ORDER BY ${g.orderBy}
    ${g.limit}
  `;
}

/** Net profit & loss totals for a date range; returns reduce all columns. */
export function buildProfitLossTotalsQuery() {
  return `
    WITH line_metrics AS (
      SELECT
        i.id AS invoice_id,
        ii.qty AS qty,
        ii.line_total AS total_sales,
        ii.discount_amount AS discount,
        ii.pre_tax_amount AS revenue_ex_tax,
        ii.qty * p.cost_price AS cogs
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      JOIN products p ON p.id = ii.product_id
      WHERE ${SQL_PL_INVOICE_WHERE}

      UNION ALL

      SELECT
        i.id AS invoice_id,
        -sri.qty AS qty,
        -sri.line_total AS total_sales,
        -${SQL_PL_RETURN_DISCOUNT} AS discount,
        -sri.pre_tax_amount AS revenue_ex_tax,
        -(sri.qty * p.cost_price) AS cogs
      FROM sales_return_items sri
      JOIN sales_returns sr ON sr.id = sri.sales_return_id
      JOIN invoice_items ii ON ii.id = sri.invoice_item_id
      JOIN invoices i ON i.id = ii.invoice_id
      JOIN products p ON p.id = ii.product_id
      WHERE ${SQL_PL_INVOICE_WHERE}
    )
    SELECT
      COUNT(DISTINCT invoice_id)::int AS invoice_count,
      COALESCE(SUM(qty), 0)::numeric(14,3) AS qty_sold,
      COALESCE(SUM(total_sales), 0)::numeric(14,2) AS total_sales,
      COALESCE(SUM(discount), 0)::numeric(14,2) AS discount,
      COALESCE(SUM(revenue_ex_tax), 0)::numeric(14,2) AS revenue_ex_tax,
      COALESCE(SUM(cogs), 0)::numeric(14,2) AS cogs,
      COALESCE(SUM(revenue_ex_tax - cogs), 0)::numeric(14,2) AS gross_profit
    FROM line_metrics
  `;
}
