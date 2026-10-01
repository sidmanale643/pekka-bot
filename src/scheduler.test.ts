import { hostname } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSchema, LOCAL_USER } from "./database/database.ts";
import { createSqliteDatabase } from "./database/sqlite.ts";
import {
  cancelScheduledJob, createScheduledJob, listScheduledJobs, pauseScheduledJob, resumeScheduledJob, runScheduler, type ScheduledJob,
} from "./scheduler.ts";

let database: ReturnType<typeof createSqliteDatabase>;
const input = () => ({ name: "Report", task: "Write a report", runAt: new Date(Date.now() + 60_000).toISOString() });

beforeEach(() => { database = createSqliteDatabase(); });
afterEach(() => { database.close(); });

async function dueJob(extra: { intervalSeconds?: number } = {}): Promise<ScheduledJob> {
  const job = await createScheduledJob(LOCAL_USER, { ...input(), ...extra }, database);
  job.runAt = new Date(Date.now() - 180_000).toISOString();
  job.nextRunAt = job.runAt;
  await database.run("UPDATE scheduled_jobs SET next_run_at = ?, data = ? WHERE id = ?", [job.nextRunAt, JSON.stringify(job), job.id]);
  return job;
}

/** Leaves a lock behind as if a scheduler on another machine had crashed. */
async function abandonedRunner(expiresAt: string) {
  await ensureSchema(database);
  await database.run("INSERT INTO scheduler_runner (id, token, host, pid, expires_at) VALUES (1, 'old', 'other-host', 1, ?)", [expiresAt]);
}

