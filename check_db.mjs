import "dotenv/config";
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'lumi_backend',
});

async function check() {
  try {
    const res = await pool.query("SELECT current_database(), current_user");
    console.log("Connected to:", res.rows[0]);
    
    const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    console.log("Tables:", tables.rows.map(r => r.table_name));
    
    if (tables.rows.some(r => r.table_name === 'users')) {
        const users = await pool.query("SELECT count(*) FROM users");
        console.log("User count:", users.rows[0].count);
        
        const superAdmin = await pool.query("SELECT email FROM users WHERE is_super_admin = true");
        console.log("Super Admins:", superAdmin.rows.map(r => r.email));
    }
  } catch (e) {
    console.error("DB Error:", e);
  } finally {
    await pool.end();
  }
}

check();
