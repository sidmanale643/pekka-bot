import { describe, expect, it, vi } from "vitest";
import { executeToolCall } from "../agent/execute-tool-call.ts";
import { FakeComputer } from "../computer/fake-computer.ts";
import type { CalendarService } from "../plugins/calendar.ts";
import { LOCAL_USER } from "../database/database.ts";
import { createCalendarTools, freeTime } from "./calendar.ts";
import { defaultTools } from "./index.ts";
import { toToolDefinition } from "./tool.ts";

function setup(respond: (path: string, method: string, data?: unknown) => unknown = () => ({})) {
  const request = vi.fn(async (userId: string, path: string, method: string, data?: unknown) => {
    expect(userId).toBe(LOCAL_USER);
    return respond(path, method, data);
  });
  const tools = createCalendarTools({ request } as unknown as CalendarService);
  const call = (name: string, args = {}) => executeToolCall({
    id: "call", type: "function", function: { name, arguments: JSON.stringify(args) },
  }, tools, { computer: new FakeComputer(), approveAction: async () => true, userId: LOCAL_USER });
  return { request, call, tools };
}

const meeting = {
  id: "ev1", summary: "Standup", htmlLink: "https://calendar.google.com/event?eid=1", hangoutLink: "https://meet.google.com/abc",
  start: { dateTime: "2026-10-02T09:00:00-07:00" }, end: { dateTime: "2026-10-02T09:15:00-07:00" },
  organizer: { email: "lead@example.com" },
  attendees: [{ email: "lead@example.com", responseStatus: "accepted", organizer: true }, { email: "me@example.com", responseStatus: "needsAction", self: true }],
};

describe("calendar tools", () => {
  it("is registered for every bot with object schemas", () => {
    const { tools } = setup();
    expect(defaultTools.filter((tool) => /^(?:calendar|tasks)_/.test(tool.name)).map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name));
    tools.forEach((tool) => expect(toToolDefinition(tool).function.parameters).toHaveProperty("type", "object"));
  });

  it("lists single occurrences in a window, defaulting to the next 7 days", async () => {
    const { call, request } = setup(() => ({ timeZone: "America/Los_Angeles", items: [meeting], nextPageToken: "next" }));
    const result = JSON.parse((await call("calendar_list_events", { time_min: "2026-10-02T00:00:00-07:00", query: "standup" })).output);
    expect(result).toMatchObject({ time_zone: "America/Los_Angeles", next_page_token: "next" });
    expect(result.events[0]).toEqual({
      id: "ev1", title: "Standup", start: "2026-10-02T09:00:00-07:00", end: "2026-10-02T09:15:00-07:00", all_day: false,
      organizer: "lead@example.com", my_response: "needsAction", meet_link: "https://meet.google.com/abc", url: "https://calendar.google.com/event?eid=1",
      attendees: [{ email: "lead@example.com", response: "accepted" }, { email: "me@example.com", response: "needsAction" }],
    });
    const url = new URL(request.mock.calls[0]![1], "https://x");
    expect(url.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ singleEvents: "true", orderBy: "startTime", q: "standup", timeMax: "2026-10-09T07:00:00.000Z" });
  });

  it("creates timed and all-day events without emailing guests unless asked", async () => {
    const { call, request } = setup((_path, _method, data) => ({ id: "new", ...(data as object) }));
    const timed = await call("calendar_create_event", {
      title: "Lunch", start: "2026-10-03T12:00:00-07:00", end: "2026-10-03T13:00:00-07:00", time_zone: "America/Los_Angeles",
      attendees: ["sam@example.com"], add_meet_link: true, reminder_minutes: [10],
    });
    expect(timed.isError).toBe(false);
    const [, path, method, body] = request.mock.calls[0]!;
    expect([path, method]).toEqual(["/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=none", "POST"]);
    expect(body).toMatchObject({
      summary: "Lunch", start: { dateTime: "2026-10-03T12:00:00-07:00", timeZone: "America/Los_Angeles" }, attendees: [{ email: "sam@example.com" }],
      conferenceData: { createRequest: { conferenceSolutionKey: { type: "hangoutsMeet" } } }, reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
    });
    await call("calendar_create_event", { calendar_id: "team@group.calendar.google.com", title: "Offsite", start: "2026-10-05", end: "2026-10-07", notify_attendees: true });
    expect(request.mock.calls[1]![1]).toBe("/calendar/v3/calendars/team%40group.calendar.google.com/events?conferenceDataVersion=1&sendUpdates=all");
    expect(request.mock.calls[1]![3]).toMatchObject({ start: { date: "2026-10-05" }, end: { date: "2026-10-07" } });
    expect((await call("calendar_create_event", { title: "Bad", start: "2026-10-05", end: "2026-10-05T10:00:00Z" })).isError).toBe(true);
    expect((await call("calendar_create_event", { title: "Bad", start: "2026-10-05T10:00:00Z", end: "2026-10-05T09:00:00Z" })).isError).toBe(true);
    expect((await call("calendar_list_events", { calendar_id: "../settings" })).isError).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps guests' responses when the guest list changes", async () => {
    const { call, request } = setup((_path, method, data) => method === "GET" ? meeting : { ...meeting, ...(data as object) });
    await call("calendar_update_event", { event_id: "ev1", attendees: ["LEAD@example.com", "new@example.com"] });
    expect(request.mock.calls[1]![3]).toEqual({ attendees: [meeting.attendees[0], { email: "new@example.com" }] });
    expect((await call("calendar_update_event", { event_id: "ev1", start: "2026-10-02T10:00:00-07:00" })).isError).toBe(true);
    expect((await call("calendar_update_event", { event_id: "ev1" })).output).toContain("at least one field");
  });

  it("answers an invitation as the user's own guest entry", async () => {
    const { call, request } = setup((_path, method, data) => method === "GET" ? meeting : { ...meeting, ...(data as object) });
    const result = JSON.parse((await call("calendar_respond_to_event", { event_id: "ev1", response: "accepted" })).output);
    expect(result.my_response).toBe("accepted");
    expect(request.mock.calls[1]!.slice(1, 3)).toEqual(["/calendar/v3/calendars/primary/events/ev1?sendUpdates=none", "PATCH"]);
    expect((request.mock.calls[1]![3] as { attendees: unknown[] }).attendees).toEqual([meeting.attendees[0], { ...meeting.attendees[1], responseStatus: "accepted" }]);
    const { call: notGuest } = setup(() => ({ ...meeting, attendees: undefined }));
    expect((await notGuest("calendar_respond_to_event", { event_id: "ev1", response: "declined" })).output).toContain("not a guest");
  });

  it("deletes an event", async () => {
    const { call, request } = setup(() => null);
    expect(JSON.parse((await call("calendar_delete_event", { event_id: "ev1" })).output)).toEqual({ status: "deleted", id: "ev1" });
    expect(request.mock.calls[0]!.slice(1, 3)).toEqual(["/calendar/v3/calendars/primary/events/ev1?sendUpdates=none", "DELETE"]);
  });

  it("finds free gaps across calendars in the requested offset", async () => {
    const { call, request } = setup(() => ({ calendars: {
      primary: { busy: [{ start: "2026-10-02T16:00:00Z", end: "2026-10-02T17:00:00Z" }, { start: "2026-10-02T16:30:00Z", end: "2026-10-02T17:30:00Z" }] },
      "sam@example.com": { busy: [], errors: [{ reason: "notFound" }] },
    } }));
    const result = JSON.parse((await call("calendar_find_free_time", { time_min: "2026-10-02T09:00:00-07:00", time_max: "2026-10-02T12:00:00-07:00", calendar_ids: ["primary", "sam@example.com"] })).output);
    expect(result).toEqual({
      busy: [{ start: "2026-10-02T09:00:00-07:00", end: "2026-10-02T10:30:00-07:00" }],
      free: [{ start: "2026-10-02T10:30:00-07:00", end: "2026-10-02T12:00:00-07:00" }],
      errors: [{ calendar: "sam@example.com", reason: "notFound" }],
    });
    expect(request.mock.calls[0]![3]).toEqual({ timeMin: "2026-10-02T09:00:00-07:00", timeMax: "2026-10-02T12:00:00-07:00", items: [{ id: "primary" }, { id: "sam@example.com" }] });
  });

  it("skips gaps shorter than the minimum", () => {
    const busy = [{ start: "2026-10-02T09:10:00Z", end: "2026-10-02T10:00:00Z" }];
    expect(freeTime(busy, "2026-10-02T09:00:00Z", "2026-10-02T10:20:00Z", 15).free).toEqual([{ start: "2026-10-02T10:00:00+00:00", end: "2026-10-02T10:20:00+00:00" }]);
  });
});

