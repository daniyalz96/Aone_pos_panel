import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { postJournalEntry } from "../services/ledger.js";
import { createAuditLog } from "../utils/audit.js";

const router = Router();

type PaymentMethod = "cash" | "card" | "qr" | "wallet" | "bank";

function settlementAccountByMethod(method: PaymentMethod) {
  return method === "bank" || method === "card" ? "1010" : "1000";
}

async function recomputeInvoicePaymentStatus(invoiceId: string) {
  const invoiceResult = await pool.query(`SELECT total_amount FROM invoices WHERE id = $1`, [invoiceId]);
  if (invoiceResult.rowCount === 0) {
    throw new Error("Invoice not found");
  }
  const total = Number(invoiceResult.rows[0].total_amount);
  const paidResult = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE invoice_id = $1 AND status = 'paid'`,
    [invoiceId],
  );
  const paid = Number(paidResult.rows[0].paid);

  let paymentStatus: "pending" | "partial" | "paid" = "pending";
  if (paid === 0) paymentStatus = "pending";
  else if (paid < total) paymentStatus = "partial";
  else paymentStatus = "paid";

  await pool.query(`UPDATE invoices SET payment_status = $2, updated_at = NOW() WHERE id = $1`, [invoiceId, paymentStatus]);
  return { paid, total, outstanding: Number((total - paid).toFixed(2)), paymentStatus };
}

router.post("/", requireAuth, async (req, res) => {
  const schema = z.object({
    invoiceId: z.string().uuid(),
    method: z.enum(["cash", "card", "qr", "wallet", "bank"]),
    amount: z.number().positive(),
    reference: z.string().max(100).optional(),
    tenderedAmount: z.number().positive().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const invoiceResult = await client.query(`SELECT * FROM invoices WHERE id = $1 FOR UPDATE`, [parsed.data.invoiceId]);
    if (invoiceResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Invoice not found" });
    }

    const invoice = invoiceResult.rows[0];
    if (invoice.invoice_status === "voided") {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Cannot accept payment for voided invoice" });
    }

    const paidResult = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE invoice_id = $1 AND status = 'paid'`,
      [parsed.data.invoiceId],
    );
    const paidAmount = Number(paidResult.rows[0].paid);
    const due = Number(invoice.total_amount) - paidAmount;
    if (parsed.data.amount > due) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Payment exceeds outstanding amount" });
    }

    let changeAmount = 0;
    if (parsed.data.method === "cash") {
      const tendered = parsed.data.tenderedAmount ?? parsed.data.amount;
      if (tendered < parsed.data.amount) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Cash tendered amount cannot be less than payment amount" });
      }
      changeAmount = Number((tendered - parsed.data.amount).toFixed(2));
    }

    const payment = await client.query(
      `
        INSERT INTO payments
          (invoice_id, method, amount, reference, status, created_by, tendered_amount, change_amount)
        VALUES
          ($1, $2, $3, $4, 'paid', $5, $6, $7)
        RETURNING *
      `,
      [
        parsed.data.invoiceId,
        parsed.data.method,
        parsed.data.amount,
        parsed.data.reference ?? null,
        req.user?.id ?? null,
        parsed.data.tenderedAmount ?? null,
        changeAmount,
      ],
    );

    const accountCode = settlementAccountByMethod(parsed.data.method);
    await postJournalEntry({
      client,
      sourceType: "payment",
      sourceId: payment.rows[0].id as string,
      memo: `Payment ${payment.rows[0].id as string}`,
      createdBy: req.user?.id ?? null,
      lines: [
        { accountCode, debit: parsed.data.amount, credit: 0, memo: "Payment received" },
        { accountCode: "1100", debit: 0, credit: parsed.data.amount, memo: "Reduce receivable" },
      ],
    });

    const totalPaidAfter = paidAmount + parsed.data.amount;
    let paymentStatus: "pending" | "partial" | "paid" = "pending";
    if (totalPaidAfter === 0) paymentStatus = "pending";
    else if (totalPaidAfter < Number(invoice.total_amount)) paymentStatus = "partial";
    else paymentStatus = "paid";

    await client.query(`UPDATE invoices SET payment_status = $2, updated_at = NOW() WHERE id = $1`, [
      parsed.data.invoiceId,
      paymentStatus,
    ]);

    await createAuditLog({
      client,
      actorUserId: req.user?.id ?? null,
      action: "create_payment",
      entity: "payments",
      entityId: payment.rows[0].id as string,
      afterData: payment.rows[0],
    });

    await client.query("COMMIT");
    return res.status(201).json({
      payment: payment.rows[0],
      paymentStatus,
      outstanding: Number(invoice.total_amount) - totalPaidAfter,
      changeAmount,
    });
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(500).json({ message });
  } finally {
    client.release();
  }
});

