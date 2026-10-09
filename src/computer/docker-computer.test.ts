import { describe, expect, it } from "vitest";
import { containerName, deleteDockerSandbox, openDockerComputer, type Docker, type DockerResult } from "./docker-computer.ts";

const ok = (stdout = ""): DockerResult => ({ exitCode: 0, stdout, stderr: "" });
const missing: DockerResult = { exitCode: 1, stdout: "", stderr: "Error: No such container: pekka-bot-1\n" };

/** A docker CLI that answers from `respond` and records every call. */
function fakeDocker(respond: (args: string[]) => DockerResult) {
  const calls: { args: string[]; input?: string }[] = [];
  const docker: Docker = async (args, options) => {
    calls.push({ args, input: options?.input });
    return respond(args);
  };
  return { docker, calls };
}

describe("openDockerComputer", () => {
  it("creates the container on first use, runs commands in its workspace, and stops it on release", async () => {
    const { docker, calls } = fakeDocker((args) => {
      if (args[0] === "container") return missing;
      if (args[0] === "exec") return ok("hello\n");
      return ok();
    });
    const { computer, release } = openDockerComputer({ sandboxName: "pekka-bot-1", image: "python:3.13-bookworm", docker });
    expect(calls).toEqual([]);

    expect(await computer.run("echo hello", { cwd: "notes", timeoutSeconds: 30 })).toEqual({ exitCode: 0, output: "hello\n" });
    await computer.run("pwd");
    await release();

    expect(calls.map(({ args }) => args[0])).toEqual(["container", "create", "start", "exec", "exec", "stop"]);
    expect(calls[1]!.args).toEqual(["create", "--name", "pekka-bot-1", "--label", "xyz.pekkabot.sandbox=pekka-bot-1", "--init", "--workdir", "/workspace", "python:3.13-bookworm", "sleep", "infinity"]);
    expect(calls[3]!.args.slice(0, 6)).toEqual(["exec", "--workdir", "/workspace/notes", "pekka-bot-1", "sh", "-c"]);
    expect(calls[3]!.args.slice(-2)).toEqual(["30", "echo hello"]);
    expect(calls[4]!.args.slice(1, 3)).toEqual(["--workdir", "/workspace"]);
  });

  it("reuses a running container and never touches Docker for a run that needs no computer", async () => {
    const { docker, calls } = fakeDocker((args) => (args[0] === "container" ? ok("true\n") : ok()));
    const { computer, release } = openDockerComputer({ sandboxName: "pekka-bot-1", image: "image", docker });
    await computer.writeFile("report.md", "# Report\n");
    await release();
    expect(calls.map(({ args }) => args[0])).toEqual(["container", "exec", "stop"]);
    expect(calls[1]).toEqual({ args: ["exec", "--interactive", "pekka-bot-1", "sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", "/workspace/report.md"], input: "# Report\n" });

    const unused = fakeDocker(() => ok());
    await openDockerComputer({ sandboxName: "pekka-bot-2", image: "image", docker: unused.docker }).release();
    expect(unused.calls).toEqual([]);
  });

  it.each([
    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n",
    // Docker 29 on macOS with Docker Desktop quit.
    "failed to connect to the docker API at unix:///Users/me/.docker/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /Users/me/.docker/run/docker.sock: connect: no such file or directory\n",
  ])("says to start Docker when it isn't running: %s", async (stderr) => {
    const { docker } = fakeDocker(() => ({ exitCode: 1, stdout: "", stderr }));
    const { computer } = openDockerComputer({ sandboxName: "pekka-bot-1", image: "image", docker });
    await expect(computer.run("ls")).rejects.toThrow("Docker isn't running. Start Docker Desktop, or set DAYTONA_API_KEY");
  });

  it("notes a command that timed out", async () => {
    const { docker } = fakeDocker((args) => (args[0] === "container" ? ok("true") : args[0] === "exec" ? { exitCode: 124, stdout: "partial\n", stderr: "" } : ok()));
    const { computer } = openDockerComputer({ sandboxName: "pekka-bot-1", image: "image", docker });
    expect(await computer.run("sleep 999", { timeoutSeconds: 5 })).toEqual({ exitCode: 124, output: "partial\n\nCommand timed out after 5 seconds." });
  });

  it("starts a container that stopped under it and tries the command again", async () => {
    let running = true;
    const { docker, calls } = fakeDocker((args) => {
      if (args[0] === "container") return ok(String(running));
      if (args[0] === "start") { running = true; return ok(); }
      if (args[0] === "exec" && !running) return { exitCode: 1, stdout: "", stderr: "Error response from daemon: container abc is not running\n" };
      return ok("done");
    });
    const { computer } = openDockerComputer({ sandboxName: "pekka-bot-1", image: "image", docker });
    await computer.run("true");
    running = false;
    expect(await computer.run("ls")).toEqual({ exitCode: 0, output: "done" });
    expect(calls.map(({ args }) => args[0])).toEqual(["container", "exec", "exec", "container", "start", "exec"]);
  });

  it("reports a file it can't read", async () => {
    const { docker } = fakeDocker((args) => (args[0] === "container" ? ok("true") : { exitCode: 1, stdout: "", stderr: "cat: /workspace/nope.txt: No such file or directory\n" }));
    const { computer } = openDockerComputer({ sandboxName: "pekka-bot-1", image: "image", docker });
    await expect(computer.readFile("nope.txt")).rejects.toThrow("cat: /workspace/nope.txt: No such file or directory");
  });
});

describe("deleteDockerSandbox", () => {
  it("removes the container, and is done when there is none", async () => {
    const removed = fakeDocker(() => ok());
    await deleteDockerSandbox("pekka-bot-1", removed.docker);
    expect(removed.calls[0]!.args).toEqual(["rm", "--force", "pekka-bot-1"]);
    await expect(deleteDockerSandbox("pekka-bot-1", fakeDocker(() => missing).docker)).resolves.toBeUndefined();
  });
});

it("turns any sandbox name into a valid container name", () => {
  expect(containerName("pekka-computer-user-a@b.c")).toBe("pekka-computer-user-a-b.c");
  expect(containerName("-my sandbox")).toBe("my-sandbox");
});
