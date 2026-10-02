import { afterAll, describe, expect, it, vi } from "vitest";
import { chunk, CHUNK, closeDocuments, documentKind, readDocument } from "./documents.ts";
import { samplePdf } from "./sample-pdf.ts";

// OCR downloads language data on first use; these PDFs have a text layer.
process.env.PEKKA_OCR = "false";
afterAll(closeDocuments);

describe("documentKind", () => {
  it("parses PDFs and images, reads text and refuses the rest", () => {
    expect(documentKind("application/pdf")).toBe("parse");
    expect(documentKind("image/jpeg")).toBe("parse");
    expect(documentKind("text/csv; charset=utf-8")).toBe("text");
    expect(documentKind("application/json")).toBe("text");
    expect(documentKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "notes.docx")).toBeUndefined();
    expect(documentKind("image/heic", "photo.heic")).toBeUndefined();
  });

  it("uses the extension when the type is generic", () => {
    expect(documentKind("application/octet-stream", "Invoice.PDF")).toBe("parse");
    expect(documentKind("", "data.csv")).toBe("text");
    expect(documentKind("application/octet-stream", "archive.zip")).toBeUndefined();
  });
});

describe("readDocument", () => {
  it("parses a PDF to Markdown with LiteParse", async () => {
    const document = await readDocument("test:pdf", "parse", async () => samplePdf(["Quarterly report (draft)", "Next steps: hiring"]));
    expect(document).toMatchObject({ totalPages: 2, pagesRead: 2 });
    expect(document.text).toContain("Quarterly report (draft)");
    expect(document.text).toContain("Next steps: hiring");
  });

  it("parses each file once and loads again after a failure", async () => {
    const load = vi.fn(async () => Buffer.from("name,email\nSam,sam@example.com"));
    await readDocument("test:cached", "text", load);
    expect((await readDocument("test:cached", "text", load)).text).toBe("name,email\nSam,sam@example.com");
    expect(load).toHaveBeenCalledTimes(1);
    const failing = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(Buffer.from("ok"));
    await expect(readDocument("test:retry", "text", failing)).rejects.toThrow("network");
    expect((await readDocument("test:retry", "text", failing)).text).toBe("ok");
  });

  it("explains files LiteParse cannot read", async () => {
    await expect(readDocument("test:bad", "parse", async () => Buffer.from("not a pdf"))).rejects.toThrow(/^Could not read this file: /);
  });
});

describe("chunk", () => {
  it("returns a window of the text and where to continue", () => {
    const text = "x".repeat(CHUNK + 10);
    expect(chunk({ text }, 0)).toMatchObject({ length: CHUNK + 10, next_offset: CHUNK });
    expect(chunk({ text }, CHUNK)).toEqual({ content: "x".repeat(10), length: CHUNK + 10 });
  });

  it("says when pages were skipped or no text was found", () => {
    expect(chunk({ text: "a", totalPages: 250, pagesRead: 200 }, 0)).toMatchObject({ pages: 250, note: "Only the first 200 of 250 pages were read." });
    expect(chunk({ text: "", totalPages: 1, pagesRead: 1 }, 0).note).toContain("OCR");
  });
});
