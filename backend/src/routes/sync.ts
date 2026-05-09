import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { createAuditLog } from "../utils/audit.js";

const router = Router();

const pushSchema = z.object({
  clientTxId: z.string().min(8),
  sourceDeviceId: z.string().max(120).optional(),
  payload: z.record(z.string(), z.any()),
});

function normalizeParamId(id: string | string[]) {
  return Array.isArray(id) ? id[0] : id;
}

async function markJobProcessed(jobId: string, userId: string | null) {
  const updated = await pool.query(
    `
      UPDATE sync_jobs
      SET status = 'processed', processed_at = NOW(), processed_by = $2, error_message = NULL, last_error_code = NULL
      WHERE id = $1
      RETURNING *
    `,
    [jobId, userId],
  );
  return updated.rows[0];
}

router.post("/push", requireAuth, async (req, res) => {
  const parsed = pushSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const existing = await pool.query(`SELECT id, status FROM sync_jobs WHERE client_tx_id = $1`, [parsed.data.clientTxId]);
  if (existing.rowCount && existing.rowCount > 0) {
    return res.status(200).json({
      message: "Duplicate sync payload already received",
      job: existing.rows[0],
    });
  }

  const job = await pool.query(
    `
      INSERT INTO sync_jobs (client_tx_id, source_device_id, payload, status, attempts, max_attempts)
      VALUES ($1, $2, $3, 'received', 0, 5)
      RETURNING *
    `,
    [parsed.data.clientTxId, parsed.data.sourceDeviceId ?? null, parsed.data.payload],
  );

  return res.status(202).json(job.rows[0]);
});

router.post("/process/:id", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const jobId = normalizeParamId(req.params.id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const jobResult = await client.query(`SELECT * FROM sync_jobs WHERE id = $1 FOR UPDATE`, [jobId]);
    if (jobResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Sync job not found" });
    }
    const job = jobResult.rows[0];
    if (job.status === "processed") {
      await client.query("ROLLBACK");
      return res.status(200).json({ message: "Sync job already processed", job });
    }

    await client.query(
      `UPDATE sync_jobs SET status = 'processing', attempts = attempts + 1, updated_at = NOW() WHERE id = $1`,
      [jobId],
    );

    const payload = job.payload as Record<string, unknown>;
    const operation = String(payload.operation ?? payload.type ?? "unknown");

    if (operation === "invoice_post") {
      const invoiceNumber = typeof payload.invoiceNumber === "string" ? payload.invoiceNumber : null;
      if (invoiceNumber) {
        const duplicate = await client.query(`SELECT id FROM invoices WHERE invoice_number = $1`, [invoiceNumber]);
        if (duplicate.rowCount && duplicate.rowCount > 0) {
          await client.query(
            `
              INSERT INTO sync_conflicts (sync_job_id, conflict_type, details, status)
              VALUES ($1, 'duplicate_invoice_number', $2, 'open')
            `,
            [jobId, { invoiceNumber, existingInvoiceId: duplicate.rows[0].id }],
          );
          const conflictJob = await client.query(
            `UPDATE sync_jobs SET status = 'conflict', error_message = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
            [jobId, "Duplicate invoice number conflict"],
          );
          await client.query("COMMIT");
          return res.status(409).json({
            message: "Sync conflict detected",
            job: conflictJob.rows[0],
          });
        }
      }
    }

    if (operation === "payment_post") {
      const invoiceId = typeof payload.invoiceId === "string" ? payload.invoiceId : null;
      if (invoiceId) {
        const invoice = await client.query(`SELECT id, invoice_status FROM invoices WHERE id = $1`, [invoiceId]);
        if (invoice.rowCount === 0 || invoice.rows[0].invoice_status === "voided") {
          await client.query(
            `
              INSERT INTO sync_conflicts (sync_job_id, conflict_type, details, status)
              VALUES ($1, 'invalid_invoice_for_payment', $2, 'open')
            `,
            [jobId, { invoiceId }],
          );
          const conflictJob = await client.query(
            `UPDATE sync_jobs SET status = 'conflict', error_message = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
            [jobId, "Invalid invoice for payment sync"],
          );
          await client.query("COMMIT");
          return res.status(409).json({
            message: "Sync conflict detected",
            job: conflictJob.rows[0],
          });
        }
      }
    }

    const processed = await client.query(
      `
        UPDATE sync_jobs
        SET status = 'processed', processed_at = NOW(), processed_by = $2, error_message = NULL, last_error_code = NULL, updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [jobId, req.user?.id ?? null],
    );

    await createAuditLog({
      client,
      actorUserId: req.user?.id ?? null,
      action: "process_sync_job",
      entity: "sync_jobs",
      entityId: jobId,
      afterData: {
        operation,
        status: "processed",
      },
    });

    await client.query("COMMIT");
    return res.json(processed.rows[0]);
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    await pool.query(
      `
        UPDATE sync_jobs
        SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'retrying' END,
            error_message = $2,
            last_error_code = 'PROCESS_ERROR',
            next_retry_at = NOW() + INTERVAL '2 minutes',
            updated_at = NOW()
        WHERE id = $1
      `,
      [jobId, message],
    );
    return res.status(500).json({ message });
  } finally {
    client.release();
  }
});

router.post("/retry/:id", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const jobId = normalizeParamId(req.params.id);
  const jobResult = await pool.query(`SELECT * FROM sync_jobs WHERE id = $1`, [jobId]);
  if (jobResult.rowCount === 0) {
    return res.status(404).json({ message: "Sync job not found" });
  }

  const job = jobResult.rows[0];
  if (Number(job.attempts) >= Number(job.max_attempts)) {
    return res.status(400).json({ message: "Max retry attempts reached" });
  }

  const updated = await pool.query(
    `
      UPDATE sync_jobs
      SET status = 'received', next_retry_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [jobId],
  );
  return res.json(updated.rows[0]);
});

