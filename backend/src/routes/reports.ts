import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

const reportFilterSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  branchId: z.string().uuid().optional(),
  cashierId: z.string().uuid().optional(),
});

function parseFilters(query: unknown) {
  const parsed = reportFilterSchema.safeParse(query);
  if (!parsed.success) {
    return { error: parsed.error.flatten() };
  }

  const from = parsed.data.from ? new Date(parsed.data.from) : new Date(new Date().setMonth(new Date().getMonth() - 1));
  const to = parsed.data.to ? new Date(parsed.data.to) : new Date();
  return {
    from,
    to,
    branchId: parsed.data.branchId,
    cashierId: parsed.data.cashierId,
  };
}

router.get("/sales-summary", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const filters = parseFilters(req.query);
  if ("error" in filters) return res.status(400).json({ message: "Invalid query params", errors: filters.error });

  const data = await pool.query(
    `
      SELECT
        COUNT(*)::int AS invoices,
        COALESCE(SUM(i.total_amount), 0)::numeric(14,2) AS total_sales,
        COALESCE(SUM(i.tax_total), 0)::numeric(14,2) AS tax_total
      FROM invoices i
      WHERE i.created_at BETWEEN $1 AND $2
        AND ($3::uuid IS NULL OR i.branch_id = $3::uuid)
        AND ($4::uuid IS NULL OR i.posted_by = $4::uuid)
        AND i.invoice_status <> 'voided'
    `,
    [filters.from.toISOString(), filters.to.toISOString(), filters.branchId ?? null, filters.cashierId ?? null],
  );

  const profit = await pool.query(
    `
      SELECT COALESCE(SUM(profit), 0)::numeric(14,2) AS total_profit
      FROM (
        SELECT
          SUM(ii.pre_tax_amount - ii.qty * p.cost_price) AS profit
        FROM invoices i
        JOIN invoice_items ii ON ii.invoice_id = i.id
        JOIN products p ON p.id = ii.product_id
        WHERE i.created_at BETWEEN $1 AND $2
          AND i.invoice_status <> 'voided'
          AND ($3::uuid IS NULL OR i.branch_id = $3::uuid)
          AND ($4::uuid IS NULL OR i.posted_by = $4::uuid)
        GROUP BY i.id
      ) inv_profit
    `,
    [filters.from.toISOString(), filters.to.toISOString(), filters.branchId ?? null, filters.cashierId ?? null],
  );

  return res.json({
    ...data.rows[0],
    total_profit: profit.rows[0].total_profit,
  });
});

const saleInvoicesQuerySchema = reportFilterSchema.extend({
  paymentStatus: z.enum(["pending", "partial", "paid"]).optional(),
  query: z.string().max(100).optional(),
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
});

