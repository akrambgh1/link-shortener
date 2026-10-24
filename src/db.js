// One small database interface, two engines:
//   • SQLite (Node's built-in node:sqlite) for local development and tests
//   • Postgres (e.g. Neon) in production, chosen when the URL starts with postgres://
// Queries are written once with "?" placeholders and converted for Postgres.

const TABLES = (id) => `
  CREATE TABLE IF NOT EXISTS links (
    id         ${id},
    code       TEXT NOT NULL,
    url        TEXT NOT NULL,
    owner      TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_links_code ON links (lower(code));
  CREATE INDEX IF NOT EXISTS idx_links_owner ON links (owner, created_at);

  CREATE TABLE IF NOT EXISTS clicks (
    id         ${id},
    link_id    INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    clicked_at TEXT NOT NULL,
    referrer   TEXT NOT NULL,
    browser    TEXT NOT NULL,
    os         TEXT NOT NULL,
    device     TEXT NOT NULL,
    visitor    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_clicks_link ON clicks (link_id, clicked_at);
`;

const SCHEMA = {
  sqlite: `PRAGMA foreign_keys = ON;\n${TABLES("INTEGER PRIMARY KEY AUTOINCREMENT")}`,
  postgres: TABLES("SERIAL PRIMARY KEY"),
};

// "... WHERE a = ? AND b = ?" -> "... WHERE a = $1 AND b = $2"
const toPostgres = (sql) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

function wrap(dialect, exec, execScript, close) {
  const db = {
    dialect,
    all: (sql, params = []) => exec(sql, params),
    get: async (sql, params = []) => (await exec(sql, params))[0],
    close,
  };
  db.ready = execScript(SCHEMA[dialect]).then(() => db);
  return db;
}

async function sqlite(path) {
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(path);
  const cache = new Map();
  const statement = (sql) => {
    if (!cache.has(sql)) cache.set(sql, raw.prepare(sql));
    return cache.get(sql);
  };
  return wrap(
    "sqlite",
    async (sql, params) => statement(sql).all(...params),
    async (script) => raw.exec(script),
    async () => raw.close()
  );
}

async function postgres(url) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 3, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  return wrap(
    "postgres",
    async (sql, params) => (await pool.query(toPostgres(sql), params)).rows,
    async (script) => pool.query(script),
    () => pool.end()
  );
}

/** Wrap any client with a pg-style `query(sql, params) -> { rows }` (used for PGlite in tests). */
export function fromPgClient(client) {
  return wrap(
    "postgres",
    async (sql, params) => (await client.query(toPostgres(sql), params)).rows,
    async (script) => client.exec(script),
    () => client.close()
  );
}

/** Opens Postgres for postgres:// URLs, otherwise SQLite at the given path (":memory:" works). */
export async function openDb(url = ":memory:") {
  const db = /^postgres(ql)?:\/\//.test(url) ? await postgres(url) : await sqlite(url);
  return db.ready;
}
