import { Router } from "express";
import { z } from "zod";
import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import { supplierBalanceAndCatalogSelect } from "../db/supplierAggregatesSql.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { fetchSupplierRowWithAggregates, replaceSupplierCatalogLinks, supplierToPublicJson } from "../services/supplierCatalogLinks.js";
import { zCatalogUuidArray } from "../utils/catalogIdArrays.js";
import { applyStockMovement } from "./inventory.js";
import { postJournalEntry } from "../services/ledger.js";
import { insertSupplierLedger } from "../services/supplierLedger.js";

const router = Router();

function routeParamId(req: { params: Record<string, string | string[]> }, key: string): string {
  const v = req.params[key];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[0] ?? "";
  return "";
}

const money = (n: number) => Math.round(n * 100) / 100;

function creditAccountForTerms(terms: "cash" | "credit" | "bank_transfer"): "1000" | "1010" | "2200" {
  if (terms === "cash") return "1000";
  if (terms === "bank_transfer") return "1010";
  return "2200";
}

function lineBase(qty: number, unitCost: number) {
  return money(qty * unitCost);
}

function computeLineTotal(qty: number, unitCost: number, taxAmount: number) {
  return money(lineBase(qty, unitCost) + taxAmount);
}

const lineInputSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().optional(),
  qty: z.coerce.number().positive(),
  unitCost: z.coerce.number().nonnegative(),
  /** When > 0, stored on the line and synced to the product master sale price. */
  salePrice: z.preprocess((val: unknown) => {
    if (val === "" || val === null || val === undefined) return undefined;
    const n = typeof val === "number" ? val : Number(String(val).replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return money(n);
  }, z.number().positive().optional()),
  taxRatePct: z.coerce.number().nonnegative().max(100).optional().default(0),
  taxAmount: z.coerce.number().nonnegative().optional(),
});

function finalizeLine(
  raw: z.infer<typeof lineInputSchema>,
): { taxAmount: number; lineTotal: number; base: number } {
  const base = lineBase(raw.qty, raw.unitCost);
  let taxAmount = raw.taxAmount;
  if (taxAmount === undefined) {
    taxAmount = raw.taxRatePct > 0 ? money((base * raw.taxRatePct) / 100) : 0;
  }
  const lineTotal = computeLineTotal(raw.qty, raw.unitCost, taxAmount);
  return { taxAmount, lineTotal, base };
}

