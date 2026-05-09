import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { executeInvoiceVoid, executeOrderCancel } from "../services/voiding.js";
import { createAuditLog } from "../utils/audit.js";

const router = Router();

router.get("/", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const status = (req.query.status as string | undefined) ?? "pending";
  const rows = await pool.query(
    `
      SELECT ar.*, u.full_name AS requested_by_name
      FROM approval_requests ar
      JOIN users u ON u.id = ar.requested_by
      WHERE ar.status = $1
      ORDER BY ar.created_at DESC
      LIMIT 200
    `,
    [status],
  );
  return res.json(rows.rows);
});

router.post("/:id/approve", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const approvalId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const schema = z.object({
    note: z.string().max(200).optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const approvalResult = await client.query(
      `SELECT * FROM approval_requests WHERE id = $1 FOR UPDATE`,
      [approvalId],
    );
    if (approvalResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Approval request not found" });
    }

    const approval = approvalResult.rows[0];
    if (approval.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: `Approval already ${approval.status as string}` });
    }

    if (approval.action_type === "order_cancel") {
      const orderId = approval.action_payload.orderId as string;
      const before = await client.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
      const updated = await executeOrderCancel({
        client,
        orderId,
        reason: approval.reason as string,
        actorUserId: req.user?.id ?? null,
      });
      await createAuditLog({
        client,
        actorUserId: req.user?.id ?? null,
        action: "approve_order_cancel",
        entity: "orders",
        entityId: orderId,
        beforeData: before.rowCount ? before.rows[0] : null,
        afterData: updated,
      });
    } else if (approval.action_type === "invoice_void") {
      const invoiceId = approval.action_payload.invoiceId as string;
      const before = await client.query(`SELECT * FROM invoices WHERE id = $1`, [invoiceId]);
      const updated = await executeInvoiceVoid({
        client,
        invoiceId,
        reason: approval.reason as string,
        actorUserId: req.user?.id ?? null,
      });
      await createAuditLog({
        client,
        actorUserId: req.user?.id ?? null,
        action: "approve_invoice_void",
        entity: "invoices",
        entityId: invoiceId,
        beforeData: before.rowCount ? before.rows[0] : null,
        afterData: updated,
      });
    }

    const marked = await client.query(
      `
        UPDATE approval_requests
        SET status = 'approved', approved_by = $2, approved_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [approvalId, req.user?.id ?? null],
    );

    await client.query("COMMIT");
    return res.json({
      approval: marked.rows[0],
      note: parsed.data.note ?? null,
    });
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ message });
  } finally {
    client.release();
  }
});

router.post("/:id/reject", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const approvalId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const schema = z.object({
    reason: z.string().min(3).max(200),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const updated = await pool.query(
    `
      UPDATE approval_requests
      SET status = 'rejected', approved_by = $2, approved_at = NOW(), reason = reason || ' | Rejected: ' || $3
      WHERE id = $1 AND status = 'pending'
      RETURNING *
    `,
    [approvalId, req.user?.id ?? null, parsed.data.reason],
  );
  if (updated.rowCount === 0) {
    return res.status(404).json({ message: "Pending approval request not found" });
  }
  return res.json(updated.rows[0]);
});

export default router;
