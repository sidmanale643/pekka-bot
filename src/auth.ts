import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

// Sign-in with Google (OpenID Connect). Sign-in is on when PEKKA_URL is set;
// without it Pekka stays a localhost-only, single-user service.

/** Thrown at startup when sign-in is half configured, so Pekka never runs open by mistake. */
export class AuthConfigError extends Error {}

export interface AuthConfig {
  /** Where people open Pekka, for example https://pekka.example.com. */
  origin: string;
  host: string;
  /** Cookies are marked Secure whenever Pekka is served over HTTPS. */
  secure: boolean;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** The account that takes over data created before sign-in existed. */
  ownerEmail?: string;
  allowed(email: string): boolean;
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** The origin in PEKKA_URL. It must be HTTPS unless it points at this machine. */
export function pekkaOrigin(env: NodeJS.ProcessEnv = process.env): URL | undefined {
  const value = env.PEKKA_URL?.trim();
  if (!value) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw new AuthConfigError("PEKKA_URL must be a URL such as https://pekka.example.com."); }
  const local = url.protocol === "http:" && LOCAL_HOSTS.includes(url.hostname);
  if (url.protocol !== "https:" && !local) throw new AuthConfigError("PEKKA_URL must use https:// unless it is a localhost address.");
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new AuthConfigError("PEKKA_URL must be an origin only, with no path, for example https://pekka.example.com.");
  }
  return url;
}

/** Whether `uri` is Pekka's own `path` callback: plain HTTP on localhost, or on the PEKKA_URL origin when it is set. */
export function isPekkaCallback(uri: string, path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let url: URL;
  try { url = new URL(uri); } catch { return false; }
  if (url.pathname !== path || [url.search, url.hash, url.username, url.password].some(Boolean)) return false;
  if (url.protocol === "http:" && LOCAL_HOSTS.includes(url.hostname)) return true;
  let origin: URL | undefined;
  try { origin = pekkaOrigin(env); } catch { return false; }
  return url.origin === origin?.origin;
}

const emails = (value: string | undefined) => (value ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);

/** Sign-in settings, or undefined when PEKKA_URL is unset and Pekka runs locally without sign-in. */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig | undefined {
  const url = pekkaOrigin(env);
  if (!url) return undefined;
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new AuthConfigError("Sign-in needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET when PEKKA_URL is set. See .env.example.");
  const ownerEmail = emails(env.PEKKA_OWNER_EMAIL)[0];
  const allowedEmails = new Set(emails(env.PEKKA_ALLOWED_EMAILS));
  if (ownerEmail) allowedEmails.add(ownerEmail);
  for (const entry of allowedEmails) {
    if (!/^[^@\s]*@[^@\s]+\.[^@\s]+$/.test(entry)) throw new AuthConfigError(`PEKKA_ALLOWED_EMAILS has an invalid entry "${entry}". Use addresses or @domain entries, separated by commas.`);
  }
  if (!allowedEmails.size) throw new AuthConfigError("Sign-in needs PEKKA_ALLOWED_EMAILS (or PEKKA_OWNER_EMAIL) so that only the people you choose can use Pekka.");
  return {
    origin: url.origin,
    host: url.host,
    secure: url.protocol === "https:",
    clientId,
    clientSecret,
    redirectUri: `${url.origin}/api/auth/google/callback`,
    ownerEmail,
    // An "@example.com" entry admits every verified address at that domain.
    allowed: (email) => {
      const address = email.toLowerCase();
      return allowedEmails.has(address) || allowedEmails.has(address.slice(address.lastIndexOf("@")));
    },
  };
}

/** A Google account that proved it owns a verified email address. */
export interface Identity {
  sub: string;
  email: string;
  name: string;
}

/** What one sign-in attempt must remember between leaving for Google and coming back. */
export interface LoginAttempt {
  state: string;
  verifier: string;
  nonce: string;
}

export class SignInError extends Error {}

const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const Claims = z.object({
  iss: z.string(),
  aud: z.string(),
  sub: z.string().min(1),
  exp: z.number(),
  nonce: z.string().optional(),
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
});

const random = () => randomBytes(32).toString("base64url");

export class GoogleSignIn {
  private readonly fetcher: typeof fetch;

  constructor(private readonly config: AuthConfig, options: { fetch?: typeof fetch } = {}) {
    this.fetcher = options.fetch ?? fetch;
  }

  start(): { attempt: LoginAttempt; url: string } {
    const attempt = { state: random(), verifier: random(), nonce: random() };
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: this.config.clientId, redirect_uri: this.config.redirectUri, response_type: "code",
      scope: "openid email profile", state: attempt.state, nonce: attempt.nonce, prompt: "select_account",
      code_challenge: createHash("sha256").update(attempt.verifier).digest("base64url"), code_challenge_method: "S256",
    }).toString();
    return { attempt, url: url.href };
  }

  /** Exchanges the code from Google's redirect for the account's identity. */
  async finish(code: string, attempt: LoginAttempt): Promise<Identity> {
    let response: Response;
    try {
      response = await this.fetcher("https://oauth2.googleapis.com/token", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.config.clientId, client_secret: this.config.clientSecret, grant_type: "authorization_code",
          code, redirect_uri: this.config.redirectUri, code_verifier: attempt.verifier,
        }),
      });
    } catch { throw new SignInError("Could not reach Google."); }
    if (!response.ok) throw new SignInError(`Google rejected the sign-in (HTTP ${response.status}).`);
    const token = z.object({ id_token: z.string() }).safeParse(await response.json().catch(() => null));
    if (!token.success) throw new SignInError("Google returned no ID token.");
    // The token came straight from Google's token endpoint over TLS, so OpenID
    // Connect Core 3.1.3.7 lets us trust it without checking its signature.
    let claims: z.infer<typeof Claims>;
    try { claims = Claims.parse(JSON.parse(Buffer.from(token.data.id_token.split(".")[1] ?? "", "base64url").toString("utf8"))); }
    catch { throw new SignInError("Google returned an unreadable ID token."); }
    if (!ISSUERS.includes(claims.iss) || claims.aud !== this.config.clientId || claims.exp * 1000 < Date.now() || claims.nonce !== attempt.nonce) {
      throw new SignInError("Google returned an ID token for a different sign-in.");
    }
    if (!claims.email || claims.email_verified !== true) throw new SignInError("The Google account has no verified email address.");
    return { sub: claims.sub, email: claims.email.toLowerCase(), name: claims.name?.trim() || claims.email };
  }
}
