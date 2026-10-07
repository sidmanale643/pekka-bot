import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Bot } from "./bots.ts";
import { ensureSchema, getDatabase, LOCAL_USER, type Database } from "./database/database.ts";

const InputSchema = z.object({
  name: z.string().trim().min(1),
  task: z.string().trim().min(1),
  runAt: z.iso.datetime({ offset: true }),
  intervalSeconds: z.number().int().min(60).max(31_536_000).optional(),
  bot: z.object({ id: z.string(), name: z.string(), role: z.string(), job: z.string() }).optional(),
});

/** Upcoming, running and paused jobs per user, so a runaway agent or user can't pile up jobs that each cost a model run. */
export const MAX_ACTIVE_JOBS = 50;

export interface ScheduledJob {
  id: string;
  /** The user the job runs as. Its bot, plugins and results belong to them. */
  userId: string;
  name: string;
  task: string;
  runAt: string;
  intervalSeconds?: number;
  bot?: Bot;
  status: "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastRunStatus?: "completed" | "failed";
  lastError?: string;
  lastResult?: unknown;
}

interface Runner {
  token: string;
  pid: number;
  host: string;
}

export interface SchedulerOptions {
  database?: Database;
  signal?: AbortSignal;
  pollMs?: number;
  once?: boolean;
  /** How long the runner lock lasts without renewal. Another runner can take over after it expires. */
  leaseMs?: number;
}

/** A job row with its version, used for compare-and-swap updates. */
interface StoredJob {
  job: ScheduledJob;
  version: number;
}

async function ready(database = getDatabase()): Promise<Database> {
  await ensureSchema(database);
  return database;
}

async function readJobs(database: Database, where = "", params: string[] = []): Promise<StoredJob[]> {
  const rows = await database.query<{ data: string; version: number; user_id: string }>(
    `SELECT data, version, user_id FROM scheduled_jobs ${where} ORDER BY rowid`, params,
  );
  // The column is the source of truth; jobs saved before users existed have no userId in their data.
  return rows.map((row) => ({ job: { ...JSON.parse(row.data) as ScheduledJob, userId: row.user_id }, version: Number(row.version) }));
}

async function insertJob(database: Database, job: ScheduledJob): Promise<boolean> {
  // D1 can't bind null, so an empty string stands in for "no next run".
  const { changes } = await database.run(
    "INSERT INTO scheduled_jobs (id, user_id, status, next_run_at, version, data) VALUES (?, ?, ?, NULLIF(?, ''), 0, ?) ON CONFLICT(id) DO NOTHING",
    [job.id, job.userId, job.status, job.nextRunAt ?? "", JSON.stringify(job)],
  );
  return changes === 1;
}

/** Applies `change` only if nobody else updated the job since it was read. */
async function updateJob(database: Database, stored: StoredJob, change: (job: ScheduledJob) => void): Promise<ScheduledJob | undefined> {
  const job = structuredClone(stored.job);
  change(job);
  job.updatedAt = new Date().toISOString();
  const { changes } = await database.run(
    "UPDATE scheduled_jobs SET status = ?, next_run_at = NULLIF(?, ''), version = version + 1, data = ? WHERE id = ? AND version = ?",
    [job.status, job.nextRunAt ?? "", JSON.stringify(job), job.id, stored.version],
  );
  return changes === 1 ? job : undefined;
}

/**
 * Re-reads and retries until the update lands on the latest version of the job.
 * With `userId`, only that user's job can be changed; the scheduler itself passes none.
 */
async function modifyJob(database: Database, id: string, change: (job: ScheduledJob) => void, userId?: string): Promise<ScheduledJob> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const [stored] = userId === undefined
      ? await readJobs(database, "WHERE id = ?", [id])
      : await readJobs(database, "WHERE id = ? AND user_id = ?", [id, userId]);
    if (!stored) throw new Error(`No scheduled job with ID "${id}".`);
    const updated = await updateJob(database, stored, change);
    if (updated) return updated;
  }
  throw new Error(`Scheduled job "${id}" kept changing; try again.`);
}

export async function createScheduledJob(
  userId: string,
  input: { name: string; task: string; runAt: string; intervalSeconds?: number; bot?: Bot },
  database?: Database,
): Promise<ScheduledJob> {
  const parsed = InputSchema.parse(input);
  if (Date.parse(parsed.runAt) <= Date.now()) throw new Error("runAt must be a future ISO timestamp with a timezone offset.");
  const store = await ready(database);
  const [count] = await store.query<{ active: number }>(
    "SELECT COUNT(*) AS active FROM scheduled_jobs WHERE user_id = ? AND status IN ('pending', 'running', 'paused')", [userId],
  );
  if (Number(count?.active) >= MAX_ACTIVE_JOBS) throw new JobStateError(`You already have ${MAX_ACTIVE_JOBS} active jobs. Cancel one before scheduling another.`);
  const now = new Date().toISOString();
  const job: ScheduledJob = {
    ...parsed,
    runAt: new Date(parsed.runAt).toISOString(),
    id: randomUUID(),
    userId,
    status: "pending",
    nextRunAt: new Date(parsed.runAt).toISOString(),
    createdAt: now,
    updatedAt: now,
    runCount: 0,
  };
  await insertJob(store, job);
  return job;
}