router.get("/sale-invoices", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const parsed = saleInvoicesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid query params", errors: parsed.error.flatten() });
  }

  const from = parsed.data.from ? new Date(parsed.data.from) : new Date(new Date().setMonth(new Date().getMonth() - 1));
  const to = parsed.data.to ? new Date(parsed.data.to) : new Date();
  const branchId = parsed.data.branchId ?? null;
  const cashierId = parsed.data.cashierId ?? null;
  const paymentStatus = parsed.data.paymentStatus ?? null;
  const search = parsed.data.query?.trim() ? `%${parsed.data.query.trim()}%` : null;
  const limit = parsed.data.limit;
  const offset = parsed.data.offset;

  const rangeParams = [from.toISOString(), to.toISOString(), branchId, cashierId, paymentStatus, search];

  const summaryRow = await pool.query(
    `
      SELECT
        COUNT(*)::int AS invoice_count,
        COALESCE(SUM(i.total_amount), 0)::numeric(14,2) AS total_sales,
        COALESCE(SUM(i.tax_total), 0)::numeric(14,2) AS total_tax
      FROM invoices i
      JOIN orders o ON o.id = i.order_id
      WHERE i.created_at BETWEEN $1 AND $2
        AND i.invoice_status <> 'voided'
        AND ($3::uuid IS NULL OR i.branch_id = $3::uuid)
        AND ($4::uuid IS NULL OR i.posted_by = $4::uuid)
        AND ($5::text IS NULL OR i.payment_status = $5::text)
        AND ($6::text IS NULL OR i.invoice_number ILIKE $6 OR o.customer_name ILIKE $6)
    `,
    rangeParams,
  );

  const profitRow = await pool.query(
    `
      SELECT COALESCE(SUM(profit), 0)::numeric(14,2) AS total_profit
      FROM (
        SELECT
          SUM(ii.pre_tax_amount - ii.qty * p.cost_price) AS profit
        FROM invoices i
        JOIN orders o ON o.id = i.order_id
        JOIN invoice_items ii ON ii.invoice_id = i.id
        JOIN products p ON p.id = ii.product_id
        WHERE i.created_at BETWEEN $1 AND $2
          AND i.invoice_status <> 'voided'
          AND ($3::uuid IS NULL OR i.branch_id = $3::uuid)
          AND ($4::uuid IS NULL OR i.posted_by = $4::uuid)
          AND ($5::text IS NULL OR i.payment_status = $5::text)
          AND ($6::text IS NULL OR i.invoice_number ILIKE $6 OR o.customer_name ILIKE $6)
        GROUP BY i.id
      ) inv_profit
    `,
    rangeParams,
  );

  const countRow = await pool.query(
    `
      SELECT COUNT(*)::int AS total
      FROM invoices i
      JOIN orders o ON o.id = i.order_id
      WHERE i.created_at BETWEEN $1 AND $2
        AND i.invoice_status <> 'voided'
        AND ($3::uuid IS NULL OR i.branch_id = $3::uuid)
        AND ($4::uuid IS NULL OR i.posted_by = $4::uuid)
        AND ($5::text IS NULL OR i.payment_status = $5::text)
        AND ($6::text IS NULL OR i.invoice_number ILIKE $6 OR o.customer_name ILIKE $6)
    `,
    rangeParams,
  );

  const listRows = await pool.query(
    `
      SELECT
        i.id,
        i.invoice_number,
        i.created_at,
        i.total_amount,
        i.tax_total,
        i.payment_status,
        i.invoice_status,
        o.customer_name,
        u.full_name AS cashier_name,
        b.name AS branch_name,
        COALESCE(SUM(ii.pre_tax_amount), 0)::numeric(14,2) AS revenue_ex_tax,
        COALESCE(SUM(ii.qty * p.cost_price), 0)::numeric(14,2) AS cogs,
        (
          COALESCE(SUM(ii.pre_tax_amount), 0) - COALESCE(SUM(ii.qty * p.cost_price), 0)
        )::numeric(14,2) AS gross_profit
      FROM invoices i
      JOIN orders o ON o.id = i.order_id
      LEFT JOIN invoice_items ii ON ii.invoice_id = i.id
      LEFT JOIN products p ON p.id = ii.product_id
      LEFT JOIN users u ON u.id = i.posted_by
      LEFT JOIN branches b ON b.id = i.branch_id
      WHERE i.created_at BETWEEN $1 AND $2
        AND i.invoice_status <> 'voided'
        AND ($3::uuid IS NULL OR i.branch_id = $3::uuid)
        AND ($4::uuid IS NULL OR i.posted_by = $4::uuid)
        AND ($5::text IS NULL OR i.payment_status = $5::text)
        AND ($6::text IS NULL OR i.invoice_number ILIKE $6 OR o.customer_name ILIKE $6)
      GROUP BY
        i.id, i.invoice_number, i.created_at, i.total_amount, i.tax_total, i.payment_status, i.invoice_status,
        o.customer_name, u.full_name, b.name
      ORDER BY i.created_at DESC
      LIMIT $7 OFFSET $8
    `,
    [...rangeParams, limit, offset],
  );

  return res.json({
    summary: {
      ...summaryRow.rows[0],
      total_profit: profitRow.rows[0].total_profit,
    },
    total: countRow.rows[0].total,
    rows: listRows.rows,
  });
});

