import { z } from "zod";
import { GoogleError, GoogleService, type GoogleMethod, type GoogleOptions } from "./google.ts";

// Read-only Google Contacts: saved contacts, plus "other contacts" Google
// collects from people the user has emailed. userinfo.email names the account.
export const CONTACTS_SCOPES = [
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];
const API = "https://people.googleapis.com";

export class ContactsError extends GoogleError {}

export class ContactsService extends GoogleService {
  constructor(options: GoogleOptions = {}) {
    super({ id: "contacts", name: "Google Contacts", scopes: CONTACTS_SCOPES, error: ContactsError }, options);
  }

  protected endpoint(path: string, method: GoogleMethod) {
    return method === "GET" && /^\/v1\/(?:people:searchContacts|otherContacts:search)\?[^#]*$/.test(path) ? `${API}${path}` : undefined;
  }

  protected async accountName(accessToken: string) {
    const info = await this.api("https://openidconnect.googleapis.com/v1/userinfo", { method: "GET" }, accessToken);
    const account = z.object({ email: z.string() }).safeParse(await info.json().catch(() => null));
    return account.success ? account.data.email : "";
  }
}

let defaultService: ContactsService | undefined;
export function getContactsService(): ContactsService {
  return defaultService ??= new ContactsService();
}
