import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";

const router = Router();

router.get("/", requireAuth, async (_req, res) => {
  const rows = await pool.query(`SELECT * FROM branches WHERE is_active = TRUE ORDER BY name ASC`);
  return res.json(rows.rows);
});

router.post("/", requireAuth, requirePermission("manage_inventory"), async (req, res) => {
  const schema = z.object({
    code: z.string().min(2).max(20),
    name: z.string().min(2).max(120),
    address: z.string().max(300).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const inserted = await pool.query(
    `
      INSERT INTO branches (code, name, address, is_active)
      VALUES ($1, $2, $3, TRUE)
      RETURNING *
    `,
    [parsed.data.code, parsed.data.name, parsed.data.address ?? null],
  );

  return res.status(201).json(inserted.rows[0]);
});

export default router;
