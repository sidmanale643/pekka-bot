import { Daytona, DaytonaNotFoundError, SandboxState, type Sandbox } from "@daytonaio/sdk";
import type { CommandResult, Computer, RunOptions } from "./computer.ts";
import { posix } from "node:path";
import { workspaceComputer } from "./workspace-computer.ts";

const DEFAULT_TIMEOUT_SECONDS = 120;
/** A backstop for runs that end without releasing the sandbox, such as a crashed process. */
const AUTO_STOP_MINUTES = 15;
/** A stopped sandbox is still billed for its disk; an archived one is not billed. */
const AUTO_ARCHIVE_MINUTES = 60;

interface SandboxOptions {
  apiKey: string;
  sandboxName: string;
  workspace?: boolean;
}

interface OpenSandbox {
  sandbox: Sandbox;
  computer: Computer;
}

/** Stops still in flight in this process, so a run that starts meanwhile waits before starting the sandbox again. */
const stopping = new Map<string, Promise<void>>();

/**
 * The user's persistent sandbox, found again by name so its files survive
 * between runs. Running sandboxes are billed, so it is only created or started
 * when a tool first uses it, and `release` stops it once the run ends.
 */
export function openDaytonaComputer(options: SandboxOptions): { computer: Computer; release(): Promise<void> } {
  let opening: Promise<OpenSandbox> | undefined;
  const open = () => (opening ??= connect(options).catch((error) => {
    opening = undefined;
    throw error;
  }));
  const use = async <T>(action: (computer: Computer) => Promise<T>): Promise<T> => {
    const { sandbox, computer } = await open();
    try {
      return await action(computer);
    } catch (error) {
      // Another process may have stopped it at the end of its own run; start it again on the next call.
      await sandbox.refreshData().catch(() => {});
      if (sandbox.state !== SandboxState.STARTED) opening = undefined;
      throw error;
    }
  };
  return {
    computer: {
      run: (command, runOptions) => use((computer) => computer.run(command, runOptions)),
      readFile: (path) => use((computer) => computer.readFile(path)),
      writeFile: (path, content) => use((computer) => computer.writeFile(path, content)),
    },
    async release() {
      const opened = await opening?.catch(() => undefined);
      opening = undefined;
      if (!opened) return;
      const stop = opened.sandbox.stop().finally(() => stopping.delete(options.sandboxName));
      stopping.set(options.sandboxName, stop);
      await stop;
    },
  };
}

async function connect(options: SandboxOptions): Promise<OpenSandbox> {
  await stopping.get(options.sandboxName)?.catch(() => {});
  const daytona = new Daytona({ apiKey: options.apiKey });
  const sandbox = await findOrCreateSandbox(daytona, options.sandboxName);

  if (sandbox.state !== SandboxState.STARTED) {
    await sandbox.start();
  }
  // Sandboxes created before archiving was shortened keep Daytona's default of 7 days until updated.
  if (sandbox.autoArchiveInterval !== AUTO_ARCHIVE_MINUTES) await sandbox.setAutoArchiveInterval(AUTO_ARCHIVE_MINUTES);
  const computer = new DaytonaComputer(sandbox);
  if (!options.workspace) return { sandbox, computer };
  const workDir = await sandbox.getWorkDir();
  if (!workDir) throw new Error("Sandbox did not return a working directory.");
  const directory = posix.join(workDir, "workspace");
  const prepared = await computer.run(`mkdir -p '${directory.replaceAll("'", "'\\''")}'`);
  if (prepared.exitCode !== 0) throw new Error(`Could not create bot workspace: ${prepared.output}`);
  return { sandbox, computer: workspaceComputer(computer, directory) };
}

async function findOrCreateSandbox(daytona: Daytona, name: string): Promise<Sandbox> {
  try {
    return await daytona.get(name);
  } catch (error) {
    if (!(error instanceof DaytonaNotFoundError)) throw error;
    return daytona.create({ name, autoStopInterval: AUTO_STOP_MINUTES, autoArchiveInterval: AUTO_ARCHIVE_MINUTES });
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