router.get("/status", requireAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const jobs = await pool.query(
    `
      SELECT
        id, client_tx_id, source_device_id, status, attempts, max_attempts, error_message,
        last_error_code, next_retry_at, processed_at, created_at, updated_at
      FROM sync_jobs
      ORDER BY created_at DESC
      LIMIT $1
    `,
    [limit],
  );
  return res.json(jobs.rows);
});

router.get("/conflicts", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const status = (req.query.status as string | undefined) ?? "open";
  const rows = await pool.query(
    `
      SELECT
        sc.*,
        sj.client_tx_id,
        sj.source_device_id,
        sj.status AS job_status
      FROM sync_conflicts sc
      JOIN sync_jobs sj ON sj.id = sc.sync_job_id
      WHERE sc.status = $1
      ORDER BY sc.created_at DESC
      LIMIT 200
    `,
    [status],
  );
  return res.json(rows.rows);
});

router.post("/conflicts/:id/resolve", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const conflictId = normalizeParamId(req.params.id);
  const schema = z.object({
    action: z.enum(["accept_server", "replay_client", "ignore"]),
    note: z.string().max(500).optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const conflictResult = await client.query(`SELECT * FROM sync_conflicts WHERE id = $1 FOR UPDATE`, [conflictId]);
    if (conflictResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Conflict not found" });
    }
    const conflict = conflictResult.rows[0];
    if (conflict.status !== "open") {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Conflict already resolved/ignored" });
    }

    const conflictStatus = parsed.data.action === "ignore" ? "ignored" : "resolved";
    const resolved = await client.query(
      `
        UPDATE sync_conflicts
        SET
          status = $2,
          resolution_action = $3,
          resolution_note = $4,
          resolved_by = $5,
          resolved_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [conflictId, conflictStatus, parsed.data.action, parsed.data.note ?? null, req.user?.id ?? null],
    );

    if (parsed.data.action === "accept_server" || parsed.data.action === "ignore") {
      await client.query(
        `
          UPDATE sync_jobs
          SET status = 'processed', processed_at = NOW(), processed_by = $2, error_message = NULL, updated_at = NOW()
          WHERE id = $1
        `,
        [conflict.sync_job_id, req.user?.id ?? null],
      );
    } else if (parsed.data.action === "replay_client") {
      await client.query(
        `
          UPDATE sync_jobs
          SET status = 'received', next_retry_at = NOW(), error_message = NULL, updated_at = NOW()
          WHERE id = $1
        `,
        [conflict.sync_job_id],
      );
    }

    await createAuditLog({
      client,
      actorUserId: req.user?.id ?? null,
      action: "resolve_sync_conflict",
      entity: "sync_conflicts",
      entityId: conflictId,
      beforeData: conflict,
      afterData: resolved.rows[0],
    });

    await client.query("COMMIT");
    return res.json(resolved.rows[0]);
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(500).json({ message });
  } finally {
    client.release();
  }
});

router.post("/scheduler/retry-due", requireAuth, requireRole("admin", "manager"), async (_req, res) => {
  const dueJobs = await pool.query(
    `
      SELECT id
      FROM sync_jobs
      WHERE status IN ('retrying', 'failed')
        AND attempts < max_attempts
        AND next_retry_at IS NOT NULL
        AND next_retry_at <= NOW()
      ORDER BY next_retry_at ASC
      LIMIT 200
    `,
  );

  if (dueJobs.rowCount === 0) {
    return res.json({ queued: 0 });
  }

  const ids = dueJobs.rows.map((row) => row.id as string);
  await pool.query(
    `
      UPDATE sync_jobs
      SET status = 'received', updated_at = NOW()
      WHERE id = ANY($1::uuid[])
    `,
    [ids],
  );
  return res.json({ queued: ids.length, ids });
});

router.get("/reconcile/summary", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const schema = z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid query params", errors: parsed.error.flatten() });
  }

  const from = parsed.data.from ? new Date(parsed.data.from) : new Date(new Date().setDate(new Date().getDate() - 1));
  const to = parsed.data.to ? new Date(parsed.data.to) : new Date();

  const [sales, paid, returns, journals] = await Promise.all([
    pool.query(
      `
        SELECT
          COUNT(*)::int AS invoices,
          COALESCE(SUM(total_amount), 0)::numeric(14,2) AS sales_total
        FROM invoices
        WHERE created_at BETWEEN $1 AND $2
          AND invoice_status <> 'voided'
      `,
      [from.toISOString(), to.toISOString()],
    ),
    pool.query(
      `
        SELECT
          COUNT(*)::int AS payments_count,
          COALESCE(SUM(amount), 0)::numeric(14,2) AS paid_total
        FROM payments
        WHERE created_at BETWEEN $1 AND $2
          AND status = 'paid'
      `,
      [from.toISOString(), to.toISOString()],
    ),
    pool.query(
      `
        SELECT
          COUNT(*)::int AS returns_count,
          COALESCE(SUM(total_amount), 0)::numeric(14,2) AS return_total
        FROM sales_returns
        WHERE created_at BETWEEN $1 AND $2
      `,
      [from.toISOString(), to.toISOString()],
    ),
    pool.query(
      `
        SELECT
          COUNT(*)::int AS journal_entries,
          COALESCE(SUM(debit), 0)::numeric(14,2) AS total_debit,
          COALESCE(SUM(credit), 0)::numeric(14,2) AS total_credit
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.journal_entry_id
        WHERE je.created_at BETWEEN $1 AND $2
      `,
      [from.toISOString(), to.toISOString()],
    ),
  ]);

  const debit = Number(journals.rows[0].total_debit);
  const credit = Number(journals.rows[0].total_credit);
  return res.json({
    from: from.toISOString(),
    to: to.toISOString(),
    sales: sales.rows[0],
    payments: paid.rows[0],
    returns: returns.rows[0],
    journals: {
      ...journals.rows[0],
      balanced: Math.abs(debit - credit) < 0.0001,
      delta: Number((debit - credit).toFixed(2)),
    },
  });
});

export default router;
