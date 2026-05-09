import type { Request, Response } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";

const dashboardSummaryQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  cashierId: z.string().uuid().optional(),
  lowStockThreshold: z.coerce.number().min(0).max(9999).optional(),
});

/** KPI payload for `GET /api/v1/home/kpis`. */
export async function handleDashboardSummary(req: Request, res: Response) {
  const parsed = dashboardSummaryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid query params", errors: parsed.error.flatten() });
  }

  const branchId = parsed.data.branchId ?? null;
  const cashierId = parsed.data.cashierId ?? null;
  const threshold = parsed.data.lowStockThreshold ?? 5;

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const yesterdayEnd = new Date(todayStart.getTime() - 1);

  const rangeParams = (from: Date, to: Date): [string, string, string | null, string | null] => [
    from.toISOString(),
    to.toISOString(),
    branchId,
    cashierId,
  ];

  const salesInvoiceSql = `
    SELECT
      COUNT(i.id)::int AS invoice_count,
      COALESCE(SUM(i.total_amount - i.return_total), 0)::numeric(14,2) AS net_sales
    FROM invoices i
    WHERE i.created_at BETWEEN $1 AND $2
      AND i.invoice_status <> 'voided'
      AND ($3::uuid IS NULL OR i.branch_id = $3::uuid)
      AND ($4::uuid IS NULL OR i.posted_by = $4::uuid)
  `;

  const pendingSql = `
    SELECT
      COUNT(*)::int AS invoice_count,
      COALESCE(SUM(GREATEST(0, i.total_amount - COALESCE(p.paid, 0))), 0)::numeric(14,2) AS outstanding
    FROM invoices i
    LEFT JOIN (
      SELECT invoice_id, COALESCE(SUM(amount), 0) AS paid
      FROM payments
      WHERE status = 'paid'
      GROUP BY invoice_id
    ) p ON p.invoice_id = i.id
    WHERE i.invoice_status <> 'voided'
      AND i.payment_status IN ('pending', 'partial')
      AND ($1::uuid IS NULL OR i.branch_id = $1::uuid)
      AND ($2::uuid IS NULL OR i.posted_by = $2::uuid)
  `;

  try {
    const [todayRow, yesterdayRow, pendingRow, lowStockRow] = await Promise.all([
      pool.query(salesInvoiceSql, rangeParams(todayStart, now)),
      pool.query(salesInvoiceSql, rangeParams(yesterdayStart, yesterdayEnd)),
      pool.query(pendingSql, [branchId, cashierId]),
      branchId
        ? pool.query(
            `
            SELECT COUNT(*)::int AS c
            FROM (
              SELECT p.id
              FROM products p
              LEFT JOIN branch_inventory_balances bib
                ON bib.product_id = p.id
                AND bib.branch_id = $2
              WHERE p.is_active = TRUE
              GROUP BY p.id
              HAVING COALESCE(SUM(bib.qty_on_hand), 0) <= GREATEST(p.low_stock_threshold, $1)
            ) sub
            `,
            [threshold, branchId],
          )
        : pool.query(
            `
            SELECT COUNT(*)::int AS c
            FROM (
              SELECT p.id
              FROM products p
              LEFT JOIN inventory_balances ib ON ib.product_id = p.id
              WHERE p.is_active = TRUE
                AND COALESCE(ib.qty_on_hand, 0) <= GREATEST(p.low_stock_threshold, $1)
            ) sub
            `,
            [threshold],
          ),
    ]);

    const t = todayRow.rows[0];
    const y = yesterdayRow.rows[0];
    const p = pendingRow.rows[0];

    return res.json({
      today_sales: t.net_sales,
      today_invoice_count: t.invoice_count,
      yesterday_sales: y.net_sales,
      yesterday_invoice_count: y.invoice_count,
      pending_payment_amount: p.outstanding,
      pending_payment_invoice_count: p.invoice_count,
      low_stock_item_count: lowStockRow.rows[0].c,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load dashboard summary" });
  }
}