/** Copies an existing job as-is, keeping its ID, for the local user. Returns false if a job with that ID already exists. */
export async function importScheduledJob(job: Omit<ScheduledJob, "userId">, database?: Database): Promise<boolean> {
  return insertJob(await ready(database), { ...job, userId: LOCAL_USER });
}

export async function listScheduledJobs(userId: string, database?: Database): Promise<ScheduledJob[]> {
  return (await readJobs(await ready(database), "WHERE user_id = ?", [userId])).map((stored) => stored.job);
}

export async function getScheduledJob(userId: string, id: string, database?: Database): Promise<ScheduledJob | undefined> {
  return (await readJobs(await ready(database), "WHERE id = ? AND user_id = ?", [id, userId]))[0]?.job;
}

export async function cancelScheduledJob(userId: string, id: string, database?: Database): Promise<ScheduledJob> {
  return modifyJob(await ready(database), id, (job) => {
    job.status = "cancelled";
    job.nextRunAt = null;
  }, userId);
}

/** Thrown when a job's current status does not allow the requested change. */
export class JobStateError extends Error {}

export async function pauseScheduledJob(userId: string, id: string, database?: Database): Promise<ScheduledJob> {
  return modifyJob(await ready(database), id, (job) => {
    if (job.status !== "pending") throw new JobStateError("Only upcoming jobs can be paused.");
    job.status = "paused";
    job.nextRunAt = null;
  }, userId);
}

/** Resumes on the next future occurrence; a one-time job whose time has passed runs right away. */
export async function resumeScheduledJob(userId: string, id: string, database?: Database): Promise<ScheduledJob> {
  return modifyJob(await ready(database), id, (job) => {
    if (job.status !== "paused") throw new JobStateError("Only paused jobs can be resumed.");
    job.status = "pending";
    job.nextRunAt = Date.parse(job.runAt) > Date.now() ? job.runAt : nextOccurrence(job) ?? new Date().toISOString();
  }, userId);
}

