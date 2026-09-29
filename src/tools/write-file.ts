import { z } from "zod";
import { defineTool } from "./tool.ts";

export const writeFile = defineTool({
  name: "write_file",
  description: "Create a text file or replace all contents of an existing text file on your persistent Linux computer. Read an existing file first if you need to preserve any of its contents.",
  input: z.object({
    path: z.string().describe("Destination path on the Linux computer."),
    content: z.string().describe("Complete text to save; replaces the file's previous contents."),
  }),
  async run(input, { computer }) {
    await computer.writeFile(input.path, input.content);
    return `wrote ${input.content.length} characters to ${input.path}`;
  },
});
