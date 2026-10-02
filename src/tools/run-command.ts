import { z } from "zod";
import { defineTool, limitOutputMiddle } from "./tool.ts";
import { isReadOnlyCommand } from "../permissions/policy.ts";

export const runCommand = defineTool({
  name: "run_command",
  permission: { effect: "command" },
  description:
    "Run a shell command on your persistent Linux computer. Returns its exit code and combined stdout and stderr. " +
    "Use this to run programs, inspect the system, install project dependencies and verify work; use read_file to read a file. Commands can change files or system state. " +
    "Output over 20,000 characters is cut from the middle, keeping the start and the end. " +
    "Commands containing any of these words are blocked: rm, rmdir, shred, dd, mkfs, wipefs, sudo, su, chmod, chown, shutdown, reboot, poweroff. " +
    "So are git reset --hard, git clean, git push --force and piping curl or wget into a shell. The words are matched anywhere, even in a flag such as --rm. " +
    "You cannot delete files, and anything that needs sudo, such as apt-get install, fails. Run scripts with an interpreter (bash script.sh) instead of making them executable.",
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
    return limitOutputMiddle(`exit code: ${result.exitCode}\n${result.output}`);
  },
});
