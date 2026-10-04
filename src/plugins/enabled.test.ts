import { afterEach, beforeEach, expect, it } from "vitest";
import { ensureSchema } from "../database/database.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { enabledPlugins } from "./enabled.ts";

let database: ReturnType<typeof createSqliteDatabase>;

beforeEach(async () => {
  database = createSqliteDatabase();
  await ensureSchema(database);
  const connect = (user: string, plugin: string, enabled: number) =>
    database.run("INSERT INTO plugin_accounts (user_id, plugin, credentials, workspace_name, enabled) VALUES (?, ?, 'sealed', 'workspace', ?)", [user, plugin, enabled]);
  await connect("alice", "gmail", 1);
  await connect("alice", "github", 0);
  await connect("bob", "notion", 1);
});

afterEach(() => { database.close(); });

it("returns only the plugins the user connected and allowed", async () => {
  expect(await enabledPlugins("alice", database, {})).toEqual(new Set(["gmail"]));
  expect(await enabledPlugins("bob", database, {})).toEqual(new Set(["notion"]));
  expect(await enabledPlugins("carol", database, {})).toEqual(new Set());
});

it("adds AgentMail when the server has a key for it", async () => {
  expect(await enabledPlugins("alice", database, { AGENTMAIL_API_KEY: "key" })).toEqual(new Set(["gmail", "agentmail"]));
  expect(await enabledPlugins("alice", database, { AGENTMAIL_API_KEY: "  " })).toEqual(new Set(["gmail"]));
});
