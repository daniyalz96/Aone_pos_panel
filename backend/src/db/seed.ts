import bcrypt from "bcryptjs";
import { pool } from "./pool.js";

async function seed() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      INSERT INTO roles (name)
      VALUES ('admin'), ('manager'), ('cashier')
      ON CONFLICT (name) DO NOTHING
    `);

    await client.query(`
      INSERT INTO permissions (key)
      VALUES
        ('price_override'),
        ('discount_override'),
        ('refund_approve'),
        ('void_bill'),
        ('manage_users'),
        ('manage_inventory'),
        ('open_close_drawer')
      ON CONFLICT (key) DO NOTHING
    `);

    await client.query(`
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id
      FROM roles r
      JOIN permissions p ON p.key IN (
        'price_override',
        'discount_override',
        'refund_approve',
        'void_bill',
        'manage_users',
        'manage_inventory',
        'open_close_drawer'
      )
      WHERE r.name = 'admin'
      ON CONFLICT DO NOTHING
    `);

    await client.query(`
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id
      FROM roles r
      JOIN permissions p ON p.key IN (
        'price_override',
        'discount_override',
        'refund_approve',
        'void_bill',
        'manage_inventory',
        'open_close_drawer'
      )
      WHERE r.name = 'manager'
      ON CONFLICT DO NOTHING
    `);

    await client.query(`
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id
      FROM roles r
      JOIN permissions p ON p.key IN ('open_close_drawer')
      WHERE r.name = 'cashier'
      ON CONFLICT DO NOTHING
    `);

    const passwordHash = await bcrypt.hash("Admin@123", 10);
    const userInsert = await client.query(
      `
      INSERT INTO users (full_name, email, password_hash, is_active)
      VALUES ($1, $2, $3, TRUE)
      ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
      RETURNING id
    `,
      ["System Admin", "admin@pos.local", passwordHash],
    );

    const userId = userInsert.rows[0].id as string;
    await client.query(
      `
      INSERT INTO user_roles (user_id, role_id)
      SELECT $1, id FROM roles WHERE name = 'admin'
      ON CONFLICT DO NOTHING
    `,
      [userId],
    );

    await client.query(`
      INSERT INTO ledger_accounts (code, name, type)
      VALUES
        ('1000', 'Cash', 'asset'),
        ('1010', 'Bank', 'asset'),
        ('1100', 'Accounts Receivable', 'asset'),
        ('1200', 'Inventory', 'asset'),
        ('2200', 'Accounts Payable', 'liability'),
        ('3100', 'Opening Balance Clearing', 'equity'),
        ('4000', 'Sales Revenue', 'income'),
        ('2100', 'Tax Payable', 'liability'),
        ('5000', 'Sales Return', 'expense'),
        ('6000', 'General Expense', 'expense')
      ON CONFLICT (code) DO NOTHING
    `);

    await client.query(`
      INSERT INTO branches (code, name, address, is_active)
      VALUES ('MAIN', 'Main Branch', 'Default branch', TRUE)
      ON CONFLICT (code) DO NOTHING
    `);

    await client.query("COMMIT");
    // eslint-disable-next-line no-console
    console.log("Seed completed.");
    // eslint-disable-next-line no-console
    console.log("Admin login -> email: admin@pos.local | password: Admin@123");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

seed()
  .then(async () => {
    await pool.end();
  })
  .catch(async (error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    await pool.end();
    process.exit(1);
  });
