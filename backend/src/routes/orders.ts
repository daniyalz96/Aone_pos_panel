import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, requirePermission, requireRole } from "../middleware/auth.js";
import { createAuditLog } from "../utils/audit.js";
import { postJournalEntry } from "../services/ledger.js";
import { notifyLowStockForProduct } from "../services/lowStockAlerts.js";
import { executeOrderCancel } from "../services/voiding.js";

async function lowStockProductIdsForOrder(client: PoolClient, orderId: string): Promise<string[]> {
  const rows = await client.query(`SELECT DISTINCT product_id FROM order_items WHERE order_id = $1`, [orderId]);
  return rows.rows.map((row) => row.product_id as string);
}

function queueLowStockNotify(productIds: string[]) {
  for (const productId of new Set(productIds)) {
    void notifyLowStockForProduct(productId).catch(() => undefined);
  }
}

function settlementAccountByMethod(method: "cash" | "card" | "qr" | "wallet" | "bank") {
  return method === "bank" || method === "card" ? "1010" : "1000";
}

type PostInvoiceOptions = {
  client: PoolClient;
  orderId: string;
  userId: string | null;
  /** If set, used as invoice `branch_id`; otherwise latest open shift for `userId` is used */
  branchId?: string | null;
  invoiceNumber?: string;
};

