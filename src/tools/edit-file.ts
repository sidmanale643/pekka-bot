import { z } from "zod";
import { defineTool } from "./tool.ts";

export const editFile = defineTool({
  name: "edit_file",
  permission: { effect: "write" },
  description: "Replace an exact piece of text in an existing text file on your persistent Linux computer, leaving the rest of the file unchanged. Prefer this over write_file for small changes. old_string must match the file exactly, including whitespace and indentation, and must be unique unless replace_all is true. Read the file first so you copy the text exactly.",
  input: z.object({
    path: z.string().describe("Path to the existing text file on the Linux computer."),
    old_string: z.string().min(1).describe("Exact text to find. Include enough surrounding lines to make it unique."),
    new_string: z.string().describe("Text to put in its place. Use an empty string to delete old_string."),
    replace_all: z.boolean().optional().describe("Replace every occurrence instead of requiring a unique match. Defaults to false."),
  }),
  async run(input, { computer }) {
    if (input.old_string === input.new_string) throw new Error("old_string and new_string are identical; nothing to change");
    const content = await computer.readFile(input.path);
    const parts = content.split(input.old_string);
    const matches = parts.length - 1;
    if (matches === 0) throw new Error(`old_string was not found in ${input.path}; read the file and copy the text exactly`);
    if (matches > 1 && !input.replace_all) {
      throw new Error(`old_string matches ${matches} places in ${input.path}; include more surrounding text to make it unique, or set replace_all`);
    }
    // split/join instead of String.replace, so "$&" and similar in new_string stay literal.
    await computer.writeFile(input.path, parts.join(input.new_string));
    return `replaced ${matches} ${matches === 1 ? "occurrence" : "occurrences"} in ${input.path}`;
  },
});
