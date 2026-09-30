import { posix } from "node:path";
import type { Computer } from "./computer.ts";

export function workspaceComputer(computer: Computer, directory: string): Computer {
  const path = (value: string) => posix.resolve(directory, value);
  return {
    run: (command, options = {}) => computer.run(command, { ...options, cwd: path(options.cwd ?? ".") }),
    readFile: (file) => computer.readFile(path(file)),
    writeFile: (file, content) => computer.writeFile(path(file), content),
  };
}
