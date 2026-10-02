import { z } from "zod";
import { defineTool, limitOutput, MAX_OUTPUT_CHARS } from "./tool.ts";

export const readFile = defineTool({
  name: "read_file",
  permission: { effect: "read" },
  description: "Read a text file on your persistent Linux computer, exactly as saved and without line numbers. Use this to inspect a file before editing or to verify what was saved. Returns up to 20,000 characters per call; when a file is longer, the result ends with a note giving the offset to read from next.",
  input: z.object({
    path: z.string().describe("Path to the text file on the Linux computer."),
    offset: z.number().int().min(1).default(1).describe("Line to start reading from, counting from 1. Defaults to 1."),
    limit: z.number().int().min(1).optional().describe("Maximum number of lines to return. Defaults to as many as fit in 20,000 characters."),
  }),
  async run({ path, offset, limit }, { computer }) {
    const content = await computer.readFile(path);
    if (offset === 1 && limit === undefined && content.length <= MAX_OUTPUT_CHARS) return content;
    const lines = content.split("\n");
    if (content.endsWith("\n")) lines.pop();
    if (offset > lines.length) throw new Error(`${path} has ${lines.length} lines; offset ${offset} is past the end.`);
    // Take whole lines until the limit or the size cap. The first line is always taken, and trimmed if it alone is too long.
    const last = Math.min(lines.length, offset - 1 + (limit ?? lines.length));
    let end = offset - 1;
    let size = 0;
    while (end < last && (end === offset - 1 || size + lines[end]!.length + 1 <= MAX_OUTPUT_CHARS)) size += lines[end++]!.length + 1;
    const text = limitOutput(lines.slice(offset - 1, end).join("\n"));
    return end < lines.length ? `${text}\n\n[Lines ${offset}-${end} of ${lines.length}. Read from offset ${end + 1} for more.]` : text;
  },
});