/** Call inside an open transaction. Updates order to posted, creates invoice, stock moves, GL. */
export async function executePostOrderAsInvoice(opts: PostInvoiceOptions) {
  const { client, orderId, userId } = opts;
  const invoiceNumber = opts.invoiceNumber ?? `INV-${Date.now()}`;

  const orderLock = await client.query(`SELECT status FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
  if (orderLock.rowCount === 0) throw new Error("Order not found");
  if (orderLock.rows[0].status === "posted") throw new Error("Order already posted");
  if (orderLock.rows[0].status === "canceled") throw new Error("Canceled order cannot be posted");

  let summary;
  try {
    summary = await getOrderSummary(client, orderId);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid order state";
    throw new Error(message);
  }

  const { items, subtotal, discountTotal, taxTotal, total } = summary;

  let branchId: string | null = null;
  if (opts.branchId !== undefined && opts.branchId !== null) {
    branchId = opts.branchId;
  } else {
    const branchResult = await client.query(
      `
        SELECT branch_id
        FROM shifts
        WHERE user_id = $1
        ORDER BY opened_at DESC
        LIMIT 1
      `,
      [userId],
    );
    branchId = branchResult.rowCount ? (branchResult.rows[0].branch_id as string | null) : null;
  }

  const invoice = await client.query(
    `
      INSERT INTO invoices
        (
          order_id, invoice_number, subtotal, discount_total, tax_total,
          total_amount, round_off, payment_status, posted_by, invoice_status, branch_id
        )
      VALUES
        ($1, $2, $3, $4, $5, $6, 0, 'pending', $7, 'posted', $8)
      RETURNING *
    `,
    [orderId, invoiceNumber, subtotal, discountTotal, taxTotal, total, userId, branchId],
  );

  for (const row of items) {
    await client.query(
      `INSERT INTO inventory_balances (product_id, qty_on_hand) VALUES ($1, 0) ON CONFLICT (product_id) DO NOTHING`,
      [row.product_id],
    );
    const balanceResult = await client.query(`SELECT qty_on_hand FROM inventory_balances WHERE product_id = $1 FOR UPDATE`, [
      row.product_id,
    ]);
    const currentQty = Number(balanceResult.rows[0].qty_on_hand);
    const nextQty = currentQty - Number(row.qty);
    await client.query(`UPDATE inventory_balances SET qty_on_hand = $2, updated_at = NOW() WHERE product_id = $1`, [
      row.product_id,
      nextQty,
    ]);
    await client.query(
      `
        INSERT INTO inventory_movements
          (product_id, movement_type, qty, reference_type, reference_id, reason, created_by)
        VALUES
          ($1, 'sale_out', $2, 'order', $3, 'Auto deduction on invoice post', $4)
      `,
      [row.product_id, row.qty, orderId, userId],
    );

    await client.query(
      `
        INSERT INTO invoice_items
          (
            invoice_id, product_id, product_name, qty, unit_price, discount_type,
            discount_amount, tax_rate, tax_inclusive, pre_tax_amount, tax_amount, line_total
          )
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `,
      [
        invoice.rows[0].id,
        row.product_id,
        row.product_name,
        row.qty,
        row.unit_price,
        row.discount_type,
        row.discount_amount,
        row.tax_rate,
        row.tax_inclusive,
        row.pre_tax_amount,
        row.tax_amount,
        row.line_total,
      ],
    );
  }

  await client.query(`UPDATE orders SET status = 'posted', updated_at = NOW() WHERE id = $1`, [orderId]);

  await postJournalEntry({
    client,
    sourceType: "invoice",
    sourceId: invoice.rows[0].id as string,
    memo: `Invoice posted ${invoice.rows[0].invoice_number as string}`,
    createdBy: userId,
    lines: [
      { accountCode: "1100", debit: total, credit: 0, memo: "Customer receivable" },
      { accountCode: "4000", debit: 0, credit: total - taxTotal, memo: "Sales revenue" },
      { accountCode: "2100", debit: 0, credit: taxTotal, memo: "Tax payable" },
    ],
  });

  await createAuditLog({
    client,
    actorUserId: userId,
    action: "post_invoice",
    entity: "invoices",
    entityId: invoice.rows[0].id as string,
    afterData: invoice.rows[0],
  });

  return invoice.rows[0] as Record<string, unknown>;
}

const router = Router();

function normalizeParamId(id: string | string[]) {
  return Array.isArray(id) ? id[0] : id;
}

function calculateLineAmounts(params: {
  qty: number;
  unitPrice: number;
  discountType: "amount" | "percent";
  discountValue: number;
  taxRate: number;
  taxInclusive: boolean;
}) {
  const gross = params.qty * params.unitPrice;
  const discountAmount =
    params.discountType === "percent" ? (gross * params.discountValue) / 100 : params.discountValue;
  const cappedDiscount = Math.min(Math.max(discountAmount, 0), gross);
  const discountedBase = gross - cappedDiscount;

  let preTaxAmount = discountedBase;
  let taxAmount = 0;
  let lineTotal = discountedBase;

  if (params.taxInclusive) {
    const divisor = 1 + params.taxRate / 100;
    preTaxAmount = divisor > 0 ? discountedBase / divisor : discountedBase;
    taxAmount = discountedBase - preTaxAmount;
    lineTotal = discountedBase;
  } else {
    taxAmount = (discountedBase * params.taxRate) / 100;
    preTaxAmount = discountedBase;
    lineTotal = discountedBase + taxAmount;
  }

  return {
    discountAmount: Number(cappedDiscount.toFixed(2)),
    preTaxAmount: Number(preTaxAmount.toFixed(2)),
    taxAmount: Number(taxAmount.toFixed(2)),
    lineTotal: Number(lineTotal.toFixed(2)),
  };
}

async function getOrderSummary(client: PoolClient, orderId: string) {
  const orderResult = await client.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
  if (orderResult.rowCount === 0) throw new Error("Order not found");

  const itemsResult = await client.query(`SELECT * FROM order_items WHERE order_id = $1`, [orderId]);
  if (itemsResult.rowCount === 0) throw new Error("Order has no items");

  const subtotal = itemsResult.rows.reduce(
    (sum: number, row: { qty: string; unit_price: string }) => sum + Number(row.qty) * Number(row.unit_price),
    0,
  );
  const preTaxSubtotal = itemsResult.rows.reduce(
    (sum: number, row: { pre_tax_amount: string }) => sum + Number(row.pre_tax_amount),
    0,
  );
  const itemDiscountTotal = itemsResult.rows.reduce(
    (sum: number, row: { discount_amount: string }) => sum + Number(row.discount_amount),
    0,
  );
  const taxBeforeBillDiscount = itemsResult.rows.reduce(
    (sum: number, row: { tax_amount: string }) => sum + Number(row.tax_amount),
    0,
  );

  const order = orderResult.rows[0];
  const billDiscountValue = Number(order.bill_discount_value ?? 0);
  const billDiscountType = order.bill_discount_type as "amount" | "percent";
  const billDiscountAmount =
    billDiscountType === "percent" ? (preTaxSubtotal * billDiscountValue) / 100 : billDiscountValue;
  const boundedBillDiscount = Math.min(Math.max(billDiscountAmount, 0), preTaxSubtotal);

  const ratio = preTaxSubtotal === 0 ? 0 : (preTaxSubtotal - boundedBillDiscount) / preTaxSubtotal;
  const taxTotal = Number((taxBeforeBillDiscount * ratio).toFixed(2));
  const discountTotal = Number((itemDiscountTotal + boundedBillDiscount).toFixed(2));
  const netPreTax = Number((preTaxSubtotal - boundedBillDiscount).toFixed(2));
  const total = Number((netPreTax + taxTotal).toFixed(2));

  return {
    order,
    items: itemsResult.rows,
    subtotal: Number(subtotal.toFixed(2)),
    discountTotal,
    taxTotal,
    total,
  };
}

router.post("/", requireAuth, async (req, res) => {
  const schema = z.object({
    customerName: z.string().max(120).optional(),
    status: z.enum(["draft", "held"]).default("draft"),
    taxInclusive: z.boolean().default(false),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });

  const order = await pool.query(
    `
      INSERT INTO orders (customer_name, status, created_by, tax_inclusive)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `,
    [parsed.data.customerName ?? null, parsed.data.status, req.user?.id ?? null, parsed.data.taxInclusive],
  );
  return res.status(201).json(order.rows[0]);
});

router.post("/manual-sale", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const manualSchema = z.object({
    customerName: z.string().max(120).optional(),
    taxInclusive: z.boolean().default(false),
    branchId: z.string().uuid().optional(),
    lines: z
      .array(
        z.object({
          productId: z.string().uuid(),
          qty: z.number().positive(),
          priceOverride: z.number().positive().optional(),
          discountType: z.enum(["amount", "percent"]).default("amount"),
          discountValue: z.number().min(0).default(0),
          taxInclusive: z.boolean().optional(),
        }),
      )
      .min(1),
    recordPayment: z
      .object({
        method: z.enum(["cash", "card", "qr", "wallet", "bank"]),
        amount: z.number().positive().optional(),
        tenderedAmount: z.number().positive().optional(),
        reference: z.string().max(100).optional(),
      })
      .optional(),
  });
  const parsed = manualSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const orderInsert = await client.query(
      `
        INSERT INTO orders (customer_name, status, created_by, tax_inclusive)
        VALUES ($1, 'draft', $2, $3)
        RETURNING *
      `,
      [parsed.data.customerName ?? null, req.user?.id ?? null, parsed.data.taxInclusive],
    );
    const orderId = orderInsert.rows[0].id as string;

    const orderTaxInclusive = parsed.data.taxInclusive;
    const orderMeta = await client.query(`SELECT id, status, tax_inclusive FROM orders WHERE id = $1`, [orderId]);
    const orderRow = orderMeta.rows[0];

    for (const line of parsed.data.lines) {
      const product = await client.query(
        `SELECT id, name, sale_price, tax_rate, is_active FROM products WHERE id = $1`,
        [line.productId],
      );
      if (product.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: `Product not found: ${line.productId}` });
      }
      if (!product.rows[0].is_active) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          message: `Product is inactive (cannot sell): ${line.productId}. Activate it under Products or pick an active item.`,
        });
      }

      if (typeof line.priceOverride === "number" && !req.user?.permissions.includes("price_override")) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "Missing permission: price_override" });
      }
      if (line.discountValue > 0 && !req.user?.permissions.includes("discount_override")) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "Missing permission: discount_override" });
      }

      const unitPrice = line.priceOverride ?? Number(product.rows[0].sale_price);
      const taxRate = Number(product.rows[0].tax_rate);
      const taxInclusive = line.taxInclusive ?? Boolean(orderRow.tax_inclusive);
      const computed = calculateLineAmounts({
        qty: line.qty,
        unitPrice,
        discountType: line.discountType,
        discountValue: line.discountValue,
        taxRate,
        taxInclusive,
      });

      await client.query(
        `
          INSERT INTO order_items
            (
              order_id, product_id, product_name, qty, unit_price, discount_type,
              discount_amount, tax_rate, tax_inclusive, pre_tax_amount, tax_amount, line_total
            )
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `,
        [
          orderId,
          line.productId,
          product.rows[0].name,
          line.qty,
          unitPrice,
          line.discountType,
          computed.discountAmount,
          taxRate,
          taxInclusive,
          computed.preTaxAmount,
          computed.taxAmount,
          computed.lineTotal,
        ],
      );
    }

    const invoiceRow = await executePostOrderAsInvoice({
      client,
      orderId,
      userId: req.user?.id ?? null,
      branchId: parsed.data.branchId ?? undefined,
      invoiceNumber: `INV-${Date.now()}`,
    });

    const invoiceId = invoiceRow.id as string;

    if (parsed.data.recordPayment) {
      const invoiceTotal = Number(invoiceRow.total_amount);
      const amount = parsed.data.recordPayment.amount ?? invoiceTotal;
      if (amount > invoiceTotal + 0.005) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Payment amount exceeds invoice total" });
      }

      let changeAmount = 0;
      let tenderedStored: number | null = null;
      if (parsed.data.recordPayment.method === "cash") {
        const tendered = parsed.data.recordPayment.tenderedAmount ?? amount;
        if (tendered < amount) {
          await client.query("ROLLBACK");
          return res.status(400).json({ message: "Cash tendered cannot be less than payment amount" });
        }
        changeAmount = Number((tendered - amount).toFixed(2));
        tenderedStored = tendered;
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
          invoiceId,
          parsed.data.recordPayment.method,
          amount,
          parsed.data.recordPayment.reference ?? null,
          req.user?.id ?? null,
          tenderedStored,
          changeAmount,
        ],
      );

      const accountCode = settlementAccountByMethod(parsed.data.recordPayment.method);
      await postJournalEntry({
        client,
        sourceType: "payment",
        sourceId: payment.rows[0].id as string,
        memo: `Payment ${payment.rows[0].id as string}`,
        createdBy: req.user?.id ?? null,
        lines: [
          { accountCode, debit: amount, credit: 0, memo: "Payment received" },
          { accountCode: "1100", debit: 0, credit: amount, memo: "Reduce receivable" },
        ],
      });

      const paidAfter = amount;
      let paymentStatus: "pending" | "partial" | "paid" = "pending";
      if (paidAfter === 0) paymentStatus = "pending";
      else if (paidAfter < invoiceTotal - 1e-6) paymentStatus = "partial";
      else paymentStatus = "paid";

      await client.query(`UPDATE invoices SET payment_status = $2, updated_at = NOW() WHERE id = $1`, [
        invoiceId,
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
    }

    await createAuditLog({
      client,
      actorUserId: req.user?.id ?? null,
      action: "manual_sale_invoice",
      entity: "invoices",
      entityId: invoiceId,
      afterData: { orderId, source: "reports_manual_sale" },
    });

    const stockProductIds = await lowStockProductIdsForOrder(client, orderId);
    await client.query("COMMIT");
    queueLowStockNotify(stockProductIds);
    const refreshedInv = await pool.query(`SELECT * FROM invoices WHERE id = $1`, [invoiceId]);
    return res.status(201).json({
      invoice: refreshedInv.rows[0],
      orderId,
    });
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    if (message === "Order not found") return res.status(404).json({ message });
    if (message === "Order already posted") return res.status(409).json({ message });
    if (message === "Canceled order cannot be posted") return res.status(409).json({ message });
    if (message.includes("Order has no items")) return res.status(400).json({ message });
    if (message.includes("Insufficient stock")) return res.status(400).json({ message });
    return res.status(500).json({ message });
  } finally {
    client.release();
  }
});

router.post("/:id/items", requireAuth, async (req, res) => {
  const orderId = normalizeParamId(req.params.id);
  const schema = z.object({
    productId: z.string().uuid(),
    qty: z.number().positive(),
    priceOverride: z.number().positive().optional(),
    discountType: z.enum(["amount", "percent"]).default("amount"),
    discountValue: z.number().min(0).default(0),
    taxInclusive: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const order = await client.query(`SELECT id, status, tax_inclusive FROM orders WHERE id = $1`, [orderId]);
    if (order.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Order not found" });
    }
    if (order.rows[0].status === "posted") {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Order already posted" });
    }

    const product = await client.query(
      `SELECT id, name, sale_price, tax_rate FROM products WHERE id = $1 AND is_active = TRUE`,
      [parsed.data.productId],
    );
    if (product.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Product not found" });
    }

    if (typeof parsed.data.priceOverride === "number" && !req.user?.permissions.includes("price_override")) {
      await client.query("ROLLBACK");
      return res.status(403).json({ message: "Missing permission: price_override" });
    }
    if (parsed.data.discountValue > 0 && !req.user?.permissions.includes("discount_override")) {
      await client.query("ROLLBACK");
      return res.status(403).json({ message: "Missing permission: discount_override" });
    }

    const unitPrice = parsed.data.priceOverride ?? Number(product.rows[0].sale_price);
    const taxRate = Number(product.rows[0].tax_rate);
    const taxInclusive = parsed.data.taxInclusive ?? Boolean(order.rows[0].tax_inclusive);
    const computed = calculateLineAmounts({
      qty: parsed.data.qty,
      unitPrice,
      discountType: parsed.data.discountType,
      discountValue: parsed.data.discountValue,
      taxRate,
      taxInclusive,
    });

    const inserted = await client.query(
      `
        INSERT INTO order_items
          (
            order_id, product_id, product_name, qty, unit_price, discount_type,
            discount_amount, tax_rate, tax_inclusive, pre_tax_amount, tax_amount, line_total
          )
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *
      `,
      [
        orderId,
        parsed.data.productId,
        product.rows[0].name,
        parsed.data.qty,
        unitPrice,
        parsed.data.discountType,
        computed.discountAmount,
        taxRate,
        taxInclusive,
        computed.preTaxAmount,
        computed.taxAmount,
        computed.lineTotal,
      ],
    );

    await createAuditLog({
      client,
      actorUserId: req.user?.id ?? null,
      action: "add_order_item",
      entity: "order_items",
      entityId: inserted.rows[0].id as string,
      afterData: inserted.rows[0],
    });

    await client.query("COMMIT");
    return res.status(201).json(inserted.rows[0]);
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(500).json({ message });
  } finally {
    client.release();
  }
});

router.patch("/:id/bill-discount", requireAuth, requirePermission("discount_override"), async (req, res) => {
  const orderId = normalizeParamId(req.params.id);
  const schema = z.object({
    type: z.enum(["amount", "percent"]),
    value: z.number().min(0),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });

  const updated = await pool.query(
    `
      UPDATE orders
      SET bill_discount_type = $2, bill_discount_value = $3, updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [orderId, parsed.data.type, parsed.data.value],
  );
  if (updated.rowCount === 0) return res.status(404).json({ message: "Order not found" });
  return res.json(updated.rows[0]);
});

