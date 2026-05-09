import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { postJournalEntry } from "../services/ledger.js";
import { createAuditLog } from "../utils/audit.js";

const router = Router();

router.post("/", requireAuth, async (req, res) => {
  const schema = z.object({
    shiftId: z.string().uuid().optional(),
    amount: z.number().positive(),
    category: z.string().min(2).max(60),
    note: z.string().max(300).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const expense = await client.query(
      `
        INSERT INTO expenses (shift_id, amount, category, note, created_by)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `,
      [
        parsed.data.shiftId ?? null,
        parsed.data.amount,
        parsed.data.category,
        parsed.data.note ?? null,
        req.user?.id ?? null,
      ],
    );

    await postJournalEntry({
      client,
      sourceType: "expense",
      sourceId: expense.rows[0].id as string,
      memo: `Drawer expense ${parsed.data.category}`,
      createdBy: req.user?.id ?? null,
      lines: [
        { accountCode: "6000", debit: parsed.data.amount, credit: 0, memo: "Expense" },
        { accountCode: "1000", debit: 0, credit: parsed.data.amount, memo: "Cash out" },
      ],
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
      SELECT COALESCE(SUM(i.total_amount), 0) AS total_sales
      FROM invoices i
      JOIN orders o ON o.id = i.order_id
      WHERE o.created_by = $1 AND i.created_at >= $2 AND i.created_at <= COALESCE($3, NOW())
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
