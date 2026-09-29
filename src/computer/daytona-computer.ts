import { Daytona, DaytonaNotFoundError, SandboxState, type Sandbox } from "@daytonaio/sdk";
import type { CommandResult, Computer, RunOptions } from "./computer.ts";

const DEFAULT_TIMEOUT_SECONDS = 120;
const AUTO_STOP_MINUTES = 15;

/**
 * Connects to the user's persistent sandbox, creating it on first use and
 * starting it if it was stopped. The sandbox is found again by name, so its
 * files survive between runs.
 */
export async function connectDaytonaComputer(options: {
  apiKey: string;
  sandboxName: string;
}): Promise<Computer> {
  const daytona = new Daytona({ apiKey: options.apiKey });
  const sandbox = await findOrCreateSandbox(daytona, options.sandboxName);

  if (sandbox.state !== SandboxState.STARTED) {
    await sandbox.start();
  }
  return new DaytonaComputer(sandbox);
}

async function findOrCreateSandbox(daytona: Daytona, name: string): Promise<Sandbox> {
  try {
    return await daytona.get(name);
  } catch (error) {
    if (!(error instanceof DaytonaNotFoundError)) throw error;
    return daytona.create({ name, autoStopInterval: AUTO_STOP_MINUTES });
  }
}

class DaytonaComputer implements Computer {
  private readonly sandbox: Sandbox;

  constructor(sandbox: Sandbox) {
    this.sandbox = sandbox;
  }

  async run(command: string, options: RunOptions = {}): Promise<CommandResult> {
    const timeout = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    const response = await this.sandbox.process.executeCommand(command, options.cwd, undefined, timeout);
    return { exitCode: response.exitCode, output: response.result };
  }

  async readFile(path: string): Promise<string> {
    const bytes = await this.sandbox.fs.downloadFile(path);
    return bytes.toString("utf8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.sandbox.fs.uploadFile(Buffer.from(content, "utf8"), path);
  }
}
