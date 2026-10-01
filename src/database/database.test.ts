import { expect, it } from "vitest";
import { listBots } from "../bots.ts";
import { ensureSchema, LOCAL_USER } from "./database.ts";
import { createSqliteDatabase } from "./sqlite.ts";

it("gives bots and plugin connections stored before users existed to the local user, once", async () => {
  const database = createSqliteDatabase();
  try {
    // The tables as they were before sign-in.
    await database.run("CREATE TABLE bots (id TEXT PRIMARY KEY, name_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL, job TEXT NOT NULL, created_at TEXT NOT NULL)");
    await database.run("CREATE TABLE plugin_connections (id TEXT PRIMARY KEY, credentials TEXT NOT NULL, workspace_name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0)");
    await database.run("CREATE TABLE scheduled_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, next_run_at TEXT, version INTEGER NOT NULL, data TEXT NOT NULL)");
    for (const [id, name] of [["b".repeat(24), "Beta"], ["a".repeat(24), "Alpha"]]) {
      await database.run("INSERT INTO bots VALUES (?, ?, ?, 'Role', 'Job', '2026-01-01')", [id!, name!.toLowerCase(), name!]);
    }
    await database.run("INSERT INTO plugin_connections VALUES ('gmail', 'sealed', 'me@gmail.com', 1)");
    await database.run("INSERT INTO scheduled_jobs VALUES ('job', 'pending', NULL, 0, '{}')");

    await ensureSchema(database);
    expect((await listBots(LOCAL_USER, database)).map((bot) => bot.name)).toEqual(["Beta", "Alpha"]);
    expect(await listBots("someone-else", database)).toEqual([]);
    expect(await database.query("SELECT user_id, plugin, enabled FROM plugin_accounts")).toEqual([{ user_id: LOCAL_USER, plugin: "gmail", enabled: 1 }]);
    expect(await database.query("SELECT user_id FROM scheduled_jobs")).toEqual([{ user_id: LOCAL_USER }]);

    // Later processes don't copy again, so rows changed or removed since stay that way.
    await database.run("DELETE FROM bot_profiles WHERE name = 'Beta'");
    await ensureSchema(createSqliteDatabaseSharing(database));
    expect((await listBots(LOCAL_USER, database)).map((bot) => bot.name)).toEqual(["Alpha"]);
  } finally { database.close(); }
});

it("creates a fresh database without the retired tables", async () => {
  const database = createSqliteDatabase();
  try {
    await ensureSchema(database);
    expect(await database.query("SELECT name FROM sqlite_master WHERE name IN ('bots', 'plugin_connections')")).toEqual([]);
    expect(await database.query("SELECT id FROM schema_migrations ORDER BY id")).toEqual([{ id: "bot-profiles" }, { id: "plugin-accounts" }]);
  } finally { database.close(); }
});

/** A second handle on the same database, so ensureSchema runs again as it would in a new process. */
function createSqliteDatabaseSharing(database: ReturnType<typeof createSqliteDatabase>) {
  return { query: database.query, run: database.run };
}