async function replaceInvoiceLines(
  client: PoolClient,
  invoiceId: string,
  lines: z.infer<typeof lineInputSchema>[],
) {
  await client.query(`DELETE FROM purchase_invoice_lines WHERE invoice_id = $1`, [invoiceId]);
  let subtotal = 0;
  let taxTotal = 0;
  let total = 0;
  for (const raw of lines) {
    const { taxAmount, lineTotal, base } = finalizeLine(raw);
    subtotal = money(subtotal + base);
    taxTotal = money(taxTotal + taxAmount);
    total = money(total + lineTotal);
    const unitSale =
      raw.salePrice !== undefined && raw.salePrice > 0 ? money(raw.salePrice) : null;
    await client.query(
      `
        INSERT INTO purchase_invoice_lines
          (invoice_id, product_id, variant_id, qty, unit_cost, unit_sale_price, tax_rate_pct, tax_amount, line_total)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        invoiceId,
        raw.productId,
        raw.variantId ?? null,
        raw.qty,
        raw.unitCost,
        unitSale,
        raw.taxRatePct ?? 0,
        taxAmount,
        lineTotal,
      ],
    );
  }
  await client.query(
    `
      UPDATE purchase_invoices
      SET subtotal = $2, tax_total = $3, total_amount = $4, updated_at = NOW()
      WHERE id = $1
    `,
    [invoiceId, subtotal, taxTotal, total],
  );

  for (const raw of lines) {
    await client.query(`UPDATE products SET cost_price = $2, updated_at = NOW() WHERE id = $1`, [
      raw.productId,
      raw.unitCost,
    ]);
    if (raw.salePrice !== undefined && raw.salePrice > 0) {
      await client.query(`UPDATE products SET sale_price = $2, updated_at = NOW() WHERE id = $1`, [
        raw.productId,
        raw.salePrice,
      ]);
    }
  }
}

router.get("/suppliers/:id", requireAuth, async (req, res) => {
  const id = routeParamId(req, "id");
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ message: "Invalid supplier id" });
  }
  const row = await pool.query(
    `
      SELECT s.*,
      ${supplierBalanceAndCatalogSelect}
      FROM suppliers s
      WHERE s.id = $1
    `,
    [id],
  );
  if (row.rowCount === 0) {
    return res.status(404).json({ message: "Supplier not found" });
  }
  return res.json(supplierToPublicJson(row.rows[0] as Record<string, unknown>));
});

router.patch("/suppliers/:id", requireAuth, requirePermission("manage_inventory"), async (req, res) => {
  const id = routeParamId(req, "id");
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ message: "Invalid supplier id" });
  }
  const schema = z.object({
    name: z.string().min(2).max(120).optional(),
    companyName: z.string().min(2).max(200).optional(),
    contactPerson: z.string().max(120).optional().nullable(),
    phone: z.string().max(25).optional().nullable(),
    email: z.string().email().optional().nullable().or(z.literal("")),
    address: z.string().max(500).optional().nullable(),
    taxNtn: z.string().max(80).optional().nullable(),
    isActive: z.boolean().optional(),
    categoryIds: zCatalogUuidArray().optional(),
    productIds: zCatalogUuidArray().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }
  const d = parsed.data;
  const fields: string[] = [];
  const vals: unknown[] = [];
  const push = (col: string, val: unknown) => {
    fields.push(`${col} = $${vals.length + 1}`);
    vals.push(val);
  };
  if (d.name !== undefined) push("name", d.name);
  if (d.companyName !== undefined) push("company_name", d.companyName);
  if (d.contactPerson !== undefined) push("contact_person", d.contactPerson);
  if (d.phone !== undefined) push("phone", d.phone);
  if (d.email !== undefined) push("email", d.email === "" ? null : d.email);
  if (d.address !== undefined) push("address", d.address);
  if (d.taxNtn !== undefined) push("tax_ntn", d.taxNtn);
  if (d.isActive !== undefined) push("is_active", d.isActive);
  const hasProfile = fields.length > 0;
  const hasCatalog = d.categoryIds !== undefined || d.productIds !== undefined;
  if (!hasProfile && !hasCatalog) {
    return res.status(400).json({ message: "No fields to update" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (hasProfile) {
      fields.push("updated_at = NOW()");
      vals.push(id);
      const updated = await client.query(
        `UPDATE suppliers SET ${fields.join(", ")} WHERE id = $${vals.length} RETURNING id`,
        vals,
      );
      if (updated.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Supplier not found" });
      }
    } else {
      const exists = await client.query(`SELECT id FROM suppliers WHERE id = $1`, [id]);
      if (exists.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Supplier not found" });
      }
    }
    if (hasCatalog) {
      await replaceSupplierCatalogLinks(client, id, d.categoryIds, d.productIds);
    }
    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ message });
  } finally {
    client.release();
  }

  const full = await fetchSupplierRowWithAggregates(id);
  if (!full) {
    return res.status(404).json({ message: "Supplier not found" });
  }
  return res.json(full);
});

router.get("/suppliers/:id/ledger", requireAuth, async (req, res) => {
  const id = routeParamId(req, "id");
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ message: "Invalid supplier id" });
  }
  const rows = await pool.query(
    `SELECT * FROM supplier_ledger_entries WHERE supplier_id = $1 ORDER BY created_at ASC`,
    [id],
  );
  let run = 0;
  const withRun = rows.rows.map((r) => {
    run = money(run + Number(r.amount));
    return { ...r, running_balance: run };
  });
  return res.json(withRun);
});

router.post("/suppliers/:id/payments", requireAuth, requirePermission("manage_inventory"), async (req, res) => {
  const id = routeParamId(req, "id");
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ message: "Invalid supplier id" });
  }
  const schema = z.object({
    amount: z.number().positive(),
    method: z.enum(["cash", "bank_transfer"]),
    reference: z.string().max(200).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pay = await client.query(
      `
        INSERT INTO supplier_payments (supplier_id, amount, method, reference, created_by)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `,
      [id, parsed.data.amount, parsed.data.method, parsed.data.reference ?? null, req.user?.id ?? null],
    );
    const payRow = pay.rows[0] as { id: string; amount: string };
    const amt = Number(payRow.amount);

    await insertSupplierLedger(client, {
      supplierId: id,
      entryKind: "supplier_payment",
      amount: -amt,
      referenceType: "supplier_payment",
      referenceId: payRow.id,
      memo: "Supplier payment",
      userId: req.user?.id ?? null,
    });

    const creditCode = parsed.data.method === "bank_transfer" ? "1010" : "1000";
    await postJournalEntry({
      client,
      sourceType: "supplier_payment",
      sourceId: payRow.id,
      memo: "Supplier payment",
      createdBy: req.user?.id ?? null,
      lines: [
        { accountCode: "2200", debit: amt, credit: 0, memo: "Reduce AP" },
        { accountCode: creditCode, debit: 0, credit: amt, memo: "Payment out" },
      ],
    });

    await client.query("COMMIT");
    return res.status(201).json(pay.rows[0]);
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ message });
  } finally {
    client.release();
  }
});

const invoiceBodySchema = z.object({
  supplierId: z.string().uuid(),
  branchId: z.string().uuid().optional(),
  invoiceNumber: z.string().min(1).max(80),
  referenceNumber: z.string().max(120).optional(),
  purchaseDate: z.string().date().optional(),
  paymentTerms: z.enum(["cash", "credit", "bank_transfer"]),
  notes: z.string().max(500).optional(),
  items: z.array(lineInputSchema).default([]),
});

router.post("/purchase-invoices", requireAuth, requirePermission("manage_inventory"), async (req, res) => {
  const parsed = invoiceBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inv = await client.query(
      `
        INSERT INTO purchase_invoices
          (supplier_id, branch_id, invoice_number, reference_number, purchase_date, payment_terms, status, notes, created_by)
        VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6, 'draft', $7, $8)
        RETURNING *
      `,
      [
        parsed.data.supplierId,
        parsed.data.branchId ?? null,
        parsed.data.invoiceNumber,
        parsed.data.referenceNumber ?? null,
        parsed.data.purchaseDate ?? null,
        parsed.data.paymentTerms,
        parsed.data.notes ?? null,
        req.user?.id ?? null,
      ],
    );
    const invId = inv.rows[0].id as string;
    if (parsed.data.items.length) {
      await replaceInvoiceLines(client, invId, parsed.data.items);
    }
    const full = await client.query(`SELECT * FROM purchase_invoices WHERE id = $1`, [invId]);
    await client.query("COMMIT");
    return res.status(201).json(full.rows[0]);
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    if (String(message).includes("unique") || String(message).includes("duplicate")) {
      return res.status(409).json({ message: "Invoice number must be unique for this supplier" });
    }
    return res.status(400).json({ message });
  } finally {
    client.release();
  }
});

router.get("/purchase-invoices", requireAuth, async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const limit = Math.min(Number(req.query.limit ?? 80), 200);
  const params: unknown[] = [limit];
  let where = "";
  if (status && ["draft", "posted", "partially_returned", "reversed"].includes(status)) {
    params.unshift(status);
    where = `WHERE pi.status = $1`;
  }
  const rows = await pool.query(
    `
      SELECT pi.*, s.name AS supplier_name, s.company_name
      FROM purchase_invoices pi
      JOIN suppliers s ON s.id = pi.supplier_id
      ${where}
      ORDER BY pi.created_at DESC
      LIMIT $${params.length}
    `,
    params,
  );
  return res.json(rows.rows);
});

router.get("/purchase-invoices/:id", requireAuth, async (req, res) => {
  const id = routeParamId(req, "id");
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ message: "Invalid id" });
  }
  const inv = await pool.query(
    `
      SELECT pi.*, s.name AS supplier_name, s.company_name, s.tax_ntn
      FROM purchase_invoices pi
      JOIN suppliers s ON s.id = pi.supplier_id
      WHERE pi.id = $1
    `,
    [id],
  );
  if (inv.rowCount === 0) {
    return res.status(404).json({ message: "Not found" });
  }
  const lines = await pool.query(
    `
      SELECT pil.*, p.name AS product_name, p.sku, p.barcode, p.sale_price AS product_sale_price
      FROM purchase_invoice_lines pil
      JOIN products p ON p.id = pil.product_id
      WHERE pil.invoice_id = $1
      ORDER BY pil.created_at ASC
    `,
    [id],
  );
  return res.json({ ...inv.rows[0], lines: lines.rows });
});

router.patch("/purchase-invoices/:id", requireAuth, requirePermission("manage_inventory"), async (req, res) => {
  const id = routeParamId(req, "id");
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ message: "Invalid id" });
  }
  const schema = invoiceBodySchema.partial().extend({
    items: z.array(lineInputSchema).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query<{ status: string }>(`SELECT status FROM purchase_invoices WHERE id = $1 FOR UPDATE`, [
      id,
    ]);
    if (cur.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Not found" });
    }
    const status = cur.rows[0].status;
    const isDraft = status === "draft";
    const isPostedMetaEdit = status === "posted" || status === "partially_returned";
    const isPostedLineEdit = status === "posted";
    if (status === "reversed") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Reversed invoices cannot be edited" });
    }
    if (!isDraft && !isPostedMetaEdit) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "This invoice cannot be edited" });
    }

    const d = parsed.data;
    if (d.items !== undefined) {
      if (isDraft || isPostedLineEdit) {
        await replaceInvoiceLines(client, id, d.items);
      } else {
        await client.query("ROLLBACK");
        return res.status(400).json({
          message:
            "Line items can only be changed on draft invoices, or on posted invoices without returns. For partially returned invoices, adjust via purchase returns.",
        });
      }
    }

    const fields: string[] = [];
    const vals: unknown[] = [];
    const push = (col: string, val: unknown) => {
      fields.push(`${col} = $${vals.length + 1}`);
      vals.push(val);
    };
    if (isDraft) {
      if (d.supplierId !== undefined) push("supplier_id", d.supplierId);
      if (d.branchId !== undefined) push("branch_id", d.branchId);
      if (d.invoiceNumber !== undefined) push("invoice_number", d.invoiceNumber);
      if (d.referenceNumber !== undefined) push("reference_number", d.referenceNumber);
      if (d.purchaseDate !== undefined) push("purchase_date", d.purchaseDate);
      if (d.paymentTerms !== undefined) push("payment_terms", d.paymentTerms);
      if (d.notes !== undefined) push("notes", d.notes);
    } else {
      if (d.supplierId !== undefined || d.branchId !== undefined || d.paymentTerms !== undefined) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          message: "After posting, only invoice number, reference, purchase date, and notes can be changed",
        });
      }
      if (d.invoiceNumber !== undefined) push("invoice_number", d.invoiceNumber);
      if (d.referenceNumber !== undefined) push("reference_number", d.referenceNumber);
      if (d.purchaseDate !== undefined) push("purchase_date", d.purchaseDate);
      if (d.notes !== undefined) push("notes", d.notes);
    }
    if (fields.length) {
      fields.push("updated_at = NOW()");
      vals.push(id);
      await client.query(`UPDATE purchase_invoices SET ${fields.join(", ")} WHERE id = $${vals.length}`, vals);
    }
    await client.query("COMMIT");
    const inv = await pool.query(`SELECT * FROM purchase_invoices WHERE id = $1`, [id]);
    return res.json(inv.rows[0]);
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ message });
  } finally {
    client.release();
  }
});

router.post("/purchase-invoices/:id/post", requireAuth, requirePermission("manage_inventory"), async (req, res) => {
  const id = routeParamId(req, "id");
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ message: "Invalid id" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const invRow = await client.query(
      `
        SELECT pi.*, s.id AS supplier_id
        FROM purchase_invoices pi
        JOIN suppliers s ON s.id = pi.supplier_id
        WHERE pi.id = $1 FOR UPDATE
      `,
      [id],
    );
    if (invRow.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Not found" });
    }
    const inv = invRow.rows[0] as {
      id: string;
      status: string;
      supplier_id: string;
      branch_id: string | null;
      payment_terms: "cash" | "credit" | "bank_transfer";
      total_amount: string;
    };
    if (inv.status !== "draft") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invoice is not a draft" });
    }

    const lines = await client.query(
      `SELECT * FROM purchase_invoice_lines WHERE invoice_id = $1 ORDER BY created_at ASC`,
      [id],
    );
    if (lines.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Add at least one line before posting" });
    }

    const total = Number(inv.total_amount);
    const creditAcc = creditAccountForTerms(inv.payment_terms);

    for (const line of lines.rows) {
      const productId = line.product_id as string;
      const qty = Number(line.qty);
      const unitCost = money(Number(line.unit_cost));
      const variantId = (line.variant_id as string | null) ?? undefined;
      const saleRaw = line.unit_sale_price as string | number | null | undefined;
      const unitSale =
        saleRaw !== null && saleRaw !== undefined && saleRaw !== ""
          ? money(Number(saleRaw))
          : null;

      await applyStockMovement({
        dbClient: client,
        productId,
        movementType: "stock_in",
        qty,
        unitCost,
        reason: "Purchase invoice posted",
        referenceType: "purchase_invoice",
        referenceId: id,
        branchId: inv.branch_id ?? undefined,
        variantId,
        userId: req.user?.id ?? null,
      });

      await client.query(`UPDATE products SET cost_price = $2, updated_at = NOW() WHERE id = $1`, [
        productId,
        unitCost,
      ]);
      if (unitSale !== null && unitSale > 0) {
        await client.query(`UPDATE products SET sale_price = $2, updated_at = NOW() WHERE id = $1`, [
          productId,
          unitSale,
        ]);
      }

      if (!inv.branch_id) {
        await client.query(
          `
            UPDATE inventory_balances
            SET opening_balance = qty_on_hand, updated_at = NOW()
            WHERE product_id = $1
              AND opening_balance IS NULL
              AND qty_on_hand > 0
          `,
          [productId],
        );
      }
    }

    await postJournalEntry({
      client,
      sourceType: "purchase_invoice",
      sourceId: id,
      memo: "Purchase invoice posted",
      createdBy: req.user?.id ?? null,
      lines: [
        { accountCode: "1200", debit: total, credit: 0, memo: "Inventory capitalization" },
        { accountCode: creditAcc, debit: 0, credit: total, memo: "Purchase obligation / payment" },
      ],
    });

    if (inv.payment_terms === "credit") {
      await insertSupplierLedger(client, {
        supplierId: inv.supplier_id,
        entryKind: "purchase_post",
        amount: total,
        referenceType: "purchase_invoice",
        referenceId: id,
        memo: "Posted purchase (credit)",
        userId: req.user?.id ?? null,
      });
    }

    await client.query(`UPDATE purchase_invoices SET status = 'posted', updated_at = NOW() WHERE id = $1`, [id]);

    await client.query("COMMIT");
    const out = await pool.query(`SELECT * FROM purchase_invoices WHERE id = $1`, [id]);
    return res.json(out.rows[0]);
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ message });
  } finally {
    client.release();
  }
});

async function processPurchaseReturn(
  client: PoolClient,
  params: {
    invoiceId: string;
    reasonCode: "damaged" | "wrong_item" | "overstock" | "invoice_error" | "other";
    notes?: string | null;
    lines: { purchaseInvoiceLineId: string; qtyReturned: number }[];
    userId: string | null;
    isFullReversal: boolean;
  },
) {
  const invRow = await client.query(
    `
      SELECT pi.* FROM purchase_invoices pi
      WHERE pi.id = $1 FOR UPDATE
    `,
    [params.invoiceId],
  );
  if (invRow.rowCount === 0) {
    throw new Error("Purchase invoice not found");
  }
  const inv = invRow.rows[0] as {
    id: string;
    status: string;
    supplier_id: string;
    branch_id: string | null;
    payment_terms: "cash" | "credit" | "bank_transfer";
  };
  if (inv.status === "draft") {
    throw new Error("Cannot return a draft invoice");
  }
  if (inv.status === "reversed") {
    throw new Error("Invoice already reversed");
  }
  if (inv.status !== "posted" && inv.status !== "partially_returned") {
    throw new Error("Invoice cannot be returned in its current state");
  }

  let glAmount = 0;
  for (const ret of params.lines) {
    const lineRow = await client.query(
      `
        SELECT pil.*, p.id AS product_id
        FROM purchase_invoice_lines pil
        JOIN products p ON p.id = pil.product_id
        WHERE pil.id = $1 AND pil.invoice_id = $2 FOR UPDATE
      `,
      [ret.purchaseInvoiceLineId, params.invoiceId],
    );
    if (lineRow.rowCount === 0) {
      throw new Error("Invalid line");
    }
    const line = lineRow.rows[0] as {
      id: string;
      qty: string;
      qty_returned: string;
      line_total: string;
      unit_cost: string;
      variant_id: string | null;
      product_id: string;
    };
    const maxRet = Number(line.qty) - Number(line.qty_returned);
    if (ret.qtyReturned <= 0 || ret.qtyReturned > maxRet) {
      throw new Error("Invalid return quantity");
    }
    const portion = ret.qtyReturned / Number(line.qty);
    const value = money(portion * Number(line.line_total));
    glAmount = money(glAmount + value);

    await applyStockMovement({
      dbClient: client,
      productId: line.product_id,
      movementType: "stock_out",
      qty: ret.qtyReturned,
      unitCost: Number(line.unit_cost),
      reason: `Purchase return (${params.reasonCode})`,
      referenceType: "purchase_return",
      referenceId: params.invoiceId,
      branchId: inv.branch_id ?? undefined,
      variantId: line.variant_id ?? undefined,
      userId: params.userId,
    });

    await client.query(
      `
        UPDATE purchase_invoice_lines
        SET qty_returned = qty_returned + $2
        WHERE id = $1
      `,
      [line.id, ret.qtyReturned],
    );
  }

  const retIns = await client.query(
    `
      INSERT INTO purchase_returns
        (purchase_invoice_id, reason_code, notes, total_amount, is_full_reversal, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `,
    [
      params.invoiceId,
      params.reasonCode,
      params.notes ?? null,
      glAmount,
      params.isFullReversal,
      params.userId,
    ],
  );
  const returnId = retIns.rows[0].id as string;

  for (const ret of params.lines) {
    await client.query(
      `
        INSERT INTO purchase_return_lines (purchase_return_id, purchase_invoice_line_id, qty_returned)
        VALUES ($1, $2, $3)
      `,
      [returnId, ret.purchaseInvoiceLineId, ret.qtyReturned],
    );
  }

  const debitAcc = creditAccountForTerms(inv.payment_terms);
  await postJournalEntry({
    client,
    sourceType: "purchase_return",
    sourceId: returnId,
    memo: params.isFullReversal ? "Purchase invoice reversal" : "Purchase return",
    createdBy: params.userId,
    lines: [
      { accountCode: debitAcc, debit: glAmount, credit: 0, memo: "Reduce payable / refund" },
      { accountCode: "1200", debit: 0, credit: glAmount, memo: "Reduce inventory" },
    ],
  });

  if (inv.payment_terms === "credit") {
    await insertSupplierLedger(client, {
      supplierId: inv.supplier_id,
      entryKind: params.isFullReversal ? "full_reversal" : "purchase_return",
      amount: -glAmount,
      referenceType: "purchase_return",
      referenceId: returnId,
      memo: params.isFullReversal ? "Full invoice reversal" : "Purchase return",
      userId: params.userId,
    });
  }

  const sumRem = await client.query(
    `
      SELECT COALESCE(SUM(qty - qty_returned), 0)::numeric AS rem
      FROM purchase_invoice_lines
      WHERE invoice_id = $1
    `,
    [params.invoiceId],
  );
  const remaining = Number(sumRem.rows[0].rem);
  const nextStatus =
    params.isFullReversal || remaining <= 0 ? "reversed" : "partially_returned";
  await client.query(`UPDATE purchase_invoices SET status = $2, updated_at = NOW() WHERE id = $1`, [
    params.invoiceId,
    nextStatus,
  ]);

  return returnId;
}

router.post("/purchase-returns", requireAuth, requirePermission("manage_inventory"), async (req, res) => {
  const schema = z.object({
    purchaseInvoiceId: z.string().uuid(),
    reasonCode: z.enum(["damaged", "wrong_item", "overstock", "invoice_error", "other"]),
    notes: z.string().max(500).optional(),
    lines: z
      .array(
        z.object({
          purchaseInvoiceLineId: z.string().uuid(),
          qtyReturned: z.number().positive(),
        }),
      )
      .min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const returnId = await processPurchaseReturn(client, {
      invoiceId: parsed.data.purchaseInvoiceId,
      reasonCode: parsed.data.reasonCode,
      notes: parsed.data.notes,
      lines: parsed.data.lines,
      userId: req.user?.id ?? null,
      isFullReversal: false,
    });
    await client.query("COMMIT");
    const row = await pool.query(`SELECT * FROM purchase_returns WHERE id = $1`, [returnId]);
    return res.status(201).json(row.rows[0]);
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ message });
  } finally {
    client.release();
  }
});

router.post("/purchase-invoices/:id/reverse", requireAuth, requirePermission("manage_inventory"), async (req, res) => {
  const id = routeParamId(req, "id");
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ message: "Invalid id" });
  }
  const schema = z.object({
    reasonCode: z.enum(["damaged", "wrong_item", "overstock", "invoice_error", "other"]).default("invoice_error"),
    notes: z.string().max(500).optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lines = await client.query(
      `
        SELECT id, (qty - qty_returned) AS rem
        FROM purchase_invoice_lines
        WHERE invoice_id = $1 AND (qty - qty_returned) > 0
      `,
      [id],
    );
    if (lines.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Nothing left to reverse on this invoice" });
    }
    const normalized = lines.rows.map((r: { id: string; rem: string }) => ({
      purchaseInvoiceLineId: r.id,
      qtyReturned: Number(r.rem),
    }));

    await processPurchaseReturn(client, {
      invoiceId: id,
      reasonCode: parsed.data.reasonCode,
      notes: parsed.data.notes,
      lines: normalized,
      userId: req.user?.id ?? null,
      isFullReversal: true,
    });
    await client.query("COMMIT");
    const inv = await pool.query(`SELECT * FROM purchase_invoices WHERE id = $1`, [id]);
    return res.json(inv.rows[0]);
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ message });
  } finally {
    client.release();
  }
});

export default router;
