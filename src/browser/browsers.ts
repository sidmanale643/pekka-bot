import { getBrowserKeys } from "./keys.ts";
import { BrowserSession, type BrowserCredentials, type Engine } from "./session.ts";

type Start = (credentials: BrowserCredentials, engine: Engine) => Promise<BrowserSession>;

/**
 * The browser each run has open, by user and bot. A run opens its browser on first use and
 * closes it when it ends, like its computer; the live view looks it up here while it runs.
 * Runs in another process, such as the scheduler's, have their own.
 */
export class BrowserRegistry {
  private readonly open = new Map<string, Promise<BrowserSession>>();

  constructor(
    private readonly credentials: (userId: string) => Promise<BrowserCredentials> = (userId) => getBrowserKeys().credentials(userId),
    private readonly start: Start = (credentials, engine) => BrowserSession.start(credentials, engine),
  ) {}

  private key(userId: string, botId?: string) { return `${userId}\n${botId ?? ""}`; }

  /** The run's browser, started now if it has none, it closed, or a different engine was asked for. */
  async browser(userId: string, botId: string | undefined, engine?: Engine): Promise<{ session: BrowserSession; restarted: boolean }> {
    const key = this.key(userId, botId);
    const pending = this.open.get(key);
    const current = pending && await pending.catch(() => undefined);
    if (current && !current.closed && (!engine || engine === current.engine)) return { session: current, restarted: false };
    if (current) await current.close();
    // Kept as a promise, so tools called in parallel share one browser rather than each starting one.
    const starting = this.credentials(userId).then((credentials) => this.start(credentials, engine ?? current?.engine ?? "kitesurf"));
    this.open.set(key, starting);
    starting.catch(() => { if (this.open.get(key) === starting) this.open.delete(key); });
    return { session: await starting, restarted: Boolean(current) };
  }

  /** The run's browser if it has one open, without starting one. */
  async find(userId: string, botId?: string): Promise<BrowserSession | undefined> {
    const session = await this.open.get(this.key(userId, botId))?.catch(() => undefined);
    return session && !session.closed ? session : undefined;
  }

  async close(userId: string, botId?: string): Promise<void> {
    const key = this.key(userId, botId);
    const pending = this.open.get(key);
    this.open.delete(key);
    await (await pending?.catch(() => undefined))?.close();
  }
}

export const browsers = new BrowserRegistry();
