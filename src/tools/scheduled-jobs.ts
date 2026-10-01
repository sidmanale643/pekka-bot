import { z } from "zod";
import type { Database } from "../database/database.ts";
import { cancelScheduledJob, createScheduledJob, listScheduledJobs, type ScheduledJob } from "../scheduler.ts";
import { defineTool } from "./tool.ts";

export function createSchedulingTools(database?: Database) {
  const scheduleJob = defineTool({
    name: "schedule_job",
    description:
      "Schedule a future agent task, once or at a fixed interval. Only schedule work the user requested. " +
      "Jobs are saved in the database and execute only while `pekka scheduler` is running from this project directory. " +
      "The current bot's identity is saved with the job. Use list_scheduled_jobs to check existing jobs before creating duplicates.",
    input: z.object({
      name: z.string().trim().min(1).describe("Short job name."),
      task: z.string().trim().min(1).describe("Self-contained task for a fresh agent conversation; include all necessary context."),
      run_at: z.iso.datetime({ offset: true }).describe("First execution time in the future, ISO 8601 with Z or an explicit UTC offset."),
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
      return JSON.stringify({ job: summarizeJob(job), execution: "Run `pekka scheduler` from the same project directory and keep it running. Saving a job does not start the scheduler." });
    },
  });

  const listJobs = defineTool({
    name: "list_scheduled_jobs",
    description: "List scheduled job summaries, IDs, next execution times, status, and latest result previews. Follow next_offset to see additional jobs. Also returns current time and host timezone for planning schedules.",
    input: z.object({
      offset: z.number().int().min(0).default(0).describe("Pagination offset; start at zero."),
      limit: z.number().int().min(1).max(10).default(10).describe("Number of summaries to return, up to ten."),
    }),
    async run({ offset, limit }, { userId }) {
      const jobs = await listScheduledJobs(userId, database);
      const page = jobs.slice(offset, offset + limit);
      return JSON.stringify({
        now: new Date().toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        jobs: page.map(summarizeJob),
        total: jobs.length,
        next_offset: offset + page.length < jobs.length ? offset + page.length : null,
      });
    },
  });

  const cancelJob = defineTool({
    name: "cancel_scheduled_job",
    description: "Cancel a scheduled job by ID. Prevents future executions; an already-running task is allowed to finish.",
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
