import { z } from "zod";
import { GoogleError, GoogleService, type GoogleMethod, type GoogleOptions } from "./google.ts";

// The user's own Google Calendar and Google Tasks, which is where Google
// Reminders now live. calendar.events covers creating, changing and deleting
// events; calendar.readonly adds the calendar list and free/busy.
export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/tasks",
];
const CALENDAR = "https://www.googleapis.com";
const TASKS = "https://tasks.googleapis.com";

const segment = "[\\w.%-]+";
const query = "(?:\\?[^#]*)?";
const allowed: [GoogleMethod[], RegExp, string][] = [
  [["GET"], new RegExp(`^/calendar/v3/users/me/calendarList${query}$`), CALENDAR],
  [["GET", "POST"], new RegExp(`^/calendar/v3/calendars/${segment}/events${query}$`), CALENDAR],
  [["GET", "PATCH", "DELETE"], new RegExp(`^/calendar/v3/calendars/${segment}/events/${segment}${query}$`), CALENDAR],
  [["POST"], /^\/calendar\/v3\/freeBusy$/, CALENDAR],
  [["GET"], new RegExp(`^/tasks/v1/users/@me/lists${query}$`), TASKS],
  [["GET", "POST"], new RegExp(`^/tasks/v1/lists/${segment}/tasks${query}$`), TASKS],
  [["PATCH"], new RegExp(`^/tasks/v1/lists/${segment}/tasks/${segment}$`), TASKS],
];

export class CalendarError extends GoogleError {}

export class CalendarService extends GoogleService {
  constructor(options: GoogleOptions = {}) {
    super({ id: "calendar", name: "Google Calendar", scopes: CALENDAR_SCOPES, error: CalendarError }, options);
  }

  /** `path` starts with /calendar/v3 or /tasks/v1. */
  protected endpoint(path: string, method: GoogleMethod) {
    const match = allowed.find(([methods, pattern]) => methods.includes(method) && pattern.test(path));
    return match ? `${match[2]}${path}` : undefined;
  }

  protected async accountName(accessToken: string) {
    const primary = await this.api(`${CALENDAR}/calendar/v3/calendars/primary`, { method: "GET" }, accessToken);
    const calendar = z.object({ id: z.string() }).safeParse(await primary.json().catch(() => null));
    return calendar.success ? calendar.data.id : "";
  }
}

let defaultService: CalendarService | undefined;
export function getCalendarService(): CalendarService {
  return defaultService ??= new CalendarService();
}
