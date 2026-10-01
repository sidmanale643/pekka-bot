import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runAgent } from "../agent/loop.ts";
import { executeToolCall } from "../agent/execute-tool-call.ts";
import { FakeComputer } from "../computer/fake-computer.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { createScheduledJob, listScheduledJobs, runScheduler } from "../scheduler.ts";
import { createSchedulingTools } from "./scheduled-jobs.ts";
import { toToolDefinition } from "./tool.ts";
import { writeFile } from "./write-file.ts";
import { LOCAL_USER } from "../database/database.ts";

// These tests cover approval review, which is off by default.
beforeEach(() => { vi.stubEnv("PEKKA_REQUIRE_APPROVAL", "true"); });
afterEach(() => { vi.unstubAllEnvs(); });

const databases: ReturnType<typeof createSqliteDatabase>[] = [];
afterEach(() => { databases.splice(0).forEach((database) => database.close()); });

async function setup() {
  const database = createSqliteDatabase();
  databases.push(database);
  return { database, tools: createSchedulingTools(database) };
}

it("lets the agent schedule, inspect and cancel a durable job with its bot identity", async () => {
  const { database, tools } = await setup();
  const bot = { id: "0123456789abcdef01234567", name: "Scout", role: "Researcher", job: "Research repositories" };
  let step = 0;
  let id = "";
  const result = await runAgent("Schedule a report", {
    computer: new FakeComputer(), approveAction: async () => true, userId: LOCAL_USER, tools, bot, maxSteps: 4, database,
    model: {
      async reply(messages) {
        step++;
        let name = "schedule_job";
        let args: unknown = { name: "Report", task: "Research repositories and save report.md", run_at: new Date(Date.now() + 3_600_000).toISOString(), interval_seconds: 86_400 };
        if (step === 2) {
          const response = messages.at(-1)!;
          const saved = JSON.parse(response.content!);
          id = saved.job.id;
          expect(saved.execution).toContain("does not start");
          name = "list_scheduled_jobs";
          args = {};
        }
        if (step === 3) {
          const listed = JSON.parse(messages.at(-1)!.content!);
          expect(listed.jobs).toHaveLength(1);
          expect(listed.jobs[0]).toMatchObject({ id, bot: { name: bot.name, role: bot.role, job: bot.job }, intervalSeconds: 86_400 });
          expect(Number.isFinite(Date.parse(listed.now))).toBe(true);
          name = "cancel_scheduled_job";
          args = { id };
        }
        return {
          message: step === 4 ? { role: "assistant" as const, content: "Cancelled" } : {
            role: "assistant" as const, content: null,
            tool_calls: [{ id: `call_${step}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }],
          },
          usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
        };
      },
    },
  });
  expect(result.status).toBe("done");
  expect(await listScheduledJobs(LOCAL_USER, database)).toMatchObject([{ id, status: "cancelled" }]);
});

it("rejects ambiguous timestamps and too-short intervals through tool validation", async () => {
  const { tools, database } = await setup();
  for (const args of [
    { run_at: "2030-01-01T10:00:00" },
    { run_at: "2030-01-01T10:00:00Z", interval_seconds: 1 },
  ]) {
    const result = await executeToolCall({
      id: "bad", type: "function", function: {
        name: "schedule_job", arguments: JSON.stringify({ name: "Report", task: "Write report", ...args }),
      },
    }, tools, { computer: new FakeComputer(), approveAction: async () => true, userId: LOCAL_USER });
    expect(result.isError).toBe(true);
  }
  expect(await listScheduledJobs(LOCAL_USER, database)).toEqual([]);
  expect(tools.map(toToolDefinition).map((tool) => tool.function.name)).toEqual([
    "schedule_job", "list_scheduled_jobs", "cancel_scheduled_job",
  ]);
});

it("keeps every job discoverable through pagination even with large saved tasks", async () => {
  const { tools, database } = await setup();
  const jobs = [];
  for (let index = 0; index < 11; index++) {
    jobs.push(await createScheduledJob(LOCAL_USER, {
      name: `Job ${index}`, task: "x".repeat(30_000), runAt: new Date(Date.now() + 60_000).toISOString(),
    }, database));
  }
  const ids: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const result = await executeToolCall({
      id: "list", type: "function", function: { name: "list_scheduled_jobs", arguments: JSON.stringify({ offset }) },
    }, tools, { computer: new FakeComputer(), approveAction: async () => true, userId: LOCAL_USER });
    expect(result.isError).toBe(false);
    const page = JSON.parse(result.output);
    expect(page.total).toBe(11);
    ids.push(...page.jobs.map((job: { id: string }) => job.id));
    offset = page.next_offset;
  }
  expect(ids).toEqual(jobs.map((job) => job.id));
});

it("picks up an approved agent-created job but rejects scheduled writes without a reviewer", async () => {
  const { tools, database } = await setup();
  const computer = new FakeComputer();
  const bot = { id: "0123456789abcdef01234567", name: "Reporter", role: "Writer", job: "Write reports" };
  const controller = new AbortController();
  const runner = runScheduler(async (job) => {
    let step = 0;
    const result = await runAgent(job.task, {
      computer, tools: [writeFile], userId: job.userId, bot: job.bot, maxSteps: 2, database,
      model: {
        async reply(messages) {
          if (++step === 1) {
            expect(messages).toHaveLength(2);
            expect(messages[0]!.content).toContain("You are Reporter, a bot running on Pekka.");
            expect(messages[1]!.content).toBe("Write the scheduled report");
          }
          return {
            message: step === 1 ? {
              role: "assistant" as const, content: null,
              tool_calls: [{ id: "write", type: "function" as const, function: {
                name: "write_file", arguments: JSON.stringify({ path: "/report.txt", content: "Scheduled report" }),
              } }],
            } : { role: "assistant" as const, content: "Report requires permission" },
            usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
          };
        },
      },
    });
    controller.abort();
    return { status: result.status, answer: result.answer };
  }, { database, pollMs: 10, signal: controller.signal });

  try {
    const saved = await executeToolCall({
      id: "schedule", type: "function", function: {
        name: "schedule_job", arguments: JSON.stringify({
          name: "Report", task: "Write the scheduled report", run_at: new Date(Date.now() + 200).toISOString(),
        }),
      },
    }, tools, { computer, approveAction: async () => true, userId: LOCAL_USER, bot });
    expect(saved.isError).toBe(false);
    const id = JSON.parse(saved.output).job.id;
    await vi.waitFor(async () => {
      expect((await listScheduledJobs(LOCAL_USER, database)).find((job) => job.id === id)).toMatchObject({
        status: "completed", runCount: 1, lastResult: { status: "done", answer: "Report requires permission" },
      });
    }, { timeout: 2000, interval: 20 });
    expect(computer.files.has("/report.txt")).toBe(false);
  } finally {
    controller.abort();
    await runner;
  }
});
