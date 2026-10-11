/** Thrown when the browser can't be reached or answers a command with an error. */
export class CdpError extends Error {}

/** The part of a CDP connection a browser session uses, so tests can stand in for the WebSocket. */
export interface CdpClient {
  send<T = any>(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<T>;
  /** Resolves when the connection closes, from either end. */
  readonly closed: Promise<void>;
  close(): void;
}

export type CdpConnect = (url: string, headers: Record<string, string>) => Promise<CdpClient>;

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }

/**
 * A Chrome DevTools Protocol connection over a WebSocket. Commands for a page
 * carry the session ID from `Target.attachToTarget` with `flatten: true`, so one
 * connection drives the whole browser. Events are ignored: pages are read by polling.
 */
export class Cdp implements CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  readonly closed: Promise<void>;

  private constructor(private readonly socket: WebSocket) {
    this.closed = new Promise((resolve) => {
      socket.addEventListener("close", () => {
        for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new CdpError("The browser closed.")); }
        this.pending.clear();
        resolve();
      });
    });
    socket.addEventListener("message", ({ data }) => {
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try { message = JSON.parse(String(data)); } catch { return; }
      const call = message.id === undefined ? undefined : this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id!);
      clearTimeout(call.timer);
      if (message.error) call.reject(new CdpError(message.error.message ?? "The browser refused the command."));
      else call.resolve(message.result ?? {});
    });
  }

  static connect(url: string, headers: Record<string, string>, timeoutMs = 30_000): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      // Node's WebSocket, from undici, takes headers; the DOM typings this project uses don't know that.
      const socket = new WebSocket(url, { headers } as unknown as string[]);
      const timer = setTimeout(() => { socket.close(); reject(new CdpError("The browser took too long to start.")); }, timeoutMs);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(new Cdp(socket)); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new CdpError("Could not connect to the browser.")); }, { once: true });
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new CdpError("The browser closed."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new CdpError(`The browser didn't answer ${method} in time.`)); }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(): void { this.socket.close(); }
}
