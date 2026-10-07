import { z } from "zod";
import type { Database } from "../database/database.ts";
import { approvalRequired } from "../permissions/policy.ts";
import { cancelScheduledJob, createScheduledJob, getSchedulerStatus, listScheduledJobs, type ScheduledJob } from "../scheduler.ts";
import { defineTool } from "./tool.ts";

export function createSchedulingTools(database?: Database) {
  const scheduleJob = defineTool({
    name: "schedule_job",
    permission: { effect: "write", confirm: true },
    description:
      "Schedule a future agent task, once or at a fixed interval. Only schedule work the user requested. " +
      "Jobs are saved in Pekka's database and run only while a Pekka scheduler process is running; the result says whether one is. " +
      "The current bot's identity is saved with the job. Use list_scheduled_jobs first to check for an existing job that already does this. " +
      "Jobs cannot be edited: to change one, cancel it and schedule a new one.",
    input: z.object({
      name: z.string().trim().min(1).describe("Short job name."),
      task: z.string().trim().min(1).describe("Self-contained task for a fresh agent conversation; include all necessary context."),
      run_at: z.iso.datetime({ offset: true }).describe("First execution time in the future, ISO 8601 with Z or an explicit UTC offset. Work it out in the user's timezone, not the server's."),
      interval_seconds: z.number().int().min(60).max(31_536_000).optional().describe("Repeat every 60 to 31536000 seconds; omit for a one-time job. Fixed intervals do not adjust for daylight saving time."),
    }),
    async run(input, context) {
      const job = await createScheduledJob(context.userId, {
        name: input.name,
        task: input.task,
        runAt: input.run_at,
        intervalSeconds: input.interval_seconds,
        bot: context.bot,
      }, database);
      const { running } = await getSchedulerStatus(database);
      return JSON.stringify({
        job: summarizeJob(job),
        scheduler_running: running,
        execution: running
          ? "A scheduler is running, so the job will run when it is due."
          : "No scheduler is running. Saving a job does not start the scheduler: the job waits until whoever hosts Pekka starts one with `pekka scheduler`.",
        ...(approvalRequired() ? {
          warning: "Approval review is on, and scheduled runs have nobody to approve actions. This job can only read: any command, file change or message it attempts will fail.",
        } : {}),
      });
    },
  });

  const listJobs = defineTool({
    name: "list_scheduled_jobs",
    permission: { effect: "read" },
    description:
      "List scheduled job summaries, IDs, next execution times, status, and latest result previews. " +
      "Includes the jobs of all the user's bots and of unnamed runs; each summary's bot field says whose it is. Follow next_offset to see additional jobs. " +
      "Also returns the current time, whether a scheduler is running, and the server's timezone, which is not necessarily the user's. " +
      "Paused jobs can only be resumed from the Scheduled page in the web app.",
    input: z.object({
      offset: z.number().int().min(0).default(0).describe("Pagination offset; start at zero."),
      limit: z.number().int().min(1).max(10).default(10).describe("Number of summaries to return, up to ten."),
    }),
    async run({ offset, limit }, { userId }) {
      const [jobs, scheduler] = await Promise.all([listScheduledJobs(userId, database), getSchedulerStatus(database)]);
      const page = jobs.slice(offset, offset + limit);
      return JSON.stringify({
        now: new Date().toISOString(),
        server_time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        scheduler_running: scheduler.running,
        jobs: page.map(summarizeJob),
        total: jobs.length,
        next_offset: offset + page.length < jobs.length ? offset + page.length : null,
      });
    },
  });

  const cancelJob = defineTool({
    name: "cancel_scheduled_job",
    permission: { effect: "write" },
    description: "Cancel a scheduled job by ID. Prevents future executions; an already-running task is allowed to finish. Works on any of the user's jobs, including other bots', so cancel only jobs the user asked to stop.",
    input: z.object({ id: z.string().min(1).describe("Job ID returned by schedule_job or list_scheduled_jobs.") }),
    async run({ id }, { userId }) {
      return JSON.stringify(summarizeJob(await cancelScheduledJob(userId, id, database)));
    },
  });

  return [scheduleJob, listJobs, cancelJob];
}

function preview(value: string | undefined, length: number): string | undefined {
  if (value === undefined || value.length <= length) return value;
  return value.slice(0, length) + "… [truncated]";
}

function summarizeJob(job: ScheduledJob) {
  return {
    id: job.id,
    name: preview(job.name, 120),
    task: preview(job.task, 300),
    bot: job.bot ? {
      name: preview(job.bot.name, 120), role: preview(job.bot.role, 120), job: preview(job.bot.job, 300),
    } : undefined,
    status: job.status,
    runAt: job.runAt,
    intervalSeconds: job.intervalSeconds,
    nextRunAt: job.nextRunAt,
    runCount: job.runCount,
    lastRunStatus: job.lastRunStatus,
    lastError: preview(job.lastError, 300),
    lastResultPreview: preview(JSON.stringify(job.lastResult), 500),
  };
}
