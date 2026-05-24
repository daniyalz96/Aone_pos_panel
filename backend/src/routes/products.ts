import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { DEFAULT_LOW_STOCK_THRESHOLD } from "../config/inventory.js";
import { requireAuth, requireInventoryManagement } from "../middleware/auth.js";
import { createAuditLog } from "../utils/audit.js";

const router = Router();

const bulkDeleteSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
});

function paramId(raw: string | string[] | undefined): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && raw[0]) return raw[0];
  return "";
}

/** Accept JSON booleans and common form-style strings (`"true"` / `"0"`). */
const booleanLike = z.preprocess((value) => {
  if (value === undefined || value === null) return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["true", "t", "1", "yes", "on", "y"].includes(v)) return true;
    if (["false", "f", "0", "no", "off", "n"].includes(v)) return false;
  }
  return value;
}, z.boolean());

const createProductSchema = z.object({
  name: z.string().min(2),
  sku: z.string().min(2),
  barcode: z.string().min(3),
  salePrice: z.number().positive(),
  costPrice: z.number().nonnegative().default(0),
  taxRate: z.number().min(0).max(100).default(0),
  imageUrl: z.string().max(5_000_000).optional(),
  categoryId: z.string().uuid().optional(),
  lowStockThreshold: z.number().min(0).default(DEFAULT_LOW_STOCK_THRESHOLD),
  isActive: booleanLike.optional(),
});

/** Map snake_case `is_active` to `isActive` for JSON clients; drop duplicate key before Zod parse. */
function normalizeProductMutationBody(body: unknown): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }
  const b = body as Record<string, unknown>;
  const out = { ...b };
  if ("is_active" in out && !Object.prototype.hasOwnProperty.call(out, "isActive")) {
    out.isActive = out.is_active;
  }
  delete out.is_active;
  return out;
}

const patchProductBodySchema = z.object({
  name: z.string().min(2).optional(),
  sku: z.string().min(2).optional(),
  barcode: z.string().min(3).optional(),
  salePrice: z.number().positive().optional(),
  costPrice: z.number().nonnegative().optional(),
  taxRate: z.number().min(0).max(100).optional(),
  imageUrl: z.string().max(5_000_000).optional().nullable(),
  categoryId: z.string().uuid().optional().nullable(),
  lowStockThreshold: z.number().min(0).optional(),
  isActive: booleanLike.optional(),
});

const listProductsQuerySchema = z.object({
  q: z.string().optional(),
  categoryId: z.string().uuid().optional(),
  /** When set, only products linked to this supplier (supplier_products) are returned. */
  supplierId: z.string().uuid().optional(),
  isActive: z.enum(["true", "false"]).optional(),
  minSalePrice: z.coerce.number().nonnegative().optional(),
  maxSalePrice: z.coerce.number().nonnegative().optional(),
  sort: z
    .enum(["created_desc", "created_asc", "name_asc", "name_desc", "sale_asc", "sale_desc"])
    .optional()
    .default("created_desc"),
  limit: z.coerce.number().min(1).max(500).optional().default(200),
  offset: z.coerce.number().min(0).optional().default(0),
  withTotal: z.enum(["true", "false"]).optional(),
});

const listCategoriesQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(500).optional(),
  offset: z.coerce.number().min(0).optional().default(0),
  withTotal: z.enum(["true", "false"]).optional(),
});

