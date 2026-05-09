import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  const q = (req.query.q as string | undefined)?.trim();
  if (!q) {
    const result = await pool.query(`SELECT * FROM customers ORDER BY created_at DESC LIMIT 200`);
    return res.json(result.rows);
  }

  const result = await pool.query(
    `
      SELECT * FROM customers
      WHERE name ILIKE $1 OR COALESCE(phone, '') ILIKE $1 OR COALESCE(email, '') ILIKE $1
      ORDER BY created_at DESC
      LIMIT 200
    `,
    [`%${q}%`],
  );
  return res.json(result.rows);
});

router.post("/", requireAuth, async (req, res) => {
  const schema = z.object({
    name: z.string().min(2),
    phone: z.string().max(20).optional(),
    email: z.string().email().optional(),
    isWalkIn: z.boolean().default(false),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const created = await pool.query(
    `
      INSERT INTO customers (name, phone, email, is_walk_in)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `,
    [
      parsed.data.name,
      parsed.data.phone ?? null,
      parsed.data.email ?? null,
      parsed.data.isWalkIn,
    ],
  );

  return res.status(201).json(created.rows[0]);
});

router.patch("/:id/loyalty", requireAuth, async (req, res) => {
  const schema = z.object({
    pointsDelta: z.number().int(),
    note: z.string().max(200).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const customerResult = await client.query(`SELECT * FROM customers WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (customerResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Customer not found" });
    }
    const current = customerResult.rows[0];
    const nextPoints = Number(current.loyalty_points) + parsed.data.pointsDelta;
    if (nextPoints < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Insufficient loyalty points" });
    }

    const updated = await client.query(
      `UPDATE customers SET loyalty_points = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id, nextPoints],
    );

    await client.query(
      `
        INSERT INTO customer_transactions (customer_id, tx_type, amount, points)
        VALUES ($1, $2, 0, $3)
      `,
      [req.params.id, parsed.data.pointsDelta >= 0 ? "loyalty_earn" : "loyalty_redeem", parsed.data.pointsDelta],
    );

    await client.query("COMMIT");
    return res.json({ customer: updated.rows[0], note: parsed.data.note ?? null });
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(500).json({ message });
  } finally {
    client.release();
  }
});

export default router;