describe("scheduled jobs", () => {
  it("validates schedules and persists a bot snapshot", async () => {
    await expect(createScheduledJob(LOCAL_USER, { ...input(), runAt: "2030-01-01T12:00:00" }, database)).rejects.toThrow();
    await expect(createScheduledJob(LOCAL_USER, { ...input(), runAt: "2020-01-01T12:00:00Z" }, database)).rejects.toThrow();
    await expect(createScheduledJob(LOCAL_USER, { ...input(), intervalSeconds: 5 }, database)).rejects.toThrow();
    const bot = { id: "0123456789abcdef01234567", name: "Reporter", role: "Researcher", job: "Reports" };
    const job = await createScheduledJob(LOCAL_USER, { ...input(), bot }, database);
    bot.role = "Changed";
    expect((await listScheduledJobs(LOCAL_USER, database))[0]).toMatchObject({ id: job.id, bot: { role: "Researcher" } });
  });

  it("keeps every concurrently created job", async () => {
    await Promise.all(Array.from({ length: 4 }, (_, i) => createScheduledJob(LOCAL_USER, { ...input(), name: `job-${i}` }, database)));
    expect(await listScheduledJobs(LOCAL_USER, database)).toHaveLength(4);
  });

  it("executes due tasks serially once, skips future and cancelled tasks, and isolates failures", async () => {
    const first = await dueJob();
    const second = await dueJob();
    const cancelled = await dueJob();
    await cancelScheduledJob(LOCAL_USER, cancelled.id, database);
    await createScheduledJob(LOCAL_USER, input(), database);
    const executed: string[] = [];
    await runScheduler(async (job) => {
      executed.push(job.id);
      if (job.id === first.id) throw new Error("Provider failed");
      return { answer: "done" };
    }, { database, once: true });
    await runScheduler(async () => { throw new Error("Must not rerun"); }, { database, once: true });
    expect(executed).toEqual([first.id, second.id]);
    const jobs = await listScheduledJobs(LOCAL_USER, database);
    expect(jobs[0]).toMatchObject({ status: "failed", runCount: 1, lastError: "Provider failed" });
    expect(jobs[1]).toMatchObject({ status: "completed", runCount: 1, lastResult: { answer: "done" } });
    expect(jobs[2]?.status).toBe("cancelled");
    expect(jobs[3]?.status).toBe("pending");
  });

  it("skips missed interval occurrences and preserves cancellation during execution", async () => {
    const repeating = await dueJob({ intervalSeconds: 60 });
    const cancelled = await dueJob({ intervalSeconds: 60 });
    await runScheduler(async (job) => {
      if (job.id === cancelled.id) await cancelScheduledJob(LOCAL_USER, job.id, database);
      return { status: "step_limit", answer: "unfinished" };
    }, { database, once: true });
    const jobs = await listScheduledJobs(LOCAL_USER, database);
    expect(jobs.find((job) => job.id === repeating.id)).toMatchObject({ status: "pending", runCount: 1, lastRunStatus: "failed" });
    expect(Date.parse(jobs[0]!.nextRunAt!)).toBeGreaterThan(Date.now());
    expect(jobs.find((job) => job.id === cancelled.id)).toMatchObject({ status: "cancelled", nextRunAt: null });
  });

  it("skips paused jobs and resumes them on the next occurrence", async () => {
    const once = await dueJob();
    const repeating = await dueJob({ intervalSeconds: 60 });
    await pauseScheduledJob(LOCAL_USER, once.id, database);
    await pauseScheduledJob(LOCAL_USER, repeating.id, database);
    await expect(pauseScheduledJob(LOCAL_USER, once.id, database)).rejects.toThrow("Only upcoming jobs");
    await runScheduler(async () => { throw new Error("Must not run while paused"); }, { database, once: true });
    expect(await listScheduledJobs(LOCAL_USER, database)).toMatchObject([{ status: "paused", nextRunAt: null }, { status: "paused", nextRunAt: null }]);
    const resumedOnce = await resumeScheduledJob(LOCAL_USER, once.id, database);
    expect(resumedOnce.status).toBe("pending");
    expect(Date.parse(resumedOnce.nextRunAt!)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse((await resumeScheduledJob(LOCAL_USER, repeating.id, database)).nextRunAt!)).toBeGreaterThan(Date.now());
    await expect(resumeScheduledJob(LOCAL_USER, once.id, database)).rejects.toThrow("Only paused jobs");
  });

  it("rejects a second runner while the first holds the lock", async () => {
    await dueJob();
    let claimed!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => { claimed = resolve; });
    const controller = new AbortController();
    const first = runScheduler(async () => {
      claimed();
      await new Promise<void>((resolve) => { finish = resolve; });
      controller.abort();
    }, { database, signal: controller.signal, pollMs: 10 });
    await started;
    await expect(runScheduler(async () => {}, { database, once: true })).rejects.toThrow("already running");
    finish();
    await first;
    await runScheduler(async () => {}, { database, once: true });
  });

  it("respects a live lock from another host and takes over an expired one without replaying its run", async () => {
    const job = await dueJob();
    await database.run("UPDATE scheduled_jobs SET status = 'running', data = json_set(data, '$.status', 'running', '$.runCount', 1) WHERE id = ?", [job.id]);
    await abandonedRunner(new Date(Date.now() + 60_000).toISOString());
    await expect(runScheduler(async () => {}, { database, once: true })).rejects.toThrow("already running (PID 1 on other-host)");
    await database.run("UPDATE scheduler_runner SET expires_at = ?", [new Date(Date.now() - 1000).toISOString()]);
    let calls = 0;
    await runScheduler(async () => { calls++; }, { database, once: true });
    expect(calls).toBe(0);
    expect((await listScheduledJobs(LOCAL_USER, database)).find((item) => item.id === job.id)).toMatchObject({
      status: "failed", runCount: 1, lastRunStatus: "failed", lastError: expect.stringContaining("will not be retried"),
    });
    expect(await database.query("SELECT * FROM scheduler_runner")).toEqual([]);
  });

  it("takes over a lock left by a dead process on this host without waiting for it to expire", async () => {
    await abandonedRunner(new Date(Date.now() + 60_000).toISOString());
    await database.run("UPDATE scheduler_runner SET host = ?, pid = ?", [hostname(), 2 ** 22 + 12345]);
    await runScheduler(async () => {}, { database, once: true });
  });

  it("stops when another runner takes over its expired lock", async () => {
    await dueJob();
    const run = runScheduler(async () => {
      await database.run("UPDATE scheduler_runner SET token = 'other'");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }, { database, pollMs: 10, leaseMs: 30 });
    await expect(run).rejects.toThrow("took over");
    expect(await database.query("SELECT token FROM scheduler_runner")).toEqual([{ token: "other" }]);
  });

  it("once processes only the initial due jobs, each at most once", async () => {
    const first = await dueJob({ intervalSeconds: 60 });
    const second = await dueJob({ intervalSeconds: 60 });
    const future = await createScheduledJob(LOCAL_USER, input(), database);
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const controller = new AbortController();
    const executed: string[] = [];
    let added: ScheduledJob | undefined;
    try {
      await runScheduler(async (job) => {
        executed.push(job.id);
        if (executed.length === 1) added = await dueJob();
        now += 90_000;
        if (executed.length > 4) controller.abort();
      }, { database, once: true, signal: controller.signal });
      expect(executed).toEqual([first.id, second.id]);
      const jobs = await listScheduledJobs(LOCAL_USER, database);
      expect(jobs.find((job) => job.id === first.id)?.runCount).toBe(1);
      expect(jobs.find((job) => job.id === second.id)?.runCount).toBe(1);
      expect(jobs.find((job) => job.id === future.id)?.runCount).toBe(0);
      expect(jobs.find((job) => job.id === added?.id)?.runCount).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  it("finishes the current task when aborted and leaves later tasks pending", async () => {
    await dueJob();
    await dueJob();
    const controller = new AbortController();
    await runScheduler(async () => { controller.abort(); return "finished"; }, { database, signal: controller.signal });
    expect((await listScheduledJobs(LOCAL_USER, database)).map((job) => job.status)).toEqual(["completed", "pending"]);
    await runScheduler(async () => "next", { database, once: true });
    expect((await listScheduledJobs(LOCAL_USER, database)).map((job) => job.status)).toEqual(["completed", "completed"]);
  });
});

describe("job owners", () => {
  it("lets each user see and change only their own jobs, and runs each job as its owner", async () => {
    const database = createSqliteDatabase();
    try {
      const runAt = new Date(Date.now() + 60_000).toISOString();
      const job = await createScheduledJob("user-a", { name: "Report", task: "Report", runAt }, database);
      expect(job.userId).toBe("user-a");
      expect(await listScheduledJobs("user-b", database)).toEqual([]);
      await expect(cancelScheduledJob("user-b", job.id, database)).rejects.toThrow("No scheduled job");
      await expect(pauseScheduledJob("user-b", job.id, database)).rejects.toThrow("No scheduled job");
      expect((await listScheduledJobs("user-a", database))[0]).toMatchObject({ id: job.id, status: "pending" });

      await database.run("UPDATE scheduled_jobs SET next_run_at = ?", [new Date(Date.now() - 1000).toISOString()]);
      const owners: string[] = [];
      await runScheduler(async (due) => { owners.push(due.userId); }, { database, once: true });
      expect(owners).toEqual(["user-a"]);
    } finally { database.close(); }
  });
});
