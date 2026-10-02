import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteParse, ParseTimeoutError } from "@llamaindex/liteparse";

// Turns files from plugins (Drive files, Gmail attachments) into text for the
// model. PDFs and images go through LiteParse, with OCR for scans and photos.

/** Text returned per tool call; callers continue with `next_offset`. */
export const CHUNK = 15_000;
const MAX_PAGES = 200;
const CACHE_SIZE = 20;

// LiteParse reads these without LibreOffice or ImageMagick.
const parseable = new Set(["application/pdf", "image/png", "image/jpeg", "image/tiff", "image/gif", "image/bmp"]);
const textTypes = /^(?:text\/|application\/(?:json|xml|javascript|x-yaml|yaml|csv|x-sh|sql)\b)/;
const extensions: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", tif: "image/tiff", tiff: "image/tiff",
  gif: "image/gif", bmp: "image/bmp", txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values",
  json: "application/json", xml: "application/xml", html: "text/html", ics: "text/calendar",
};

export type DocumentKind = "parse" | "text";

/** Largest file Pekka downloads to read. Documents match Gmail's attachment limit. */
export const MAX_BYTES: Record<DocumentKind, number> = { parse: 25_000_000, text: 5_000_000 };

/**
 * How a file can be read, or undefined when it can't. Mail clients often send
 * PDFs as application/octet-stream, so the extension decides then.
 */
export function documentKind(mimeType: string, filename = ""): DocumentKind | undefined {
  let type = mimeType.toLowerCase().split(";")[0]!.trim();
  if (!type || type === "application/octet-stream") type = extensions[filename.toLowerCase().split(".").pop() ?? ""] ?? type;
  if (parseable.has(type)) return "parse";
  if (textTypes.test(type)) return "text";
  return undefined;
}

let parser: LiteParse | undefined;
function getParser(env: NodeJS.ProcessEnv = process.env) {
  return parser ??= new LiteParse({
    outputFormat: "markdown", imageMode: "off", quiet: true, maxPages: MAX_PAGES,
    ocrEnabled: env.PEKKA_OCR !== "false",
    // OCR downloads its language data (about 15 MB) on first use, and the
    // default location isn't writable on serverless hosts.
    tessdataPath: env.PEKKA_TESSDATA_PATH?.trim() || join(tmpdir(), "pekka-tessdata"),
    // Files come from other people. Parsing in killable worker processes means
    // a hostile or enormous file can't hang or crash Pekka.
    poolSize: 2, parseTimeoutMs: 120_000,
  });
}

/** Stops the parsing workers, so none is left starting up when a short-lived process exits. */
export function closeDocuments(): void {
  parser?.close();
  parser = undefined;
}

export interface ReadDocument {
  text: string;
  /** For parsed documents: the document's pages and how many were read. */
  totalPages?: number;
  pagesRead?: number;
}

async function parse(bytes: Uint8Array): Promise<ReadDocument> {
  try {
    const result = await getParser().parse(bytes);
    // An empty document comes back as an empty fenced block.
    const text = result.text.replace(/^```\w*\s*```$/, "").trim();
    return { text, totalPages: result.totalPages, pagesRead: Math.min(result.totalPages, MAX_PAGES) };
  } catch (error) {
    if (error instanceof ParseTimeoutError) throw new Error("Reading this file took longer than 2 minutes, so it was stopped.");
    const message = error instanceof Error ? error.message.replace(/^liteparse worker process died while parsing <\d+ bytes>: /, "") : String(error);
    throw new Error(`Could not read this file: ${message.slice(0, 300)}`);
  }
}

// Recent results by key, so reading a long document a chunk at a time parses it once.
const cache = new Map<string, Promise<ReadDocument>>();

/**
 * Reads a file as text. `key` must identify both the user and the file's
 * version, because cached text is returned without calling `load` again.
 */
export function readDocument(key: string, kind: DocumentKind, load: () => Promise<Uint8Array>): Promise<ReadDocument> {
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const result = load().then((bytes) => kind === "parse" ? parse(bytes) : { text: Buffer.from(bytes).toString("utf8") });
  cache.set(key, result);
  result.catch(() => cache.delete(key));
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return result;
}

/** The part of `document` starting at `offset`, plus what the model needs to continue. */
export function chunk(document: ReadDocument, offset: number) {
  const end = offset + CHUNK;
  const { text, totalPages, pagesRead } = document;
  return {
    content: text.slice(offset, end), length: text.length, ...(end < text.length ? { next_offset: end } : {}),
    ...(totalPages === undefined ? {} : { pages: totalPages }),
    ...(totalPages !== undefined && pagesRead! < totalPages ? { note: `Only the first ${pagesRead} of ${totalPages} pages were read.` } : {}),
    ...(totalPages !== undefined && !text ? { note: "No text was found. A scan or photo needs OCR, which may be turned off on this server." } : {}),
  };
}
