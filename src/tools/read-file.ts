import { z } from "zod";
import { defineTool, limitOutput } from "./tool.ts";

export const readFile = defineTool({
  name: "read_file",
  permission: { effect: "read" },
  description: "Read the contents of an existing text file on your persistent Linux computer. Use this to inspect a file before editing or to verify what was saved.",
  input: z.object({
    path: z.string().describe("Path to the text file on the Linux computer."),
  }),
  async run(input, { computer }) {
    return limitOutput(await computer.readFile(input.path));
  },
});