router.post("/:id/hold", requireAuth, async (req, res) => {
  const orderId = normalizeParamId(req.params.id);
  const held = await pool.query(`UPDATE orders SET status = 'held', updated_at = NOW() WHERE id = $1 RETURNING *`, [
    orderId,
  ]);
  if (held.rowCount === 0) return res.status(404).json({ message: "Order not found" });
  return res.json(held.rows[0]);
});

router.post("/:id/resume", requireAuth, async (req, res) => {
  const orderId = normalizeParamId(req.params.id);
  const resumed = await pool.query(
    `UPDATE orders SET status = 'draft', updated_at = NOW() WHERE id = $1 RETURNING *`,
    [orderId],
  );
  if (resumed.rowCount === 0) return res.status(404).json({ message: "Order not found" });
  return res.json(resumed.rows[0]);
});

router.post("/:id/post", requireAuth, async (req, res) => {
  const orderId = normalizeParamId(req.params.id);
  const schema = z.object({});
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const invoiceRow = await executePostOrderAsInvoice({
      client,
      orderId,
      userId: req.user?.id ?? null,
    });
    const stockProductIds = await lowStockProductIdsForOrder(client, orderId);
    await client.query("COMMIT");
    queueLowStockNotify(stockProductIds);
    return res.status(201).json(invoiceRow);
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    if (message === "Order not found") return res.status(404).json({ message });
    if (message === "Order already posted") return res.status(409).json({ message });
    if (message === "Canceled order cannot be posted") return res.status(409).json({ message });
    if (message.includes("Order has no items")) return res.status(400).json({ message });
    if (message.includes("Insufficient stock")) return res.status(400).json({ message });
    return res.status(500).json({ message });
  } finally {
    client.release();
  }
});