/** Express can pass repeated keys as string[]; clients may send empty strings. */
function normalizeListQuery(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(query)) {
    let v: unknown = Array.isArray(val) ? val[0] : val;
    if (v === "" || v === undefined || v === null) continue;
    if (typeof v === "string") {
      v = v.trim();
      if (v === "") continue;
    }
    out[key] = v;
  }

  /** Accept snake_case query aliases (manual URL / proxies). */
  if (!out.categoryId && out.category_id) {
    out.categoryId = out.category_id;
  }
  delete out.category_id;
  if (!out.supplierId && out.supplier_id) {
    out.supplierId = out.supplier_id;
  }
  delete out.supplier_id;

  /**
   * Resolve status filter once: prefer `isActive`, else `is_active`. Drop both first so duplicate
   * query keys (e.g. `isActive=true&is_active=false`) cannot leave the list handler in an invalid state.
   */
  const iaRaw = out.isActive !== undefined && out.isActive !== null && out.isActive !== "" ? out.isActive : out.is_active;
  delete out.is_active;
  delete out.isActive;

  if (iaRaw === true || iaRaw === "true" || iaRaw === 1 || iaRaw === "1") {
    out.isActive = "true";
  } else if (iaRaw === false || iaRaw === "false" || iaRaw === 0 || iaRaw === "0") {
    out.isActive = "false";
  } else if (typeof iaRaw === "string") {
    const s = iaRaw.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes" || s === "on") {
      out.isActive = "true";
    } else if (s === "false" || s === "0" || s === "no" || s === "off") {
      out.isActive = "false";
    }
  }

  return out;
}

router.get("/", requireAuth, async (req, res) => {
  const parsed = listProductsQuerySchema.safeParse(normalizeListQuery(req.query as Record<string, unknown>));
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid query params", errors: parsed.error.flatten() });
  }
  const filters = parsed.data;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  const q = filters.q?.trim();
  if (q) {
    conditions.push(`(p.name ILIKE $${i} OR p.sku ILIKE $${i} OR p.barcode ILIKE $${i})`);
    params.push(`%${q}%`);
    i += 1;
  }
  if (filters.categoryId) {
    conditions.push(`p.category_id = $${i}`);
    params.push(filters.categoryId);
    i += 1;
  }
  if (filters.supplierId) {
    conditions.push(
      `EXISTS (SELECT 1 FROM supplier_products sp WHERE sp.product_id = p.id AND sp.supplier_id = $${i}::uuid)`,
    );
    params.push(filters.supplierId);
    i += 1;
  }
  if (filters.isActive === "true") {
    conditions.push(`p.is_active = TRUE`);
  } else if (filters.isActive === "false") {
    conditions.push(`p.is_active = FALSE`);
  }
  if (filters.minSalePrice !== undefined) {
    conditions.push(`p.sale_price >= $${i}`);
    params.push(filters.minSalePrice);
    i += 1;
  }
  if (filters.maxSalePrice !== undefined) {
    conditions.push(`p.sale_price <= $${i}`);
    params.push(filters.maxSalePrice);
    i += 1;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const orderByMap: Record<string, string> = {
    created_desc: "p.created_at DESC",
    created_asc: "p.created_at ASC",
    name_asc: "p.name ASC",
    name_desc: "p.name DESC",
    sale_asc: "p.sale_price ASC NULLS LAST",
    sale_desc: "p.sale_price DESC NULLS LAST",
  };
  const orderBy = orderByMap[filters.sort] ?? orderByMap.created_desc;

  const countParams = [...params];
  const countResult = await pool.query(
    `
      SELECT COUNT(*)::int AS total
      FROM products p
      ${whereClause}
    `,
    countParams,
  );
  const total = countResult.rows[0]?.total ?? 0;

  params.push(filters.limit);
  const limitParam = `$${i}`;
  i += 1;
  params.push(filters.offset);
  const offsetParam = `$${i}`;

  const result = await pool.query(
    `
      SELECT
        p.*,
        c.name AS category_name,
        COALESCE(ib.qty_on_hand, 0) AS qty_on_hand,
        ib.opening_balance AS opening_balance
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN inventory_balances ib ON ib.product_id = p.id
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
    `,
    params,
  );

  if (filters.withTotal === "true") {
    return res.json({
      items: result.rows,
      total,
      limit: filters.limit,
      offset: filters.offset,
    });
  }
  return res.json(result.rows);
});

