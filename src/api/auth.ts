import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { GoogleSignIn, type AuthConfig, type LoginAttempt } from "../auth.ts";
import { LOCAL_USER, type Database } from "../database/database.ts";
import { createSession, endSession, SESSION_SECONDS, sessionUser, signIn } from "../users.ts";
import { body, HttpError, json, readCookie } from "./http.ts";

type Handler = (request: IncomingMessage, response: ServerResponse, params: string[], userId: string) => Promise<void>;
/** A route marked public answers without a signed-in user. */
export type Route = [method: string, pattern: RegExp, handler: Handler, isPublic?: boolean];

/** Decides which requests Pekka accepts and who each one is from. */
export interface Access {
  /** Rejects requests for another host and cross-origin requests. */
  check(request: IncomingMessage): void;
  /** The origin the browser sees Pekka at, which OAuth callbacks must match. */
  origin(request: IncomingMessage): string;
  /** The signed-in user's ID, or the local user when sign-in is off. Throws 401 otherwise. */
  userId(request: IncomingMessage): Promise<string>;
  routes: Route[];
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** Without sign-in, Pekka only answers on this machine and everything belongs to the local user. */
function localAccess(): Access {
  return {
    check(request) {
      const host = request.headers.host;
      if (!host || !LOCAL_HOST.test(host)) throw new HttpError(403, "Only localhost requests are accepted.");
      const origin = request.headers.origin;
      if (origin && origin !== `http://${host}`) throw new HttpError(403, "Cross-origin requests are not allowed.");
    },
    origin: (request) => `http://${request.headers.host}`,
    userId: async () => LOCAL_USER,
    routes: [
      ["GET", /^\/api\/auth\/session$/, async (_request, response) => { json(response, 200, { required: false, user: null }); }, true],
    ],
  };
}

function signedInAccess(config: AuthConfig, database: () => Database, google: GoogleSignIn): Access {
  // The __Host- prefix stops other subdomains from setting or overwriting these cookies.
  const prefix = config.secure ? "__Host-" : "";
  const sessionCookie = `${prefix}pekka_session`;
  const loginCookie = `${prefix}pekka_login`;
  const attributes = `HttpOnly; SameSite=Lax; Path=/${config.secure ? "; Secure" : ""}`;

  const redirect = (response: ServerResponse, location: string, cookies: string[]) => {
    response.writeHead(303, { Location: location, "Set-Cookie": cookies, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    response.end();
  };

  const attempt = (request: IncomingMessage): LoginAttempt | undefined => {
    const [state, verifier, nonce, ...rest] = readCookie(request, loginCookie)?.split(".") ?? [];
    return state && verifier && nonce && !rest.length ? { state, verifier, nonce } : undefined;
  };

  const user = async (request: IncomingMessage) => {
    const token = readCookie(request, sessionCookie);
    const found = token ? await sessionUser(token, database()) : undefined;
    // Removing someone from PEKKA_ALLOWED_EMAILS ends their existing sessions too.
    return found && config.allowed(found.email) ? found : undefined;
  };

  const start: Handler = async (_request, response) => {
    const { attempt, url } = google.start();
    redirect(response, url, [`${loginCookie}=${attempt.state}.${attempt.verifier}.${attempt.nonce}; ${attributes}; Max-Age=600`]);
  };

  const callback: Handler = async (request, response) => {
    const query = new URL(request.url!, "http://localhost").searchParams;
    const pending = attempt(request);
    const cleared = `${loginCookie}=; ${attributes}; Max-Age=0`;
    const fail = (reason: string) => redirect(response, `/?login=${reason}`, [cleared]);
    if (!pending || query.get("state") !== pending.state) { fail("error"); return; }
    if (query.has("error")) { fail(query.get("error") === "access_denied" ? "denied" : "error"); return; }
    const code = query.get("code");
    if (!code || code.length > 4096) { fail("error"); return; }
    let identity;
    try { identity = await google.finish(code, pending); } catch { fail("error"); return; }
    if (!config.admits(identity)) { fail("forbidden"); return; }
    const account = await signIn(identity, config.ownerEmail, database());
    const token = await createSession(account.id, database());
    redirect(response, "/", [cleared, `${sessionCookie}=${token}; ${attributes}; Max-Age=${SESSION_SECONDS}`]);
  };

  const logout: Handler = async (request, response) => {
    await body(request, z.object({}).strict());
    const token = readCookie(request, sessionCookie);
    if (token) await endSession(token, database());
    response.setHeader("Set-Cookie", `${sessionCookie}=; ${attributes}; Max-Age=0`);
    json(response, 200, {});
  };

  return {
    check(request) {
      if (request.headers.host?.toLowerCase() !== config.host) throw new HttpError(403, `Open Pekka at ${config.origin}.`);
      const origin = request.headers.origin;
      // Browsers send Origin on every POST, PUT and DELETE, so a missing one is not a browser on this site.
      if (origin ? origin !== config.origin : !["GET", "HEAD"].includes(request.method ?? "")) {
        throw new HttpError(403, "Cross-origin requests are not allowed.");
      }
    },
    origin: () => config.origin,
    async userId(request) {
      const found = await user(request);
      if (!found) throw new HttpError(401, "Sign in to use Pekka.");
      return found.id;
    },
    routes: [
      ["GET", /^\/api\/auth\/session$/, async (request, response) => {
        const found = await user(request);
        json(response, 200, { required: true, user: found ? { id: found.id, email: found.email, name: found.name } : null });
      }, true],
      ["GET", /^\/api\/auth\/google$/, start, true],
      ["GET", /^\/api\/auth\/google\/callback$/, callback, true],
      ["POST", /^\/api\/auth\/logout$/, logout, true],
    ],
  };
}

function sharedAccess(origin: string): Access {
  const host = new URL(origin).host;
  return {
    check(request) {
      if (request.headers.host?.toLowerCase() !== host) throw new HttpError(403, `Open Pekka at ${origin}.`);
      const suppliedOrigin = request.headers.origin;
      if (suppliedOrigin ? suppliedOrigin !== origin : !["GET", "HEAD"].includes(request.method ?? "")) {
        throw new HttpError(403, "Cross-origin requests are not allowed.");
      }
    },
    origin: () => origin,
    userId: async () => LOCAL_USER,
    routes: [
      ["GET", /^\/api\/auth\/session$/, async (_request, response) => {
        json(response, 200, { required: false, user: null, shared: true });
      }, true],
    ],
  };
}

export function createAccess(config: AuthConfig | undefined, database: () => Database, options: { fetch?: typeof fetch; publicOrigin?: string } = {}): Access {
  if (options.publicOrigin) return sharedAccess(options.publicOrigin);
  return config ? signedInAccess(config, database, new GoogleSignIn(config, options)) : localAccess();
}
