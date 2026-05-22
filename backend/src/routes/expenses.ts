import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { EXPENSE_TYPES, isValidExpenseCategory, type ExpenseType } from "../constants/expenseCategories.js";
import { pool } from "../db/pool.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { deleteJournalEntryBySource, postJournalEntry } from "../services/ledger.js";
import { createAuditLog } from "../utils/audit.js";

const router = Router();

const dateRangeSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  expenseType: z.enum(EXPENSE_TYPES).optional(),
});

function parseDateRange(query: unknown) {
  const parsed = dateRangeSchema.safeParse(query);
  if (!parsed.success) {
    return { error: parsed.error.flatten() } as const;
  }
  const to = parsed.data.to ? new Date(parsed.data.to) : new Date();
  const from = parsed.data.from
    ? new Date(parsed.data.from)
    : new Date(new Date().setDate(to.getDate() - 30));
  from.setHours(0, 0, 0, 0);
  to.setHours(23, 59, 59, 999);
  return {
    from,
    to,
    expenseType: parsed.data.expenseType as ExpenseType | undefined,
  };
}

/** Calendar date YYYY-MM-DD (local), safe for pg DATE/TIMESTAMP values from node-pg. */
function toDateOnly(d: Date | string): string {
  if (typeof d === "string") {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(d.trim());
    if (m) return m[1];
  }
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d).slice(0, 10);
  const y = dt.getFullYear();
  const month = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${month}-${day}`;
}

function postsToLedger(type: ExpenseType): boolean {
  return type === "business" || type === "charity";
}

async function syncExpenseLedger(
  client: PoolClient,
  opts: {
    id: string;
    expenseType: ExpenseType;
    category: string;
    amount: number;
    createdBy: string | null;
  },
) {
  await deleteJournalEntryBySource(client, "expense", opts.id);
  if (!postsToLedger(opts.expenseType)) {
    return;
  }

  const memo =
    opts.expenseType === "charity"
      ? `Charity expense — ${opts.category}`
      : `Business expense — ${opts.category}`;

  await postJournalEntry({
    client,
    sourceType: "expense",
    sourceId: opts.id,
    memo,
    createdBy: opts.createdBy,
    lines: [
      { accountCode: "6000", debit: opts.amount, credit: 0, memo },
      { accountCode: "1000", debit: 0, credit: opts.amount, memo: "Cash out" },
    ],
  });
}

const expenseBodySchema = z.object({
  shiftId: z.string().uuid().optional(),
  amount: z.number().positive(),
  expenseType: z.enum(EXPENSE_TYPES).default("business"),
  category: z.string().min(2).max(60),
  expenseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  note: z.string().max(300).optional(),
});

const expensePatchSchema = z.object({
  amount: z.number().positive().optional(),
  expenseType: z.enum(EXPENSE_TYPES).optional(),
  category: z.string().min(2).max(60).optional(),
  expenseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  note: z.string().max(300).nullable().optional(),
});

router.get("/", requireAuth, async (req, res) => {
  const range = parseDateRange(req.query);
  if ("error" in range) {
    return res.status(400).json({ message: "Invalid query params", errors: range.error });
  }

  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const params: unknown[] = [range.from, range.to];
  let typeFilter = "";
  if (range.expenseType) {
    params.push(range.expenseType);
    typeFilter = ` AND e.expense_type = $${params.length}`;
  }
  params.push(limit);

  const rows = await pool.query(
    `
      SELECT
        e.id,
        e.shift_id,
        e.amount,
        e.category,
        e.expense_type,
        e.expense_date,
        e.note,
        e.created_by,
        e.created_at,
        u.email AS created_by_email
      FROM expenses e
      LEFT JOIN users u ON u.id = e.created_by
      WHERE e.expense_date >= $1::date AND e.expense_date <= $2::date
        ${typeFilter}
      ORDER BY e.expense_date DESC, e.created_at DESC
      LIMIT $${params.length}
    `,
    params,
  );

  return res.json(rows.rows);
});

router.get("/summary", requireAuth, async (req, res) => {
  const range = parseDateRange(req.query);
  if ("error" in range) {
    return res.status(400).json({ message: "Invalid query params", errors: range.error });
  }

  const rows = await pool.query(
    `
      SELECT
        expense_type,
        COALESCE(SUM(amount), 0)::numeric(14,2) AS total_amount,
        COUNT(*)::int AS entry_count
      FROM expenses
      WHERE expense_date >= $1::date AND expense_date <= $2::date
      GROUP BY expense_type
    `,
    [range.from, range.to],
  );

  const byType: Record<ExpenseType, { total: number; count: number }> = {
    personal: { total: 0, count: 0 },
    business: { total: 0, count: 0 },
    charity: { total: 0, count: 0 },
  };

  for (const row of rows.rows) {
    const t = row.expense_type as ExpenseType;
    if (EXPENSE_TYPES.includes(t)) {
      byType[t] = {
        total: Number(row.total_amount),
        count: Number(row.entry_count),
      };
    }
  }

  const total = EXPENSE_TYPES.reduce((sum, t) => sum + byType[t].total, 0);

  return res.json({
    from: toDateOnly(range.from),
    to: toDateOnly(range.to),
    total,
    byType,
  });
});

router.get("/analytics/weekly", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const range = parseDateRange(req.query);
  if ("error" in range) {
    return res.status(400).json({ message: "Invalid query params", errors: range.error });
  }

  const [salesRows, expenseRows] = await Promise.all([
    pool.query(
      `
        SELECT
          DATE(i.created_at) AS day,
          COALESCE(SUM(i.total_amount - i.return_total), 0)::numeric(14,2) AS sales
        FROM invoices i
        WHERE i.created_at BETWEEN $1 AND $2
          AND i.invoice_status <> 'voided'
        GROUP BY DATE(i.created_at)
        ORDER BY day ASC
      `,
      [range.from, range.to],
    ),
    pool.query(
      `
        SELECT
          expense_date AS day,
          COALESCE(SUM(amount), 0)::numeric(14,2) AS expenses,
          COALESCE(SUM(amount) FILTER (WHERE expense_type = 'personal'), 0)::numeric(14,2) AS personal,
          COALESCE(SUM(amount) FILTER (WHERE expense_type = 'business'), 0)::numeric(14,2) AS business,
          COALESCE(SUM(amount) FILTER (WHERE expense_type = 'charity'), 0)::numeric(14,2) AS charity
        FROM expenses
        WHERE expense_date >= $1::date AND expense_date <= $2::date
        GROUP BY expense_date
        ORDER BY expense_date ASC
      `,
      [toDateOnly(range.from), toDateOnly(range.to)],
    ),
  ]);

  const salesMap = new Map<string, number>();
  for (const r of salesRows.rows) {
    const key = toDateOnly(r.day as Date | string);
    salesMap.set(key, Number(r.sales));
  }

  const expenseMap = new Map<string, { expenses: number; personal: number; business: number; charity: number }>();
  for (const r of expenseRows.rows) {
    const key = toDateOnly(r.day as Date | string);
    expenseMap.set(key, {
      expenses: Number(r.expenses),
      personal: Number(r.personal),
      business: Number(r.business),
      charity: Number(r.charity),
    });
  }

  const out: Array<{
    period: string;
    label: string;
    sales: number;
    expenses: number;
    personal: number;
    business: number;
    charity: number;
  }> = [];

  const cursor = new Date(range.from);
  cursor.setHours(12, 0, 0, 0);
  const end = new Date(range.to);
  end.setHours(12, 0, 0, 0);

  while (cursor <= end) {
    const key = toDateOnly(cursor);
    const exp = expenseMap.get(key) ?? { expenses: 0, personal: 0, business: 0, charity: 0 };
    out.push({
      period: key,
      label: cursor.toLocaleDateString(undefined, { weekday: "short" }),
      sales: salesMap.get(key) ?? 0,
      expenses: exp.expenses,
      personal: exp.personal,
      business: exp.business,
      charity: exp.charity,
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  return res.json(out.slice(-14));
});

router.get("/analytics/monthly", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const range = parseDateRange(req.query);
  if ("error" in range) {
    return res.status(400).json({ message: "Invalid query params", errors: range.error });
  }

  const rows = await pool.query(
    `
      SELECT
        to_char(date_trunc('month', expense_date), 'YYYY-MM') AS month,
        COALESCE(SUM(amount), 0)::numeric(14,2) AS expenses
      FROM expenses
      WHERE expense_date >= $1::date AND expense_date <= $2::date
      GROUP BY 1
      ORDER BY 1 ASC
    `,
    [toDateOnly(range.from), toDateOnly(range.to)],
  );

  return res.json(
    rows.rows.map((r) => ({
      month: String(r.month),
      expenses: Number(r.expenses),
    })),
  );
});

router.post("/", requireAuth, async (req, res) => {
  const parsed = expenseBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const expenseType = parsed.data.expenseType;
  const category = parsed.data.category.trim().toLowerCase();
  if (!isValidExpenseCategory(expenseType, category)) {
    return res.status(400).json({ message: "Invalid category for expense type" });
  }

  const expenseDate = parsed.data.expenseDate ?? toDateOnly(new Date());

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const expense = await client.query(
      `
        INSERT INTO expenses (shift_id, amount, category, expense_type, expense_date, note, created_by)
        VALUES ($1, $2, $3, $4, $5::date, $6, $7)
        RETURNING *
      `,
      [
        parsed.data.shiftId ?? null,
        parsed.data.amount,
        category,
        expenseType,
        expenseDate,
        parsed.data.note ?? null,
        req.user?.id ?? null,
      ],
    );

    await syncExpenseLedger(client, {
      id: expense.rows[0].id as string,
      expenseType,
      category,
      amount: parsed.data.amount,
      createdBy: req.user?.id ?? null,
    });

    await createAuditLog({
      client,
      actorUserId: req.user?.id ?? null,
      action: "create_expense",
      entity: "expenses",
      entityId: expense.rows[0].id as string,
      afterData: expense.rows[0],
    });

    await client.query("COMMIT");
    return res.status(201).json(expense.rows[0]);
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(500).json({ message });
  } finally {
    client.release();
  }
});

router.patch("/:id", requireAuth, async (req, res) => {
  const expenseId = String(req.params.id);
  const parsed = expensePatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  if (Object.keys(parsed.data).length === 0) {
    return res.status(400).json({ message: "No fields to update" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(`SELECT * FROM expenses WHERE id = $1`, [expenseId]);
    if (existing.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Expense not found" });
    }

    const before = existing.rows[0];
    const expenseType = (parsed.data.expenseType ?? before.expense_type) as ExpenseType;
    const category = (parsed.data.category ?? before.category).trim().toLowerCase();
    const amount = parsed.data.amount ?? Number(before.amount);
    const expenseDate = parsed.data.expenseDate ?? String(before.expense_date).slice(0, 10);
    const note =
      parsed.data.note !== undefined
        ? parsed.data.note
        : (before.note as string | null);

    if (!isValidExpenseCategory(expenseType, category)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invalid category for expense type" });
    }

    const updated = await client.query(
      `
        UPDATE expenses
        SET
          amount = $2,
          category = $3,
          expense_type = $4,
          expense_date = $5::date,
          note = $6
        WHERE id = $1
        RETURNING *
      `,
      [expenseId, amount, category, expenseType, expenseDate, note],
    );

    await syncExpenseLedger(client, {
      id: expenseId,
      expenseType,
      category,
      amount,
      createdBy: req.user?.id ?? null,
    });

    await createAuditLog({
      client,
      actorUserId: req.user?.id ?? null,
      action: "update_expense",
      entity: "expenses",
      entityId: expenseId,
      beforeData: before,
      afterData: updated.rows[0],
    });

    await client.query("COMMIT");
    return res.json(updated.rows[0]);
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(500).json({ message });
  } finally {
    client.release();
  }
});

router.delete("/:id", requireAuth, async (req, res) => {
  const expenseId = String(req.params.id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(`SELECT * FROM expenses WHERE id = $1`, [expenseId]);
    if (existing.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Expense not found" });
    }

    const before = existing.rows[0];
    await deleteJournalEntryBySource(client, "expense", expenseId);
    await client.query(`DELETE FROM expenses WHERE id = $1`, [expenseId]);

    await createAuditLog({
      client,
      actorUserId: req.user?.id ?? null,
      action: "delete_expense",
      entity: "expenses",
      entityId: expenseId,
      beforeData: before,
    });

    await client.query("COMMIT");
    return res.json({ ok: true, id: expenseId });
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(500).json({ message });
  } finally {
    client.release();
  }
});

router.get("/day-close-summary", requireAuth, async (req, res) => {
  const shiftId = req.query.shiftId as string | undefined;
  if (!shiftId) {
    return res.status(400).json({ message: "shiftId is required" });
  }

  const shiftResult = await pool.query(`SELECT * FROM shifts WHERE id = $1`, [shiftId]);
  if (shiftResult.rowCount === 0) {
    return res.status(404).json({ message: "Shift not found" });
  }

  const shift = shiftResult.rows[0];
  const sales = await pool.query(
    `
      SELECT COALESCE(SUM(i.total_amount - i.return_total), 0) AS total_sales
      FROM invoices i
      JOIN orders o ON o.id = i.order_id
      WHERE o.created_by = $1
        AND i.created_at >= $2
        AND i.created_at <= COALESCE($3, NOW())
        AND i.invoice_status <> 'voided'
    `,
    [shift.user_id, shift.opened_at, shift.closed_at],
  );

  const expenses = await pool.query(
    `
      SELECT COALESCE(SUM(amount), 0) AS total_expense
      FROM expenses
      WHERE shift_id = $1
    `,
    [shiftId],
  );

  return res.json({
    shift,
    totalSales: Number(sales.rows[0].total_sales),
    totalExpense: Number(expenses.rows[0].total_expense),
    expectedCash:
      Number(shift.opening_cash) + Number(sales.rows[0].total_sales) - Number(expenses.rows[0].total_expense),
  });
});

export default router;