router.post("/:id/split", requireAuth, async (req, res) => {
  const orderId = normalizeParamId(req.params.id);
  const schema = z.object({
    items: z.array(z.object({ orderItemId: z.string().uuid(), qty: z.number().positive() })).min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sourceOrder = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    if (sourceOrder.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Order not found" });
    }
    if (sourceOrder.rows[0].status === "posted") {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Cannot split posted order" });
    }

    const splitOrder = await client.query(
      `
        INSERT INTO orders
          (customer_name, status, created_by, tax_inclusive, bill_discount_type, bill_discount_value, split_from_order_id)
        VALUES
          ($1, 'draft', $2, $3, $4, 0, $5)
        RETURNING *
      `,
      [
        sourceOrder.rows[0].customer_name,
        req.user?.id ?? null,
        sourceOrder.rows[0].tax_inclusive,
        sourceOrder.rows[0].bill_discount_type,
        orderId,
      ],
    );

    for (const item of parsed.data.items) {
      const row = await client.query(`SELECT * FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE`, [
        item.orderItemId,
        orderId,
      ]);
      if (row.rowCount === 0) throw new Error(`Order item not found: ${item.orderItemId}`);
      const src = row.rows[0];
      const existingQty = Number(src.qty);
      if (item.qty > existingQty) throw new Error(`Split qty exceeds item qty for ${item.orderItemId}`);

      const ratio = item.qty / existingQty;
      const movedDiscount = Number((Number(src.discount_amount) * ratio).toFixed(2));
      const movedPreTax = Number((Number(src.pre_tax_amount) * ratio).toFixed(2));
      const movedTax = Number((Number(src.tax_amount) * ratio).toFixed(2));
      const movedLineTotal = Number((Number(src.line_total) * ratio).toFixed(2));

      await client.query(
        `
          INSERT INTO order_items
            (
              order_id, product_id, product_name, qty, unit_price, discount_type, discount_amount,
              tax_rate, tax_inclusive, pre_tax_amount, tax_amount, line_total
            )
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `,
        [
          splitOrder.rows[0].id,
          src.product_id,
          src.product_name,
          item.qty,
          src.unit_price,
          src.discount_type,
          movedDiscount,
          src.tax_rate,
          src.tax_inclusive,
          movedPreTax,
          movedTax,
          movedLineTotal,
        ],
      );

      if (item.qty === existingQty) {
        await client.query(`DELETE FROM order_items WHERE id = $1`, [item.orderItemId]);
      } else {
        await client.query(
          `
            UPDATE order_items
            SET
              qty = qty - $2,
              discount_amount = discount_amount - $3,
              pre_tax_amount = pre_tax_amount - $4,
              tax_amount = tax_amount - $5,
              line_total = line_total - $6
            WHERE id = $1
          `,
          [item.orderItemId, item.qty, movedDiscount, movedPreTax, movedTax, movedLineTotal],
        );
      }
    }

    await client.query("COMMIT");
    return res.status(201).json({ sourceOrderId: orderId, splitOrder: splitOrder.rows[0] });
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ message });
  } finally {
    client.release();
  }
});

