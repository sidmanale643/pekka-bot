import { z } from "zod";
import { defineTool, limitOutput } from "./tool.ts";
import { isReadOnlyCommand } from "../permissions/policy.ts";

export const runCommand = defineTool({
  name: "run_command",
  permission: { effect: "command" },
  description:
    "Run a shell command on your persistent Linux computer. Returns its exit code and output. " +
    "Use this to inspect files, run programs, install dependencies, and verify work. Commands can change files or system state.",
  input: z.object({
    command: z.string().describe("Shell command to execute on the Linux computer."),
    cwd: z.string().optional().describe("Working directory on the Linux computer. Defaults to the named bot's workspace, or the home directory for unnamed runs."),
    timeout_seconds: z.number().int().positive().max(1800).optional().describe("Maximum time to wait, in seconds. Defaults to 120; maximum 1800."),
  }),
  async run(input, { computer }) {
    const command = isReadOnlyCommand(input.command) ? `/usr/bin/${input.command.trim()}` : input.command;
    const result = await computer.run(command, {
      cwd: input.cwd,
      timeoutSeconds: input.timeout_seconds,
    });
    return limitOutput(`exit code: ${result.exitCode}\n${result.output}`);
  },
});