router.get("/search/billing", requireAuth, async (req, res) => {
  const q = (req.query.q as string | undefined)?.trim();
  if (!q || q.length < 2) {
    return res.status(400).json({ message: "Query must be at least 2 characters" });
  }

  const rows = await pool.query(
    `
      (
        SELECT
          p.id AS product_id,
          NULL::uuid AS variant_id,
          p.name AS display_name,
          p.sku,
          p.barcode,
          p.sale_price AS sale_price,
          c.name AS category_name,
          p.category_id,
          p.image_url,
          p.tax_rate,
          FALSE AS is_variant,
          COALESCE(ib.qty_on_hand, 0) AS qty_on_hand
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN inventory_balances ib ON ib.product_id = p.id
        WHERE p.is_active = TRUE
          AND (p.barcode = $1 OR p.sku = $1)
        LIMIT 20
      )
      UNION ALL
      (
        SELECT
          p.id AS product_id,
          pv.id AS variant_id,
          CONCAT(p.name, ' - ', pv.name) AS display_name,
          pv.sku,
          pv.barcode,
          COALESCE(pv.sale_price, p.sale_price) AS sale_price,
          c.name AS category_name,
          p.category_id,
          p.image_url,
          p.tax_rate,
          TRUE AS is_variant,
          COALESCE(ib.qty_on_hand, 0) AS qty_on_hand
        FROM product_variants pv
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN inventory_balances ib ON ib.product_id = p.id
        WHERE pv.is_active = TRUE
          AND (
            pv.barcode = $1
            OR pv.sku = $1
            OR CONCAT(p.name, ' ', pv.name) ILIKE $2
          )
        LIMIT 20
      )
      LIMIT 40
    `,
    [q, `%${q}%`],
  );

  if (rows.rowCount === 0) {
    const fallback = await pool.query(
      `
        SELECT
          p.id AS product_id,
          NULL::uuid AS variant_id,
          p.name AS display_name,
          p.sku,
          p.barcode,
          p.sale_price AS sale_price,
          c.name AS category_name,
          p.category_id,
          p.image_url,
          p.tax_rate,
          FALSE AS is_variant,
          COALESCE(ib.qty_on_hand, 0) AS qty_on_hand
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN inventory_balances ib ON ib.product_id = p.id
        WHERE p.is_active = TRUE
          AND (p.name ILIKE $1 OR p.sku ILIKE $1 OR p.barcode ILIKE $1)
        ORDER BY p.name ASC
        LIMIT 200
      `,
      [`%${q}%`],
    );
    return res.json(fallback.rows);
  }

  return res.json(rows.rows);
});

router.get("/departments", requireAuth, async (_req, res) => {
  const result = await pool.query(
    `SELECT * FROM departments WHERE is_active = TRUE ORDER BY name ASC`,
  );
  return res.json(result.rows);
});

