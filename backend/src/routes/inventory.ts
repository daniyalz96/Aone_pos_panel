import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { DEFAULT_LOW_STOCK_THRESHOLD } from "../config/inventory.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { notifyLowStockForProduct } from "../services/lowStockAlerts.js";
import { createAuditLog } from "../utils/audit.js";

const router = Router();

const paginatedQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(500).optional(),
  offset: z.coerce.number().min(0).optional().default(0),
  withTotal: z.enum(["true", "false"]).optional(),
  q: z.string().optional(),
});

function searchClauseForProducts(alias = "p", categoryAlias = "c", departmentAlias = "d"): string {
  return `(
    ${alias}.name ILIKE $SEARCH OR ${alias}.sku ILIKE $SEARCH OR ${alias}.barcode ILIKE $SEARCH
    OR ${categoryAlias}.name ILIKE $SEARCH OR ${departmentAlias}.name ILIKE $SEARCH
  )`;
}

async function applyStockMovement(params: {
  productId: string;
  movementType: "stock_in" | "stock_out" | "sale_out" | "return_in" | "adjustment";
  qty: number;
  unitCost?: number;
  reason?: string;
  referenceType?: string;
  referenceId?: string;
  branchId?: string;
  variantId?: string;
  batchId?: string;
  userId?: string | null;
  dbClient?: PoolClient;
}) {
  const client = params.dbClient ?? (await pool.connect());
  const ownsTransaction = !params.dbClient;
  try {
    if (ownsTransaction) {
      await client.query("BEGIN");
    }
    const delta =
      params.movementType === "stock_out" || params.movementType === "sale_out" ? -params.qty : params.qty;

    await client.query(
      `
        INSERT INTO inventory_balances (product_id, qty_on_hand)
        VALUES ($1, 0)
        ON CONFLICT (product_id) DO NOTHING
      `,
      [params.productId],
    );

    const currentResult = await client.query(
      `SELECT qty_on_hand FROM inventory_balances WHERE product_id = $1 FOR UPDATE`,
      [params.productId],
    );
    const currentQty = Number(currentResult.rows[0].qty_on_hand);
    const nextQty = currentQty + delta;

    await client.query(
      `
        INSERT INTO inventory_movements
          (product_id, movement_type, qty, unit_cost, reference_type, reference_id, reason, created_by)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        params.productId,
        params.movementType,
        params.qty,
        params.unitCost ?? null,
        params.referenceType ?? null,
        params.referenceId ?? null,
        params.reason ?? null,
        params.userId ?? null,
      ],
    );

    if (params.branchId) {
      await client.query(
        `
          INSERT INTO branch_inventory_balances (branch_id, product_id, variant_id, batch_id, qty_on_hand)
          VALUES ($1, $2, $3, $4, 0)
          ON CONFLICT (branch_id, product_id, variant_id, batch_id) DO NOTHING
        `,
        [params.branchId, params.productId, params.variantId ?? null, params.batchId ?? null],
      );

      const branchBalance = await client.query(
        `
          SELECT id, qty_on_hand
          FROM branch_inventory_balances
          WHERE branch_id = $1
            AND product_id = $2
            AND variant_id IS NOT DISTINCT FROM $3
            AND batch_id IS NOT DISTINCT FROM $4
          FOR UPDATE
        `,
        [params.branchId, params.productId, params.variantId ?? null, params.batchId ?? null],
      );
      const branchCurrentQty = Number(branchBalance.rows[0].qty_on_hand);
      const branchNextQty = branchCurrentQty + delta;

      await client.query(
        `
          UPDATE branch_inventory_balances
          SET qty_on_hand = $2, updated_at = NOW()
          WHERE id = $1
        `,
        [branchBalance.rows[0].id as string, branchNextQty],
      );

      await client.query(
        `
          INSERT INTO branch_inventory_movements
            (branch_id, product_id, variant_id, batch_id, movement_type, qty, unit_cost, reference_type, reference_id, reason, created_by)
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `,
        [
          params.branchId,
          params.productId,
          params.variantId ?? null,
          params.batchId ?? null,
          params.movementType,
          params.qty,
          params.unitCost ?? null,
          params.referenceType ?? null,
          params.referenceId ?? null,
          params.reason ?? null,
          params.userId ?? null,
        ],
      );
    }

    await client.query(
      `UPDATE inventory_balances SET qty_on_hand = $2, updated_at = NOW() WHERE product_id = $1`,
      [params.productId, nextQty],
    );

    await createAuditLog({
      client,
      actorUserId: params.userId ?? null,
      action: "inventory_movement",
      entity: "inventory_balances",
      entityId: params.productId,
      afterData: {
        movementType: params.movementType,
        qty: params.qty,
        previousQty: currentQty,
        nextQty,
      },
    });

    if (ownsTransaction) {
      await client.query("COMMIT");
      void notifyLowStockForProduct(params.productId).catch(() => undefined);
    }
    return { productId: params.productId, previousQty: currentQty, nextQty };
  } catch (error) {
    if (ownsTransaction) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    if (ownsTransaction) {
      client.release();
    }
  }
}

router.post("/stock-in", requireAuth, requirePermission("manage_inventory"), async (req, res) => {
  const schema = z.object({
    productId: z.string().uuid(),
    qty: z.number().positive(),
    unitCost: z.number().nonnegative().optional(),
    reason: z.string().max(200).optional(),
    branchId: z.string().uuid().optional(),
    variantId: z.string().uuid().optional(),
    batchCode: z.string().min(2).max(60).optional(),
    expiryDate: z.string().date().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  try {
    let batchId: string | undefined;
    if (parsed.data.batchCode) {
      const batchResult = await pool.query(
        `
          INSERT INTO inventory_batches (product_id, variant_id, branch_id, batch_code, expiry_date)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (product_id, variant_id, branch_id, batch_code)
          DO UPDATE SET expiry_date = COALESCE(EXCLUDED.expiry_date, inventory_batches.expiry_date)
          RETURNING id
        `,
        [
          parsed.data.productId,
          parsed.data.variantId ?? null,
          parsed.data.branchId ?? null,
          parsed.data.batchCode,
          parsed.data.expiryDate ?? null,
        ],
      );
      batchId = batchResult.rows[0].id as string;
    }

    const result = await applyStockMovement({
      productId: parsed.data.productId,
      movementType: "stock_in",
      qty: parsed.data.qty,
      unitCost: parsed.data.unitCost,
      reason: parsed.data.reason,
      branchId: parsed.data.branchId,
      variantId: parsed.data.variantId,
      batchId,
      userId: req.user?.id ?? null,
    });

    /** First-time global stock: record opening balance once it was unset and on-hand is now positive. */
    if (!parsed.data.branchId) {
      await pool.query(
        `
          UPDATE inventory_balances
          SET opening_balance = qty_on_hand, updated_at = NOW()
          WHERE product_id = $1
            AND opening_balance IS NULL
            AND qty_on_hand > 0
        `,
        [parsed.data.productId],
      );
    }

    return res.status(201).json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ message });
  }
});

router.post("/stock-out", requireAuth, requirePermission("manage_inventory"), async (req, res) => {
  const schema = z.object({
    productId: z.string().uuid(),
    qty: z.number().positive(),
    reason: z.string().max(200).optional(),
    branchId: z.string().uuid().optional(),
    variantId: z.string().uuid().optional(),
    batchId: z.string().uuid().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  try {
    const result = await applyStockMovement({
      productId: parsed.data.productId,
      movementType: "stock_out",
      qty: parsed.data.qty,
      reason: parsed.data.reason,
      branchId: parsed.data.branchId,
      variantId: parsed.data.variantId,
      batchId: parsed.data.batchId,
      userId: req.user?.id ?? null,
    });
    return res.status(201).json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ message });
  }
});

router.get("/balances", requireAuth, async (req, res) => {
  const parsed = paginatedQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid query params", errors: parsed.error.flatten() });
  }
  const pagination = parsed.data;

  const branchId = req.query.branchId as string | undefined;
  const departmentId =
    typeof req.query.departmentId === "string" && /^[0-9a-f-]{36}$/i.test(req.query.departmentId)
      ? req.query.departmentId
      : undefined;

  if (branchId) {
    const params: unknown[] = [branchId];
    let deptClause = "";
    if (departmentId) {
      params.push(departmentId);
      deptClause = `AND c.department_id = $${params.length}`;
    }

    const branchResult = await pool.query(
      `
        SELECT
          b.id AS branch_id,
          b.name AS branch_name,
          p.id AS product_id,
          p.name,
          p.sku,
          p.barcode,
          p.cost_price,
          p.sale_price,
          c.id AS category_id,
          c.name AS category_name,
          d.id AS department_id,
          d.name AS department_name,
          pv.id AS variant_id,
          pv.name AS variant_name,
          ib.batch_code,
          ib.expiry_date,
          bib.qty_on_hand
        FROM branch_inventory_balances bib
        JOIN branches b ON b.id = bib.branch_id
        JOIN products p ON p.id = bib.product_id
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN departments d ON d.id = c.department_id
        LEFT JOIN product_variants pv ON pv.id = bib.variant_id
        LEFT JOIN inventory_batches ib ON ib.id = bib.batch_id
        WHERE bib.branch_id = $1
          ${deptClause}
        ORDER BY p.name ASC
      `,
      params,
    );
    if (pagination.withTotal === "true" && pagination.limit !== undefined) {
      return res.json({
        items: branchResult.rows,
        total: branchResult.rows.length,
        limit: pagination.limit,
        offset: pagination.offset,
      });
    }
    return res.json(branchResult.rows);
  }

  const params: unknown[] = [];
  let deptClause = "";
  if (departmentId) {
    params.push(departmentId);
    deptClause = `AND c.department_id = $${params.length}`;
  }

  const qTrim = pagination.q?.trim();
  let searchClause = "";
  if (qTrim) {
    params.push(`%${qTrim}%`);
    const searchParam = `$${params.length}`;
    searchClause = `AND ${searchClauseForProducts().replace(/\$SEARCH/g, searchParam)}`;
  }

  const whereBase = `
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN departments d ON d.id = c.department_id
      LEFT JOIN inventory_balances inv ON inv.product_id = p.id
      WHERE p.is_active = TRUE
        ${deptClause}
        ${searchClause}
  `;

  if (pagination.withTotal === "true" && pagination.limit !== undefined) {
    const countResult = await pool.query(`SELECT COUNT(*)::int AS total ${whereBase}`, params);
    const total = countResult.rows[0]?.total ?? 0;

    const listParams = [...params, pagination.limit, pagination.offset];
    const limitParam = `$${params.length + 1}`;
    const offsetParam = `$${params.length + 2}`;

    const result = await pool.query(
      `
        SELECT
          p.id AS product_id,
          p.name,
          p.sku,
          p.barcode,
          p.cost_price,
          p.sale_price,
          c.id AS category_id,
          c.name AS category_name,
          d.id AS department_id,
          d.name AS department_name,
          COALESCE(inv.qty_on_hand, 0) AS qty_on_hand,
          inv.opening_balance AS opening_balance
        ${whereBase}
        ORDER BY p.name ASC
        LIMIT ${limitParam}
        OFFSET ${offsetParam}
      `,
      listParams,
    );
    return res.json({
      items: result.rows,
      total,
      limit: pagination.limit,
      offset: pagination.offset,
    });
  }

  const result = await pool.query(
    `
      SELECT
        p.id AS product_id,
        p.name,
        p.sku,
        p.barcode,
        p.cost_price,
        p.sale_price,
        c.id AS category_id,
        c.name AS category_name,
        d.id AS department_id,
        d.name AS department_name,
        COALESCE(inv.qty_on_hand, 0) AS qty_on_hand,
        inv.opening_balance AS opening_balance
      ${whereBase}
      ORDER BY p.name ASC
    `,
    params,
  );
  return res.json(result.rows);
});

/** Set global on-hand quantity (creates adjustment / stock-out movements vs current balance). */
router.patch("/balances/:productId", requireAuth, requirePermission("manage_inventory"), async (req, res) => {
  const rawId = req.params.productId;
  const productIdCandidate = typeof rawId === "string" ? rawId : Array.isArray(rawId) ? rawId[0] : "";
  if (!productIdCandidate || !z.string().uuid().safeParse(productIdCandidate).success) {
    return res.status(400).json({ message: "Invalid product id" });
  }
  const productId = productIdCandidate;

  const schema = z
    .object({
      qtyOnHand: z.coerce.number().optional(),
      openingBalance: z.coerce.number().optional(),
      reason: z.string().max(200).optional(),
    })
    .refine((d) => d.qtyOnHand !== undefined || d.openingBalance !== undefined, {
      message: "Send qtyOnHand and/or openingBalance",
    });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const productCheck = await client.query(`SELECT id FROM products WHERE id = $1 AND is_active = TRUE`, [
      productId,
    ]);
    if (productCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Product not found or inactive" });
    }

    await client.query(
      `
        INSERT INTO inventory_balances (product_id, qty_on_hand)
        VALUES ($1, 0)
        ON CONFLICT (product_id) DO NOTHING
      `,
      [productId],
    );

    const curRow = await client.query<{ qty_on_hand: string; opening_balance: string | null }>(
      `SELECT qty_on_hand, opening_balance FROM inventory_balances WHERE product_id = $1 FOR UPDATE`,
      [productId],
    );
    const currentQty = Number(curRow.rows[0]?.qty_on_hand ?? 0);
    const rawOb = curRow.rows[0]?.opening_balance;
    const currentOpening: number | null =
      rawOb === null || rawOb === undefined || rawOb === ""
        ? null
        : (() => {
            const n = Number(rawOb);
            return Number.isFinite(n) ? n : null;
          })();

    const qtyInRequest = parsed.data.qtyOnHand !== undefined;
    const openingInRequest = parsed.data.openingBalance !== undefined;
    const reqQty = qtyInRequest ? Number(parsed.data.qtyOnHand!.toFixed(3)) : undefined;
    const reqOpening = openingInRequest ? Number(parsed.data.openingBalance!.toFixed(3)) : undefined;

    const qtyClose = (a: number, b: number) => Math.abs(a - b) < 1e-9;

    const qtyValueChanged =
      qtyInRequest && reqQty !== undefined && !qtyClose(reqQty, currentQty);

    /** Request differs from stored opening (including first persist when stored is null). */
    const openingRecordChanged =
      openingInRequest &&
      reqOpening !== undefined &&
      (currentOpening === null || !qtyClose(reqOpening, currentOpening));

    /**
     * Explicit quantity edit wins. Otherwise, changing an existing opening reference shifts on-hand
     * by the same delta (e.g. opening 10→9 with qty 8 → qty 7, preserving 2 units "sold since opening").
     * First time recording opening (null → value) updates the column only; physical qty unchanged.
     */
    let targetQty: number;
    if (qtyValueChanged) {
      targetQty = reqQty!;
    } else if (currentOpening !== null && openingRecordChanged) {
      targetQty = Number((currentQty + (reqOpening! - currentOpening)).toFixed(3));
    } else if (currentOpening === null && openingRecordChanged) {
      targetQty = currentQty;
    } else if (qtyInRequest && reqQty !== undefined) {
      targetQty = reqQty;
    } else {
      targetQty = currentQty;
    }

    const openingProvided = openingInRequest;
    const diff = targetQty - currentQty;

    const note = parsed.data.reason?.trim() || "Manual quantity edit";

    if (diff > 0) {
      await applyStockMovement({
        productId,
        movementType: "adjustment",
        qty: diff,
        reason: note,
        userId: req.user?.id ?? null,
        dbClient: client,
      });
    } else if (diff < 0) {
      await applyStockMovement({
        productId,
        movementType: "stock_out",
        qty: Math.abs(diff),
        reason: note,
        userId: req.user?.id ?? null,
        dbClient: client,
      });
    }

    if (openingProvided) {
      const ob = Number(parsed.data.openingBalance!.toFixed(3));
      await client.query(
        `
          UPDATE inventory_balances
          SET opening_balance = $2, updated_at = NOW()
          WHERE product_id = $1
        `,
        [productId, ob],
      );
    }

    await client.query("COMMIT");
    void notifyLowStockForProduct(productId).catch(() => undefined);
    return res.json({
      productId,
      previousQty: currentQty,
      nextQty: targetQty,
      openingBalance: openingProvided ? Number(parsed.data.openingBalance!.toFixed(3)) : undefined,
    });
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ message });
  } finally {
    client.release();
  }
});

router.get("/low-stock", requireAuth, async (req, res) => {
  const parsed = paginatedQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid query params", errors: parsed.error.flatten() });
  }
  const pagination = parsed.data;

  const threshold = Math.max(0, Number(req.query.threshold ?? DEFAULT_LOW_STOCK_THRESHOLD));
  const branchId = req.query.branchId as string | undefined;
  if (branchId) {
    const branchResult = await pool.query(
      `
        SELECT
          p.id AS product_id,
          p.name,
          p.sku,
          p.low_stock_threshold,
          COALESCE(SUM(bib.qty_on_hand), 0) AS qty_on_hand
        FROM products p
        LEFT JOIN branch_inventory_balances bib
          ON bib.product_id = p.id
          AND bib.branch_id = $2
        WHERE p.is_active = TRUE
        GROUP BY p.id
        HAVING COALESCE(SUM(bib.qty_on_hand), 0) <= GREATEST(p.low_stock_threshold, $1)
        ORDER BY qty_on_hand ASC
      `,
      [threshold, branchId],
    );
    if (pagination.withTotal === "true" && pagination.limit !== undefined) {
      return res.json({
        items: branchResult.rows,
        total: branchResult.rows.length,
        limit: pagination.limit,
        offset: pagination.offset,
      });
    }
    return res.json(branchResult.rows);
  }

  const whereBase = `
      FROM products p
      LEFT JOIN inventory_balances ib ON ib.product_id = p.id
      WHERE p.is_active = TRUE AND COALESCE(ib.qty_on_hand, 0) <= GREATEST(p.low_stock_threshold, $1)
  `;

  if (pagination.withTotal === "true" && pagination.limit !== undefined) {
    const countResult = await pool.query(`SELECT COUNT(*)::int AS total ${whereBase}`, [threshold]);
    const total = countResult.rows[0]?.total ?? 0;

    const result = await pool.query(
      `
        SELECT
          p.id AS product_id,
          p.name,
          p.sku,
          p.barcode,
          p.low_stock_threshold,
          COALESCE(ib.qty_on_hand, 0) AS qty_on_hand
        ${whereBase}
        ORDER BY qty_on_hand ASC
        LIMIT $2
        OFFSET $3
      `,
      [threshold, pagination.limit, pagination.offset],
    );
    return res.json({
      items: result.rows,
      total,
      limit: pagination.limit,
      offset: pagination.offset,
    });
  }

  const result = await pool.query(
    `
      SELECT
        p.id AS product_id,
        p.name,
        p.sku,
        p.barcode,
        p.low_stock_threshold,
        COALESCE(ib.qty_on_hand, 0) AS qty_on_hand
      ${whereBase}
      ORDER BY qty_on_hand ASC
    `,
    [threshold],
  );
  return res.json(result.rows);
});

router.get("/movements", requireAuth, async (req, res) => {
  const parsed = paginatedQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid query params", errors: parsed.error.flatten() });
  }
  const pagination = parsed.data;

  const branchId = req.query.branchId as string | undefined;
  const limit = Math.min(Number(pagination.limit ?? req.query.limit ?? 100), 500);
  const offset = pagination.offset;

  if (branchId) {
    if (pagination.withTotal === "true") {
      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS total FROM branch_inventory_movements WHERE branch_id = $1`,
        [branchId],
      );
      const total = countResult.rows[0]?.total ?? 0;
      const rows = await pool.query(
        `
          SELECT
            bim.*,
            p.name AS product_name,
            pv.name AS variant_name,
            ib.batch_code
          FROM branch_inventory_movements bim
          JOIN products p ON p.id = bim.product_id
          LEFT JOIN product_variants pv ON pv.id = bim.variant_id
          LEFT JOIN inventory_batches ib ON ib.id = bim.batch_id
          WHERE bim.branch_id = $1
          ORDER BY bim.created_at DESC
          LIMIT $2
          OFFSET $3
        `,
        [branchId, limit, offset],
      );
      return res.json({ items: rows.rows, total, limit, offset });
    }

    const rows = await pool.query(
      `
        SELECT
          bim.*,
          p.name AS product_name,
          pv.name AS variant_name,
          ib.batch_code
        FROM branch_inventory_movements bim
        JOIN products p ON p.id = bim.product_id
        LEFT JOIN product_variants pv ON pv.id = bim.variant_id
        LEFT JOIN inventory_batches ib ON ib.id = bim.batch_id
        WHERE bim.branch_id = $1
        ORDER BY bim.created_at DESC
        LIMIT $2
      `,
      [branchId, limit],
    );
    return res.json(rows.rows);
  }

  if (pagination.withTotal === "true") {
    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM inventory_movements`);
    const total = countResult.rows[0]?.total ?? 0;
    const rows = await pool.query(
      `
        SELECT im.*, p.name AS product_name
        FROM inventory_movements im
        JOIN products p ON p.id = im.product_id
        ORDER BY im.created_at DESC
        LIMIT $1
        OFFSET $2
      `,
      [limit, offset],
    );
    return res.json({ items: rows.rows, total, limit, offset });
  }

  const rows = await pool.query(
    `
      SELECT im.*, p.name AS product_name
      FROM inventory_movements im
      JOIN products p ON p.id = im.product_id
      ORDER BY im.created_at DESC
      LIMIT $1
    `,
    [limit],
  );

  return res.json(rows.rows);
});

router.get("/expiry-alerts", requireAuth, async (req, res) => {
  const branchId = req.query.branchId as string | undefined;
  const days = Math.max(1, Number(req.query.days ?? 30));

  if (branchId) {
    const rows = await pool.query(
      `
        SELECT
          ib.id AS batch_id,
          ib.batch_code,
          ib.expiry_date,
          p.id AS product_id,
          p.name AS product_name,
          pv.id AS variant_id,
          pv.name AS variant_name,
          COALESCE(SUM(bib.qty_on_hand), 0) AS qty_on_hand,
          b.name AS branch_name
        FROM inventory_batches ib
        JOIN products p ON p.id = ib.product_id
        LEFT JOIN product_variants pv ON pv.id = ib.variant_id
        LEFT JOIN branches b ON b.id = ib.branch_id
        LEFT JOIN branch_inventory_balances bib ON bib.batch_id = ib.id
        WHERE ib.expiry_date IS NOT NULL
          AND ib.branch_id = $1
          AND ib.expiry_date <= CURRENT_DATE + ($2 || ' days')::interval
        GROUP BY ib.id, p.id, pv.id, b.name
        HAVING COALESCE(SUM(bib.qty_on_hand), 0) > 0
        ORDER BY ib.expiry_date ASC
      `,
      [branchId, days],
    );
    return res.json(rows.rows);
  }

  const rows = await pool.query(
    `
      SELECT
        ib.id AS batch_id,
        ib.batch_code,
        ib.expiry_date,
        p.id AS product_id,
        p.name AS product_name,
        pv.id AS variant_id,
        pv.name AS variant_name,
        COALESCE(SUM(bib.qty_on_hand), 0) AS qty_on_hand,
        b.name AS branch_name
      FROM inventory_batches ib
      JOIN products p ON p.id = ib.product_id
      LEFT JOIN product_variants pv ON pv.id = ib.variant_id
      LEFT JOIN branches b ON b.id = ib.branch_id
      LEFT JOIN branch_inventory_balances bib ON bib.batch_id = ib.id
      WHERE ib.expiry_date IS NOT NULL
        AND ib.expiry_date <= CURRENT_DATE + ($1 || ' days')::interval
      GROUP BY ib.id, p.id, pv.id, b.name
      HAVING COALESCE(SUM(bib.qty_on_hand), 0) > 0
      ORDER BY ib.expiry_date ASC
    `,
    [days],
  );
  return res.json(rows.rows);
});

router.post("/transfer", requireAuth, requirePermission("manage_inventory"), async (req, res) => {
  const schema = z.object({
    productId: z.string().uuid(),
    qty: z.number().positive(),
    fromBranchId: z.string().uuid(),
    toBranchId: z.string().uuid(),
    variantId: z.string().uuid().optional(),
    batchId: z.string().uuid().optional(),
    reason: z.string().max(200).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }
  if (parsed.data.fromBranchId === parsed.data.toBranchId) {
    return res.status(400).json({ message: "Source and destination branch cannot be the same" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const upsertBalance = async (branchId: string) => {
      await client.query(
        `
          INSERT INTO branch_inventory_balances (branch_id, product_id, variant_id, batch_id, qty_on_hand)
          VALUES ($1, $2, $3, $4, 0)
          ON CONFLICT (branch_id, product_id, variant_id, batch_id) DO NOTHING
        `,
        [branchId, parsed.data.productId, parsed.data.variantId ?? null, parsed.data.batchId ?? null],
      );

      const row = await client.query(
        `
          SELECT id, qty_on_hand
          FROM branch_inventory_balances
          WHERE branch_id = $1
            AND product_id = $2
            AND variant_id IS NOT DISTINCT FROM $3
            AND batch_id IS NOT DISTINCT FROM $4
          FOR UPDATE
        `,
        [branchId, parsed.data.productId, parsed.data.variantId ?? null, parsed.data.batchId ?? null],
      );

      return row.rows[0] as { id: string; qty_on_hand: string };
    };

    const fromBalance = await upsertBalance(parsed.data.fromBranchId);
    const fromCurrent = Number(fromBalance.qty_on_hand);
    const fromNext = fromCurrent - parsed.data.qty;
    if (fromNext < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Insufficient stock in source branch" });
    }

    const toBalance = await upsertBalance(parsed.data.toBranchId);
    const toCurrent = Number(toBalance.qty_on_hand);
    const toNext = toCurrent + parsed.data.qty;

    await client.query(
      `UPDATE branch_inventory_balances SET qty_on_hand = $2, updated_at = NOW() WHERE id = $1`,
      [fromBalance.id, fromNext],
    );
    await client.query(
      `UPDATE branch_inventory_balances SET qty_on_hand = $2, updated_at = NOW() WHERE id = $1`,
      [toBalance.id, toNext],
    );

    await client.query(
      `
        INSERT INTO branch_inventory_movements
          (branch_id, product_id, variant_id, batch_id, movement_type, qty, reason, created_by)
        VALUES
          ($1, $2, $3, $4, 'transfer_out', $5, $6, $7),
          ($8, $2, $3, $4, 'transfer_in', $5, $6, $7)
      `,
      [
        parsed.data.fromBranchId,
        parsed.data.productId,
        parsed.data.variantId ?? null,
        parsed.data.batchId ?? null,
        parsed.data.qty,
        parsed.data.reason ?? "Branch transfer",
        req.user?.id ?? null,
        parsed.data.toBranchId,
      ],
    );

    await client.query("COMMIT");
    return res.status(201).json({
      productId: parsed.data.productId,
      fromBranchId: parsed.data.fromBranchId,
      toBranchId: parsed.data.toBranchId,
      qty: parsed.data.qty,
    });
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(500).json({ message });
  } finally {
    client.release();
  }
});

export { applyStockMovement };
export default router;
