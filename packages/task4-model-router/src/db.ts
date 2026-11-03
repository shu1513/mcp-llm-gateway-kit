/**
 * SQLite (on disk) via better-sqlite3. WAL mode so readers never block the
 * writer; synchronous API so each limiter decision is one atomic transaction.
 */
import Database from "better-sqlite3";

export type Db = Database.Database;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_key TEXT    NOT NULL,
      ts_ms      INTEGER NOT NULL,
      tokens     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS token_usage_tenant_ts ON token_usage (tenant_key, ts_ms);

    CREATE TABLE IF NOT EXISTS request_log (
      request_id TEXT PRIMARY KEY,
      tenant_key TEXT    NOT NULL,
      ts_ms      INTEGER NOT NULL,
      provider   TEXT,
      status     INTEGER NOT NULL,
      error_code TEXT,
      tokens     INTEGER
    );
  `);
  return db;
}
