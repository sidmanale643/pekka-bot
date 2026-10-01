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

/** The tools every bot gets. To add a tool, write one file and list it here. */
export const defaultTools: Tool[] = [runCommand, readFile, writeFile, editFile, webSearch, webScrape, readMemory, writeMemory, listSkills, loadSkill, ...createSchedulingTools()];
