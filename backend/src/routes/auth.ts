import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { signAccessToken } from "../utils/jwt.js";

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid login payload", errors: parsed.error.flatten() });
  }

  const { email, password } = parsed.data;

  const userResult = await pool.query(
    `
      SELECT id, email, password_hash
      FROM users
      WHERE email = $1 AND is_active = TRUE
    `,
    [email],
  );

  if (userResult.rowCount === 0) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  const user = userResult.rows[0];
  const isValid = await bcrypt.compare(password, user.password_hash as string);
  if (!isValid) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  const accessToken = signAccessToken({ sub: user.id as string, email: user.email as string });
  return res.json({ accessToken });
});

router.get("/me", requireAuth, async (req, res) => {
  return res.json({
    id: req.user?.id,
    email: req.user?.email,
    roles: req.user?.roles ?? [],
    permissions: req.user?.permissions ?? [],
  });
});

export default router;
