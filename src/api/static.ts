import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./http.ts";

const assets = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/favicon.png", { file: "favicon.png", type: "image/png" }],
  ["/logo.png", { file: "logo.png", type: "image/png" }],
  [
    "/vendor/marked.js",
    {
      file: import.meta.resolve("marked"),
      type: "text/javascript; charset=utf-8",
    },
  ],
  [
    "/vendor/dompurify.js",
    {
      file: import.meta.resolve("dompurify"),
      type: "text/javascript; charset=utf-8",
    },
  ],
]);

export async function serveAsset(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const asset = assets.get(pathname);
  if (!asset) return false;
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    throw new HttpError(405, "Method not allowed.");
  }
  const content = await readFile(
    new URL(asset.file, new URL("../web/", import.meta.url)),
  );
  response.writeHead(200, {
    "Content-Type": asset.type,
    "Content-Length": content.byteLength,
    "Cache-Control": "no-cache",
  });
  response.end(request.method === "HEAD" ? undefined : content);
  return true;
}
