import { z } from "zod";
import { memoryFiles } from "../bot-memory.ts";
import { defineTool, MAX_OUTPUT_CHARS } from "./tool.ts";

const memoryFile = z.enum(memoryFiles).describe("PREFERENCES.md for the user's explicit preferences, or KNOWLEDGE.md for verified facts, useful paths and reusable findings.");

export const readMemory = defineTool({
  name: "read_memory",
  permission: { effect: "read" },
  description: "Read this bot's persistent Markdown preferences or accumulated knowledge. Available only for named bots. Returns up to 20,000 characters per call; when there is more, the result ends with the offset to read from next.",
  input: z.object({
    file: memoryFile,
    offset: z.number().int().min(0).default(0).describe("Character position to start reading from. Defaults to 0."),
  }),
  async run({ file, offset }, { memory }) {
    if (!memory) throw new Error("Memory is available only for named bots.");
    const content = (await memory.read(file)).slice(offset);
    if (content.length <= MAX_OUTPUT_CHARS) return content;
    return `${content.slice(0, MAX_OUTPUT_CHARS)}\n\n[Truncated. Read from offset ${offset + MAX_OUTPUT_CHARS} for the rest.]`;
  },
});

export const writeMemory = defineTool({
  name: "write_memory",
  permission: { effect: "write" },
  description: "Replace the whole of this bot's Markdown preferences or accumulated knowledge file. Read the existing file first and preserve useful entries; if read_memory said the file was truncated, read the rest before writing, or it will be lost. Save explicit user preferences and verified reusable facts, never secrets or unverified claims. Available only for named bots.",
  input: z.object({
    file: memoryFile,
    content: z.string().max(100_000).describe("Complete Markdown contents, including any entries to retain."),
  }),
  async run({ file, content }, { memory }) {
    if (!memory) throw new Error("Memory is available only for named bots.");
    await memory.write(file, content);
    return `Saved ${file} (${content.length} characters).`;
  },
});
