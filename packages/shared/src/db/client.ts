import "dotenv/config";
import { Pool } from "pg";

/** Each microservice process has its own pool. Default pg max=10 with connectionTimeoutMillis=0 waits forever when busy → nginx 504. */
const pool = new Pool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? "5432"),
  user: process.env.DB_USER ?? "postgres",
  password: process.env.DB_PASSWORD ?? "postgres",
  database: process.env.DB_NAME ?? "lumi_backend",
  max: Number(process.env.DB_POOL_MAX ?? 20),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: Number(process.env.DB_POOL_ACQUIRE_MS ?? 12_000),
});

export { pool };
export default pool;