router.get("/monthly-pl", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const filters = parseFilters(req.query);
  if ("error" in filters) return res.status(400).json({ message: "Invalid query params", errors: filters.error });

  const data = await pool.query(
    `
      SELECT
        to_char(date_trunc('month', je.created_at), 'YYYY-MM') AS month,
        COALESCE(SUM(CASE WHEN la.type = 'income' THEN jl.credit - jl.debit ELSE 0 END), 0)::numeric(14,2) AS income,
        COALESCE(SUM(CASE WHEN la.type = 'expense' THEN jl.debit - jl.credit ELSE 0 END), 0)::numeric(14,2) AS expense,
        (
          COALESCE(SUM(CASE WHEN la.type = 'income' THEN jl.credit - jl.debit ELSE 0 END), 0)
          -
          COALESCE(SUM(CASE WHEN la.type = 'expense' THEN jl.debit - jl.credit ELSE 0 END), 0)
        )::numeric(14,2) AS profit
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      JOIN ledger_accounts la ON la.id = jl.account_id
      WHERE je.created_at BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 24
    `,
    [filters.from.toISOString(), filters.to.toISOString()],
  );
  return res.json(data.rows);
});

router.get("/tax-slabs", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const filters = parseFilters(req.query);
  if ("error" in filters) return res.status(400).json({ message: "Invalid query params", errors: filters.error });

  const rows = await pool.query(
    `
      SELECT
        ii.tax_rate,
        COALESCE(SUM(ii.pre_tax_amount), 0)::numeric(14,2) AS taxable_value,
        COALESCE(SUM(ii.tax_amount), 0)::numeric(14,2) AS tax_value,
        COALESCE(SUM(ii.line_total), 0)::numeric(14,2) AS gross_value
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      WHERE i.created_at BETWEEN $1 AND $2
        AND i.invoice_status <> 'voided'
        AND ($3::uuid IS NULL OR i.branch_id = $3::uuid)
      GROUP BY ii.tax_rate
      ORDER BY ii.tax_rate ASC
    `,
    [filters.from.toISOString(), filters.to.toISOString(), filters.branchId ?? null],
  );
  return res.json(rows.rows);
});

router.get("/cashier-sales", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const filters = parseFilters(req.query);
  if ("error" in filters) return res.status(400).json({ message: "Invalid query params", errors: filters.error });

  const rows = await pool.query(
    `
      SELECT
        u.id AS cashier_id,
        u.full_name AS cashier_name,
        COUNT(i.id)::int AS invoice_count,
        COALESCE(SUM(i.total_amount), 0)::numeric(14,2) AS total_sales,
        COALESCE(SUM(i.tax_total), 0)::numeric(14,2) AS total_tax
      FROM invoices i
      LEFT JOIN users u ON u.id = i.posted_by
      WHERE i.created_at BETWEEN $1 AND $2
        AND i.invoice_status <> 'voided'
        AND ($3::uuid IS NULL OR i.branch_id = $3::uuid)
        AND ($4::uuid IS NULL OR i.posted_by = $4::uuid)
      GROUP BY u.id, u.full_name
      ORDER BY total_sales DESC
    `,
    [filters.from.toISOString(), filters.to.toISOString(), filters.branchId ?? null, filters.cashierId ?? null],
  );
  return res.json(rows.rows);
});

router.get("/payment-methods", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const filters = parseFilters(req.query);
  if ("error" in filters) return res.status(400).json({ message: "Invalid query params", errors: filters.error });

  const rows = await pool.query(
    `
      SELECT
        p.method,
        COUNT(*)::int AS count,
        COALESCE(SUM(p.amount), 0)::numeric(14,2) AS total_amount
      FROM payments p
      JOIN invoices i ON i.id = p.invoice_id
      WHERE p.created_at BETWEEN $1 AND $2
        AND p.status = 'paid'
        AND i.invoice_status <> 'voided'
        AND ($3::uuid IS NULL OR i.branch_id = $3::uuid)
      GROUP BY p.method
      ORDER BY total_amount DESC
    `,
    [filters.from.toISOString(), filters.to.toISOString(), filters.branchId ?? null],
  );
  return res.json(rows.rows);
});