router.post("/merge", requireAuth, async (req, res) => {
  const schema = z.object({ sourceOrderIds: z.array(z.string().uuid()).min(2) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sourceOrders = await client.query(`SELECT * FROM orders WHERE id = ANY($1::uuid[]) FOR UPDATE`, [
      parsed.data.sourceOrderIds,
    ]);
    if (sourceOrders.rowCount !== parsed.data.sourceOrderIds.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "One or more orders not found" });
    }
    if (sourceOrders.rows.some((row: { status: string }) => row.status === "posted")) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Cannot merge posted orders" });
    }

    const primary = sourceOrders.rows[0];
    const mergeTarget = await client.query(
      `
        INSERT INTO orders
          (customer_name, status, created_by, tax_inclusive, bill_discount_type, bill_discount_value)
        VALUES
          ($1, 'draft', $2, $3, $4, 0)
        RETURNING *
      `,
      [primary.customer_name, req.user?.id ?? null, primary.tax_inclusive, primary.bill_discount_type],
    );
    const targetOrderId = mergeTarget.rows[0].id as string;

    await client.query(`UPDATE order_items SET order_id = $1 WHERE order_id = ANY($2::uuid[])`, [
      targetOrderId,
      parsed.data.sourceOrderIds,
    ]);
    await client.query(
      `UPDATE orders SET merged_into_order_id = $2, status = 'held', updated_at = NOW() WHERE id = ANY($1::uuid[])`,
      [parsed.data.sourceOrderIds, targetOrderId],
    );

    await client.query("COMMIT");
    return res.status(201).json({ mergedOrder: mergeTarget.rows[0], sourceOrderIds: parsed.data.sourceOrderIds });
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(500).json({ message });
  } finally {
    client.release();
  }
});

