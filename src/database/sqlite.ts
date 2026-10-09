import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "./database.ts";

/**
 * A local SQLite database with the same interface as D1. D1 runs SQLite, so the
 * same SQL works in both, and tests exercise it without a Cloudflare account.
 */
export function createSqliteDatabase(path = ":memory:"): Database & { close(): void } {
  // Loaded here rather than imported, so a server on D1 never loads node:sqlite (Node 22 warns that it's experimental).
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec("PRAGMA busy_timeout = 5000");
  // The server and the scheduler are separate processes; with WAL, one reads while the other writes.
  if (path !== ":memory:") database.exec("PRAGMA journal_mode = WAL");
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: (string | number)[] = []) {
      return database.prepare(sql).all(...params) as T[];
    },
    async run(sql, params = []) {
      return { changes: Number(database.prepare(sql).run(...params).changes) };
    },
    close: () => database.close(),
  };
}