router.get("/profit-margin", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const filters = parseFilters(req.query);
  if ("error" in filters) return res.status(400).json({ message: "Invalid query params", errors: filters.error });

  const rows = await pool.query(
    `
      SELECT
        to_char(date_trunc('month', i.created_at), 'YYYY-MM') AS month,
        COALESCE(SUM(ii.pre_tax_amount), 0)::numeric(14,2) AS revenue_ex_tax,
        COALESCE(SUM(ii.qty * p.cost_price), 0)::numeric(14,2) AS cogs,
        (
          COALESCE(SUM(ii.pre_tax_amount), 0)
          -
          COALESCE(SUM(ii.qty * p.cost_price), 0)
        )::numeric(14,2) AS gross_profit,
        CASE
          WHEN COALESCE(SUM(ii.pre_tax_amount), 0) = 0 THEN 0
          ELSE ROUND(
            (
              (
                COALESCE(SUM(ii.pre_tax_amount), 0)
                -
                COALESCE(SUM(ii.qty * p.cost_price), 0)
              ) / COALESCE(SUM(ii.pre_tax_amount), 1)
            ) * 100, 2
          )
        END AS margin_percent
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      JOIN products p ON p.id = ii.product_id
      WHERE i.created_at BETWEEN $1 AND $2
        AND i.invoice_status <> 'voided'
        AND ($3::uuid IS NULL OR i.branch_id = $3::uuid)
      GROUP BY 1
      ORDER BY 1 DESC
    `,
    [filters.from.toISOString(), filters.to.toISOString(), filters.branchId ?? null],
  );
  return res.json(rows.rows);
});