router.post("/departments", requireAuth, requireInventoryManagement, async (req, res) => {
  const schema = z.object({
    name: z.string().min(1).max(120).trim(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const inserted = await pool.query(
    `
      INSERT INTO departments (name, is_active)
      VALUES ($1, TRUE)
      RETURNING *
    `,
    [parsed.data.name],
  );

  return res.status(201).json(inserted.rows[0]);
});

router.get("/categories", requireAuth, async (req, res) => {
  const parsed = listCategoriesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid query params", errors: parsed.error.flatten() });
  }
  const { limit, offset, withTotal } = parsed.data;

  const baseFrom = `
      FROM categories c
      LEFT JOIN departments d ON d.id = c.department_id
      WHERE c.is_active = TRUE
  `;

  if (withTotal === "true" && limit !== undefined) {
    const countResult = await pool.query(`SELECT COUNT(*)::int AS total ${baseFrom}`);
    const total = countResult.rows[0]?.total ?? 0;
    const result = await pool.query(
      `
        SELECT
          c.*,
          d.name AS department_name
        ${baseFrom}
        ORDER BY c.name ASC
        LIMIT $1
        OFFSET $2
      `,
      [limit, offset],
    );
    return res.json({ items: result.rows, total, limit, offset });
  }

  const result = await pool.query(
    `
      SELECT
        c.*,
        d.name AS department_name
      ${baseFrom}
      ORDER BY c.name ASC
    `,
  );
  return res.json(result.rows);
});

router.post("/categories", requireAuth, requireInventoryManagement, async (req, res) => {
  const schema = z.object({
    name: z.string().min(2).max(100),
    description: z.string().max(300).optional(),
    departmentId: z.string().uuid().optional().nullable(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  if (parsed.data.departmentId) {
    const dept = await pool.query(`SELECT id FROM departments WHERE id = $1 AND is_active = TRUE`, [
      parsed.data.departmentId,
    ]);
    if (dept.rowCount === 0) {
      return res.status(400).json({ message: "Department not found or inactive" });
    }
  }

  const inserted = await pool.query(
    `
      INSERT INTO categories (name, description, is_active, department_id)
      VALUES ($1, $2, TRUE, $3)
      RETURNING *
    `,
    [parsed.data.name, parsed.data.description ?? null, parsed.data.departmentId ?? null],
  );

  const withDept = await pool.query(
    `
      SELECT c.*, d.name AS department_name
      FROM categories c
      LEFT JOIN departments d ON d.id = c.department_id
      WHERE c.id = $1
    `,
    [inserted.rows[0].id],
  );

  return res.status(201).json(withDept.rows[0]);
});

router.patch("/categories/:id", requireAuth, requireInventoryManagement, async (req, res) => {
  const schema = z.object({
    name: z.string().min(2).max(100).optional(),
    description: z.string().max(300).optional().nullable(),
    departmentId: z.string().uuid().optional().nullable(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const current = await pool.query(`SELECT * FROM categories WHERE id = $1`, [req.params.id]);
  if (current.rowCount === 0) {
    return res.status(404).json({ message: "Category not found" });
  }

  const payload = parsed.data;
  if (payload.departmentId) {
    const dept = await pool.query(`SELECT id FROM departments WHERE id = $1 AND is_active = TRUE`, [
      payload.departmentId,
    ]);
    if (dept.rowCount === 0) {
      return res.status(400).json({ message: "Department not found or inactive" });
    }
  }

  const assignments: string[] = [];
  const values: unknown[] = [];
  let p = 1;

  const push = (sqlFragment: string, val: unknown) => {
    assignments.push(`${sqlFragment} $${p}`);
    values.push(val);
    p += 1;
  };

  if (payload.name !== undefined) push("name =", payload.name);
  if (payload.description !== undefined) push("description =", payload.description);
  if (payload.departmentId !== undefined) push("department_id =", payload.departmentId);

  if (assignments.length === 0) {
    return res.status(400).json({
      message: "No fields to update. Send at least one of: name, description, departmentId.",
    });
  }

  values.push(req.params.id);
  const idPlaceholder = `$${p}`;

  await pool.query(
    `
      UPDATE categories
      SET ${assignments.join(", ")}, updated_at = NOW()
      WHERE id = ${idPlaceholder}
    `,
    values,
  );

  const refreshed = await pool.query(
    `
      SELECT c.*, d.name AS department_name
      FROM categories c
      LEFT JOIN departments d ON d.id = c.department_id
      WHERE c.id = $1
    `,
    [req.params.id],
  );

  return res.json(refreshed.rows[0]);
});

router.post("/categories/bulk-delete", requireAuth, requireInventoryManagement, async (req, res) => {
  const parsed = bulkDeleteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const client = await pool.connect();
  const failed: { id: string; message: string }[] = [];
  let deletedCount = 0;

  try {
    await client.query("BEGIN");
    for (const id of parsed.data.ids) {
      try {
        const current = await client.query(`SELECT * FROM categories WHERE id = $1`, [id]);
        if (current.rowCount === 0) {
          failed.push({ id, message: "Category not found" });
          continue;
        }
        const result = await hardDeleteCategory(client, id, req.user?.id ?? null);
        if (!result.ok) {
          failed.push({ id, message: result.message });
          continue;
        }
        deletedCount += 1;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Delete failed";
        failed.push({ id, message });
      }
    }
    await client.query("COMMIT");
    return res.json({ deletedCount, failedCount: failed.length, failed });
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Bulk delete failed";
    return res.status(500).json({ message });
  } finally {
    client.release();
  }
});

router.delete("/categories/:id", requireAuth, requireInventoryManagement, async (req, res) => {
  const id = paramId(req.params.id);
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ message: "Invalid category id" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(`SELECT * FROM categories WHERE id = $1`, [id]);
    if (current.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Category not found" });
    }
    const result = await hardDeleteCategory(client, id, req.user?.id ?? null);
    if (!result.ok) {
      await client.query("ROLLBACK");
      return res.status(result.status).json({ message: result.message });
    }
    await client.query("COMMIT");
    return res.json(result.row);
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Delete failed";
    return res.status(500).json({ message });
  } finally {
    client.release();
  }
});

async function getProductDeleteBlockReason(
  client: PoolClient,
  productId: string,
): Promise<string | null> {
  const checks: Array<{ sql: string; label: string }> = [
    { sql: `SELECT 1 FROM order_items WHERE product_id = $1 LIMIT 1`, label: "sales orders" },
    { sql: `SELECT 1 FROM invoice_items WHERE product_id = $1 LIMIT 1`, label: "invoices" },
    {
      sql: `SELECT 1 FROM purchase_receipt_items WHERE product_id = $1 LIMIT 1`,
      label: "purchase receipts",
    },
    {
      sql: `SELECT 1 FROM purchase_invoice_lines WHERE product_id = $1 LIMIT 1`,
      label: "supplier purchase invoices",
    },
  ];
  for (const { sql, label } of checks) {
    const hit = await client.query(sql, [productId]);
    if ((hit.rowCount ?? 0) > 0) {
      return `Cannot delete: product is used on ${label}.`;
    }
  }
  return null;
}

async function hardDeleteProduct(
  client: PoolClient,
  productId: string,
  actorUserId: string | null,
): Promise<{ ok: true; row: Record<string, unknown> } | { ok: false; message: string; status: number }> {
  const current = await client.query(`SELECT * FROM products WHERE id = $1`, [productId]);
  if (current.rowCount === 0) {
    return { ok: false, message: "Product not found", status: 404 };
  }
  const blockReason = await getProductDeleteBlockReason(client, productId);
  if (blockReason) {
    return { ok: false, message: blockReason, status: 409 };
  }
  await client.query(`DELETE FROM products WHERE id = $1`, [productId]);
  await createAuditLog({
    client,
    actorUserId,
    action: "delete_product",
    entity: "products",
    entityId: productId,
    beforeData: current.rows[0] as Record<string, unknown>,
    afterData: null,
  });
  return { ok: true, row: current.rows[0] as Record<string, unknown> };
}

async function hardDeleteCategory(
  client: PoolClient,
  categoryId: string,
  actorUserId: string | null,
): Promise<{ ok: true; row: Record<string, unknown> } | { ok: false; message: string; status: number }> {
  const current = await client.query(`SELECT * FROM categories WHERE id = $1`, [categoryId]);
  if (current.rowCount === 0) {
    return { ok: false, message: "Category not found", status: 404 };
  }
  await client.query(
    `UPDATE products SET category_id = NULL, updated_at = NOW() WHERE category_id = $1`,
    [categoryId],
  );
  await client.query(`DELETE FROM categories WHERE id = $1`, [categoryId]);
  await createAuditLog({
    client,
    actorUserId,
    action: "delete_category",
    entity: "categories",
    entityId: categoryId,
    beforeData: current.rows[0] as Record<string, unknown>,
    afterData: null,
  });
  return { ok: true, row: current.rows[0] as Record<string, unknown> };
}

router.post("/bulk-delete", requireAuth, requireInventoryManagement, async (req, res) => {
  const parsed = bulkDeleteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const client = await pool.connect();
  const failed: { id: string; message: string }[] = [];
  let deletedCount = 0;

  try {
    await client.query("BEGIN");
    for (const id of parsed.data.ids) {
      const result = await hardDeleteProduct(client, id, req.user?.id ?? null);
      if (result.ok) {
        deletedCount += 1;
      } else {
        failed.push({ id, message: result.message });
      }
    }
    await client.query("COMMIT");
    return res.json({ deletedCount, failedCount: failed.length, failed });
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Bulk delete failed";
    return res.status(500).json({ message });
  } finally {
    client.release();
  }
});

router.delete("/:id", requireAuth, requireInventoryManagement, async (req, res) => {
  const id = paramId(req.params.id);
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ message: "Invalid product id" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await hardDeleteProduct(client, id, req.user?.id ?? null);
    if (!result.ok) {
      await client.query("ROLLBACK");
      return res.status(result.status).json({ message: result.message });
    }
    await client.query("COMMIT");
    return res.json(result.row);
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Delete failed";
    return res.status(500).json({ message });
  } finally {
    client.release();
  }
});

router.post("/", requireAuth, requireInventoryManagement, async (req, res) => {
  const parsed = createProductSchema.safeParse(normalizeProductMutationBody(req.body));
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `
        INSERT INTO products (name, sku, barcode, sale_price, cost_price, tax_rate, image_url, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `,
      [
        parsed.data.name,
        parsed.data.sku,
        parsed.data.barcode,
        parsed.data.salePrice,
        parsed.data.costPrice,
        parsed.data.taxRate,
        parsed.data.imageUrl ?? null,
        parsed.data.isActive ?? true,
      ],
    );

    if (parsed.data.categoryId) {
      await client.query(
        `
          UPDATE products
          SET category_id = $2, low_stock_threshold = $3
          WHERE id = $1
        `,
        [inserted.rows[0].id, parsed.data.categoryId, parsed.data.lowStockThreshold],
      );
      const refreshed = await client.query(`SELECT * FROM products WHERE id = $1`, [inserted.rows[0].id]);
      inserted.rows[0] = refreshed.rows[0];
    } else {
      await client.query(
        `
          UPDATE products
          SET low_stock_threshold = $2
          WHERE id = $1
        `,
        [inserted.rows[0].id, parsed.data.lowStockThreshold],
      );
      const refreshed = await client.query(`SELECT * FROM products WHERE id = $1`, [inserted.rows[0].id]);
      inserted.rows[0] = refreshed.rows[0];
    }

    await createAuditLog({
      client,
      actorUserId: req.user?.id ?? null,
      action: "create_product",
      entity: "products",
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

/** Coerce explicit isActive / is_active from JSON body (handles strings; ignores missing keys). */
function coerceExplicitIsActive(raw: Record<string, unknown>): boolean | undefined {
  const pick = (v: unknown): boolean | undefined => {
    if (typeof v === "boolean") {
      return v;
    }
    if (typeof v === "number") {
      return v !== 0;
    }
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (s === "true" || s === "1") {
        return true;
      }
      if (s === "false" || s === "0") {
        return false;
      }
    }
    return undefined;
  };

  if (Object.prototype.hasOwnProperty.call(raw, "isActive")) {
    return pick(raw.isActive);
  }
  if (Object.prototype.hasOwnProperty.call(raw, "is_active")) {
    return pick(raw.is_active);
  }
  return undefined;
}

/** Bypass Zod edge cases — read boolean from JSON / form-style strings explicitly. */
function readIsActiveFromBody(body: unknown): boolean | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  return coerceExplicitIsActive(body as Record<string, unknown>);
}

router.patch("/:id", requireAuth, requireInventoryManagement, async (req, res) => {
  const parsed = patchProductBodySchema.safeParse(normalizeProductMutationBody(req.body));
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }
  const payload = parsed.data;

  const current = await pool.query(`SELECT * FROM products WHERE id = $1`, [req.params.id]);
  if (current.rowCount === 0) {
    return res.status(404).json({ message: "Product not found" });
  }

  const assignments: string[] = [];
  const values: unknown[] = [];
  let p = 1;

  const push = (sqlFragment: string, val: unknown) => {
    assignments.push(`${sqlFragment} $${p}`);
    values.push(val);
    p += 1;
  };

  if (payload.name !== undefined) push("name =", payload.name);
  if (payload.sku !== undefined) push("sku =", payload.sku);
  if (payload.barcode !== undefined) push("barcode =", payload.barcode);
  if (payload.salePrice !== undefined) push("sale_price =", payload.salePrice);
  if (payload.costPrice !== undefined) push("cost_price =", payload.costPrice);
  if (payload.taxRate !== undefined) push("tax_rate =", payload.taxRate);
  if (payload.categoryId !== undefined) push("category_id =", payload.categoryId);
  if (payload.lowStockThreshold !== undefined) push("low_stock_threshold =", payload.lowStockThreshold);
  if (payload.imageUrl !== undefined) push("image_url =", payload.imageUrl);

  /** Own-key body values win over parsed payload so JSON `false`/`true` always reaches SQL. */
  const rawBody =
    req.body !== null && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : null;
  const fromOwnKeys = rawBody ? coerceExplicitIsActive(rawBody) : undefined;
  const resolvedActive = fromOwnKeys !== undefined ? fromOwnKeys : payload.isActive;
  if (resolvedActive !== undefined) push("is_active =", resolvedActive);

  if (assignments.length === 0) {
    return res.status(400).json({
      message:
        "No fields to update. Send JSON body with at least one of: name, sku, barcode, salePrice, costPrice, taxRate, imageUrl, categoryId, lowStockThreshold, isActive.",
    });
  }

  values.push(req.params.id);
  const idPlaceholder = `$${p}`;

  const updated = await pool.query(
    `
      UPDATE products
      SET ${assignments.join(", ")}, updated_at = NOW()
      WHERE id = ${idPlaceholder}
      RETURNING *
    `,
    values,
  );

  return res.json(updated.rows[0]);
});

router.get("/:id/variants", requireAuth, async (req, res) => {
  const variants = await pool.query(
    `
      SELECT *
      FROM product_variants
      WHERE product_id = $1
      ORDER BY created_at DESC
    `,
    [req.params.id],
  );
  return res.json(variants.rows);
});

router.post("/:id/variants", requireAuth, requireInventoryManagement, async (req, res) => {
  const schema = z.object({
    sku: z.string().min(2),
    barcode: z.string().min(3).optional(),
    name: z.string().min(2),
    attributes: z.record(z.string(), z.string()).default({}),
    salePrice: z.number().positive().optional(),
    costPrice: z.number().nonnegative().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const productExists = await pool.query(`SELECT id FROM products WHERE id = $1`, [req.params.id]);
  if (productExists.rowCount === 0) {
    return res.status(404).json({ message: "Product not found" });
  }

  const inserted = await pool.query(
    `
      INSERT INTO product_variants
        (product_id, sku, barcode, name, attributes, sale_price, cost_price, is_active)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, TRUE)
      RETURNING *
    `,
    [
      req.params.id,
      parsed.data.sku,
      parsed.data.barcode ?? null,
      parsed.data.name,
      parsed.data.attributes,
      parsed.data.salePrice ?? null,
      parsed.data.costPrice ?? null,
    ],
  );

  return res.status(201).json(inserted.rows[0]);
});

export default router;
