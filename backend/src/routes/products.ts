import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, requireInventoryManagement } from "../middleware/auth.js";
import { createAuditLog } from "../utils/audit.js";

const router = Router();

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
  lowStockThreshold: z.number().min(0).default(5),
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
  isActive: z.enum(["true", "false"]).optional(),
  minSalePrice: z.coerce.number().nonnegative().optional(),
  maxSalePrice: z.coerce.number().nonnegative().optional(),
  sort: z
    .enum(["created_desc", "created_asc", "name_asc", "name_desc", "sale_asc", "sale_desc"])
    .optional()
    .default("created_desc"),
  limit: z.coerce.number().min(1).max(500).optional().default(200),
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

  params.push(filters.limit);
  const limitParam = `$${i}`;

  const result = await pool.query(
    `
      SELECT p.*, c.name AS category_name
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT ${limitParam}
    `,
    params,
  );
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
          p.image_url,
          p.tax_rate,
          FALSE AS is_variant
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
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
          p.image_url,
          p.tax_rate,
          TRUE AS is_variant
        FROM product_variants pv
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN categories c ON c.id = p.category_id
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
          p.image_url,
          p.tax_rate,
          FALSE AS is_variant
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.is_active = TRUE
          AND (p.name ILIKE $1 OR p.sku ILIKE $1 OR p.barcode ILIKE $1)
        ORDER BY p.name ASC
        LIMIT 40
      `,
      [`%${q}%`],
    );
    return res.json(fallback.rows);
  }

  return res.json(rows.rows);
});

router.get("/categories", requireAuth, async (_req, res) => {
  const result = await pool.query(
    `SELECT * FROM categories WHERE is_active = TRUE ORDER BY name ASC`,
  );
  return res.json(result.rows);
});

router.post("/categories", requireAuth, requireInventoryManagement, async (req, res) => {
  const schema = z.object({
    name: z.string().min(2).max(100),
    description: z.string().max(300).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const inserted = await pool.query(
    `
      INSERT INTO categories (name, description, is_active)
      VALUES ($1, $2, TRUE)
      RETURNING *
    `,
    [parsed.data.name, parsed.data.description ?? null],
  );

  return res.status(201).json(inserted.rows[0]);
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
