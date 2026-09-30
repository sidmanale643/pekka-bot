import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Bot } from "./bots.ts";

const InputSchema = z.object({
  name: z.string().trim().min(1),
  task: z.string().trim().min(1),
  runAt: z.iso.datetime({ offset: true }),
  intervalSeconds: z.number().int().min(60).max(31_536_000).optional(),
  bot: z.object({ name: z.string(), role: z.string(), job: z.string() }).optional(),
});

export interface ScheduledJob {
  id: string;
  name: string;
  task: string;
  runAt: string;
  intervalSeconds?: number;
  bot?: Bot;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
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
  directory?: string;
  signal?: AbortSignal;
  pollMs?: number;
  once?: boolean;
}

async function openDatabase(directory = join(process.cwd(), ".pekka")): Promise<DatabaseSync> {
  const jobsDirectory = join(directory, "jobs");
  await mkdir(jobsDirectory, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(join(jobsDirectory, "scheduler.sqlite"));
  try {
    database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runner (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
    `);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

async function transaction<T>(directory: string | undefined, operation: (database: DatabaseSync) => T): Promise<T> {
  const database = await openDatabase(directory);
  try {
    database.exec("BEGIN IMMEDIATE");
    const result = operation(database);
    database.exec("COMMIT");
    return result;
  } finally {
    database.close();
  }
}

function readJobs(database: DatabaseSync): ScheduledJob[] {
  return database.prepare("SELECT data FROM jobs ORDER BY rowid").all()
    .map((row) => JSON.parse(row.data as string) as ScheduledJob);
}

function saveJob(database: DatabaseSync, job: ScheduledJob): ScheduledJob {
  job.updatedAt = new Date().toISOString();
  database.prepare("INSERT INTO jobs (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
    .run(job.id, JSON.stringify(job));
  return job;
}

export async function createScheduledJob(
  input: { name: string; task: string; runAt: string; intervalSeconds?: number; bot?: Bot },
  directory?: string,
): Promise<ScheduledJob> {
  const parsed = InputSchema.parse(input);
  if (Date.parse(parsed.runAt) <= Date.now()) throw new Error("runAt must be a future ISO timestamp with a timezone offset.");
  const now = new Date().toISOString();
  const job: ScheduledJob = {
    ...parsed,
    runAt: new Date(parsed.runAt).toISOString(),
    id: randomUUID(),
    status: "pending",
    nextRunAt: new Date(parsed.runAt).toISOString(),
    createdAt: now,
    updatedAt: now,
    runCount: 0,
  };
  return transaction(directory, (database) => saveJob(database, job));
}

export async function listScheduledJobs(directory?: string): Promise<ScheduledJob[]> {
  return transaction(directory, readJobs);
}

export async function cancelScheduledJob(id: string, directory?: string): Promise<ScheduledJob> {
  return transaction(directory, (database) => {
    const job = readJobs(database).find((item) => item.id === id);
    if (!job) throw new Error(`No scheduled job with ID "${id}".`);
    job.status = "cancelled";
    job.nextRunAt = null;
    return saveJob(database, job);
  });
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

function recoverInterruptedJobs(database: DatabaseSync): void {
  for (const job of readJobs(database).filter((item) => item.status === "running")) {
    job.lastError = "Scheduler stopped during this run. Outcome is unknown; this occurrence will not be retried.";
    job.lastRunStatus = "failed";
    job.lastFinishedAt = new Date().toISOString();
    job.nextRunAt = nextOccurrence(job);
    job.status = job.nextRunAt ? "pending" : "failed";
    saveJob(database, job);
  }
}

async function acquireRunner(directory?: string): Promise<Runner> {
  return transaction(directory, (database) => {
    const existing = database.prepare("SELECT data FROM runner WHERE id = 1").get();
    if (existing) {
      const owner = JSON.parse(existing.data as string) as Runner;
      if (owner.host !== hostname() || processIsAlive(owner.pid)) {
        throw new Error(`A scheduler is already running (PID ${owner.pid} on ${owner.host}).`);
      }
    }
    const runner = { token: randomUUID(), pid: process.pid, host: hostname() };
    database.prepare("INSERT INTO runner (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      .run(JSON.stringify(runner));
    recoverInterruptedJobs(database);
    return runner;
  });
}

async function releaseRunner(runner: Runner, directory?: string): Promise<void> {
  await transaction(directory, (database) => {
    database.prepare("DELETE FROM runner WHERE id = 1 AND data = ?").run(JSON.stringify(runner));
  });
}

function dueJobs(database: DatabaseSync): ScheduledJob[] {
  const now = Date.now();
  return readJobs(database)
    .filter((item) => item.status === "pending" && item.nextRunAt !== null && Date.parse(item.nextRunAt) <= now)
    .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!));
}

async function claimDueJob(directory?: string, eligibleIds?: Set<string>): Promise<ScheduledJob | undefined> {
  return transaction(directory, (database) => {
    const job = dueJobs(database).find((item) => eligibleIds === undefined || eligibleIds.has(item.id));
    if (!job) return undefined;
    job.status = "running";
    job.runCount += 1;
    job.lastStartedAt = new Date().toISOString();
    delete job.lastError;
    delete job.lastResult;
    return saveJob(database, job);
  });
}

async function finishJob(id: string, result: unknown, error: string | undefined, directory?: string): Promise<void> {
  await transaction(directory, (database) => {
    const job = readJobs(database).find((item) => item.id === id)!;
    job.lastResult = result;
    job.lastError = error;
    job.lastRunStatus = error === undefined ? "completed" : "failed";
    job.lastFinishedAt = new Date().toISOString();
    if (job.status !== "cancelled") {
      job.nextRunAt = nextOccurrence(job);
      job.status = job.nextRunAt ? "pending" : job.lastRunStatus;
    }
    saveJob(database, job);
  });
}

async function executeJob(job: ScheduledJob, execute: (job: ScheduledJob) => Promise<unknown>, directory?: string): Promise<void> {
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
  await finishJob(job.id, result, error, directory);
}

export async function runScheduler(execute: (job: ScheduledJob) => Promise<unknown>, options: SchedulerOptions = {}): Promise<void> {
  const pollMs = options.pollMs ?? 1000;
  if (!Number.isFinite(pollMs) || pollMs < 1) throw new Error("pollMs must be a positive number.");
  if (options.signal?.aborted) return;
  const runner = await acquireRunner(options.directory);
  try {
    const eligibleIds = options.once
      ? await transaction(options.directory, (database) => new Set(dueJobs(database).map((job) => job.id)))
      : undefined;
    while (!options.signal?.aborted) {
      const job = await claimDueJob(options.directory, eligibleIds);
      if (job) {
        eligibleIds?.delete(job.id);
        await executeJob(job, execute, options.directory);
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
    await releaseRunner(runner, options.directory);
  }
}
