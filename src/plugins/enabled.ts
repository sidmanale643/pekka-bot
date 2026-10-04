import { ensureSchema, getDatabase, type Database } from "../database/database.ts";

/**
 * The plugins a user's runs can use: each one they connected and allowed on
 * the Plugins page, plus AgentMail when the server has a key for it.
 */
export async function enabledPlugins(userId: string, database: Database = getDatabase(), env: NodeJS.ProcessEnv = process.env): Promise<Set<string>> {
  await ensureSchema(database);
  const rows = await database.query<{ plugin: string }>("SELECT plugin FROM plugin_accounts WHERE user_id = ? AND enabled = 1", [userId]);
  const plugins = new Set(rows.map((row) => row.plugin));
  if (env.AGENTMAIL_API_KEY?.trim()) plugins.add("agentmail");
  return plugins;
}
