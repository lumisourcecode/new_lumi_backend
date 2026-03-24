import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Monorepo backend root — the directory that contains `.env` (same as `npm run db:init`). */
export const backendRoot = path.resolve(__dirname, "../../..");

config({ path: path.join(backendRoot, ".env") });
