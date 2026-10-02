import { z } from "zod";
import { GoogleError, GoogleService, type GoogleMethod, type GoogleOptions } from "./google.ts";

// The user's own Gmail through Google OAuth. gmail.modify covers reading,
// labelling, drafting and sending, but not permanent deletion.
const SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailError extends GoogleError {}

export class GmailService extends GoogleService {
  constructor(options: GoogleOptions = {}) {
    super({ id: "gmail", name: "Gmail", scopes: [SCOPE], error: GmailError }, options);
  }

  /** `path` is relative to /users/me. */
  protected endpoint(path: string, method: GoogleMethod) {
    if (method !== "GET" && method !== "POST") return undefined;
    return /^\/(?:profile|labels|messages(?:\/send|\/[\w-]+(?:\/modify|\/attachments\/[\w-]+)?)?|threads\/[\w-]+|drafts)(?:\?[^#]*)?$/.test(path) ? `${API}${path}` : undefined;
  }

  protected async accountName(accessToken: string) {
    const profile = await this.api(`${API}/profile`, { method: "GET" }, accessToken);
    const email = z.object({ emailAddress: z.string() }).safeParse(await profile.json().catch(() => null));
    return email.success ? email.data.emailAddress : "";
  }
}

let defaultService: GmailService | undefined;
export function getGmailService(): GmailService {
  return defaultService ??= new GmailService();
}
