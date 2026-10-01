import { existsSync } from "node:fs";
import { loadAuthConfig } from "../auth.ts";
import { createApiServer } from "./server.ts";

if (existsSync(".env")) process.loadEnvFile(".env");
const port = Number(process.env.PEKKA_API_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PEKKA_API_PORT must be an integer between 1 and 65535.");
// Listen on all interfaces only behind a reverse proxy that terminates HTTPS for PEKKA_URL.
const host = process.env.PEKKA_API_HOST?.trim() || "127.0.0.1";
// Invalid sign-in settings stop startup rather than leaving Pekka open.
const auth = loadAuthConfig();
const server = createApiServer({ auth: auth ?? null });
server.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
server.listen(port, host, () => {
  console.log(`Pekka API listening on http://${host.includes(":") ? `[${host}]` : host}:${port}`);
  console.log(auth ? `Sign-in with Google is on. Open Pekka at ${auth.origin}.` : "Sign-in is off: localhost only, single user.");
});
const stop = () => { server.close(); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
