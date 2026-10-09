import { spawn } from "node:child_process";
import type { CommandResult, Computer, RunOptions } from "./computer.ts";
import { workspaceComputer } from "./workspace-computer.ts";

// Without a Daytona key, each sandbox is a Docker container on the machine that
// runs Pekka, with the same life as a Daytona sandbox: created when a tool first
// needs it, kept between runs so its files persist, and stopped when a run ends.

const DEFAULT_TIMEOUT_SECONDS = 120;
/** Where commands start and relative paths point, in every container. */
const WORKSPACE = "/workspace";
const LABEL = "xyz.pekkabot.sandbox";
const NO_DOCKER = "Bots need a computer, and Docker isn't installed. Install Docker Desktop, or set DAYTONA_API_KEY to use Daytona sandboxes.";
const DOCKER_STOPPED = "Bots need a computer, and Docker isn't running. Start Docker Desktop, or set DAYTONA_API_KEY to use Daytona sandboxes.";

export interface DockerResult {
  exitCode: number;
  stdout: string;
  /** What the docker command itself reported, such as a container that isn't running. */
  stderr: string;
}

/** Runs the docker CLI. Tests pass a fake. */
export type Docker = (args: string[], options?: { input?: string; timeoutMs?: number }) => Promise<DockerResult>;

export const dockerCli: Docker = (args, { input, timeoutMs } = {}) => new Promise((resolve, reject) => {
  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  let timedOut = false;
  const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs) : undefined;
  child.on("error", (error: NodeJS.ErrnoException) => {
    clearTimeout(timer);
    reject(error.code === "ENOENT" ? new Error(NO_DOCKER) : error);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ exitCode: timedOut ? 124 : code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
  });
  child.stdin.on("error", () => {});
  child.stdin.end(input);
});

interface ContainerOptions {
  sandboxName: string;
  image: string;
  docker?: Docker;
}

/** Stops still in flight in this process, so a run that starts meanwhile waits before starting the container again. */
const stopping = new Map<string, Promise<unknown>>();

export function openDockerComputer({ sandboxName, image, docker = dockerCli }: ContainerOptions): { computer: Computer; release(): Promise<void> } {
  const name = containerName(sandboxName);
  let opening: Promise<Computer> | undefined;
  const open = () => (opening ??= start(docker, name, image)
    .then(() => workspaceComputer(new DockerComputer(docker, name), WORKSPACE))
    .catch((error) => {
      opening = undefined;
      throw error;
    }));
  const use = async <T>(action: (computer: Computer) => Promise<T>): Promise<T> => {
    try {
      return await action(await open());
    } catch (error) {
      // Docker restarted, or something stopped the container: start it again and retry once.
      if (!(error instanceof ContainerGoneError)) throw error;
      opening = undefined;
      return action(await open());
    }
  };
  return {
    computer: {
      run: (command, options) => use((computer) => computer.run(command, options)),
      readFile: (path) => use((computer) => computer.readFile(path)),
      writeFile: (path, content) => use((computer) => computer.writeFile(path, content)),
    },
    async release() {
      const opened = await opening?.catch(() => undefined);
      opening = undefined;
      if (!opened) return;
      const stop = docker(["stop", "--time", "5", name]).finally(() => stopping.delete(name));
      stopping.set(name, stop);
      await stop;
    },
  };
}

/** Deletes the named sandbox's container and every file in it. A bot that never used its computer has none. */
export async function deleteDockerSandbox(sandboxName: string, docker: Docker = dockerCli): Promise<void> {
  let removed: DockerResult;
  try {
    removed = await docker(["rm", "--force", containerName(sandboxName)]);
  } catch (error) {
    // Without Docker there's no container to delete.
    if (error instanceof Error && error.message === NO_DOCKER) return;
    throw error;
  }
  if (removed.exitCode === 0 || /no such container/i.test(removed.stderr)) return;
  throw new Error(daemonDown(removed.stderr) ? DOCKER_STOPPED : removed.stderr.trim());
}

/** Docker container names allow letters, digits, `_`, `.` and `-`, starting with a letter or digit. */
export function containerName(sandboxName: string): string {
  return sandboxName.replace(/[^\w.-]/g, "-").replace(/^[^a-zA-Z0-9]+/, "") || "pekka-computer";
}

async function start(docker: Docker, name: string, image: string): Promise<void> {
  await stopping.get(name)?.catch(() => {});
  const inspected = await docker(["container", "inspect", "--format", "{{.State.Running}}", name]);
  if (inspected.exitCode === 0 && inspected.stdout.trim() === "true") return;
  if (inspected.exitCode !== 0) {
    if (daemonDown(inspected.stderr)) throw new Error(DOCKER_STOPPED);
    // Pulls the image the first time, which can take a few minutes.
    const created = await docker(["create", "--name", name, "--label", `${LABEL}=${name}`, "--init", "--workdir", WORKSPACE, image, "sleep", "infinity"]);
    // Another process may have created it first.
    if (created.exitCode !== 0 && !/already in use/i.test(created.stderr)) throw new Error(`Could not create the Docker sandbox: ${created.stderr.trim()}`);
  }
  const started = await docker(["start", name]);
  if (started.exitCode !== 0) throw new Error(`Could not start the Docker sandbox: ${started.stderr.trim()}`);
}

function daemonDown(stderr: string): boolean {
  // Older CLIs say "Cannot connect to the Docker daemon"; Docker 29 says "failed to connect to the docker API".
  return /cannot connect to the docker daemon|failed to connect to the docker api|is the docker daemon running|docker desktop is (not running|unable)/i.test(stderr);
}

class ContainerGoneError extends Error {}

/** Runs the command in bash when the image has it, merges stderr into stdout in order, and stops it at the timeout. */
const SHELL = 'shell=sh; command -v bash >/dev/null 2>&1 && shell=bash; exec timeout -k 5 "$0" "$shell" -c "$1" 2>&1';

class DockerComputer implements Computer {
  private readonly docker: Docker;
  private readonly name: string;

  constructor(docker: Docker, name: string) {
    this.docker = docker;
    this.name = name;
  }

  async run(command: string, options: RunOptions = {}): Promise<CommandResult> {
    const seconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    const result = await this.exec(["exec", ...(options.cwd ? ["--workdir", options.cwd] : []), this.name, "sh", "-c", SHELL, String(seconds), command], { timeoutMs: (seconds + 30) * 1000 });
    // Anything the docker command itself printed means the command never ran.
    if (result.stderr.trim()) throw new Error(result.stderr.trim());
    if (result.exitCode === 124) return { exitCode: 124, output: `${result.stdout}\nCommand timed out after ${seconds} seconds.` };
    return { exitCode: result.exitCode, output: result.stdout };
  }

  async readFile(path: string): Promise<string> {
    const result = await this.exec(["exec", this.name, "cat", "--", path]);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not read ${path}.`);
    return result.stdout;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const write = 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"';
    const result = await this.exec(["exec", "--interactive", this.name, "sh", "-c", write, "sh", path], { input: content });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not write ${path}.`);
  }

  private async exec(args: string[], options?: { input?: string; timeoutMs?: number }): Promise<DockerResult> {
    const result = await this.docker(args, options);
    if (/no such container|is not running/i.test(result.stderr)) throw new ContainerGoneError(result.stderr.trim());
    if (daemonDown(result.stderr)) throw new Error(DOCKER_STOPPED);
    return result;
  }
}
