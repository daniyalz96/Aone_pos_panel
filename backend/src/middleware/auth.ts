import type { NextFunction, Request, Response } from "express";
import { pool } from "../db/pool.js";
import { verifyAccessToken } from "../utils/jwt.js";

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const token = authHeader.replace("Bearer ", "").trim();

  try {
    const payload = verifyAccessToken(token);

    const userQuery = await pool.query(
      `
        SELECT u.id, u.email
        FROM users u
        WHERE u.id = $1 AND u.is_active = TRUE
      `,
      [payload.sub],
    );

    if (userQuery.rowCount === 0) {
      return res.status(401).json({ message: "Invalid user" });
    }

    const rolesQuery = await pool.query(
      `
        SELECT r.name
        FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = $1
      `,
      [payload.sub],
    );

    const permissionsQuery = await pool.query(
      `
        SELECT DISTINCT p.key
        FROM user_roles ur
        JOIN role_permissions rp ON rp.role_id = ur.role_id
        JOIN permissions p ON p.id = rp.permission_id
        WHERE ur.user_id = $1
      `,
      [payload.sub],
    );

    req.user = {
      id: userQuery.rows[0].id,
      email: userQuery.rows[0].email,
      roles: rolesQuery.rows.map((row: { name: string }) => row.name),
      permissions: permissionsQuery.rows.map((row: { key: string }) => row.key),
    };

    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const userRoles = req.user?.roles ?? [];
    const allowed = roles.some((role) => userRoles.includes(role));
    if (!allowed) {
      return res.status(403).json({ message: "Forbidden" });
    }
    next();
  };
}

export function requirePermission(...permissions: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const userPermissions = req.user?.permissions ?? [];
    const allowed = permissions.every((permission) => userPermissions.includes(permission));
    if (!allowed) {
      return res.status(403).json({ message: "Missing permission" });
    }
    next();
  };
}

/** Product/inventory writes: explicit permission or admin/manager role (covers stale permission rows). */
export function requireInventoryManagement(req: Request, res: Response, next: NextFunction) {
  const perms = req.user?.permissions ?? [];
  const roles = req.user?.roles ?? [];
  if (perms.includes("manage_inventory")) {
    next();
    return;
  }
  if (roles.includes("admin") || roles.includes("manager")) {
    next();
    return;
  }
  return res.status(403).json({ message: "Missing permission" });
}
