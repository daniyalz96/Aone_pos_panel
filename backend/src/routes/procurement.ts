import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { supplierBalanceAndCatalogSelect } from "../db/supplierAggregatesSql.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { fetchSupplierRowWithAggregates, replaceSupplierCatalogLinks, supplierToPublicJson } from "../services/supplierCatalogLinks.js";
import { zCatalogUuidArray } from "../utils/catalogIdArrays.js";
import { postSupplierOpeningBalance } from "../services/supplierLedger.js";
import { applyStockMovement } from "./inventory.js";

const router = Router();

router.get("/suppliers", requireAuth, async (_req, res) => {
  const rows = await pool.query(
    `
      SELECT s.*,
      ${supplierBalanceAndCatalogSelect}
      FROM suppliers s
      WHERE s.is_active = TRUE
      ORDER BY s.company_name ASC, s.name ASC
    `,
  );
  return res.json(rows.rows.map((r) => supplierToPublicJson(r as Record<string, unknown>)));
});

router.post("/suppliers", requireAuth, requirePermission("manage_inventory"), async (req, res) => {
  const schema = z.object({
    name: z.string().min(2).max(120),
    companyName: z.string().min(2).max(200).optional(),
    contactPerson: z.string().max(120).optional().nullable(),
    phone: z.string().max(25).optional(),
    email: z.string().email().optional().or(z.literal("")),
    address: z.string().max(500).optional().nullable(),
    taxNtn: z.string().max(80).optional().nullable(),
    openingBalance: z.number().nonnegative().optional().default(0),
    categoryIds: zCatalogUuidArray().optional(),
    productIds: zCatalogUuidArray().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const companyName = parsed.data.companyName ?? parsed.data.name;
  const email = parsed.data.email === "" ? null : parsed.data.email ?? null;
  const opening = parsed.data.openingBalance ?? 0;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `
        INSERT INTO suppliers
          (name, company_name, contact_person, phone, email, address, tax_ntn, opening_balance, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
        RETURNING *
      `,
      [
        parsed.data.name,
        companyName,
        parsed.data.contactPerson ?? null,
        parsed.data.phone ?? null,
        email,
        parsed.data.address ?? null,
        parsed.data.taxNtn ?? null,
        opening,
      ],
    );
    const row = inserted.rows[0] as { id: string };
    if (opening > 0) {
      await postSupplierOpeningBalance(client, {
        supplierId: row.id,
        amount: opening,
        userId: req.user?.id ?? null,
      });
    }
    await replaceSupplierCatalogLinks(
      client,
      row.id,
      parsed.data.categoryIds,
      parsed.data.productIds,
    );
    await client.query("COMMIT");
    const full = await fetchSupplierRowWithAggregates(row.id);
    if (!full) {
      return res.status(500).json({ message: "Supplier was created but could not be reloaded with catalog data." });
    }
    return res.status(201).json(full);
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ message });
  } finally {
    client.release();
  }
});

router.post("/grn", requireAuth, requirePermission("manage_inventory"), async (req, res) => {
  const schema = z.object({
    supplierId: z.string().uuid().optional(),
    branchId: z.string().uuid().optional(),
    invoiceRef: z.string().max(120).optional(),
    note: z.string().max(300).optional(),
    items: z
      .array(
        z.object({
          productId: z.string().uuid(),
          variantId: z.string().uuid().optional(),
          qty: z.number().positive(),
          unitCost: z.number().nonnegative(),
          batchCode: z.string().min(2).max(60).optional(),
          expiryDate: z.string().date().optional(),
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
    const grnNumber = `GRN-${Date.now()}`;
    const receipt = await client.query(
      `
        INSERT INTO purchase_receipts
          (grn_number, supplier_id, branch_id, invoice_ref, note, created_by)
        VALUES
          ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `,
      [
        grnNumber,
        parsed.data.supplierId ?? null,
        parsed.data.branchId ?? null,
        parsed.data.invoiceRef ?? null,
        parsed.data.note ?? null,
        req.user?.id ?? null,
      ],
    );

    for (const item of parsed.data.items) {
      let batchId: string | undefined;
      if (item.batchCode) {
        const batchResult = await client.query(
          `
            INSERT INTO inventory_batches (product_id, variant_id, branch_id, batch_code, expiry_date)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (product_id, variant_id, branch_id, batch_code)
            DO UPDATE SET expiry_date = COALESCE(EXCLUDED.expiry_date, inventory_batches.expiry_date)
            RETURNING id
          `,
          [
            item.productId,
            item.variantId ?? null,
            parsed.data.branchId ?? null,
            item.batchCode,
            item.expiryDate ?? null,
          ],
        );
        batchId = batchResult.rows[0].id as string;
      }

      await client.query(
        `
          INSERT INTO purchase_receipt_items
            (receipt_id, product_id, variant_id, batch_id, qty, unit_cost)
          VALUES
            ($1, $2, $3, $4, $5, $6)
        `,
        [receipt.rows[0].id, item.productId, item.variantId ?? null, batchId ?? null, item.qty, item.unitCost],
      );

      await applyStockMovement({
        dbClient: client,
        productId: item.productId,
        movementType: "stock_in",
        qty: item.qty,
        unitCost: item.unitCost,
        reason: "GRN stock in",
        referenceType: "grn",
        referenceId: receipt.rows[0].id as string,
        branchId: parsed.data.branchId,
        variantId: item.variantId,
        batchId,
        userId: req.user?.id ?? null,
      });
    }

    await client.query("COMMIT");
    return res.status(201).json(receipt.rows[0]);
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(500).json({ message });
  } finally {
    client.release();
  }
});

router.get("/grn", requireAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const rows = await pool.query(
    `
      SELECT pr.*, s.name AS supplier_name, b.name AS branch_name
      FROM purchase_receipts pr
      LEFT JOIN suppliers s ON s.id = pr.supplier_id
      LEFT JOIN branches b ON b.id = pr.branch_id
      ORDER BY pr.created_at DESC
      LIMIT $1
    `,
    [limit],
  );
  return res.json(rows.rows);
});

export default router;
