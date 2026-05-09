import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

router.get("/accounts", requireAuth, requireRole("admin", "manager"), async (_req, res) => {
  const result = await pool.query(
    `
      SELECT
        la.id,
        la.code,
        la.name,
        la.type,
        COALESCE(SUM(jl.debit), 0) AS total_debit,
        COALESCE(SUM(jl.credit), 0) AS total_credit
      FROM ledger_accounts la
      LEFT JOIN journal_lines jl ON jl.account_id = la.id
      GROUP BY la.id
      ORDER BY la.code ASC
    `,
  );

  const rows = result.rows.map((row) => {
    const debit = Number(row.total_debit);
    const credit = Number(row.total_credit);
    const t = row.type as string;
    const net =
      t === "asset" || t === "expense"
        ? Number((debit - credit).toFixed(2))
        : Number((credit - debit).toFixed(2));
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type,
      total_debit: debit,
      total_credit: credit,
      net_balance: net,
    };
  });

  const sumDebit = rows.reduce((a, r) => a + r.total_debit, 0);
  const sumCredit = rows.reduce((a, r) => a + r.total_credit, 0);

  return res.json({
    accounts: rows,
    totals: {
      debit: Number(sumDebit.toFixed(2)),
      credit: Number(sumCredit.toFixed(2)),
      balanced: Math.abs(sumDebit - sumCredit) < 0.01,
    },
  });
});

router.get("/entries", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const sourceType = typeof req.query.sourceType === "string" && req.query.sourceType.trim() ? req.query.sourceType.trim() : null;
  const from = typeof req.query.from === "string" && req.query.from.trim() ? new Date(req.query.from) : null;
  const to = typeof req.query.to === "string" && req.query.to.trim() ? new Date(req.query.to) : null;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (sourceType) {
    conditions.push(`je.source_type = $${i++}`);
    params.push(sourceType);
  }
  if (from && !Number.isNaN(from.getTime())) {
    conditions.push(`je.created_at >= $${i++}`);
    params.push(from);
  }
  if (to && !Number.isNaN(to.getTime())) {
    conditions.push(`je.created_at <= $${i++}`);
    params.push(to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);

  const entries = await pool.query(
    `
      SELECT je.id, je.source_type, je.source_id, je.memo, je.created_at, je.created_by, u.email AS created_by_email
      FROM journal_entries je
      LEFT JOIN users u ON u.id = je.created_by
      ${where}
      ORDER BY je.created_at DESC
      LIMIT $${i}
    `,
    params,
  );

  return res.json(entries.rows);
});

router.get("/entries/:id", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const entry = await pool.query(`SELECT * FROM journal_entries WHERE id = $1`, [req.params.id]);
  if (entry.rowCount === 0) {
    return res.status(404).json({ message: "Journal entry not found" });
  }
  const lines = await pool.query(
    `
      SELECT jl.*, la.code AS account_code, la.name AS account_name, la.type AS account_type
      FROM journal_lines jl
      JOIN ledger_accounts la ON la.id = jl.account_id
      WHERE jl.journal_entry_id = $1
      ORDER BY jl.created_at ASC
    `,
    [req.params.id],
  );

  return res.json({
    entry: entry.rows[0],
    lines: lines.rows,
  });
});

export default router;