/** Whether a runner currently holds an unexpired lock, so pending jobs will execute. */
export async function getSchedulerStatus(database?: Database): Promise<{ running: boolean; host?: string }> {
  const [owner] = await (await ready(database)).query<{ host: string; expires_at: string }>(
    "SELECT host, expires_at FROM scheduler_runner WHERE id = 1",
  );
  return owner && owner.expires_at >= new Date().toISOString() ? { running: true, host: owner.host } : { running: false };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function nextOccurrence(job: ScheduledJob): string | null {
  if (!job.intervalSeconds) return null;
  const base = Date.parse(job.runAt);
  const interval = job.intervalSeconds * 1000;
  const elapsedIntervals = Math.floor((Date.now() - base) / interval) + 1;
  return new Date(base + Math.max(1, elapsedIntervals) * interval).toISOString();
}

async function recoverInterruptedJobs(database: Database): Promise<void> {
  for (const { job } of await readJobs(database, "WHERE status = 'running'")) {
    await modifyJob(database, job.id, (current) => {
      if (current.status !== "running") return;
      current.lastError = "Scheduler stopped during this run. Outcome is unknown; this occurrence will not be retried.";
      current.lastRunStatus = "failed";
      current.lastFinishedAt = new Date().toISOString();
      current.nextRunAt = nextOccurrence(current);
      current.status = current.nextRunAt ? "pending" : "failed";
    });
  }
}

const expiry = (leaseMs: number) => new Date(Date.now() + leaseMs).toISOString();

/**
 * Only one scheduler may run per database. The lock expires unless renewed, so
 * a runner that crashed on another machine is replaced once its lease runs out.
 * On the same machine, a dead process is detected right away.
 */
async function acquireRunner(database: Database, leaseMs: number): Promise<Runner> {
  const runner = { token: randomUUID(), pid: process.pid, host: hostname() };
  const values = [runner.token, runner.host, runner.pid, expiry(leaseMs)];
  const [owner] = await database.query<{ token: string; host: string; pid: number; expires_at: string }>(
    "SELECT token, host, pid, expires_at FROM scheduler_runner WHERE id = 1",
  );
  const busy = () => new Error(`A scheduler is already running (PID ${owner?.pid ?? "unknown"} on ${owner?.host ?? "another host"}).`);
  if (owner) {
    const expired = owner.expires_at < new Date().toISOString();
    const dead = owner.host === runner.host && !processIsAlive(Number(owner.pid));
    if (!expired && !dead) throw busy();
    const { changes } = await database.run(
      "UPDATE scheduler_runner SET token = ?, host = ?, pid = ?, expires_at = ? WHERE id = 1 AND token = ?",
      [...values, owner.token],
    );
    if (!changes) throw busy();
  } else {
    const { changes } = await database.run(
      "INSERT INTO scheduler_runner (id, token, host, pid, expires_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
      values,
    );
    if (!changes) throw busy();
  }
  await recoverInterruptedJobs(database);
  return runner;
}

async function renewRunner(database: Database, runner: Runner, leaseMs: number): Promise<boolean> {
  const { changes } = await database.run(
    "UPDATE scheduler_runner SET expires_at = ? WHERE id = 1 AND token = ?", [expiry(leaseMs), runner.token],
  );
  return changes === 1;
}

async function releaseRunner(database: Database, runner: Runner): Promise<void> {
  await database.run("DELETE FROM scheduler_runner WHERE id = 1 AND token = ?", [runner.token]);
}

async function dueJobs(database: Database): Promise<StoredJob[]> {
  return (await readJobs(database, "WHERE status = 'pending' AND next_run_at <= ?", [new Date().toISOString()]))
    .sort((a, b) => a.job.nextRunAt!.localeCompare(b.job.nextRunAt!));
}

async function claimDueJob(database: Database, eligibleIds?: Set<string>): Promise<ScheduledJob | undefined> {
  // A failed claim means the job changed (for example, it was cancelled), so look again.
  for (let attempt = 0; attempt < 10; attempt++) {
    const stored = (await dueJobs(database)).find((item) => eligibleIds === undefined || eligibleIds.has(item.job.id));
    if (!stored) return undefined;
    const claimed = await updateJob(database, stored, (job) => {
      job.status = "running";
      job.runCount += 1;
      job.lastStartedAt = new Date().toISOString();
      delete job.lastError;
      delete job.lastResult;
    });
    if (claimed) return claimed;
  }
  return undefined;
}

async function finishJob(database: Database, id: string, result: unknown, error: string | undefined): Promise<void> {
  await modifyJob(database, id, (job) => {
    job.lastResult = result;
    job.lastError = error;
    job.lastRunStatus = error === undefined ? "completed" : "failed";
    job.lastFinishedAt = new Date().toISOString();
    if (job.status !== "cancelled") {
      job.nextRunAt = nextOccurrence(job);
      job.status = job.nextRunAt ? "pending" : job.lastRunStatus;
    }
  });
}

async function executeJob(database: Database, job: ScheduledJob, execute: (job: ScheduledJob) => Promise<unknown>): Promise<void> {
  let result: unknown;
  let error: string | undefined;
  try {
    result = await execute(job);
    result = result === undefined ? undefined : JSON.parse(JSON.stringify(result));
    if (result && typeof result === "object" && "status" in result && result.status === "step_limit") {
      error = "Agent reached its step limit before completing the scheduled task.";
    }
  } catch (failure) {
    result = undefined;
    error = failure instanceof Error ? failure.message : String(failure);
  }
  await finishJob(database, job.id, result, error);
}

export async function runScheduler(execute: (job: ScheduledJob) => Promise<unknown>, options: SchedulerOptions = {}): Promise<void> {
  // Each poll is an HTTPS request to D1, so poll less often than a local database would.
  const pollMs = options.pollMs ?? 5000;
  const leaseMs = options.leaseMs ?? 60_000;
  if (!Number.isFinite(pollMs) || pollMs < 1) throw new Error("pollMs must be a positive number.");
  if (options.signal?.aborted) return;
  const database = await ready(options.database);
  const runner = await acquireRunner(database, leaseMs);
  let lost = false;
  const heartbeat = setInterval(() => {
    renewRunner(database, runner, leaseMs).then((held) => { if (!held) lost = true; }, (error: unknown) => {
      console.error(`Could not renew the scheduler lock: ${error instanceof Error ? error.message : error}`);
    });
  }, Math.max(1, Math.floor(leaseMs / 3)));
  heartbeat.unref();
  try {
    const eligibleIds = options.once ? new Set((await dueJobs(database)).map((stored) => stored.job.id)) : undefined;
    while (!options.signal?.aborted) {
      if (lost) throw new Error("Another scheduler took over after this one's lock expired.");
      const job = await claimDueJob(database, eligibleIds);
      if (job) {
        eligibleIds?.delete(job.id);
        await executeJob(database, job, execute);
        continue;
      }
      if (options.once) return;
      try {
        await delay(pollMs, undefined, { signal: options.signal });
      } catch (error) {
        if (!options.signal?.aborted) throw error;
      }
    }
  } finally {
    clearInterval(heartbeat);
    if (!lost) await releaseRunner(database, runner);
  }
}
