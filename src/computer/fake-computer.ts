import type { CommandResult, Computer } from "./computer.ts";

/** An in-memory computer for tests. Commands get canned answers. */
export class FakeComputer implements Computer {
  readonly files = new Map<string, string>();
  readonly commands: string[] = [];
  private readonly answers: Record<string, CommandResult>;

  constructor(answers: Record<string, CommandResult> = {}) {
    this.answers = answers;
  }

  async run(command: string): Promise<CommandResult> {
    this.commands.push(command);
    return this.answers[command] ?? { exitCode: 127, output: `command not found: ${command}` };
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`no such file: ${path}`);
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
}
