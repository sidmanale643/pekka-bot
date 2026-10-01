import { createServer } from "node:http";
import { loadAuthConfig, pekkaOrigin } from "./src/auth.ts";
import { createApiServer } from "./src/api/server.ts";
import { serveAsset } from "./src/api/static.ts";
import { fail, HttpError, json } from "./src/api/http.ts";

let auth;
const publicOrigin = process.env.PEKKA_PUBLIC_ACCESS === "true" ? pekkaOrigin()?.origin : undefined;
if (!publicOrigin) {
  try { auth = loadAuthConfig(); } catch { /* Keep the public deployment locked until sign-in is configured. */ }
}

const server = publicOrigin ? createApiServer({ auth: null, publicOrigin }) : auth ? createApiServer({ auth }) : createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const message = "Google sign-in is not configured yet. The site owner needs to finish setup before you can use Pekka.";
  void (async () => {
    if (await serveAsset(request, response, pathname)) return;
    if (request.method === "GET" && pathname === "/api/auth/session") {
      json(response, 200, { required: true, user: null, configured: false, error: message });
      return;
    }
    throw new HttpError(503, message);
  })().catch((error) => fail(response, error));
});

server.listen(Number(process.env.PORT ?? 3000));
