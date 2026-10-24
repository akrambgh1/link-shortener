import { fileURLToPath } from "node:url";
import { createApp } from "./src/app.js";
import { openDb } from "./src/db.js";

const PORT = process.env.PORT || 4100;
// A postgres:// URL uses Postgres (e.g. Neon); otherwise a local SQLite file
const DB_URL = process.env.DATABASE_URL || process.env.DB_PATH || fileURLToPath(new URL("./data/snip.db", import.meta.url));

const app = createApp({ database: openDb(DB_URL), salt: process.env.VISITOR_SALT || "snip-dev-salt" });

app.listen(PORT, () => {
  console.log(`Snip is running on http://localhost:${PORT}`);
});
