import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { createAuditLog } from "../utils/audit.js";
import { executeInvoiceVoid } from "../services/voiding.js";

const router = Router();

router.post("/invoices/:id/void", requireAuth, async (req, res) => {
  const invoiceId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const schema = z.object({ reason: z.string().min(3).max(200) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (!req.user?.permissions.includes("void_bill")) {
      const approval = await client.query(
        `
          INSERT INTO approval_requests (action_type, action_payload, reason, status, requested_by)
          VALUES ('invoice_void', $1, $2, 'pending', $3)
          RETURNING *
        `,
        [{ invoiceId }, parsed.data.reason, req.user?.id ?? null],
      );
      await client.query("COMMIT");
      return res.status(202).json({
        message: "Approval required for invoice void",
        approvalRequest: approval.rows[0],
      });
    }

    const before = await client.query(`SELECT * FROM invoices WHERE id = $1`, [invoiceId]);
    if (before.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Invoice not found" });
    }

    const updated = await executeInvoiceVoid({
      client,
      invoiceId,
      reason: parsed.data.reason,
      actorUserId: req.user?.id ?? null,
    });

    await createAuditLog({
      client,
      actorUserId: req.user?.id ?? null,
      action: "void_invoice",
      entity: "invoices",
      entityId: invoiceId,
      beforeData: before.rows[0],
      afterData: updated,
    });

    await client.query("COMMIT");
    return res.json(updated);
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ message });
  } finally {
    client.release();
  }
});

export default router;
