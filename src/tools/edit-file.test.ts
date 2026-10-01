import { describe, expect, it } from "vitest";
import { executeToolCall } from "../agent/execute-tool-call.ts";
import { FakeComputer } from "../computer/fake-computer.ts";
import { editFile } from "./edit-file.ts";
import { defaultTools } from "./index.ts";
import { LOCAL_USER } from "../database/database.ts";

function setup(content: string) {
  const computer = new FakeComputer();
  computer.files.set("notes.md", content);
  return { computer, context: { computer, approveAction: async () => true, userId: LOCAL_USER } };
}

describe("edit_file", () => {
  it("registers the tool and replaces a unique match without touching the rest of the file", async () => {
    const { computer, context } = setup("# Title\nstatus: draft\nfooter\n");
    const result = await editFile.run({ path: "notes.md", old_string: "status: draft", new_string: "status: final" }, context);
    expect(computer.files.get("notes.md")).toBe("# Title\nstatus: final\nfooter\n");
    expect(result).toBe("replaced 1 occurrence in notes.md");
    expect(defaultTools.some((entry) => entry.name === editFile.name)).toBe(true);
  });

  it("rejects ambiguous matches unless replace_all is set", async () => {
    const { computer, context } = setup("a TODO b TODO c");
    await expect(editFile.run({ path: "notes.md", old_string: "TODO", new_string: "DONE" }, context)).rejects.toThrow("matches 2 places");
    expect(computer.files.get("notes.md")).toBe("a TODO b TODO c");
    const result = await editFile.run({ path: "notes.md", old_string: "TODO", new_string: "DONE", replace_all: true }, context);
    expect(computer.files.get("notes.md")).toBe("a DONE b DONE c");
    expect(result).toBe("replaced 2 occurrences in notes.md");
  });

  it("keeps replacement patterns such as $& literal and allows deletion", async () => {
    const { computer, context } = setup("price: X\nremove me\n");
    await editFile.run({ path: "notes.md", old_string: "X", new_string: "$&5 $1" }, context);
    await editFile.run({ path: "notes.md", old_string: "remove me\n", new_string: "" }, context);
    expect(computer.files.get("notes.md")).toBe("price: $&5 $1\n");
  });

  it("reports missing text, missing files, no-op edits, and empty old_string as errors without writing", async () => {
    const { computer, context } = setup("hello");
    await expect(editFile.run({ path: "notes.md", old_string: "absent", new_string: "x" }, context)).rejects.toThrow("not found");
    await expect(editFile.run({ path: "missing.md", old_string: "a", new_string: "b" }, context)).rejects.toThrow("no such file");
    await expect(editFile.run({ path: "notes.md", old_string: "hello", new_string: "hello" }, context)).rejects.toThrow("identical");
    const result = await executeToolCall({ id: "edit", type: "function", function: {
      name: editFile.name, arguments: JSON.stringify({ path: "notes.md", old_string: "", new_string: "x" }),
    } }, [editFile], context);
    expect(result.isError).toBe(true);
    expect(computer.files.get("notes.md")).toBe("hello");
    expect(computer.files.has("missing.md")).toBe(false);
  });
});
