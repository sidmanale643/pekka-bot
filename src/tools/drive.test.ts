import { afterAll, describe, expect, it, vi } from "vitest";
import { executeToolCall } from "../agent/execute-tool-call.ts";
import { closeDocuments } from "../documents.ts";
import { samplePdf } from "../sample-pdf.ts";
import { FakeComputer } from "../computer/fake-computer.ts";
import type { ContactsService } from "../plugins/contacts.ts";
import type { DriveService } from "../plugins/drive.ts";
import { LOCAL_USER } from "../database/database.ts";
import { createContactsTools } from "./contacts.ts";
import { createDriveTools } from "./drive.ts";
import { defaultTools } from "./index.ts";
import type { Tool } from "./tool.ts";

// OCR downloads language data on first use; the test PDFs have a text layer.
process.env.PEKKA_OCR = "false";
afterAll(closeDocuments);

function setup(respond: (path: string, method: string, data?: unknown) => unknown, download: (path: string) => Buffer = () => Buffer.alloc(0)) {
  const request = vi.fn(async (_userId: string, path: string, method: string, data?: unknown) => respond(path, method, data));
  const fetchText = vi.fn(async (_userId: string, path: string, _maxBytes: number) => download(path));
  const tools: Tool[] = [
    ...createDriveTools({ request, download: fetchText } as unknown as DriveService),
    ...createContactsTools({ request } as unknown as ContactsService),
  ];
  const call = (name: string, args = {}) => executeToolCall({
    id: "call", type: "function", function: { name, arguments: JSON.stringify(args) },
  }, tools, { computer: new FakeComputer(), approveAction: async () => true, userId: LOCAL_USER });
  return { request, download: fetchText, call, tools };
}

const query = (path: string) => Object.fromEntries(new URL(path, "https://x").searchParams);

