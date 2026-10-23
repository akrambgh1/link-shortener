import { DatabaseSync } from "node:sqlite";

export function openDb(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS links (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT NOT NULL UNIQUE COLLATE NOCASE,
      url        TEXT NOT NULL,
      owner      TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_links_owner ON links(owner, created_at);

    CREATE TABLE IF NOT EXISTS clicks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id    INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      clicked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      referrer   TEXT NOT NULL,
      browser    TEXT NOT NULL,
      os         TEXT NOT NULL,
      device     TEXT NOT NULL,
      visitor    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_clicks_link ON clicks(link_id, clicked_at);
  `);
  return db;
}
