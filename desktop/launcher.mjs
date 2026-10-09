// Started by the Mac app as `launcher.mjs <entry point> [arguments]`. Runs one of
// Pekka's entry points (the API server or the CLI's scheduler) and stops it when the
// app goes away. The app holds the other end of stdin, so stdin closes even if the
// app crashes, and the server never outlives it holding Pekka's port.
import { pathToFileURL } from "node:url";

const [runtime, , entry, ...args] = process.argv;
process.argv = [runtime, entry, ...args];

process.stdin.on("end", () => {
  process.kill(process.pid, "SIGTERM");
  // Open event streams can keep the server from closing; don't wait on them forever.
  setTimeout(() => process.exit(0), 5000).unref();
});
process.stdin.resume();
// Watching stdin must not keep the process alive once the entry point is done.
process.stdin.unref?.();

await import(pathToFileURL(entry).href);
