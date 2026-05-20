import { Router, type Request } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { postJournalEntry } from "../services/ledger.js";
import { createAuditLog } from "../utils/audit.js";

const router = Router();

function userCanRefund(user: Request["user"]): boolean {
  if (!user) return false;
  if (user.permissions.includes("refund_approve")) return true;
  return (user.roles ?? []).some((r) => r === "admin" || r === "manager");
}

router.get("/invoice/:invoiceId/detail", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const invoiceId = Array.isArray(req.params.invoiceId) ? req.params.invoiceId[0] : req.params.invoiceId;

  const invoiceResult = await pool.query(
    `
      SELECT
        i.id,
        i.invoice_number,
        i.invoice_status,
        i.payment_status,
        i.total_amount,
        i.return_total,
        i.created_at,
        o.customer_name,
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

  const invoice = invoiceResult.rows[0];
  if (invoice.invoice_status === "voided") {
    return res.status(409).json({ message: "Cannot return items on a voided invoice" });
  }
  if (invoice.invoice_status === "returned") {
    return res.status(409).json({ message: "This invoice is fully returned" });
  }

  const lineRows = await pool.query(
    `
      SELECT
        ii.id,
        ii.product_id,
        ii.product_name,
        p.sku,
        ii.qty,
        ii.unit_price,
        ii.line_total,
        COALESCE((
          SELECT SUM(sri.qty)
          FROM sales_return_items sri
          WHERE sri.invoice_item_id = ii.id
        ), 0)::numeric(14,3) AS qty_returned
      FROM invoice_items ii
      LEFT JOIN products p ON p.id = ii.product_id
      WHERE ii.invoice_id = $1
      ORDER BY ii.created_at ASC
    `,
    [invoiceId],
  );

  const lines = lineRows.rows.map((row) => {
    const soldQty = Number(row.qty);
    const alreadyReturned = Number(row.qty_returned);
    const maxReturn = Math.max(0, Number((soldQty - alreadyReturned).toFixed(3)));
    return {
      id: row.id,
      productId: row.product_id,
      productName: row.product_name,
      sku: row.sku ?? "",
      qty: soldQty,
      qtyReturned: alreadyReturned,
      maxReturn,
      unitPrice: Number(row.unit_price),
      lineTotal: Number(row.line_total),
    };
  });

  return res.json({
    id: invoice.id,
    invoiceNumber: invoice.invoice_number,
    invoiceStatus: invoice.invoice_status,
    paymentStatus: invoice.payment_status,
    totalAmount: Number(invoice.total_amount),
    returnTotal: Number(invoice.return_total ?? 0),
    createdAt: invoice.created_at,
    customerName: invoice.customer_name,
    cashierName: invoice.cashier_name,
    branchName: invoice.branch_name,
    lines,
  });
});

router.post("/", requireAuth, async (req, res) => {
  const schema = z.object({
    invoiceId: z.string().uuid(),
    reason: z.string().min(3).max(200),
    refundMethod: z.enum(["cash", "bank", "card", "wallet", "qr"]).default("cash"),
    items: z
      .array(
        z.object({
          invoiceItemId: z.string().uuid(),
          qty: z.number().positive(),
        }),
      )
      .min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  if (!userCanRefund(req.user)) {
    return res.status(403).json({ message: "Missing permission to process sale returns" });
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
      return res.status(409).json({ message: "Cannot return items on a voided invoice" });
    }

    let subtotal = 0;
    let taxTotal = 0;
    const computedItems: Array<{
      invoiceItemId: string;
      qty: number;
      preTaxAmount: number;
      taxAmount: number;
      lineTotal: number;
      productId: string;
    }> = [];

    for (const reqItem of parsed.data.items) {
      const line = await client.query(`SELECT * FROM invoice_items WHERE id = $1 AND invoice_id = $2`, [
        reqItem.invoiceItemId,
        parsed.data.invoiceId,
      ]);
      if (line.rowCount === 0) throw new Error(`Invoice item not found: ${reqItem.invoiceItemId}`);
      const item = line.rows[0];

      const returnedQtyResult = await client.query(
        `
          SELECT COALESCE(SUM(sri.qty), 0) AS returned_qty
          FROM sales_return_items sri
          WHERE sri.invoice_item_id = $1
        `,
        [reqItem.invoiceItemId],
      );
      const alreadyReturnedQty = Number(returnedQtyResult.rows[0].returned_qty);
      const soldQty = Number(item.qty);
      const remainingQty = soldQty - alreadyReturnedQty;
      if (reqItem.qty > remainingQty) {
        throw new Error(`Return qty exceeds remaining qty for item ${reqItem.invoiceItemId}`);
      }

      const ratio = reqItem.qty / soldQty;
      const preTaxAmount = Number((Number(item.pre_tax_amount) * ratio).toFixed(2));
      const taxAmount = Number((Number(item.tax_amount) * ratio).toFixed(2));
      const lineTotal = Number((preTaxAmount + taxAmount).toFixed(2));

      subtotal += preTaxAmount;
      taxTotal += taxAmount;
      computedItems.push({
        invoiceItemId: reqItem.invoiceItemId,
        qty: reqItem.qty,
        preTaxAmount,
        taxAmount,
        lineTotal,
        productId: item.product_id as string,
      });
    }

    const returnTotal = Number((subtotal + taxTotal).toFixed(2));
    const salesReturn = await client.query(
      `
        INSERT INTO sales_returns
          (invoice_id, reason, refund_method, subtotal, tax_total, total_amount, created_by)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `,
      [
        parsed.data.invoiceId,
        parsed.data.reason,
        parsed.data.refundMethod,
        Number(subtotal.toFixed(2)),
        Number(taxTotal.toFixed(2)),
        returnTotal,
        req.user?.id ?? null,
      ],
    );

    for (const row of computedItems) {
      await client.query(
        `
          INSERT INTO sales_return_items
            (sales_return_id, invoice_item_id, qty, pre_tax_amount, tax_amount, line_total)
          VALUES
            ($1, $2, $3, $4, $5, $6)
        `,
        [salesReturn.rows[0].id, row.invoiceItemId, row.qty, row.preTaxAmount, row.taxAmount, row.lineTotal],
      );

      await client.query(
        `INSERT INTO inventory_balances (product_id, qty_on_hand) VALUES ($1, 0) ON CONFLICT (product_id) DO NOTHING`,
        [row.productId],
      );
      await client.query(
        `UPDATE inventory_balances SET qty_on_hand = qty_on_hand + $2, updated_at = NOW() WHERE product_id = $1`,
        [row.productId, row.qty],
      );
      await client.query(
        `
          INSERT INTO inventory_movements
            (product_id, movement_type, qty, reference_type, reference_id, reason, created_by)
          VALUES
            ($1, 'return_in', $2, 'sales_return', $3, $4, $5)
        `,
        [row.productId, row.qty, salesReturn.rows[0].id, parsed.data.reason, req.user?.id ?? null],
      );
    }

    const updatedInvoiceResult = await client.query(
      `
        UPDATE invoices
        SET
          return_total = return_total + $2,
          invoice_status = CASE
            WHEN (return_total + $2) >= total_amount THEN 'returned'
            ELSE 'partially_returned'
          END,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [parsed.data.invoiceId, returnTotal],
    );

    const cashLikeMethod = parsed.data.refundMethod === "bank" || parsed.data.refundMethod === "card" ? "1010" : "1000";
    await postJournalEntry({
      client,
      sourceType: "sales_return",
      sourceId: salesReturn.rows[0].id as string,
      memo: `Sales return ${salesReturn.rows[0].id as string}`,
      createdBy: req.user?.id ?? null,
      lines: [
        { accountCode: "5000", debit: Number(subtotal.toFixed(2)), credit: 0, memo: "Sales return" },
        { accountCode: "2100", debit: Number(taxTotal.toFixed(2)), credit: 0, memo: "Tax adjustment" },
        { accountCode: cashLikeMethod, debit: 0, credit: returnTotal, memo: "Refund payout" },
      ],
    });

    await createAuditLog({
      client,
      actorUserId: req.user?.id ?? null,
      action: "create_sales_return",
      entity: "sales_returns",
      entityId: salesReturn.rows[0].id as string,
      afterData: salesReturn.rows[0],
    });

    await client.query("COMMIT");
    return res.status(201).json({
      salesReturn: salesReturn.rows[0],
      invoice: updatedInvoiceResult.rows[0],
    });
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ message });
  } finally {
    client.release();
  }
});

router.get("/invoice/:invoiceId", requireAuth, async (req, res) => {
  const invoiceId = Array.isArray(req.params.invoiceId) ? req.params.invoiceId[0] : req.params.invoiceId;
  const rows = await pool.query(
    `
      SELECT sr.*, u.full_name AS created_by_name
      FROM sales_returns sr
      LEFT JOIN users u ON u.id = sr.created_by
      WHERE sr.invoice_id = $1
      ORDER BY sr.created_at DESC
    `,
    [invoiceId],
  );
  return res.json(rows.rows);
});

export default router;
