import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { workspaceComputer } from "./workspace-computer.ts";
import type { Computer } from "./computer.ts";

it("keeps relative file operations and shell working directories in the selected workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pekka-workspaces-"));
  const execute = promisify(execFile);
  const computer: Computer = {
    async run(command, options) {
      const { stdout } = await execute("sh", ["-c", command], { cwd: options?.cwd });
      return { exitCode: 0, output: stdout };
    },
    readFile: (path) => readFile(path, "utf8"),
    writeFile: (path, content) => writeFile(path, content, "utf8"),
  };
  try {
    const scoutDirectory = join(directory, "scout");
    const writerDirectory = join(directory, "writer");
    await mkdir(scoutDirectory);
    await mkdir(writerDirectory);
    const scout = workspaceComputer(computer, scoutDirectory);
    const writer = workspaceComputer(computer, writerDirectory);
    await scout.writeFile("report.md", "Scout report");
    await writer.writeFile("report.md", "Writer report");
    expect(await scout.readFile("report.md")).toBe("Scout report");
    expect(await writer.readFile("report.md")).toBe("Writer report");
    expect((await scout.run("cat report.md")).output).toBe("Scout report");
    expect((await writer.run("cat report.md", { cwd: "." })).output).toBe("Writer report");
    await mkdir(join(scoutDirectory, "reports"));
    await scout.run("printf 'nested' > result.txt", { cwd: "reports" });
    expect(await scout.readFile("reports/result.txt")).toBe("nested");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
