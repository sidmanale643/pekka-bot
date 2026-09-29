import { readFile } from "./read-file.ts";
import { runCommand } from "./run-command.ts";
import type { Tool } from "./tool.ts";
import { webSearch } from "./web-search.ts";
import { writeFile } from "./write-file.ts";

/** The tools every bot gets. To add a tool, write one file and list it here. */
export const defaultTools: Tool[] = [runCommand, readFile, writeFile, webSearch];
