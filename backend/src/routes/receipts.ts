import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.get("/:invoiceId", requireAuth, async (req, res) => {
  const invoiceId = Array.isArray(req.params.invoiceId) ? req.params.invoiceId[0] : req.params.invoiceId;
  const invoiceResult = await pool.query(
    `
      SELECT
        i.*,
        o.customer_name,
        o.created_at AS order_created_at,
        u.full_name AS cashier_name,
        b.name AS branch_name
      FROM invoices i
      JOIN orders o ON o.id = i.order_id
      LEFT JOIN users u ON u.id = i.posted_by
      LEFT JOIN branches b ON b.id = i.branch_id
      WHERE i.id = $1
    `,
    [invoiceId],
  );
  if (invoiceResult.rowCount === 0) {
    return res.status(404).json({ message: "Invoice not found" });
  }

  const items = await pool.query(
    `
      SELECT
        product_name,
        qty,
        unit_price,
        discount_amount,
        tax_rate,
        tax_amount,
        line_total
      FROM invoice_items
      WHERE invoice_id = $1
      ORDER BY created_at ASC
    `,
    [invoiceId],
  );

  const payments = await pool.query(
    `
      SELECT id, method, amount, reference, status, created_at
      FROM payments
      WHERE invoice_id = $1
      ORDER BY created_at ASC
    `,
    [invoiceId],
  );

  const returns = await pool.query(
    `
      SELECT id, total_amount, reason, refund_method, created_at
      FROM sales_returns
      WHERE invoice_id = $1
      ORDER BY created_at ASC
    `,
    [invoiceId],
  );

  const invoice = invoiceResult.rows[0];
  const qrData = `INV:${invoice.invoice_number as string}|TOTAL:${Number(invoice.total_amount).toFixed(2)}|DATE:${new Date(
    invoice.created_at as string,
  )
    .toISOString()
    .slice(0, 10)}`;

  return res.json({
    header: {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      customerName: invoice.customer_name,
      branchName: invoice.branch_name,
      cashierName: invoice.cashier_name,
      createdAt: invoice.created_at,
      qrData,
    },
    totals: {
      subtotal: Number(invoice.subtotal),
      discountTotal: Number(invoice.discount_total),
      taxTotal: Number(invoice.tax_total),
      roundOff: Number(invoice.round_off),
      totalAmount: Number(invoice.total_amount),
      returnTotal: Number(invoice.return_total ?? 0),
      paymentStatus: invoice.payment_status,
      invoiceStatus: invoice.invoice_status,
    },
    items: items.rows.map((row) => ({
      productName: row.product_name,
      qty: Number(row.qty),
      unitPrice: Number(row.unit_price),
      discountAmount: Number(row.discount_amount),
      taxRate: Number(row.tax_rate),
      taxAmount: Number(row.tax_amount),
      lineTotal: Number(row.line_total),
    })),
    payments: payments.rows.map((row) => ({
      id: row.id,
      method: row.method,
      amount: Number(row.amount),
      reference: row.reference,
      status: row.status,
      createdAt: row.created_at,
    })),
    returns: returns.rows.map((row) => ({
      id: row.id,
      totalAmount: Number(row.total_amount),
      reason: row.reason,
      refundMethod: row.refund_method,
      createdAt: row.created_at,
    })),
  });
});

router.post("/:invoiceId/send", requireAuth, async (req, res) => {
  const invoiceId = Array.isArray(req.params.invoiceId) ? req.params.invoiceId[0] : req.params.invoiceId;
  const schema = z.object({
    channel: z.enum(["print", "email", "whatsapp"]),
    destination: z.string().max(200).optional(),
    payload: z.record(z.string(), z.any()).optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const invoiceResult = await pool.query(`SELECT id, invoice_number FROM invoices WHERE id = $1`, [invoiceId]);
  if (invoiceResult.rowCount === 0) {
    return res.status(404).json({ message: "Invoice not found" });
  }

  const dispatch = await pool.query(
    `
      INSERT INTO receipt_dispatches
        (invoice_id, channel, destination, status, payload, sent_by, sent_at)
      VALUES
        ($1, $2, $3, 'sent', $4, $5, NOW())
      RETURNING *
    `,
    [
      invoiceId,
      parsed.data.channel,
      parsed.data.destination ?? null,
      parsed.data.payload ?? null,
      req.user?.id ?? null,
    ],
  );

  return res.status(201).json({
    message: "Receipt dispatch logged",
    dispatch: dispatch.rows[0],
  });
});

router.get("/:invoiceId/dispatches", requireAuth, async (req, res) => {
  const invoiceId = Array.isArray(req.params.invoiceId) ? req.params.invoiceId[0] : req.params.invoiceId;
  const dispatches = await pool.query(
    `
      SELECT *
      FROM receipt_dispatches
      WHERE invoice_id = $1
      ORDER BY created_at DESC
    `,
    [invoiceId],
  );
  return res.json(dispatches.rows);
});

export default router;