router.patch("/:id/items/:itemId", requireAuth, async (req, res) => {
  const orderId = normalizeParamId(req.params.id);
  const itemId = normalizeParamId(req.params.itemId);
  const schema = z.object({
    qty: z.number().positive().optional(),
    discountType: z.enum(["amount", "percent"]).optional(),
    discountValue: z.number().min(0).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  if (
    typeof parsed.data.qty !== "number" &&
    typeof parsed.data.discountType === "undefined" &&
    typeof parsed.data.discountValue === "undefined"
  ) {
    return res.status(400).json({ message: "Nothing to update" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const order = await client.query(`SELECT id, status FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    if (order.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Order not found" });
    }
    if (order.rows[0].status === "posted") {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Order already posted" });
    }

    const currentItem = await client.query(
      `SELECT * FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE`,
      [itemId, orderId],
    );
    if (currentItem.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Order item not found" });
    }

    const row = currentItem.rows[0];
    const oldQty = Number(row.qty);
    const nextQty = parsed.data.qty ?? oldQty;

    const baseDiscountType = (row.discount_type as "amount" | "percent") ?? "amount";
    const nextDiscountType = parsed.data.discountType ?? baseDiscountType;

    const currentDiscountAmount = Number(row.discount_amount);
    const grossCurrent = oldQty * Number(row.unit_price);
    const inferredDiscountValue =
      baseDiscountType === "percent"
        ? grossCurrent > 0
          ? Number(((currentDiscountAmount / grossCurrent) * 100).toFixed(4))
          : 0
        : currentDiscountAmount;
    const nextDiscountValue = parsed.data.discountValue ?? inferredDiscountValue;

    if (nextDiscountValue > 0 && !req.user?.permissions.includes("discount_override")) {
      await client.query("ROLLBACK");
      return res.status(403).json({ message: "Missing permission: discount_override" });
    }

    const computed = calculateLineAmounts({
      qty: nextQty,
      unitPrice: Number(row.unit_price),
      discountType: nextDiscountType,
      discountValue: nextDiscountValue,
      taxRate: Number(row.tax_rate),
      taxInclusive: Boolean(row.tax_inclusive),
    });

    const updated = await client.query(
      `
        UPDATE order_items
        SET
          qty = $3,
          discount_type = $4,
          discount_amount = $5,
          pre_tax_amount = $6,
          tax_amount = $7,
          line_total = $8
        WHERE id = $1 AND order_id = $2
        RETURNING *
      `,
      [
        itemId,
        orderId,
        nextQty,
        nextDiscountType,
        computed.discountAmount,
        computed.preTaxAmount,
        computed.taxAmount,
        computed.lineTotal,
      ],
    );

    await createAuditLog({
      client,
      actorUserId: req.user?.id ?? null,
      action: "update_order_item_qty",
      entity: "order_items",
      entityId: itemId,
      beforeData: row,
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

router.delete("/:id/items/:itemId", requireAuth, async (req, res) => {
  const orderId = normalizeParamId(req.params.id);
  const itemId = normalizeParamId(req.params.itemId);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const order = await client.query(`SELECT id, status FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    if (order.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Order not found" });
    }
    if (order.rows[0].status === "posted") {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Order already posted" });
    }

    const deleted = await client.query(
      `DELETE FROM order_items WHERE id = $1 AND order_id = $2 RETURNING *`,
      [itemId, orderId],
    );
    if (deleted.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Order item not found" });
    }

    await createAuditLog({
      client,
      actorUserId: req.user?.id ?? null,
      action: "remove_order_item",
      entity: "order_items",
      entityId: itemId,
      beforeData: deleted.rows[0],
      afterData: null,
    });

    await client.query("COMMIT");
    return res.status(204).send();
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(500).json({ message });
  } finally {
    client.release();
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  const orderId = normalizeParamId(req.params.id);
  const order = await pool.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
  if (order.rowCount === 0) return res.status(404).json({ message: "Order not found" });
  const items = await pool.query(`SELECT * FROM order_items WHERE order_id = $1 ORDER BY created_at ASC`, [orderId]);
  return res.json({ order: order.rows[0], items: items.rows });
});

router.post("/:id/cancel", requireAuth, async (req, res) => {
  const orderId = normalizeParamId(req.params.id);
  const schema = z.object({ reason: z.string().min(3).max(200) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const orderResult = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    if (orderResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Order not found" });
    }
    const order = orderResult.rows[0];
    if (order.status === "posted") {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Posted order cannot be canceled. Use invoice void flow." });
    }
    if (order.status === "canceled") {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Order already canceled" });
    }

    if (!req.user?.permissions.includes("void_bill")) {
      const approval = await client.query(
        `
          INSERT INTO approval_requests (action_type, action_payload, reason, status, requested_by)
          VALUES ('order_cancel', $1, $2, 'pending', $3)
          RETURNING *
        `,
        [{ orderId }, parsed.data.reason, req.user?.id ?? null],
      );
      await client.query("COMMIT");
      return res.status(202).json({
        message: "Approval required for cancel request",
        approvalRequest: approval.rows[0],
      });
    }

    const updated = await executeOrderCancel({
      client,
      orderId,
      reason: parsed.data.reason,
      actorUserId: req.user?.id ?? null,
    });

    await createAuditLog({
      client,
      actorUserId: req.user?.id ?? null,
      action: "cancel_order",
      entity: "orders",
      entityId: orderId,
      beforeData: order,
      afterData: updated,
    });

    await client.query("COMMIT");
    return res.json(updated);
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(500).json({ message });
  } finally {
    client.release();
  }
});

export default router;
