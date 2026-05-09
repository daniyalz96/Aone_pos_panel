import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

async function runMigrations() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const migrationsDir = path.resolve(__dirname, "../../migrations");

  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    const sql = await fs.readFile(filePath, "utf-8");
    // SQL files are idempotent with IF NOT EXISTS.
    await pool.query(sql);
    // eslint-disable-next-line no-console
    console.log(`Applied migration: ${file}`);
  }
}

runMigrations()
  .then(async () => {
    await pool.end();
    // eslint-disable-next-line no-console
    console.log("Migrations completed.");
  })
  .catch(async (error) => {
    // eslint-disable-next-line no-console
    console.error("Migration failed:", error);
    await pool.end();
    process.exit(1);
  });