router.post("/collect", requireAuth, async (req, res) => {
  const schema = z.object({
    invoiceId: z.string().uuid(),
    splits: z
      .array(
        z.object({
          method: z.enum(["cash", "card", "qr", "wallet", "bank"]),
          amount: z.number().positive(),
          reference: z.string().max(100).optional(),
          tenderedAmount: z.number().positive().optional(),
        }),
      )
      .min(1),
    markPendingIfUnderpaid: z.boolean().default(true),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const invoiceResult = await client.query(`SELECT * FROM invoices WHERE id = $1 FOR UPDATE`, [parsed.data.invoiceId]);
    if (invoiceResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Invoice not found" });
    }
    const invoice = invoiceResult.rows[0];
    if (invoice.invoice_status === "voided") {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Cannot accept payment for voided invoice" });
    }

    const alreadyPaidResult = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE invoice_id = $1 AND status = 'paid'`,
      [parsed.data.invoiceId],
    );
    const alreadyPaid = Number(alreadyPaidResult.rows[0].paid);
    const due = Number(invoice.total_amount) - alreadyPaid;
    const splitTotal = Number(parsed.data.splits.reduce((sum, split) => sum + split.amount, 0).toFixed(2));
    if (splitTotal > due) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Split payment total exceeds outstanding amount" });
    }

    const cashReceived = parsed.data.splits
      .filter((split) => split.method === "cash")
      .reduce((sum, split) => sum + (split.tenderedAmount ?? split.amount), 0);
    const cashApplied = parsed.data.splits
      .filter((split) => split.method === "cash")
      .reduce((sum, split) => sum + split.amount, 0);
    const changeDue = Number((cashReceived - cashApplied).toFixed(2));
    if (changeDue < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Cash tendered amount is insufficient for cash splits" });
    }

    const finalPaid = alreadyPaid + splitTotal;
    const collectionStatus: "pending" | "partial" | "paid" =
      finalPaid === 0 ? "pending" : finalPaid < Number(invoice.total_amount) ? "partial" : "paid";

    const collection = await client.query(
      `
        INSERT INTO payment_collections
          (invoice_id, total_amount, received_cash, change_due, status, created_by)
        VALUES
          ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `,
      [
        parsed.data.invoiceId,
        splitTotal,
        Number(cashReceived.toFixed(2)),
        changeDue,
        collectionStatus,
        req.user?.id ?? null,
      ],
    );

    const createdPayments: unknown[] = [];
    for (const split of parsed.data.splits) {
      const changeAmount = split.method === "cash" ? Number(((split.tenderedAmount ?? split.amount) - split.amount).toFixed(2)) : 0;
      if (changeAmount < 0) {
        throw new Error("Invalid cash split: tenderedAmount cannot be less than amount");
      }

      const paymentInsert = await client.query(
        `
          INSERT INTO payments
            (invoice_id, method, amount, reference, status, created_by, payment_collection_id, tendered_amount, change_amount)
          VALUES
            ($1, $2, $3, $4, 'paid', $5, $6, $7, $8)
          RETURNING *
        `,
        [
          parsed.data.invoiceId,
          split.method,
          split.amount,
          split.reference ?? null,
          req.user?.id ?? null,
          collection.rows[0].id,
          split.tenderedAmount ?? null,
          changeAmount,
        ],
      );

      await postJournalEntry({
        client,
        sourceType: "payment",
        sourceId: paymentInsert.rows[0].id as string,
        memo: `Payment ${paymentInsert.rows[0].id as string}`,
        createdBy: req.user?.id ?? null,
        lines: [
          { accountCode: settlementAccountByMethod(split.method), debit: split.amount, credit: 0, memo: "Payment received" },
          { accountCode: "1100", debit: 0, credit: split.amount, memo: "Reduce receivable" },
        ],
      });

      createdPayments.push(paymentInsert.rows[0]);
    }

    if (collectionStatus === "partial" && !parsed.data.markPendingIfUnderpaid) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invoice remains underpaid and pending mode was disabled" });
    }

    await client.query(`UPDATE invoices SET payment_status = $2, updated_at = NOW() WHERE id = $1`, [
      parsed.data.invoiceId,
      collectionStatus,
    ]);

    await createAuditLog({
      client,
      actorUserId: req.user?.id ?? null,
      action: "collect_split_payment",
      entity: "payment_collections",
      entityId: collection.rows[0].id as string,
      afterData: collection.rows[0],
    });

    await client.query("COMMIT");
    return res.status(201).json({
      collection: collection.rows[0],
      payments: createdPayments,
      outstanding: Number((Number(invoice.total_amount) - finalPaid).toFixed(2)),
      paymentStatus: collectionStatus,
    });
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ message });
  } finally {
    client.release();
  }
});

router.get("/invoice/:id", requireAuth, async (req, res) => {
  const invoiceId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const invoiceResult = await pool.query(`SELECT * FROM invoices WHERE id = $1`, [invoiceId]);
  if (invoiceResult.rowCount === 0) {
    return res.status(404).json({ message: "Invoice not found" });
  }

  const payments = await pool.query(
    `
      SELECT
        p.*,
        pc.status AS collection_status
      FROM payments p
      LEFT JOIN payment_collections pc ON pc.id = p.payment_collection_id
      WHERE p.invoice_id = $1
      ORDER BY p.created_at ASC
    `,
    [invoiceId],
  );

  const collections = await pool.query(
    `
      SELECT *
      FROM payment_collections
      WHERE invoice_id = $1
      ORDER BY created_at ASC
    `,
    [invoiceId],
  );

  const status = await recomputeInvoicePaymentStatus(invoiceId);
  return res.json({
    invoiceId,
    totals: status,
    collections: collections.rows,
    payments: payments.rows,
  });
});

router.post("/refund", requireAuth, async (req, res) => {
  const schema = z.object({
    invoiceId: z.string().uuid(),
    amount: z.number().positive(),
    reason: z.string().min(3).max(200),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  if (!req.user?.permissions.includes("refund_approve")) {
    return res.status(403).json({ message: "Missing permission: refund_approve" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const invoiceResult = await client.query(`SELECT * FROM invoices WHERE id = $1`, [parsed.data.invoiceId]);
    if (invoiceResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Invoice not found" });
    }
    if (invoiceResult.rows[0].invoice_status === "voided") {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Cannot refund a voided invoice" });
    }

    const refund = await client.query(
      `
        INSERT INTO refunds (invoice_id, amount, reason, created_by)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `,
      [parsed.data.invoiceId, parsed.data.amount, parsed.data.reason, req.user?.id ?? null],
    );

    await postJournalEntry({
      client,
      sourceType: "refund",
      sourceId: refund.rows[0].id as string,
      memo: `Refund ${refund.rows[0].id as string}`,
      createdBy: req.user?.id ?? null,
      lines: [
        { accountCode: "5000", debit: parsed.data.amount, credit: 0, memo: "Sales return" },
        { accountCode: "1000", debit: 0, credit: parsed.data.amount, memo: "Cash out refund" },
      ],
    });

    await createAuditLog({
      client,
      actorUserId: req.user?.id ?? null,
      action: "refund_invoice",
      entity: "refunds",
      entityId: refund.rows[0].id as string,
      afterData: refund.rows[0],
    });

    await client.query("COMMIT");
    return res.status(201).json(refund.rows[0]);
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(500).json({ message });
  } finally {
    client.release();
  }
});

export default router;
