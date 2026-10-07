import { editFile } from "./edit-file.ts";
import { readFile } from "./read-file.ts";
import { runCommand } from "./run-command.ts";
import type { Tool } from "./tool.ts";
import { webSearch } from "./web-search.ts";
import { webScrape } from "./web-scrape.ts";
import { writeFile } from "./write-file.ts";
import { createSchedulingTools } from "./scheduled-jobs.ts";
import { readMemory, writeMemory } from "./bot-memory.ts";
import { listSkills, loadSkill, writeSkill } from "./skills.ts";
import { createEmailTools } from "./email.ts";
import { createGmailTools } from "./gmail.ts";
import { createNotionTools } from "./notion.ts";
import { createLinearTools } from "./linear.ts";
import { createGranolaTools } from "./granola.ts";
import { createTodoistTools } from "./todoist.ts";
import { createTelegramTools } from "./telegram.ts";
import { createGitHubTools } from "./github.ts";
import { createCalendarTools } from "./calendar.ts";
import { createDriveTools } from "./drive.ts";
import { createContactsTools } from "./contacts.ts";
import { updateBotConfig } from "./bot-config.ts";
import { chiefOfStaffTools } from "./chief-of-staff.ts";

/** The tools every bot gets. To add a tool, write one file and list it here. */
export const defaultTools: Tool[] = [runCommand, readFile, writeFile, editFile, webSearch, webScrape, readMemory, writeMemory, updateBotConfig, listSkills, loadSkill, writeSkill, ...createSchedulingTools(), ...createEmailTools(), ...createGmailTools(), ...createCalendarTools(), ...createDriveTools(), ...createContactsTools(), ...createNotionTools(), ...createTelegramTools(), ...createGitHubTools(), ...createLinearTools(), ...createGranolaTools(), ...createTodoistTools()];

/** The chief of staff also manages the user's other bots. */
export const chiefTools: Tool[] = [...defaultTools, ...chiefOfStaffTools];

/** These need a named bot's memory, configuration, skills or mailbox, so unnamed runs don't get them. */
const namedBotTools = new Set([readMemory.name, writeMemory.name, updateBotConfig.name, writeSkill.name, "get_email_address", "send_email"]);

/** Runs without a named bot get every default tool that works without one. */
export const unnamedTools: Tool[] = defaultTools.filter((tool) => !namedBotTools.has(tool.name));

/** Leaves out tools whose provider key the server doesn't have, since they could only fail. */
export function withServerKeys(tools: Tool[], env: NodeJS.ProcessEnv = process.env): Tool[] {
  const missing = new Set<string>();
  if (!env.TAVILY_API_KEY && !env.EXA_API_KEY) missing.add(webSearch.name);
  if (!env.SCRAPERAPI_API_KEY?.trim()) missing.add(webScrape.name);
  return tools.filter((tool) => !missing.has(tool.name));
}

/** Leaves out the tools of plugins that aren't set up, so a run is only shown tools it can use. */
export function withPlugins(tools: Tool[], plugins: ReadonlySet<string>): Tool[] {
  return tools.filter(({ permission }) => !permission?.plugin || plugins.has(permission.plugin));
}
