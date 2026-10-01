import { DatabaseSync } from "node:sqlite";
import type { Database } from "./database.ts";

/**
 * A local SQLite database with the same interface as D1. D1 runs SQLite, so
 * tests exercise the real SQL without a Cloudflare account.
 */
export function createSqliteDatabase(path = ":memory:"): Database & { close(): void } {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA busy_timeout = 5000");
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
