import { parseEnv } from "node:util";

// The .env file the Mac app keeps in its data folder. Pekka's server reads it the
// same way `pnpm api` reads the repository's .env. Plain functions, so tests can
// run them without Electron.

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/**
 * Sets each of `values` in `.env` text: an existing assignment is replaced in
 * place and a new one is appended. Every other line, comments included, is kept.
 */
export function setEnvValues(text, values) {
  const lines = text ? text.replace(/\r?\n$/, "").split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(values)) {
    const assignment = `${key}=${quote(value)}`;
    const index = lines.findIndex((line) => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(line));
    if (index >= 0) lines[index] = assignment;
    else lines.push(assignment);
  }
  return `${lines.join("\n")}\n`;
}

/** Writes a value so that parseEnv reads it back unchanged, quoting it only when it needs quotes. */
function quote(value) {
  if (/^[\w.,:/@+=-]*$/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  throw new Error("A value can't contain both single and double quotes.");
}

/**
 * Where the app opens a local Pekka: PEKKA_URL when it points at this Mac, otherwise
 * 127.0.0.1 on PEKKA_API_PORT (3000 by default), the address `pnpm api` prints.
 * Plugin sign-in only works on the origin of each plugin's redirect URI, so it must match them.
 */
export function localServer(text) {
  const env = parseEnv(text);
  const port = Number(env.PEKKA_API_PORT?.trim() || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PEKKA_API_PORT must be an integer between 1 and 65535.");
  const configured = env.PEKKA_URL?.trim();
  if (configured) {
    const url = new URL(configured);
    if (url.protocol === "http:" && LOCAL_HOSTS.includes(url.hostname)) return { origin: url.origin, port };
  }
  return { origin: `http://127.0.0.1:${port}`, port };
}
