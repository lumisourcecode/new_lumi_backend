import path from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import argon2 from "argon2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "../../../../");
config({ path: path.join(backendRoot, ".env") });
import { pool } from "./client";
import { runMigrations } from "./migrations";

async function seedMainAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;

  const normalizedEmail = email.toLowerCase().trim();
  const existing = await pool.query("select id from users where email = $1", [normalizedEmail]);
  let userId: string;

  if (existing.rowCount && existing.rows[0]?.id) {
    userId = existing.rows[0].id as string;
    const passwordHash = await argon2.hash(password);
    await pool.query(
      "update users set is_super_admin = true, password_hash = $2 where id = $1",
      [userId, passwordHash],
    );
  } else {
    const passwordHash = await argon2.hash(password);
    const inserted = await pool.query(
      "insert into users (email, password_hash, is_super_admin) values ($1, $2, true) returning id",
      [normalizedEmail, passwordHash],
    );
    userId = inserted.rows[0].id as string;
  }

  await pool.query(
    "insert into user_roles (user_id, role) values ($1, 'admin') on conflict do nothing",
    [userId],
  );
  await pool.query(
    "insert into admin_profiles (user_id, display_name) values ($1, 'Main Admin') on conflict do nothing",
    [userId],
  );
}

async function main() {
  await runMigrations();
  await seedMainAdmin();
  await pool.end();
  console.log("Database initialized and admin seeded (if env provided).");
}

void main();

