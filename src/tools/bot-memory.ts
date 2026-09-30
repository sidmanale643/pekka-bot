import { z } from "zod";
import { memoryFiles } from "../bot-memory.ts";
import { defineTool, limitOutput } from "./tool.ts";

export const readMemory = defineTool({
  name: "read_memory",
  description: "Read this bot's persistent Markdown preferences or accumulated knowledge. Available only for named bots. Use offset to read long files in chunks.",
  input: z.object({
    file: z.enum(memoryFiles),
    offset: z.number().int().min(0).default(0),
  }),
  async run({ file, offset }, { memory }) {
    if (!memory) throw new Error("Memory is available only for named bots.");
    return limitOutput((await memory.read(file)).slice(offset));
  },
});

export const writeMemory = defineTool({
  name: "write_memory",
  description: "Replace this bot's Markdown preferences or accumulated knowledge. Read the existing file first and preserve useful entries. Save explicit user preferences and verified reusable facts, never secrets or unverified claims. Available only for named bots.",
  input: z.object({
    file: z.enum(memoryFiles),
    content: z.string().max(100_000).describe("Complete Markdown contents, including any entries to retain."),
  }),
  async run({ file, content }, { memory }) {
    if (!memory) throw new Error("Memory is available only for named bots.");
    await memory.write(file, content);
    return `Saved ${file} (${content.length} characters).`;
  },
});