describe("tasks tools", () => {
  it("creates reminders with a due date and lists open ones", async () => {
    const { call, request } = setup((path, method, data) => method === "POST"
      ? { id: "t1", status: "needsAction", ...(data as object) }
      : { items: [{ id: "t1", title: "Call the bank", due: "2026-10-04T00:00:00.000Z", status: "needsAction" }] });
    const created = JSON.parse((await call("tasks_create", { title: "Call the bank", due: "2026-10-04" })).output);
    expect(created).toMatchObject({ id: "t1", title: "Call the bank", due: "2026-10-04" });
    expect(request.mock.calls[0]!.slice(1)).toEqual(["/tasks/v1/lists/%40default/tasks", "POST", { title: "Call the bank", due: "2026-10-04T00:00:00.000Z" }]);
    const listed = JSON.parse((await call("tasks_list", { due_before: "2026-10-05" })).output);
    expect(listed.tasks).toEqual([{ id: "t1", title: "Call the bank", due: "2026-10-04", status: "needsAction" }]);
    expect(Object.fromEntries(new URL(request.mock.calls[1]![1], "https://x").searchParams)).toEqual({ maxResults: "50", showCompleted: "false", showHidden: "false", dueMax: "2026-10-05T23:59:59.999Z" });
  });

  it("completes, reopens and clears due dates", async () => {
    const { call, request } = setup((_path, _method, data) => ({ id: "t1", ...(data as object) }));
    await call("tasks_update", { task_id: "t1", completed: true });
    expect(request.mock.calls[0]!.slice(1)).toEqual(["/tasks/v1/lists/%40default/tasks/t1", "PATCH", { status: "completed" }]);
    await call("tasks_update", { list_id: "abc", task_id: "t1", completed: false, due: null });
    expect(request.mock.calls[1]!.slice(1)).toEqual(["/tasks/v1/lists/abc/tasks/t1", "PATCH", { due: null, status: "needsAction", completed: null }]);
    expect((await call("tasks_update", { task_id: "t1" })).isError).toBe(true);
  });
});
