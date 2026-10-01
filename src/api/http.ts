import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

export async function body<T>(request: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
    throw new HttpError(415, "Content-Type must be application/json.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, "Request body exceeds 1 MB.");
    chunks.push(Buffer.from(chunk));
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON body.");
  }
  return schema.parse(value);
}

export function fail(response: ServerResponse, error: unknown): void {
  if (response.destroyed) return;
  if (response.headersSent) {
    console.error(error instanceof Error ? error.message : "Task execution failed.");
    response.write(`event: error\ndata: ${JSON.stringify({ error: "Task execution failed." })}\n\n`);
    response.end();
    return;
  }
  if (error instanceof z.ZodError) {
    json(response, 400, { error: "Invalid request.", issues: error.issues.map(({ path, message }) => ({ path, message })) });
    return;
  }
  if (error instanceof HttpError) {
    json(response, error.status, { error: error.message });
    return;
  }
  console.error(error instanceof Error ? error.message : "API request failed.");
  json(response, 500, { error: "Internal server error." });
}

export function readCookie(request: IncomingMessage, name: string): string | undefined {
  return request.headers.cookie?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}
