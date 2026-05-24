import { pool } from "../db/pool.js";
import { DEFAULT_LOW_STOCK_THRESHOLD } from "../config/inventory.js";

async function insertNotificationIfOpen(params: {
  type: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  dedupeKey: string;
  sourceType?: string;
  sourceId?: string;
  metadata?: Record<string, unknown>;
}) {
  const existing = await pool.query(
    `
      SELECT id
      FROM notifications
      WHERE dedupe_key = $1
        AND acknowledged = FALSE
      LIMIT 1
    `,
    [params.dedupeKey],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    return null;
  }

  const inserted = await pool.query(
    `
      INSERT INTO notifications
        (type, severity, title, message, acknowledged, dedupe_key, source_type, source_id, metadata)
      VALUES
        ($1, $2, $3, $4, FALSE, $5, $6, $7, $8)
      RETURNING *
    `,
    [
      params.type,
      params.severity,
      params.title,
      params.message,
      params.dedupeKey,
      params.sourceType ?? null,
      params.sourceId ?? null,
      params.metadata ?? null,
    ],
  );
  return inserted.rows[0];
}

function formatQty(qty: number) {
  const rounded = Math.round(qty * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(3);
}

/** Create a low-stock notification for one product when qty is at/below its effective threshold. */
export async function notifyLowStockForProduct(
  productId: string,
  fallbackThreshold: number = DEFAULT_LOW_STOCK_THRESHOLD,
) {
  const result = await pool.query(
    `
      SELECT
        p.id AS product_id,
        p.name,
        p.sku,
        p.low_stock_threshold,
        COALESCE(ib.qty_on_hand, 0) AS qty_on_hand
      FROM products p
      LEFT JOIN inventory_balances ib ON ib.product_id = p.id
      WHERE p.id = $1
        AND p.is_active = TRUE
        AND COALESCE(ib.qty_on_hand, 0) <= GREATEST(p.low_stock_threshold, $2)
    `,
    [productId, fallbackThreshold],
  );

  if (!result.rowCount) return null;

  const row = result.rows[0];
  const qty = Number(row.qty_on_hand);
  return insertNotificationIfOpen({
    type: "low_stock",
    severity: qty <= 0 ? "critical" : "warning",
    title: "Low stock alert",
    message: `${row.name as string} (${row.sku as string}) has ${formatQty(qty)} left in stock`,
    dedupeKey: `low_stock:${row.product_id as string}`,
    sourceType: "product",
    sourceId: row.product_id as string,
    metadata: {
      qtyOnHand: qty,
      threshold: Number(row.low_stock_threshold),
    },
  });
}

/** Scan all products and open notifications for items at/below the effective threshold. */
export async function syncLowStockNotifications(fallbackThreshold: number = DEFAULT_LOW_STOCK_THRESHOLD) {
  const lowStockRows = await pool.query(
    `
      SELECT
        p.id AS product_id,
        p.name,
        p.sku,
        p.low_stock_threshold,
        COALESCE(ib.qty_on_hand, 0) AS qty_on_hand
      FROM products p
      LEFT JOIN inventory_balances ib ON ib.product_id = p.id
      WHERE p.is_active = TRUE
        AND COALESCE(ib.qty_on_hand, 0) <= GREATEST(p.low_stock_threshold, $1)
      ORDER BY qty_on_hand ASC
      LIMIT 200
    `,
    [fallbackThreshold],
  );

  const created: unknown[] = [];
  for (const row of lowStockRows.rows) {
    const qty = Number(row.qty_on_hand);
    const inserted = await insertNotificationIfOpen({
      type: "low_stock",
      severity: qty <= 0 ? "critical" : "warning",
      title: "Low stock alert",
      message: `${row.name as string} (${row.sku as string}) has ${formatQty(qty)} left in stock`,
      dedupeKey: `low_stock:${row.product_id as string}`,
      sourceType: "product",
      sourceId: row.product_id as string,
      metadata: {
        qtyOnHand: qty,
        threshold: Number(row.low_stock_threshold),
      },
    });
    if (inserted) created.push(inserted);
  }
  return created;
}
