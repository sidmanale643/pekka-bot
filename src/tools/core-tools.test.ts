import { describe, expect, it } from "vitest";
import { FakeComputer } from "../computer/fake-computer.ts";
import { LOCAL_USER } from "../database/database.ts";
import { readFile } from "./read-file.ts";

function withFile(content: string) {
  const computer = new FakeComputer();
  computer.files.set("notes.md", content);
  return { computer, userId: LOCAL_USER };
}

describe("read_file", () => {
  it("returns a file that fits exactly as saved", async () => {
    expect(await readFile.run({ path: "notes.md", offset: 1 }, withFile("one\ntwo\n"))).toBe("one\ntwo\n");
  });

  it("pages through a long file by line and says where to continue", async () => {
    const lines = Array.from({ length: 3000 }, (_, index) => `line ${index + 1} ${"x".repeat(20)}`);
    const context = withFile(`${lines.join("\n")}\n`);
    const first = await readFile.run({ path: "notes.md", offset: 1 }, context);
    const next = Number(/Read from offset (\d+)/.exec(first)![1]);
    expect(first.startsWith("line 1 ")).toBe(true);
    expect(first).toContain(`[Lines 1-${next - 1} of 3000.`);
    expect(first.length).toBeLessThan(20_200);
    const second = await readFile.run({ path: "notes.md", offset: next, limit: 2 }, context);
    expect(second).toBe(`${lines[next - 1]}\n${lines[next]}\n\n[Lines ${next}-${next + 1} of 3000. Read from offset ${next + 2} for more.]`);
    expect(await readFile.run({ path: "notes.md", offset: 2999 }, context)).toBe(`${lines[2998]}\n${lines[2999]}`);
  });

  it("rejects an offset past the end of the file", async () => {
    await expect(readFile.run({ path: "notes.md", offset: 5 }, withFile("one\ntwo\n"))).rejects.toThrow("has 2 lines");
  });
});
