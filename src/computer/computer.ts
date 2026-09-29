// The agent's computer. Tools only talk to this interface, so the agent
// doesn't care whether it's a Daytona sandbox or an in-memory fake.

export interface CommandResult {
  exitCode: number;
  /** Combined stdout and stderr. */
  output: string;
}

export interface RunOptions {
  cwd?: string;
  timeoutSeconds?: number;
}

export interface Computer {
  run(command: string, options?: RunOptions): Promise<CommandResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}
