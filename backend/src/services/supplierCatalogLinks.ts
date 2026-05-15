import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import { supplierBalanceAndCatalogSelect } from "../db/supplierAggregatesSql.js";

function parseJsonArrayField(raw: unknown): unknown[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw) as unknown;
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(raw)) {
    try {
      const p = JSON.parse(raw.toString("utf8")) as unknown;
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

function numField(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Stable JSON shape for API clients (always includes catalog + balance fields). */
export function supplierToPublicJson(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    linked_categories: parseJsonArrayField(row.linked_categories),
    linked_products: parseJsonArrayField(row.linked_products),
    total_balance: numField(row.total_balance),
    paid_balance: numField(row.paid_balance),
    current_balance: numField(row.current_balance),
    ledger_balance: numField(row.ledger_balance),
  };
}

export async function replaceSupplierCatalogLinks(
  client: PoolClient,
  supplierId: string,
  categoryIds: string[] | undefined,
  productIds: string[] | undefined,
) {
  if (categoryIds !== undefined) {
    await client.query(`DELETE FROM supplier_categories WHERE supplier_id = $1`, [supplierId]);
    for (const cid of categoryIds) {
      const chk = await client.query(`SELECT id FROM categories WHERE id = $1`, [cid]);
      if (chk.rowCount && chk.rowCount > 0) {
        await client.query(
          `INSERT INTO supplier_categories (supplier_id, category_id) VALUES ($1, $2)`,
          [supplierId, cid],
        );
      }
    }
  }
  if (productIds !== undefined) {
    await client.query(`DELETE FROM supplier_products WHERE supplier_id = $1`, [supplierId]);
    for (const pid of productIds) {
      const chk = await client.query(`SELECT id FROM products WHERE id = $1`, [pid]);
      if (chk.rowCount && chk.rowCount > 0) {
        await client.query(`INSERT INTO supplier_products (supplier_id, product_id) VALUES ($1, $2)`, [
          supplierId,
          pid,
        ]);
      }
    }
  }
}

export async function fetchSupplierRowWithAggregates(id: string) {
  const row = await pool.query(
    `
      SELECT s.*,
      ${supplierBalanceAndCatalogSelect}
      FROM suppliers s
      WHERE s.id = $1
    `,
    [id],
  );
  const raw = row.rows[0] as Record<string, unknown> | undefined;
  if (!raw) return null;
  return supplierToPublicJson(raw);
}
