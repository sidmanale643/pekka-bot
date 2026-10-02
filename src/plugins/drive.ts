import { z } from "zod";
import { GoogleError, GoogleService, type GoogleMethod, type GoogleOptions } from "./google.ts";

// Google Drive, Docs and Sheets. Drive itself is read-only, so bots can find
// and read any file but cannot move, share or delete one. The Docs and Sheets
// scopes let them create documents and spreadsheets and add to existing ones.
export const DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
];
const DRIVE = "https://www.googleapis.com";
const DOCS = "https://docs.googleapis.com";
const SHEETS = "https://sheets.googleapis.com";

const segment = "[\\w.%-]+";
const query = "(?:\\?[^#]*)?";
const allowed: [GoogleMethod[], RegExp, string][] = [
  [["GET"], new RegExp(`^/drive/v3/files${query}$`), DRIVE],
  [["GET"], new RegExp(`^/drive/v3/files/${segment}(?:/export)?${query}$`), DRIVE],
  [["POST"], /^\/v1\/documents$/, DOCS],
  [["POST"], new RegExp(`^/v1/documents/${segment}:batchUpdate$`), DOCS],
  [["POST"], /^\/v4\/spreadsheets$/, SHEETS],
  [["GET"], new RegExp(`^/v4/spreadsheets/${segment}${query}$`), SHEETS],
  [["GET", "PUT"], new RegExp(`^/v4/spreadsheets/${segment}/values/${segment}${query}$`), SHEETS],
  [["POST"], new RegExp(`^/v4/spreadsheets/${segment}/values/${segment}:append${query}$`), SHEETS],
];

export class DriveError extends GoogleError {}

export class DriveService extends GoogleService {
  constructor(options: GoogleOptions = {}) {
    super({ id: "drive", name: "Google Drive", scopes: DRIVE_SCOPES, error: DriveError }, options);
  }

  /** `path` starts with /drive/v3, /v1/documents or /v4/spreadsheets. */
  protected endpoint(path: string, method: GoogleMethod) {
    const match = allowed.find(([methods, pattern]) => methods.includes(method) && pattern.test(path));
    return match ? `${match[2]}${path}` : undefined;
  }

  protected async accountName(accessToken: string) {
    const about = await this.api(`${DRIVE}/drive/v3/about?fields=user(emailAddress)`, { method: "GET" }, accessToken);
    const account = z.object({ user: z.object({ emailAddress: z.string() }) }).safeParse(await about.json().catch(() => null));
    return account.success ? account.data.user.emailAddress : "";
  }
}

let defaultService: DriveService | undefined;
export function getDriveService(): DriveService {
  return defaultService ??= new DriveService();
}
