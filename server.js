import { fileURLToPath } from "node:url";
import { createApp } from "./src/app.js";
import { openDb } from "./src/db.js";

const PORT = process.env.PORT || 4100;
const DB_PATH = process.env.DB_PATH || fileURLToPath(new URL("./data/snip.db", import.meta.url));

const app = createApp({ db: openDb(DB_PATH), salt: process.env.VISITOR_SALT || "snip-dev-salt" });

app.listen(PORT, () => {
  console.log(`Snip is running on http://localhost:${PORT}`);
});
