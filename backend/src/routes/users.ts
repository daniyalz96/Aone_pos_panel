import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { createAuditLog } from "../utils/audit.js";

const router = Router();

const createUserSchema = z.object({
  fullName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["admin", "manager", "cashier"]),
});

router.get("/", requireAuth, requirePermission("manage_users"), async (_req, res) => {
  const users = await pool.query(
    `
      SELECT u.id, u.full_name, u.email, u.is_active, u.created_at, r.name AS role
      FROM users u
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN roles r ON r.id = ur.role_id
      ORDER BY u.created_at DESC
    `,
  );

  return res.json(users.rows);
});

router.post("/", requireAuth, requirePermission("manage_users"), async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const passwordHash = await bcrypt.hash(parsed.data.password, 10);

    const newUser = await client.query(
      `
        INSERT INTO users (full_name, email, password_hash, is_active)
        VALUES ($1, $2, $3, TRUE)
        RETURNING id, full_name, email, is_active, created_at
      `,
      [parsed.data.fullName, parsed.data.email, passwordHash],
    );

    await client.query(
      `
        INSERT INTO user_roles (user_id, role_id)
        SELECT $1, id FROM roles WHERE name = $2
      `,
      [newUser.rows[0].id, parsed.data.role],
    );

    await createAuditLog({
      client,
      actorUserId: req.user?.id ?? null,
      action: "create_user",
      entity: "users",
      entityId: newUser.rows[0].id as string,
      afterData: {
        fullName: parsed.data.fullName,
        email: parsed.data.email,
        role: parsed.data.role,
      },
    });

    await client.query("COMMIT");
    return res.status(201).json(newUser.rows[0]);
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(500).json({ message });
  } finally {
    client.release();
  }
});

router.patch("/:id/active", requireAuth, requirePermission("manage_users"), async (req, res) => {
  const schema = z.object({ isActive: z.boolean() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const entityId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const before = await client.query(
      `SELECT id, full_name, email, is_active FROM users WHERE id = $1`,
      [entityId],
    );
    if (before.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "User not found" });
    }

    const updated = await client.query(
      `
        UPDATE users SET is_active = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING id, full_name, email, is_active
      `,
      [entityId, parsed.data.isActive],
    );

    await createAuditLog({
      client,
      actorUserId: req.user?.id ?? null,
      action: "toggle_user_active",
      entity: "users",
      entityId: entityId ?? null,
      beforeData: before.rows[0],
      afterData: updated.rows[0],
    });

    await client.query("COMMIT");
    return res.json(updated.rows[0]);
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(500).json({ message });
  } finally {
    client.release();
  }
});

export default router;
