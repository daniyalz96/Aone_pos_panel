import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { createAuditLog } from "../utils/audit.js";

const router = Router();

router.post("/open", requireAuth, requirePermission("open_close_drawer"), async (req, res) => {
  const schema = z.object({
    openingCash: z.number().min(0),
    branchId: z.string().uuid().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const activeShift = await pool.query(
    `SELECT id FROM shifts WHERE user_id = $1 AND closed_at IS NULL`,
    [req.user?.id],
  );

  if (activeShift.rowCount && activeShift.rowCount > 0) {
    return res.status(409).json({ message: "An active shift already exists" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const shift = await client.query(
      `
        INSERT INTO shifts (user_id, branch_id, opening_cash, opened_at)
        VALUES ($1, $2, $3, NOW())
        RETURNING *
      `,
      [req.user?.id, parsed.data.branchId ?? null, parsed.data.openingCash],
    );

    await createAuditLog({
      client,
      actorUserId: req.user?.id ?? null,
      action: "shift_open",
      entity: "shifts",
      entityId: shift.rows[0].id as string,
      afterData: shift.rows[0],
    });

    await client.query("COMMIT");
    return res.status(201).json(shift.rows[0]);
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(500).json({ message });
  } finally {
    client.release();
  }
});

router.post("/close", requireAuth, requirePermission("open_close_drawer"), async (req, res) => {
  const schema = z.object({
    closingCash: z.number().min(0),
    notes: z.string().max(500).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const activeShift = await client.query(
      `
        SELECT * FROM shifts
        WHERE user_id = $1 AND closed_at IS NULL
        ORDER BY opened_at DESC
        LIMIT 1
      `,
      [req.user?.id],
    );

    if (activeShift.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "No active shift found" });
    }

    const shiftId = activeShift.rows[0].id as string;
    const updated = await client.query(
      `
        UPDATE shifts
        SET closing_cash = $2, notes = $3, closed_at = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [shiftId, parsed.data.closingCash, parsed.data.notes ?? null],
    );

    await createAuditLog({
      client,
      actorUserId: req.user?.id ?? null,
      action: "shift_close",
      entity: "shifts",
      entityId: shiftId,
      beforeData: activeShift.rows[0],
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

export default router;
