import type { Application } from "express";
import multer from "multer";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, requireInventoryManagement } from "../middleware/auth.js";
import { createAuditLog } from "../utils/audit.js";
import { applyImportedProductStock, parseProductExcelBuffer } from "../utils/productExcelImport.js";

const excelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mimeOk =
      file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.mimetype === "application/vnd.ms-excel" ||
      file.mimetype === "application/octet-stream";
    const extOk = /\.xlsx$/i.test(file.originalname) || /\.xls$/i.test(file.originalname);
    if (mimeOk || extOk) cb(null, true);
    else cb(new Error("Upload an Excel file (.xlsx or .xls)."));
  },
});

const excelApplyRowSchema = z.object({
  rowNumber: z.number().int().positive(),
  categoryName: z.union([z.string().min(1).max(200), z.null()]).optional(),
  name: z.string().min(2).max(500),
  sku: z.string().min(2).max(120),
  barcode: z.string().min(3).max(120),
  salePrice: z.number().positive(),
  costPrice: z.number().nonnegative(),
  taxRate: z.number().min(0).max(100),
  qtyOnHand: z.number().nonnegative().default(0),
  openingBalance: z.number().nonnegative().nullable().optional(),
});

const excelApplyBodySchema = z.object({
  rows: z.array(excelApplyRowSchema).min(1).max(1000),
});

/** Nested under products so the main `/api/v1` router documents a single resource tree. */
const PRODUCTS_EXCEL_IMPORT = "/api/v1/products/import/excel";

const metaJson = {
  upload: { method: "POST", path: PRODUCTS_EXCEL_IMPORT, field: "excelFile" },
  apply: { method: "POST", path: `${PRODUCTS_EXCEL_IMPORT}/apply`, body: "{ rows: [...] }" },
  formats: [".xlsx", ".xls"],
};

/**
 * Multipart upload — must be registered **before** `express.json()` so the request body
 * stream is not consumed by JSON middleware (fixes missing file / routing oddities).
 */
export function registerExcelUploadRoute(app: Application): void {
  app.post(
    PRODUCTS_EXCEL_IMPORT,
    requireAuth,
    requireInventoryManagement,
    (req, res, next) => {
      excelUpload.single("excelFile")(req, res, (err: unknown) => {
        if (err) {
          const msg = err instanceof Error ? err.message : "Upload failed";
          return res.status(400).json({ message: msg });
        }
        next();
      });
    },
    async (req, res) => {
      const file = req.file;
      if (!file?.buffer) {
        return res.status(400).json({ message: 'Missing multipart field "excelFile" (Excel .xlsx / .xls).' });
      }
      try {
        const rows = parseProductExcelBuffer(file.buffer);
        return res.json({
          fileName: file.originalname,
          rowCount: rows.length,
          rows,
        });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : "Failed to parse Excel";
        return res.status(400).json({ message: msg });
      }
    },
  );
}

/** GET discovery + JSON apply — register after `express.json()`. */
export function registerExcelMetaAndApplyRoutes(app: Application): void {
  app.get(PRODUCTS_EXCEL_IMPORT, (_req, res) => {
    res.json(metaJson);
  });

  app.post(`${PRODUCTS_EXCEL_IMPORT}/apply`, requireAuth, requireInventoryManagement, async (req, res) => {
    const parsed = excelApplyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    }

    const client = await pool.connect();
    const created: Record<string, unknown>[] = [];
    const failed: { rowNumber: number; message: string }[] = [];
    const categoryByLower = new Map<string, string>();

    const resolveCategoryId = async (catName: string | null | undefined): Promise<string | null> => {
      const trimmed = typeof catName === "string" ? catName.trim() : "";
      if (!trimmed) return null;
      const key = trimmed.toLowerCase();
      const cached = categoryByLower.get(key);
      if (cached) return cached;

      const existing = await client.query<{ id: string }>(
        `SELECT id FROM categories WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) LIMIT 1`,
        [trimmed],
      );
      if (existing.rows[0]) {
        categoryByLower.set(key, existing.rows[0].id);
        return existing.rows[0].id;
      }

      const insertedCat = await client.query<{ id: string }>(
        `
        INSERT INTO categories (name, description, is_active)
        VALUES ($1, NULL, TRUE)
        RETURNING id
      `,
        [trimmed],
      );
      categoryByLower.set(key, insertedCat.rows[0].id);
      return insertedCat.rows[0].id;
    };

    try {
      await client.query("BEGIN");

      for (const row of parsed.data.rows) {
        await client.query("SAVEPOINT excel_import_row");
        try {
          const categoryId = await resolveCategoryId(row.categoryName ?? null);

          const inserted = await client.query(
            `
            INSERT INTO products (name, sku, barcode, sale_price, cost_price, tax_rate, image_url, is_active, category_id)
            VALUES ($1, $2, $3, $4, $5, $6, NULL, TRUE, $7)
            RETURNING *
          `,
            [row.name, row.sku, row.barcode, row.salePrice, row.costPrice, row.taxRate, categoryId],
          );

          const productId = inserted.rows[0].id as string;

          await createAuditLog({
            client,
            actorUserId: req.user?.id ?? null,
            action: "create_product",
            entity: "products",
            entityId: productId,
            afterData: inserted.rows[0] as Record<string, unknown>,
          });

          await applyImportedProductStock(
            client,
            productId,
            row.qtyOnHand,
            row.openingBalance ?? null,
            req.user?.id ?? null,
          );

          created.push(inserted.rows[0] as Record<string, unknown>);
          await client.query("RELEASE SAVEPOINT excel_import_row");
        } catch (error: unknown) {
          await client.query("ROLLBACK TO SAVEPOINT excel_import_row");
          const message = error instanceof Error ? error.message : "Insert failed";
          failed.push({ rowNumber: row.rowNumber, message });
        }
      }

      await client.query("COMMIT");
      return res.status(201).json({
        createdCount: created.length,
        failedCount: failed.length,
        failed,
      });
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      const message = error instanceof Error ? error.message : "Import failed";
      return res.status(500).json({ message });
    } finally {
      client.release();
    }
  });
}