describe("drive tools", () => {
  it("is registered for every bot", () => {
    const { tools } = setup(() => ({}));
    expect(defaultTools.map((tool) => tool.name)).toEqual(expect.arrayContaining(tools.map((tool) => tool.name)));
  });

  it("searches names and content with escaped queries", async () => {
    const { call, request } = setup(() => ({ files: [{ id: "f1", name: "Plan", mimeType: "application/vnd.google-apps.document", webViewLink: "https://docs.google.com/x", owners: [{ emailAddress: "me@example.com" }] }] }));
    const result = JSON.parse((await call("drive_search", { query: "Bob's plan", type: "document", folder_id: "folder1" })).output);
    expect(result.files).toEqual([{ id: "f1", name: "Plan", type: "application/vnd.google-apps.document", url: "https://docs.google.com/x", owner: "me@example.com" }]);
    const params = query(request.mock.calls[0]![1]);
    expect(params.q).toBe("trashed = false and fullText contains 'Bob\\'s plan' and mimeType = 'application/vnd.google-apps.document' and 'folder1' in parents");
    expect(params).not.toHaveProperty("orderBy");
    await call("drive_search", {});
    expect(query(request.mock.calls[1]![1])).toMatchObject({ q: "trashed = false", orderBy: "modifiedTime desc" });
  });

  it("exports Google files to text in chunks, downloading each version once", async () => {
    const doc = { id: "d1", name: "Notes", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-10-01T00:00:00Z" };
    const { call, download } = setup(() => doc, () => Buffer.from("x".repeat(20_000)));
    const first = JSON.parse((await call("drive_read_file", { file_id: "d1" })).output);
    expect(first).toMatchObject({ name: "Notes", length: 20_000, next_offset: 15_000 });
    expect(first.content).toHaveLength(15_000);
    expect(download.mock.calls[0]!.slice(1)).toEqual(["/drive/v3/files/d1/export?mimeType=text%2Fplain", 5_000_000]);
    const rest = JSON.parse((await call("drive_read_file", { file_id: "d1", offset: 15_000 })).output);
    expect(rest.content).toHaveLength(5_000);
    expect(rest).not.toHaveProperty("next_offset");
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("parses PDFs with LiteParse and declines Office files and oversized files", async () => {
    const pdf = { id: "p1", name: "Invoice.pdf", mimeType: "application/pdf", size: "900", modifiedTime: "2026-10-01T00:00:00Z" };
    const { call, download } = setup(() => pdf, () => samplePdf(["Invoice 1042: total due 300 dollars"]));
    const result = JSON.parse((await call("drive_read_file", { file_id: "p1" })).output);
    expect(result).toMatchObject({ name: "Invoice.pdf", pages: 1 });
    expect(result.content).toContain("Invoice 1042: total due 300 dollars");
    expect(download.mock.calls[0]!.slice(1)).toEqual(["/drive/v3/files/p1?alt=media&supportsAllDrives=true", 25_000_000]);

    for (const file of [
      { id: "w1", name: "Plan.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: "100" },
      { id: "p2", name: "Huge.pdf", mimeType: "application/pdf", size: "30000000" },
    ]) {
      const { call: read, download: none } = setup(() => file);
      expect(JSON.parse((await read("drive_read_file", { file_id: file.id })).output)).toMatchObject({ readable: false });
      expect(none).not.toHaveBeenCalled();
    }
  });

  it("creates a doc with text and explains a partial failure", async () => {
    const { call, request } = setup((path) => path === "/v1/documents" ? { documentId: "doc1" } : {});
    expect(JSON.parse((await call("docs_create", { title: "Brief", text: "Hello" })).output)).toEqual({ status: "created", id: "doc1", title: "Brief", url: "https://docs.google.com/document/d/doc1/edit" });
    expect(request.mock.calls[1]!.slice(1)).toEqual(["/v1/documents/doc1:batchUpdate", "POST", { requests: [{ insertText: { location: { index: 1 }, text: "Hello" } }] }]);
    await call("docs_append_text", { document_id: "doc1", text: "\nMore" });
    expect(request.mock.calls[2]![3]).toEqual({ requests: [{ insertText: { endOfSegmentLocation: {}, text: "\nMore" } }] });

    const { call: failing } = setup((path) => { if (path === "/v1/documents") return { documentId: "doc2" }; throw new Error("Quota exceeded."); });
    const result = await failing("docs_create", { title: "Brief", text: "Hello" });
    expect(result.output).toContain("Created the document https://docs.google.com/document/d/doc2/edit, but adding its text failed: Quota exceeded.");
  });

  it("reads the first sheet by default and writes raw values unless formulas are asked for", async () => {
    const { call, request } = setup((path) => path.includes("/values/")
      ? { range: "'Q3 budget'!A1:B3", values: [["Item", "Cost"], ["Coffee", "4"], ["Tea", "3"]] }
      : { properties: { title: "Budget" }, sheets: [{ properties: { title: "Q3 budget", gridProperties: { rowCount: 100, columnCount: 5 } } }] });
    const read = JSON.parse((await call("sheets_read", { spreadsheet_id: "s1", max_rows: 2 })).output);
    expect(read).toMatchObject({ title: "Budget", sheets: [{ name: "Q3 budget", rows: 100, columns: 5 }], values: [["Item", "Cost"], ["Coffee", "4"]], truncated: true, total_rows: 3 });
    expect(request.mock.calls[1]![1]).toBe("/v4/spreadsheets/s1/values/%27Q3%20budget%27?majorDimension=ROWS");

    await call("sheets_append_rows", { spreadsheet_id: "s1", range: "Sheet1!A:B", rows: [["=IMPORTXML(\"x\")", 1]] });
    expect(request.mock.calls[2]!.slice(1)).toEqual(["/v4/spreadsheets/s1/values/Sheet1%21A%3AB:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS", "POST", { majorDimension: "ROWS", values: [["=IMPORTXML(\"x\")", 1]] }]);
    await call("sheets_update_range", { spreadsheet_id: "s1", range: "Sheet1!B2", rows: [["=SUM(A1:A2)"]], interpret_formulas: true });
    expect(request.mock.calls[3]!.slice(1, 3)).toEqual(["/v4/spreadsheets/s1/values/Sheet1%21B2?valueInputOption=USER_ENTERED", "PUT"]);
  });

  it("creates a spreadsheet with a header row", async () => {
    const { call, request } = setup((path) => path === "/v4/spreadsheets"
      ? { spreadsheetId: "s2", spreadsheetUrl: "https://docs.google.com/spreadsheets/d/s2/edit", sheets: [{ properties: { title: "Sheet1" } }] }
      : {});
    expect(JSON.parse((await call("sheets_create", { title: "Leads", rows: [["Name", "Email"]] })).output)).toEqual({ status: "created", id: "s2", title: "Leads", url: "https://docs.google.com/spreadsheets/d/s2/edit" });
    expect(request.mock.calls[1]![1]).toBe("/v4/spreadsheets/s2/values/%27Sheet1%27:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS");
  });
});

describe("contacts tools", () => {
  it("warms up the search cache, then lists saved contacts before other contacts without duplicates", async () => {
    const { call, request } = setup((path) => {
      if (query(path).query === "") return {};
      return path.startsWith("/v1/people:searchContacts")
        ? { results: [{ person: { names: [{ displayName: "Sam Lee" }], emailAddresses: [{ value: "sam@example.com" }], organizations: [{ name: "Acme", title: "CFO" }] } }] }
        : { results: [
          { person: { names: [{ displayName: "Sam" }], emailAddresses: [{ value: "SAM@example.com" }] } },
          { person: { emailAddresses: [{ value: "samantha@example.com" }] } },
        ] };
    });
    expect(JSON.parse((await call("contacts_search", { query: "sam" })).output)).toEqual([
      { name: "Sam Lee", emails: ["sam@example.com"], phones: [], organization: "Acme", job_title: "CFO", source: "contacts" },
      { name: "", emails: ["samantha@example.com"], phones: [], source: "other" },
    ]);
    expect(request.mock.calls.map(([, path]) => query(path).query)).toEqual(["", "", "sam", "sam"]);
    expect(query(request.mock.calls[2]![1])).toMatchObject({ readMask: "names,emailAddresses,phoneNumbers,organizations", pageSize: "10" });
  });
});
