# Pekka

Pekka is a command-line AI agent that works on tasks in a persistent Linux
sandbox. It uses [OpenRouter](https://openrouter.ai) for a tool-capable model
and [Daytona](https://daytona.io) for the computer where it runs commands and
reads and writes files. You can run a one-off task or save a named bot with a
role and job.

Pekka currently has a CLI, an agent loop, shell and file tools, and optional web
search, web scraping, and scheduled jobs. Bot profiles are local JSON files. There is no web UI,
browser control, or bot-to-bot delegation yet.

## Requirements

- Node.js 22.13 or newer and pnpm 11 (the project specifies pnpm 11.3.0).
- An [OpenRouter API key](https://openrouter.ai/settings/keys) and a model that supports tool calling.
- A [Daytona API key](https://app.daytona.io/dashboard/keys).
- Optional: a [Tavily](https://app.tavily.com/) or [Exa](https://dashboard.exa.ai/) API key for web search.

## Get started

```bash
pnpm install
cp .env.example .env
```

Set `OPENROUTER_API_KEY` and `DAYTONA_API_KEY` in `.env`, then run a task:

```bash
pnpm pekka run "Create a hello.txt file containing a short greeting, then read it back to verify it"
```

The CLI prints model output, tool calls, results, and a final token and cost
summary. The file in this example is created **inside the Daytona sandbox**,
not in this repository. Pekka looks up the sandbox by name on each run, creates
it if needed, and starts it if it was stopped. New sandboxes are configured to
stop after 15 idle minutes; their files remain available on later runs.

For a task that needs current information, add `TAVILY_API_KEY` or
`EXA_API_KEY` to `.env` before running it. Tavily is tried first; Exa is used
if Tavily fails or returns no results.

## Saved bots

```bash
pnpm pekka bot create --name "Scout" --role "Repository researcher" --job "Find interesting TypeScript repositories and write a report"
pnpm pekka bot list
pnpm pekka bot run "Scout"
```

`bot run` uses the bot's job as the task and adds its name, role, and job to the
system prompt. Profiles are stored in `.pekka/bots.json` under the directory
from which you run the CLI. Each named bot gets its own sandbox on its first run
and its own Markdown memory when created. Creating a bot does not schedule runs.

## Scheduled jobs

Ask the agent to schedule work in natural language:

```bash
pnpm pekka run "Schedule a repository research report every 24 hours, starting tomorrow at 09:00 Asia/Kolkata. Save each report in the sandbox."
```

The agent has `schedule_job`, `list_scheduled_jobs`, and
`cancel_scheduled_job` tools. A job contains a self-contained task, a first
execution time with an explicit UTC offset, and an optional repeat interval
between 60 seconds and 365 days. Omit the interval for a one-time job. Jobs created by
a named bot retain that bot's name, role, and job at creation time.

Start the runner from the **same local project directory** in another terminal:

```bash
pnpm pekka scheduler
pnpm pekka jobs list
pnpm pekka jobs cancel "<job-id>"
```

Keep the scheduler process and its host running. Creating a job does not start
the runner or install an operating-system service. `pnpm pekka scheduler --once`
processes currently due jobs and exits. Ctrl-C stops the runner after its active
task finishes. Cancelling a running job prevents future runs but does not
interrupt the active task.

Jobs and their latest results persist in a local SQLite database under `.pekka`;
Node.js 22 may print an experimental SQLite warning. Runs use the scheduler's
current environment configuration and the owning bot's sandbox (or the base
sandbox for unnamed tasks). Each run
starts a fresh conversation. Jobs execute serially, with only one runner per
project. Missed repeats are coalesced into one overdue run, then the schedule
advances to a future interval. Fixed intervals do not adjust for daylight saving
time. Interrupted runs are recorded as failed instead of automatically replaying
potentially completed actions. Inspect `pekka jobs list` for status and the latest
answer or error; there is no notification delivery or full run-history UI.

## Per-bot workspace and Markdown memory

Each named bot uses a separate persistent Daytona sandbox with a `workspace`
directory under the sandbox's working directory. Commands and relative file paths
default to that workspace. Manual bot runs and scheduled jobs reuse the same
workspace; unnamed `pekka run` tasks continue using the configured base sandbox.
Existing files in the old shared sandbox are not moved automatically.

Memory lives locally in `.pekka/bots/<bot-key>/memory/PREFERENCES.md` and
`KNOWLEDGE.md`. The key derives from the local project directory and the
case-insensitive bot name. Keep running the project from the same directory to
reuse its sandbox and memory. Each bot gets its own files, which you can edit
directly as Markdown. Preferences hold user instructions about style and workflow;
knowledge holds verified facts and reusable findings.

The agent loads previews of both files at the start of every named-bot run and
can read and replace them using `read_memory` and `write_memory`. Scheduled jobs
load the latest memory rather than a snapshot. Memory updates are explicit tool
calls, not automatic transcript storage. Memory remains on the local host while
workspace files remain in Daytona.

## Skills with progressive disclosure

Skills are local folders containing `SKILL.md` with YAML frontmatter. Named bots
look in `.pekka/bots/<bot-key>/skills/`; unnamed runs look in `.pekka/skills/`.
Bot creation scaffolds its skills directory. Add a folder such as `research/`:

```markdown
---
name: research
description: Research repositories and write a sourced report.
---
Search for current sources, verify the findings, and write the report.
Read references/report-format.md when preparing the final report.
```

The name must match the folder and contain lowercase letters, digits, and
hyphens, up to 64 characters. Descriptions may use YAML multiline strings.
Only names and description previews enter the initial agent prompt, capped at
20 skills. `list_skills` provides full descriptions and pagination;
`load_skill` loads the selected instructions and, when needed, referenced text
files inside that skill folder. Long files return `next_offset` for continuation.
Malformed skills are reported without disabling valid skills.

Instructions and supporting files are not all loaded upfront. Skills remain
separate for each bot, and scheduled runs discover the latest files. Supporting
scripts are read as text; they are not automatically executed or installed in
the Daytona workspace.

## Configuration

The CLI loads `.env` from the current directory when it exists. Environment
variables can also be supplied by your shell. See [.env.example](.env.example)
for a copyable template.

| Variable | Purpose | Default |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | OpenRouter authentication; required to run a task | — |
| `DAYTONA_API_KEY` | Daytona authentication; required to run a task | — |
| `PEKKA_MODEL` | OpenRouter model ID; choose one with tool calling | `z-ai/glm-5.3-flash` |
| `PEKKA_SANDBOX_NAME` | Name used to find or create the persistent sandbox | `pekka-computer` |
| `PEKKA_MAX_STEPS` | Maximum model replies per task | `30` |
| `TAVILY_API_KEY` | Enables Tavily web search | unset |
| `EXA_API_KEY` | Enables Exa web search or fallback | unset |
| `SCRAPERAPI_API_KEY` | Enables ScraperAPI web scraping | unset |

Without a search key, the `web_search` tool returns an error when called.
`PEKKA_MAX_STEPS` limits model replies, not the number of commands within a
reply. The cost summary uses provider-reported cost, which can be zero when the
provider does not include it.

The repository also contains a standalone [Cloudflare D1 query
service](src/database/d1.ts). It needs `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_D1_DATABASE_ID` when used directly.
The CLI does not use D1, and bot profiles are not stored there.

## How it works

1. The CLI connects to the named Daytona sandbox and creates an OpenRouter model client.
2. The [agent loop](src/agent/loop.ts) sends the task and available tool definitions to the model.
3. Pekka executes requested tools and sends their results back to the model until it gives a reply without a tool call or reaches the step limit.

The available tools are `run_command`, `read_file`, `write_file`, and
`web_search`, `web_scrape`, `schedule_job`, `list_scheduled_jobs`, and
`cancel_scheduled_job`. Shell and file operations run on the Daytona computer.
`write_file` replaces the entire target file. Web search calls Tavily or Exa
from the CLI process and returns result titles, URLs, and snippets for the
model to assess.

Set `SCRAPERAPI_API_KEY` to use `web_scrape` for reading HTTP/HTTPS URLs.
It calls ScraperAPI from the CLI process and returns Markdown by default;
`output_format` also accepts `text` or `html`. Set `render: true` for pages
that require JavaScript (this uses additional API credits). Requests time out
after 90 seconds, and tool output is limited to 20,000 characters. Without
the key, the tool reports a configuration error. See the
[ScraperAPI documentation](https://docs.scraperapi.com/) for provider details.

The model can choose shell commands that change the sandbox. Review what you
ask it to do and avoid placing secrets in task text. Files in the named sandbox
persist across tasks in that bot's sandbox.

## Development

```bash
pnpm typecheck
pnpm test
```

The tests use a fake computer and do not need API keys. They do not exercise a
live Daytona sandbox or OpenRouter model. To add a tool, define it in
`src/tools/` and register it in [src/tools/index.ts](src/tools/index.ts).
