import type { PoolClient } from "pg";
import { postJournalEntry } from "./ledger.js";

export async function executeOrderCancel(params: {
  client: PoolClient;
  orderId: string;
  reason: string;
  actorUserId: string | null;
}) {
  const { client, orderId, reason, actorUserId } = params;
  const orderResult = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
  if (orderResult.rowCount === 0) {
    throw new Error("Order not found");
  }

  const order = orderResult.rows[0];
  if (order.status === "posted") {
    throw new Error("Posted order cannot be canceled");
  }
  if (order.status === "canceled") {
    return order;
  }

  const updated = await client.query(
    `
      UPDATE orders
      SET status = 'canceled', canceled_reason = $2, canceled_by = $3, canceled_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [orderId, reason, actorUserId],
  );

  return updated.rows[0];
}

export async function executeInvoiceVoid(params: {
  client: PoolClient;
  invoiceId: string;
  reason: string;
  actorUserId: string | null;
}) {
  const { client, invoiceId, reason, actorUserId } = params;
  const invoiceResult = await client.query(`SELECT * FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId]);
  if (invoiceResult.rowCount === 0) {
    throw new Error("Invoice not found");
  }

  const invoice = invoiceResult.rows[0];
  if (invoice.invoice_status === "voided") {
    return invoice;
  }

  const paidResult = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE invoice_id = $1 AND status = 'paid'`,
    [invoiceId],
  );
  const paid = Number(paidResult.rows[0].paid);
  if (paid > 0) {
    throw new Error("Cannot void paid invoice. Process return/refund first.");
  }

  const itemRows = await client.query(`SELECT * FROM invoice_items WHERE invoice_id = $1`, [invoiceId]);
  for (const row of itemRows.rows) {
    await client.query(
      `INSERT INTO inventory_balances (product_id, qty_on_hand) VALUES ($1, 0) ON CONFLICT (product_id) DO NOTHING`,
      [row.product_id],
    );
    await client.query(
      `
        UPDATE inventory_balances
        SET qty_on_hand = qty_on_hand + $2, updated_at = NOW()
        WHERE product_id = $1
      `,
      [row.product_id, row.qty],
    );
    await client.query(
      `
        INSERT INTO inventory_movements
          (product_id, movement_type, qty, reference_type, reference_id, reason, created_by)
        VALUES
          ($1, 'return_in', $2, 'invoice', $3, $4, $5)
      `,
      [row.product_id, row.qty, invoiceId, `Invoice void: ${reason}`, actorUserId],
    );
  }

  const updatedInvoice = await client.query(
    `
      UPDATE invoices
      SET
        invoice_status = 'voided',
        void_reason = $2,
        voided_by = $3,
        voided_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [invoiceId, reason, actorUserId],
  );

  await postJournalEntry({
    client,
    sourceType: "invoice_void",
    sourceId: invoiceId,
    memo: `Invoice void ${invoice.invoice_number as string}`,
    createdBy: actorUserId,
    lines: [
      { accountCode: "4000", debit: Number(invoice.total_amount) - Number(invoice.tax_total), credit: 0, memo: "Reverse revenue" },
      { accountCode: "2100", debit: Number(invoice.tax_total), credit: 0, memo: "Reverse tax payable" },
      { accountCode: "1100", debit: 0, credit: Number(invoice.total_amount), memo: "Reverse receivable" },
    ],
  });

  await client.query(`UPDATE orders SET status = 'canceled', updated_at = NOW() WHERE id = $1`, [invoice.order_id]);
  return updatedInvoice.rows[0];
}