router.get("/day-close", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const schema = z.object({
    shiftId: z.string().uuid().optional(),
    date: z.string().date().optional(),
    branchId: z.string().uuid().optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid query params", errors: parsed.error.flatten() });
  }

  if (parsed.data.shiftId) {
    const shift = await pool.query(`SELECT * FROM shifts WHERE id = $1`, [parsed.data.shiftId]);
    if (shift.rowCount === 0) {
      return res.status(404).json({ message: "Shift not found" });
    }

    const sales = await pool.query(
      `
        SELECT COALESCE(SUM(i.total_amount), 0) AS total_sales
        FROM invoices i
        JOIN orders o ON o.id = i.order_id
        WHERE o.created_by = $1
          AND i.created_at >= $2
          AND i.created_at <= COALESCE($3, NOW())
          AND i.invoice_status <> 'voided'
      `,
      [shift.rows[0].user_id, shift.rows[0].opened_at, shift.rows[0].closed_at],
    );
    const expenses = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total_expense FROM expenses WHERE shift_id = $1`,
      [parsed.data.shiftId],
    );
    return res.json({
      shift: shift.rows[0],
      totalSales: Number(sales.rows[0].total_sales),
      totalExpense: Number(expenses.rows[0].total_expense),
      expectedCash:
        Number(shift.rows[0].opening_cash) + Number(sales.rows[0].total_sales) - Number(expenses.rows[0].total_expense),
      actualClosingCash: Number(shift.rows[0].closing_cash ?? 0),
    });
  }

  const reportDate = parsed.data.date ?? new Date().toISOString().slice(0, 10);
  const rows = await pool.query(
    `
      SELECT
        DATE(i.created_at) AS report_date,
        COUNT(i.id)::int AS invoice_count,
        COALESCE(SUM(i.total_amount), 0)::numeric(14,2) AS total_sales,
        COALESCE(SUM(i.tax_total), 0)::numeric(14,2) AS total_tax,
        COALESCE(SUM(i.return_total), 0)::numeric(14,2) AS total_returns
      FROM invoices i
      WHERE DATE(i.created_at) = $1::date
        AND i.invoice_status <> 'voided'
        AND ($2::uuid IS NULL OR i.branch_id = $2::uuid)
      GROUP BY DATE(i.created_at)
    `,
    [reportDate, parsed.data.branchId ?? null],
  );
  return res.json(rows.rowCount ? rows.rows[0] : { report_date: reportDate, invoice_count: 0, total_sales: 0, total_tax: 0, total_returns: 0 });
});

router.get("/analytics/sales-trend", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const baseFilters = parseFilters(req.query);
  if ("error" in baseFilters) return res.status(400).json({ message: "Invalid query params", errors: baseFilters.error });

  const schema = z.object({
    bucket: z.enum(["hour", "day", "week", "month"]).default("day"),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid query params", errors: parsed.error.flatten() });
  }

  const bucket = parsed.data.bucket;
  const dateTrunc = bucket === "hour" ? "hour" : bucket === "week" ? "week" : bucket === "month" ? "month" : "day";
  const labelFormat = bucket === "hour" ? "YYYY-MM-DD HH24:00" : bucket === "week" ? "IYYY-\"W\"IW" : bucket === "month" ? "YYYY-MM" : "YYYY-MM-DD";

  const rows = await pool.query(
    `
      WITH invoice_profit AS (
        SELECT
          ii.invoice_id,
          COALESCE(SUM(ii.pre_tax_amount - ii.qty * p.cost_price), 0)::numeric(14,2) AS gross_profit
        FROM invoice_items ii
        JOIN products p ON p.id = ii.product_id
        GROUP BY ii.invoice_id
      )
      SELECT
        to_char(date_trunc('${dateTrunc}', i.created_at), '${labelFormat}') AS period,
        COUNT(i.id)::int AS invoice_count,
        COALESCE(SUM(i.total_amount), 0)::numeric(14,2) AS total_sales,
        COALESCE(SUM(i.tax_total), 0)::numeric(14,2) AS total_tax,
        COALESCE(SUM(ip.gross_profit), 0)::numeric(14,2) AS gross_profit
      FROM invoices i
      LEFT JOIN invoice_profit ip ON ip.invoice_id = i.id
      WHERE i.created_at BETWEEN $1 AND $2
        AND i.invoice_status <> 'voided'
        AND ($3::uuid IS NULL OR i.branch_id = $3::uuid)
        AND ($4::uuid IS NULL OR i.posted_by = $4::uuid)
      GROUP BY 1
      ORDER BY 1 ASC
    `,
    [
      baseFilters.from.toISOString(),
      baseFilters.to.toISOString(),
      baseFilters.branchId ?? null,
      baseFilters.cashierId ?? null,
    ],
  );
  return res.json(rows.rows);
});

router.get("/analytics/peak-hours", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const filters = parseFilters(req.query);
  if ("error" in filters) return res.status(400).json({ message: "Invalid query params", errors: filters.error });

  const rows = await pool.query(
    `
      SELECT
        EXTRACT(DOW FROM i.created_at)::int AS day_of_week,
        EXTRACT(HOUR FROM i.created_at)::int AS hour_of_day,
        COUNT(i.id)::int AS invoice_count,
        COALESCE(SUM(i.total_amount), 0)::numeric(14,2) AS total_sales
      FROM invoices i
      WHERE i.created_at BETWEEN $1 AND $2
        AND i.invoice_status <> 'voided'
        AND ($3::uuid IS NULL OR i.branch_id = $3::uuid)
      GROUP BY 1, 2
      ORDER BY 1 ASC, 2 ASC
    `,
    [filters.from.toISOString(), filters.to.toISOString(), filters.branchId ?? null],
  );
  return res.json(rows.rows);
});

router.get("/analytics/top-items", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const filters = parseFilters(req.query);
  if ("error" in filters) return res.status(400).json({ message: "Invalid query params", errors: filters.error });

  const schema = z.object({
    limit: z.coerce.number().min(1).max(200).default(20),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid query params", errors: parsed.error.flatten() });
  }

  const rows = await pool.query(
    `
      SELECT
        ii.product_id,
        COALESCE(NULLIF(TRIM(p.name), ''), NULLIF(TRIM(ii.product_name), ''), 'Unknown product') AS product_name,
        COALESCE(SUM(ii.qty), 0)::numeric(14,3) AS total_qty,
        COALESCE(SUM(ii.pre_tax_amount), 0)::numeric(14,2) AS revenue_ex_tax,
        COALESCE(SUM(ii.line_total), 0)::numeric(14,2) AS gross_revenue,
        COALESCE(SUM(ii.qty * p.cost_price), 0)::numeric(14,2) AS cogs,
        (
          COALESCE(SUM(ii.pre_tax_amount), 0)
          -
          COALESCE(SUM(ii.qty * p.cost_price), 0)
        )::numeric(14,2) AS gross_profit
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      JOIN products p ON p.id = ii.product_id
      WHERE i.created_at BETWEEN $1 AND $2
        AND i.invoice_status <> 'voided'
        AND ($3::uuid IS NULL OR i.branch_id = $3::uuid)
      GROUP BY ii.product_id, p.name, ii.product_name
      ORDER BY gross_profit DESC
      LIMIT $4
    `,
    [filters.from.toISOString(), filters.to.toISOString(), filters.branchId ?? null, parsed.data.limit],
  );
  return res.json(rows.rows);
});

router.get("/analytics/branch-comparison", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const filters = parseFilters(req.query);
  if ("error" in filters) return res.status(400).json({ message: "Invalid query params", errors: filters.error });

  const rows = await pool.query(
    `
      SELECT
        b.id AS branch_id,
        b.code AS branch_code,
        b.name AS branch_name,
        COUNT(i.id)::int AS invoice_count,
        COALESCE(SUM(i.total_amount), 0)::numeric(14,2) AS total_sales,
        COALESCE(SUM(i.tax_total), 0)::numeric(14,2) AS total_tax,
        COALESCE(SUM(i.return_total), 0)::numeric(14,2) AS total_returns,
        (
          COALESCE(SUM(i.total_amount), 0)
          - COALESCE(SUM(i.return_total), 0)
        )::numeric(14,2) AS net_sales
      FROM branches b
      LEFT JOIN invoices i
        ON i.branch_id = b.id
        AND i.created_at BETWEEN $1 AND $2
        AND i.invoice_status <> 'voided'
      WHERE b.is_active = TRUE
      GROUP BY b.id, b.code, b.name
      ORDER BY net_sales DESC
    `,
    [filters.from.toISOString(), filters.to.toISOString()],
  );
  return res.json(rows.rows);
});

router.get("/analytics/kpis", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const filters = parseFilters(req.query);
  if ("error" in filters) return res.status(400).json({ message: "Invalid query params", errors: filters.error });

  const row = await pool.query(
    `
      SELECT
        COUNT(i.id)::int AS invoice_count,
        COALESCE(SUM(i.total_amount), 0)::numeric(14,2) AS total_sales,
        COALESCE(SUM(i.return_total), 0)::numeric(14,2) AS total_returns,
        COALESCE(SUM(i.total_amount - i.return_total), 0)::numeric(14,2) AS net_sales,
        CASE WHEN COUNT(i.id) = 0 THEN 0
          ELSE ROUND(COALESCE(SUM(i.total_amount), 0) / COUNT(i.id), 2)
        END::numeric(14,2) AS avg_ticket_size
      FROM invoices i
      WHERE i.created_at BETWEEN $1 AND $2
        AND i.invoice_status <> 'voided'
        AND ($3::uuid IS NULL OR i.branch_id = $3::uuid)
        AND ($4::uuid IS NULL OR i.posted_by = $4::uuid)
    `,
    [filters.from.toISOString(), filters.to.toISOString(), filters.branchId ?? null, filters.cashierId ?? null],
  );

  return res.json(row.rows[0]);
});

export default router;
