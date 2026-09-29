import { z } from "zod";
import { defineTool, limitOutput } from "./tool.ts";

export const runCommand = defineTool({
  name: "run_command",
  description:
    "Run a shell command on your persistent Linux computer. Returns its exit code and output. " +
    "Use this to inspect files, run programs, install dependencies, and verify work. Commands can change files or system state.",
  input: z.object({
    command: z.string().describe("Shell command to execute on the Linux computer."),
    cwd: z.string().optional().describe("Working directory on the Linux computer. Defaults to its home directory."),
    timeout_seconds: z.number().int().positive().max(1800).optional().describe("Maximum time to wait, in seconds. Defaults to 120; maximum 1800."),
  }),
  async run(input, { computer }) {
    const result = await computer.run(input.command, {
      cwd: input.cwd,
      timeoutSeconds: input.timeout_seconds,
    });
    return limitOutput(`exit code: ${result.exitCode}\n${result.output}`);
  },
});
