import { editFile } from "./edit-file.ts";
import { readFile } from "./read-file.ts";
import { runCommand } from "./run-command.ts";
import type { Tool } from "./tool.ts";
import { webSearch } from "./web-search.ts";
import { webScrape } from "./web-scrape.ts";
import { writeFile } from "./write-file.ts";
import { createSchedulingTools } from "./scheduled-jobs.ts";
import { readMemory, writeMemory } from "./bot-memory.ts";
import { listSkills, loadSkill } from "./skills.ts";
import { createEmailTools } from "./email.ts";
import { createGmailTools } from "./gmail.ts";
import { createNotionTools } from "./notion.ts";
import { createTelegramTools } from "./telegram.ts";
import { createGitHubTools } from "./github.ts";
import { updateBotConfig } from "./bot-config.ts";

/** The tools every bot gets. To add a tool, write one file and list it here. */
export const defaultTools: Tool[] = [runCommand, readFile, writeFile, editFile, webSearch, webScrape, readMemory, writeMemory, updateBotConfig, listSkills, loadSkill, ...createSchedulingTools(), ...createEmailTools(), ...createGmailTools(), ...createNotionTools(), ...createTelegramTools(), ...createGitHubTools()];

/** These need a named bot's memory, configuration or mailbox, so unnamed runs don't get them. */
const namedBotTools = new Set([readMemory.name, writeMemory.name, updateBotConfig.name, "get_email_address", "send_email"]);

/** Runs without a named bot get every default tool that works without one. */
export const unnamedTools: Tool[] = defaultTools.filter((tool) => !namedBotTools.has(tool.name));
