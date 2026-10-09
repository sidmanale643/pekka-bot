import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

// Pekka's API server and scheduler, run as child processes of the app on the
// Node.js runtime built into Electron. Both read the .env in their working
// directory, the app's data folder, exactly as they read the repository's .env.

const START_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 5000;
/** How long to wait before trying the scheduler again, usually because another one holds the database's lock. */
const SCHEDULER_RETRY_MS = 5 * 60_000;
const LOG_LIMIT_BYTES = 5 * 1024 * 1024;

/** Whether a Pekka server answers at `origin`. */
export async function isPekka(origin, timeoutMs = 1000) {
  try {
    const response = await fetch(new URL("/api/health", origin), { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok && (await response.json()).status === "ok";
  } catch {
    return false;
  }
}

export class PekkaProcesses {
  #serverDir;
  #dataDir;
  #env;
  #log;
  #tail = [];
  #server;
  #scheduler;
  #schedulerRetry;
  #stopping = false;
  #onServerExit;

  /**
   * @param {{ serverDir: string, dataDir: string, logFile: string, env: NodeJS.ProcessEnv, onServerExit?: (message: string) => void }} options
   * `serverDir` holds the compiled server (see scripts/stage-server.mjs). `onServerExit` hears about
   * a server that stops on its own after it started.
   */
  constructor({ serverDir, dataDir, logFile, env, onServerExit }) {
    this.#serverDir = serverDir;
    this.#onServerExit = onServerExit;
    this.#dataDir = dataDir;
    this.#env = { ...env, ELECTRON_RUN_AS_NODE: "1" };
    mkdirSync(dirname(logFile), { recursive: true });
    try {
      if (statSync(logFile).size > LOG_LIMIT_BYTES) renameSync(logFile, logFile.replace(/\.log$/, ".old.log"));
    } catch {}
    this.#log = createWriteStream(logFile, { flags: "a" });
  }

  /**
   * Starts the API server on `origin` and resolves once it answers. A Pekka server that already
   * answers there, such as `pnpm api` from a checkout, is used instead of starting a second one.
   * @returns {Promise<{ attached: boolean }>}
   */
  async startServer(origin) {
    if (await isPekka(origin)) {
      this.#write("app", `Using the Pekka server that is already running at ${origin}.`);
      return { attached: true };
    }
    const child = this.#spawn("server", join(this.#serverDir, "src/api/main.js"));
    this.#server = child;
    let exit;
    let started = false;
    child.once("exit", (code, signal) => {
      exit = signal ? `stopped by ${signal}` : `exited with code ${code}`;
      if (this.#server !== child) return;
      this.#server = undefined;
      if (started && !this.#stopping) this.#onServerExit?.(this.#explain(`Pekka's server ${exit}.`));
    });
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exit) throw new Error(this.#explain(`Pekka's server ${exit}.`));
      if (await isPekka(origin, 1000)) {
        started = true;
        return { attached: false };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Pekka's server did not answer at ${origin} within ${START_TIMEOUT_MS / 1000} seconds.`);
  }

  /** Runs `pekka scheduler`, which executes scheduled jobs as they come due, until stop(). */
  startScheduler() {
    if (this.#scheduler || this.#stopping) return;
    clearTimeout(this.#schedulerRetry);
    const child = this.#spawn("scheduler", join(this.#serverDir, "src/cli.js"), ["scheduler"]);
    this.#scheduler = child;
    child.once("exit", (code) => {
      if (this.#scheduler !== child) return;
      this.#scheduler = undefined;
      if (this.#stopping || code === 0) return;
      this.#write("app", `The scheduler stopped. Trying again in ${SCHEDULER_RETRY_MS / 60_000} minutes.`);
      this.#schedulerRetry = setTimeout(() => this.startScheduler(), SCHEDULER_RETRY_MS);
    });
  }


  /** Stops the server and the scheduler, killing whichever hasn't exited after a few seconds. */
  async stop() {
    this.#stopping = true;
    clearTimeout(this.#schedulerRetry);
    const children = [this.#server, this.#scheduler].filter(Boolean);
    this.#server = this.#scheduler = undefined;
    await Promise.all(children.map(terminate));
    this.#log.end();
  }

  #spawn(name, entry, args = []) {
    const child = spawn(process.execPath, [join(this.#serverDir, "launcher.mjs"), entry, ...args], {
      cwd: this.#dataDir,
      env: this.#env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    for (const stream of [child.stdout, child.stderr]) {
      let partial = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        const lines = (partial + chunk).split("\n");
        partial = lines.pop();
        for (const line of lines) this.#write(name, line);
      });
    }
    child.on("error", (error) => this.#write(name, `Could not start: ${error.message}`));
    return child;
  }

  #write(name, line) {
    const entry = `${new Date().toISOString()} [${name}] ${line}`;
    if (!this.#log.writableEnded) this.#log.write(`${entry}\n`);
    this.#tail.push(`[${name}] ${line}`);
    if (this.#tail.length > 60) this.#tail.shift();
  }

  /** Adds the likely cause to a failed start, when the output names one. */
  #explain(message) {
    if (this.#tail.some((line) => line.includes("EADDRINUSE"))) {
      return `${message} Another app is using its port. Set PEKKA_API_PORT to a free port in Pekka's .env, or quit the other app.`;
    }
    return message;
  }
}

function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
