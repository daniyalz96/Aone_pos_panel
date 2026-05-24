import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { DEFAULT_LOW_STOCK_THRESHOLD } from "../config/inventory.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { syncLowStockNotifications } from "../services/lowStockAlerts.js";

const router = Router();

function normalizeParamId(id: string | string[]) {
  return Array.isArray(id) ? id[0] : id;
}

async function insertNotificationIfOpen(params: {
  type: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  dedupeKey: string;
  sourceType?: string;
  sourceId?: string;
  metadata?: Record<string, unknown>;
}) {
  const existing = await pool.query(
    `
      SELECT id
      FROM notifications
      WHERE dedupe_key = $1
        AND acknowledged = FALSE
      LIMIT 1
    `,
    [params.dedupeKey],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    return null;
  }

  const inserted = await pool.query(
    `
      INSERT INTO notifications
        (type, severity, title, message, acknowledged, dedupe_key, source_type, source_id, metadata)
      VALUES
        ($1, $2, $3, $4, FALSE, $5, $6, $7, $8)
      RETURNING *
    `,
    [
      params.type,
      params.severity,
      params.title,
      params.message,
      params.dedupeKey,
      params.sourceType ?? null,
      params.sourceId ?? null,
      params.metadata ?? null,
    ],
  );
  return inserted.rows[0];
}

router.get("/", requireAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 200);
  const includeAcknowledged = String(req.query.includeAcknowledged ?? "false") === "true";
  const result = await pool.query(
    `
      SELECT *
      FROM notifications
      WHERE ($2::boolean = TRUE OR acknowledged = FALSE)
      ORDER BY created_at DESC
      LIMIT $1
    `,
    [limit, includeAcknowledged],
  );
  return res.json(result.rows);
});

router.post("/", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const schema = z.object({
    type: z.string().min(2).max(40),
    severity: z.enum(["info", "warning", "critical"]),
    title: z.string().min(2).max(120),
    message: z.string().min(2).max(500),
    dedupeKey: z.string().min(3).max(200).optional(),
    sourceType: z.string().max(80).optional(),
    sourceId: z.string().uuid().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  if (parsed.data.dedupeKey) {
    const inserted = await insertNotificationIfOpen({
      type: parsed.data.type,
      severity: parsed.data.severity,
      title: parsed.data.title,
      message: parsed.data.message,
      dedupeKey: parsed.data.dedupeKey,
      sourceType: parsed.data.sourceType,
      sourceId: parsed.data.sourceId,
      metadata: parsed.data.metadata,
    });
    if (!inserted) {
      return res.status(200).json({ message: "Notification already open for dedupe key" });
    }
    return res.status(201).json(inserted);
  }

  const inserted = await pool.query(
    `
      INSERT INTO notifications (type, severity, title, message, acknowledged, source_type, source_id, metadata)
      VALUES ($1, $2, $3, $4, FALSE, $5, $6, $7)
      RETURNING *
    `,
    [
      parsed.data.type,
      parsed.data.severity,
      parsed.data.title,
      parsed.data.message,
      parsed.data.sourceType ?? null,
      parsed.data.sourceId ?? null,
      parsed.data.metadata ?? null,
    ],
  );

  return res.status(201).json(inserted.rows[0]);
});

router.patch("/:id/ack", requireAuth, async (req, res) => {
  const notificationId = normalizeParamId(req.params.id);
  const updated = await pool.query(
    `
      UPDATE notifications
      SET acknowledged = TRUE, resolved_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [notificationId],
  );
  if (updated.rowCount === 0) {
    return res.status(404).json({ message: "Notification not found" });
  }
  return res.json(updated.rows[0]);
});

router.post("/automation/run", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const schema = z.object({
    lowStockThresholdFallback: z.number().min(0).default(DEFAULT_LOW_STOCK_THRESHOLD),
    pendingOrderMinutes: z.number().int().min(1).default(30),
    shiftReminderHours: z.number().int().min(1).default(12),
    syncLookbackHours: z.number().int().min(1).default(24),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const created: unknown[] = [];

  const lowStockCreated = await syncLowStockNotifications(parsed.data.lowStockThresholdFallback);
  created.push(...lowStockCreated);
  const syncRows = await pool.query(
    `
      SELECT id, client_tx_id, status, error_message
      FROM sync_jobs
      WHERE status IN ('failed', 'conflict')
        AND updated_at >= NOW() - ($1 || ' hours')::interval
      ORDER BY updated_at DESC
      LIMIT 200
    `,
    [parsed.data.syncLookbackHours],
  );
  for (const row of syncRows.rows) {
    const inserted = await insertNotificationIfOpen({
      type: "sync_failure",
      severity: row.status === "conflict" ? "warning" : "critical",
      title: "Sync issue detected",
      message: `Sync job ${row.client_tx_id as string} is ${row.status as string}. ${row.error_message ?? ""}`.trim(),
      dedupeKey: `sync_issue:${row.id as string}:${row.status as string}`,
      sourceType: "sync_job",
      sourceId: row.id as string,
      metadata: { status: row.status },
    });
    if (inserted) created.push(inserted);
  }

  // 3) Pending bills alerts.
  const pendingRows = await pool.query(
    `
      SELECT id, customer_name, status, created_at
      FROM orders
      WHERE status IN ('draft', 'held')
        AND created_at <= NOW() - ($1 || ' minutes')::interval
      ORDER BY created_at ASC
      LIMIT 200
    `,
    [parsed.data.pendingOrderMinutes],
  );
  for (const row of pendingRows.rows) {
    const inserted = await insertNotificationIfOpen({
      type: "pending_bill",
      severity: "info",
      title: "Pending bill reminder",
      message: `Order ${row.id as string} has been ${row.status as string} since ${new Date(row.created_at as string).toISOString()}.`,
      dedupeKey: `pending_order:${row.id as string}`,
      sourceType: "order",
      sourceId: row.id as string,
    });
    if (inserted) created.push(inserted);
  }

  // 4) Day close reminders for open shifts.
  const shiftRows = await pool.query(
    `
      SELECT s.id, s.user_id, s.opened_at, u.full_name
      FROM shifts s
      JOIN users u ON u.id = s.user_id
      WHERE s.closed_at IS NULL
        AND s.opened_at <= NOW() - ($1 || ' hours')::interval
      ORDER BY s.opened_at ASC
      LIMIT 200
    `,
    [parsed.data.shiftReminderHours],
  );
  for (const row of shiftRows.rows) {
    const dateKey = new Date(row.opened_at as string).toISOString().slice(0, 10);
    const inserted = await insertNotificationIfOpen({
      type: "day_close_reminder",
      severity: "warning",
      title: "Day closing reminder",
      message: `Shift for ${row.full_name as string} is still open. Please close the shift.`,
      dedupeKey: `day_close_shift:${row.id as string}:${dateKey}`,
      sourceType: "shift",
      sourceId: row.id as string,
      metadata: { userId: row.user_id, openedAt: row.opened_at },
    });
    if (inserted) created.push(inserted);
  }

  return res.json({
    generated: created.length,
    notifications: created,
  });
});

export default router;
