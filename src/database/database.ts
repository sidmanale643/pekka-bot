import { createD1Service } from "./d1.ts";

// Everything Pekka stores goes through this interface. Production uses
// Cloudflare D1; tests use node:sqlite, which runs the same SQL.

/** D1's HTTP API only binds strings, so numbers are sent as text and SQLite's column affinity converts them back. */
export type SqlValue = string | number;

export interface Database {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  /** Runs a write and reports how many rows it changed, so callers can detect lost races. */
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
}

/**
 * Owns everything the CLI creates, and everything stored before people could
 * sign in. With sign-in on, the account matching PEKKA_OWNER_EMAIL takes it over.
 */
export const LOCAL_USER = "local";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_sub TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  // Only a hash of each session token is stored, so a database leak cannot be replayed as a login.
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS plugin_accounts (
    user_id TEXT NOT NULL,
    plugin TEXT NOT NULL,
    credentials TEXT NOT NULL,
    workspace_name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, plugin)
  )`,
  // API keys a user brought for model providers, one row per provider. The row with active = 1
  // is the one their runs use instead of the server's; with none active they use the server's.
  // credentials is the key sealed with PEKKA_PLUGIN_KEY; hint is its last four characters, for display.
  // context_window is 0 when the provider doesn't say.
  `CREATE TABLE IF NOT EXISTS provider_keys (
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    credentials TEXT NOT NULL,
    hint TEXT NOT NULL,
    context_window INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, provider)
  )`,
  `CREATE TABLE IF NOT EXISTS bot_email (
    bot_id TEXT PRIMARY KEY,
    inbox_id TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bot_characters (
    bot_id TEXT PRIMARY KEY,
    preset TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL
  )`,
  // Bot names are unique per user. This replaced the bots table, whose names were unique across the whole database.
  `CREATE TABLE IF NOT EXISTS bot_profiles (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name_key TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    job TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (user_id, name_key)
  )`,
  `CREATE TABLE IF NOT EXISTS bot_memory (
    bot_id TEXT NOT NULL,
    file TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (bot_id, file)
  )`,
  // scope is '' for skills every bot shares, or a bot ID for skills only that bot sees.
  `CREATE TABLE IF NOT EXISTS skill_files (
    scope TEXT NOT NULL,
    skill TEXT NOT NULL,
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    revision TEXT NOT NULL,
    PRIMARY KEY (scope, skill, path)
  )`,
  `CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    next_run_at TEXT,
    version INTEGER NOT NULL,
    data TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS scheduled_jobs_due ON scheduled_jobs (status, next_run_at)",
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY
  )`,
  // Chats are saved per bot ID rather than name, so renaming a bot keeps its chat. data is the message as JSON.
  `CREATE TABLE IF NOT EXISTS chat_messages (
    user_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    id TEXT NOT NULL,
    time INTEGER NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, bot_id, id)
  )`,
  "CREATE INDEX IF NOT EXISTS chat_messages_by_time ON chat_messages (user_id, bot_id, time)",
  `CREATE TABLE IF NOT EXISTS scheduler_runner (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token TEXT NOT NULL,
    host TEXT NOT NULL,
    pid INTEGER NOT NULL,
    expires_at TEXT NOT NULL
  )`,
];

/** Columns added after a table first shipped. SQLite has no ADD COLUMN IF NOT EXISTS, so a duplicate-column error means it is already there. */
const ADDED_COLUMNS = [
  "ALTER TABLE bot_characters ADD COLUMN name TEXT NOT NULL DEFAULT ''",
  `ALTER TABLE scheduled_jobs ADD COLUMN user_id TEXT NOT NULL DEFAULT '${LOCAL_USER}'`,
  // 1 marks the user's chief of staff, the primary bot that manages their others.
  "ALTER TABLE bot_profiles ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0",
];

/** Indexes on added columns, created once those columns exist. */
const ADDED_INDEXES = [
  "CREATE UNIQUE INDEX IF NOT EXISTS bot_profiles_primary ON bot_profiles (user_id) WHERE is_primary = 1",
];

/**
 * One-time copies from tables that were replaced, giving their rows to the
 * local user. The old tables are left in place. A copy that is interrupted, or
 * run by two processes at once, is safe to repeat because it skips rows already copied.
 */
const MIGRATIONS: [id: string, sql: string][] = [
  ["bot-profiles", `INSERT OR IGNORE INTO bot_profiles (id, user_id, name_key, name, role, job, created_at)
    SELECT id, '${LOCAL_USER}', name_key, name, role, job, created_at FROM bots ORDER BY rowid`],
  ["plugin-accounts", `INSERT OR IGNORE INTO plugin_accounts (user_id, plugin, credentials, workspace_name, enabled)
    SELECT '${LOCAL_USER}', id, credentials, workspace_name, enabled FROM plugin_connections`],
];

const ready = new WeakMap<Database, Promise<void>>();

/** Creates missing tables once per process and database. */
export function ensureSchema(database: Database): Promise<void> {
  let pending = ready.get(database);
  if (!pending) {
    pending = (async () => {
      for (const statement of SCHEMA) await database.run(statement);
      for (const statement of ADDED_COLUMNS) {
        await database.run(statement).catch((error: unknown) => {
          if (!/duplicate column/i.test(String(error))) throw error;
        });
      }
      for (const statement of ADDED_INDEXES) await database.run(statement);
      const applied = new Set((await database.query<{ id: string }>("SELECT id FROM schema_migrations")).map((row) => row.id));
      for (const [id, sql] of MIGRATIONS) {
        if (applied.has(id)) continue;
        // A database created after the old table was retired has nothing to copy.
        await database.run(sql).catch((error: unknown) => {
          if (!/no such table/i.test(String(error))) throw error;
        });
        await database.run("INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)", [id]);
      }
    })();
    pending.catch(() => ready.delete(database));
    ready.set(database, pending);
  }
  return pending;
}

let defaultDatabase: Database | undefined;

/** The configured D1 database. Created on first use so commands that never touch storage don't need D1 keys. */
export function getDatabase(): Database {
  defaultDatabase ??= createD1Service();
  return defaultDatabase;
}
