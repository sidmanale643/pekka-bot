import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { Cdp } from "./cdp.ts";

// A WebSocket server just big enough to answer CDP: short text frames each way.
let server: Server;
let headers: Record<string, string | string[] | undefined>;
let peer: Duplex | undefined;

function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([head, payload]);
}

/** Splits a chunk into the client's masked frames: their opcodes and text. */
function read(chunk: Buffer): { opcode: number; text: string }[] {
  const frames = [];
  let offset = 0;
  while (offset < chunk.length) {
    const opcode = chunk[offset]! & 0x0f;
    let length = chunk[offset + 1]! & 0x7f;
    let start = offset + 2;
    if (length === 126) { length = chunk.readUInt16BE(offset + 2); start = offset + 4; }
    const mask = chunk.subarray(start, start + 4);
    frames.push({ opcode, text: Buffer.from(chunk.subarray(start + 4, start + 4 + length).map((byte, index) => byte ^ mask[index % 4]!)).toString() });
    offset = start + 4 + length;
  }
  return frames;
}

async function listen(answer: (message: { id: number; method: string; params: unknown; sessionId?: string }) => object | undefined) {
  server = createServer();
  server.on("upgrade", (request, socket) => {
    headers = request.headers;
    peer = socket;
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("data", (chunk: Buffer) => {
      for (const { opcode, text } of read(chunk)) {
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        const message = JSON.parse(text);
        const reply = answer(message);
        if (reply) socket.write(frame(JSON.stringify({ id: message.id, ...reply })));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/devtools/browser`;
}

afterEach(async () => {
  peer?.destroy();
  peer = undefined;
  await new Promise((resolve) => server.close(resolve));
});

it("sends the token, matches answers to commands and passes on errors", async () => {
  const url = await listen(({ method, params, sessionId }) => {
    if (method === "Target.getTargets") return { result: { targetInfos: [{ targetId: "T1", type: "page" }] } };
    if (method === "Runtime.evaluate") return { result: { echo: params, sessionId } };
    return { error: { message: `'${method}' wasn't found` } };
  });
  const cdp = await Cdp.connect(url, { Authorization: "Bearer secret-token" });
  expect(headers.authorization).toBe("Bearer secret-token");
  const [targets, evaluated] = await Promise.all([cdp.send("Target.getTargets"), cdp.send("Runtime.evaluate", { expression: "1" }, "S1")]);
  expect(targets).toEqual({ targetInfos: [{ targetId: "T1", type: "page" }] });
  expect(evaluated).toEqual({ echo: { expression: "1" }, sessionId: "S1" });
  await expect(cdp.send("Cloudflare.getLiveView")).rejects.toThrow("'Cloudflare.getLiveView' wasn't found");
  cdp.close();
  await cdp.closed;
});

it("fails waiting commands when the browser goes away, and times out unanswered ones", async () => {
  const url = await listen(() => undefined);
  const cdp = await Cdp.connect(url, {});
  await expect(cdp.send("Page.navigate", {}, undefined, 50)).rejects.toThrow("didn't answer Page.navigate in time");
  const waiting = cdp.send("Runtime.evaluate");
  peer!.destroy();
  await expect(waiting).rejects.toThrow("The browser closed.");
  await cdp.closed;
  await expect(cdp.send("Runtime.evaluate")).rejects.toThrow("The browser closed.");
});

it("explains a connection that can't be made", async () => {
  const url = await listen(() => undefined);
  server.removeAllListeners("upgrade");
  server.on("upgrade", (_request, socket) => { socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n"); });
  await expect(Cdp.connect(url, {})).rejects.toThrow("Could not connect to the browser.");
});
