<p align="center"><img src="src/web/logo.png" alt="Pekka logo" width="160" /></p>

# Pekka

Pekka is a command-line AI agent that works on tasks in a persistent Linux
sandbox. It uses [OpenRouter](https://openrouter.ai) for a tool-capable model
and [Daytona](https://daytona.io) for the computer where it runs commands and
reads and writes files. You can run a one-off task or save a named bot with a
name and description. In the web interface, the bot learns your context and
working preferences through conversation.

Pekka currently has a CLI, a local web interface and HTTP API, an agent loop,
shell and file tools, and optional web search, web scraping, and scheduled jobs.
Bot profiles and scheduled jobs are stored in [Cloudflare
D1](https://developers.cloudflare.com/d1/). There is no browser control or
bot-to-bot delegation yet.

## Requirements

- Node.js 22.13 or newer and pnpm 11 (the project specifies pnpm 11.3.0).
- An [OpenRouter API key](https://openrouter.ai/settings/keys) and a model that supports tool calling.
- A [Daytona API key](https://app.daytona.io/dashboard/keys).
- A [Cloudflare D1 database](https://developers.cloudflare.com/d1/get-started/) and an [API token](https://dash.cloudflare.com/profile/api-tokens) with the **Account > D1 > Edit** permission.
- Optional: a [Tavily](https://app.tavily.com/) or [Exa](https://dashboard.exa.ai/) API key for web search.

## Get started

```bash
pnpm install
cp .env.example .env
```

Set `OPENROUTER_API_KEY`, `DAYTONA_API_KEY`, `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_D1_DATABASE_ID` in `.env`. Check the
database connection:

```bash
pnpm pekka db check
```

Pekka creates its tables the first time it uses the database. If you used
Pekka before it stored data in D1, run the import once from the same project
directory you used before:

```bash
pnpm pekka db import
```

It copies bots from `.pekka/bots.json`, each bot's memory and skills from
`.pekka/bots/`, shared skills from `.pekka/skills/`, and jobs from
`.pekka/jobs/scheduler.sqlite`. Imported bots keep the key their sandbox was
named after, so they reuse their existing Daytona sandboxes. The import skips
anything already in D1, so it is safe to run again, and it leaves the local
files in place. Then run a task:

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
pnpm pekka bot create --name "Scout" --description "Help me research repositories"
pnpm pekka bot list
```

Open the bot in the web interface to tell it about yourself and what you want
help with. It can save preferences and refine its description and working
instructions using tools, subject to permission review. Recent chat messages
are included with each reply; saved configuration and memory also apply to
future runs. Once working instructions are saved, `pnpm pekka bot run "Scout"`
uses them as its task. The legacy `--role` and `--job` creation flags remain supported.
Profiles are stored in D1, and each user's bot names are unique
regardless of case. The CLI always acts as the local user (see
[Sign-in and multiple users](#sign-in-and-multiple-users)). Each bot gets a permanent ID when it is created. Its sandbox, memory and
own skills are keyed by that ID, so the bot is the same from any machine or
directory that uses the same D1 database. Creating a bot does not schedule runs.

## Web interface

Start the server from the project directory:

```bash
pnpm api
```

Open [Pekka in your browser](http://127.0.0.1:3000). Create a bot with a name,
role, and job, select it in the sidebar, and send a task to see streamed output.
The bot header opens its details. No frontend build or separate development
server is required; the interface and API share the same local address.

Task history is saved in this browser's local storage, not on the server. It
does not transfer between browsers or addresses, and clearing browser data
removes it. Each task starts a fresh model conversation: earlier chat messages
are not sent automatically. The bot's persistent workspace and explicit memory
remain available across runs.

Open **Scheduled** in the sidebar to create recurring or one-time tasks for a
bot, start from a template, and pause, resume, cancel or duplicate tasks. Each
task's page shows its schedule, next run and latest result. The page also
shows whether a scheduler process is running; tasks only execute while
`pnpm pekka scheduler` is running.

## Sign-in and multiple users

By default Pekka has no sign-in. It answers only on localhost, and everything
belongs to one built-in `local` user. To let several people use one Pekka
server, each with their own account, turn on sign-in with Google:

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials),
   create an OAuth client of type **Web application**. You can reuse the Gmail
   plugin's client. Add the redirect URI `<PEKKA_URL>/api/auth/google/callback`,
   for example `https://pekka.example.com/api/auth/google/callback`.
2. Set `PEKKA_URL` to the address people open Pekka at, and set `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET` and `PEKKA_ALLOWED_EMAILS` in `.env`. The allowlist is
   a comma-separated list of addresses, or `@domain` entries that admit every
   verified address at that domain.
3. Set `PEKKA_OWNER_EMAIL` to your own Google address so that you keep the bots,
   jobs and plugin connections created before sign-in. The first time that
   account signs in, it takes over the `local` user. The owner is always allowed.
4. Restart the API and open `PEKKA_URL`.

`PEKKA_URL` must use HTTPS unless it is a localhost address, for example
`http://127.0.0.1:3000` for trying sign-in locally. With sign-in on, Pekka only
answers requests for that host, and it refuses to start if the Google settings
or the allowlist are missing. It still listens on `127.0.0.1`. To serve it
publicly, put a reverse proxy such as Caddy or Cloudflare Tunnel in front to
terminate HTTPS and forward the original `Host` header. Set `PEKKA_API_HOST`
(for example `0.0.0.0` in a container) only if the proxy cannot reach
`127.0.0.1`.

Signing in uses the OAuth authorization-code flow with PKCE, a one-time state
and a nonce. It asks Google only for `openid email profile`, and the account's
email address must be verified. A session lasts 30 days in an `HttpOnly`,
`SameSite=Lax` cookie, which is `Secure` and `__Host-` prefixed over HTTPS.
Only a hash of the session token is stored in D1. Removing an address from
`PEKKA_ALLOWED_EMAILS` ends its sessions on their next request. Every API call
except `/api/health` and the sign-in routes needs a session. Writes must come
from a page on `PEKKA_URL`, so other sites cannot send them.

Each user has their own bots, memory, characters, scheduled jobs, plugin
connections and task history. The task history stays in their browser. Unnamed
runs use a separate sandbox for each user. Another user's bot or job returns
404, the same as one that doesn't exist. Shared skills added with
`pekka skills add` without `--bot` are visible to every user. The CLI and
`pekka db import` act as the local user, while `pekka scheduler` runs every
user's jobs, each as its owner.

Upgrading creates new `bot_profiles` and `plugin_accounts` tables. It copies
the existing bots and plugin connections into them for the local user once and
leaves the old `bots` and `plugin_connections` tables in place. Restart every
Pekka process (API, scheduler and CLI) after upgrading so that none of them
keeps writing to the old tables.

## HTTP API

Start the API from the project directory:

```bash
pnpm api
```

It listens on `http://127.0.0.1:3000`; set `PEKKA_API_PORT` to choose another
port. Bot, memory, skill, and schedule endpoints do not need OpenRouter or
Daytona keys. All of them need D1 configuration and return HTTP 503 without
it.
Task execution uses the same environment, sandbox, tools, and step limit as the
CLI. The server loads `.env` on startup.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Server health |
| GET | `/api/auth/session` | Whether sign-in is required, and the signed-in user |
| GET | `/api/auth/google` | Start signing in with Google (browser navigation) |
| POST | `/api/auth/logout` | End the current session |
| GET / POST | `/api/bots` | List / create bots (`name`, `role`, `job`) |
| GET | `/api/bots/:name` | Read a bot |
| POST | `/api/runs` | Execute a task (`task`, optional `botName`) |
| GET | `/api/permissions` | Pending permission requests for the signed-in user |
| POST | `/api/permissions/:id` | Approve or deny a pending action (`approved`: boolean) once |
| GET / PUT | `/api/bots/:name/memory/:file` | Read / replace memory (`content`) |
| GET | `/api/bots/:name/skills` | Skills a bot can use (shared and its own) |
| GET | `/api/skills` | Skills shared by every bot |
| GET / POST | `/api/jobs` | List jobs with scheduler status / create a scheduled job |
| GET | `/api/jobs/:id` | Job status and latest result |
| POST | `/api/jobs/:id/pause` | Pause an upcoming job |
| POST | `/api/jobs/:id/resume` | Resume a paused job |
| POST | `/api/jobs/:id/cancel` | Cancel future executions |

URL-encode bot names. Memory file names must be `PREFERENCES.md` or
`KNOWLEDGE.md`. Creation returns HTTP 201; other successful requests return 200.
Lists use `{ "bots": [...] }` or `{ "jobs": [...] }`; individual resources
return the resource object. Errors return `{ "error": "..." }`, with
validation issues when applicable. JSON request bodies are limited to 1 MB.

```bash
curl http://127.0.0.1:3000/api/bots
curl http://127.0.0.1:3000/api/bots \
  -H 'Content-Type: application/json' \
  -d '{"name":"Scout","role":"Researcher","job":"Find interesting repositories"}'
curl -N http://127.0.0.1:3000/api/runs \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{"botName":"Scout"}'
```

A run requires `task` or `botName`; omitting `task` runs the named bot's job.
By default, the request waits for a JSON result containing `status`, `answer`,
`steps`, and `usage`. With `Accept: text/event-stream`, it streams agent events
(`step`, `message_delta`, `message`, `tool_call`, `tool_result`), followed by
`result` or `error`. Each event's `data` is JSON. A streaming failure uses an
`error` event because HTTP headers have already been sent. Disconnecting does
not cancel execution. Run history is not persisted.

Job creation accepts `name`, `task`, `runAt` (a future ISO timestamp with an
explicit timezone offset), optional `intervalSeconds`, and optional `botName`.
The existing `pnpm pekka scheduler` process must be running to execute jobs.
The API blocks overlapping API runs within the same workspace with HTTP 409;
this does not coordinate with separate CLI or scheduler processes. Bot names are
checked for duplicates in D1, so simultaneous creations from the API and CLI
cannot both succeed with the same name.

Without `PEKKA_URL`, the API is a local, single-user service with no
authentication. It accepts localhost hosts and same-origin browser requests.
With sign-in on, every request except health and sign-in needs a session cookie
and only sees that user's data. Unauthenticated requests get HTTP 401. See
[Sign-in and multiple users](#sign-in-and-multiple-users).

## Email

Set `AGENTMAIL_API_KEY` in `.env` using a key from the
[AgentMail console](https://console.agentmail.to/), then restart the API or
scheduler process. Select a named bot in the web interface and ask:

```text
What is your email address?
Email alice@example.com with the subject "Report" and this message: ...
```

`get_email_address` creates a mailbox on first use. `send_email` can also create
it if needed. Each bot keeps its own address on `@agentmail.to`; its inbox ID
and address are saved in D1 against its permanent bot ID. Creation uses an
idempotent client ID so concurrent requests and interrupted setup reuse the
same provider inbox. Bots that never use email consume no inbox slots.

The API key stays in the Pekka process, outside the model context and Daytona
sandbox. Sending is available to named bots in the CLI, web interface, and
scheduled tasks. Unnamed runs cannot send email. Only plain-text sending is
implemented; incoming mail, attachments, and reply tools are not yet available.

A successful result includes the message and thread IDs and means AgentMail
accepted the submission, not that the recipient received it. Requests are not
automatically retried. If a send times out or its outcome is unknown, check the
AgentMail console before resending to avoid duplicate mail. Account verification
and sending quotas are managed by AgentMail; see its
[setup guide](https://docs.agentmail.to/quickstart) and
[current limits](https://www.agentmail.to/pricing).

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

Start the runner in another terminal, on any machine configured with the same
D1 database:

```bash
pnpm pekka scheduler
pnpm pekka jobs list
pnpm pekka jobs cancel "<job-id>"
```

Keep the scheduler process and its host running. Creating a job does not start
the runner or install an operating-system service. `pnpm pekka scheduler --once`
processes currently due jobs and exits. Ctrl-C stops the runner after its active
task finishes. Cancelling a running job prevents future runs but does not
interrupt the active task. Only upcoming jobs can be paused, so a running job
must finish first. A resumed job continues from its next future occurrence; a
paused one-time job whose time has passed runs right away.

Jobs and their latest results are stored in D1. Runs use the scheduler's
current environment configuration and the owning bot's sandbox (or the base
sandbox for unnamed tasks). Each run starts a fresh conversation. Jobs execute
serially, with only one runner per D1 database. The runner holds a lock that it
renews every 20 seconds. If the runner crashes, another runner can start once
the lock expires after 60 seconds, or immediately on the same machine. The
runner checks for due jobs every 5 seconds, so a job can start up to 5 seconds
after its scheduled time. Each check is a request to the Cloudflare API and
counts toward its rate limits. Missed repeats are coalesced into one overdue run, then the schedule
advances to a future interval. Fixed intervals do not adjust for daylight saving
time. Interrupted runs are recorded as failed instead of automatically replaying
potentially completed actions. Inspect the Scheduled page or `pekka jobs list`
for status and the latest answer or error; only the latest run is kept.

## Per-bot workspace and memory

Each named bot uses a separate persistent Daytona sandbox, named after the bot's
ID, with a `workspace` directory under the sandbox's working directory. Commands and relative file paths
default to that workspace. Manual bot runs and scheduled jobs reuse the same
workspace; unnamed `pekka run` tasks continue using the configured base sandbox.
Existing files in the old shared sandbox are not moved automatically.

Each bot has two Markdown memory documents, `PREFERENCES.md` and
`KNOWLEDGE.md`, stored in D1. Edit them in the web interface under Details >
Memory, or through `/api/bots/:name/memory/:file`. Preferences hold user
instructions about style and workflow; knowledge holds verified facts and
reusable findings.

The agent loads previews of both files at the start of every named-bot run and
can read and replace them using `read_memory` and `write_memory`. Scheduled jobs
load the latest memory rather than a snapshot. Memory updates are explicit tool
calls, not automatic transcript storage. Memory is in D1 while workspace files
remain in Daytona.

## Skills with progressive disclosure

A skill is a folder containing `SKILL.md` with YAML frontmatter, plus any
supporting text files. Skills are stored in D1. Write the folder locally, for
example `research/`:

```markdown
---
name: research
description: Research repositories and write a sourced report.
---
Search for current sources, verify the findings, and write the report.
Read references/report-format.md when preparing the final report.
```

Then save it to D1:

```bash
pnpm pekka skills add ./research
pnpm pekka skills add ./research --bot "Scout"
pnpm pekka skills list --bot "Scout"
pnpm pekka skills remove research --bot "Scout"
```

Without `--bot`, a skill is shared by every bot and by unnamed runs. With
`--bot`, only that bot sees it, and it replaces a shared skill with the same
name for that bot. Adding a skill again replaces all of its files. Each file
must be text and at most 1 MB. Symbolic links in the folder are skipped. After
you edit the local folder, run `skills add` again to update the stored copy.

The name must match the folder and contain lowercase letters, digits, and
hyphens, up to 64 characters. Descriptions may use YAML multiline strings.
Only names and description previews enter the initial agent prompt, capped at
20 skills. `list_skills` provides full descriptions and pagination;
`load_skill` loads the selected instructions and, when needed, referenced text
files inside that skill folder. Long files return `next_offset` for continuation.
Malformed skills are reported without disabling valid skills.

Plugin skills are included in `skills/notion`, `skills/gmail`,
`skills/telegram`, and `skills/github`. Save them as shared skills using the
existing CLI:

```bash
pnpm pekka skills add ./skills/notion
pnpm pekka skills add ./skills/gmail
pnpm pekka skills add ./skills/telegram
pnpm pekka skills add ./skills/github
pnpm pekka skills list
```

Add `--bot "Scout"` to install one for a particular bot instead. These folders
are not loaded automatically; importing them stores their instructions in D1.
Each user still needs to connect and enable the corresponding plugin on the
Plugins page. The skills describe the available tools, pagination, write
authorization, and how to handle uncertain results.

Instructions and supporting files are not all loaded upfront. Scheduled runs
see the latest saved skills. Supporting
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
| `PEKKA_REQUIRE_APPROVAL` | Set to `true` to ask before writes, commands and plugin actions | unset (no approval prompts) |
| `PEKKA_URL` | Address people open Pekka at; turns on Google sign-in | unset (no sign-in, localhost only) |
| `PEKKA_ALLOWED_EMAILS` | Comma-separated addresses or `@domain` entries allowed to sign in | — |
| `PEKKA_OWNER_EMAIL` | Google account that takes over data created before sign-in | unset |
| `PEKKA_API_HOST` | Address the API listens on | `127.0.0.1` |
| `TAVILY_API_KEY` | Enables Tavily web search | unset |
| `EXA_API_KEY` | Enables Exa web search or fallback | unset |
| `SCRAPERAPI_API_KEY` | Enables ScraperAPI web scraping | unset |
| `AGENTMAIL_API_KEY` | Enables per-bot AgentMail mailboxes and email sending | unset |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with D1 Edit permission; required for bots and jobs | — |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account that owns the D1 database | — |
| `CLOUDFLARE_D1_DATABASE_ID` | ID of the D1 database Pekka stores data in | — |

Without a search key, the `web_search` tool returns an error when called.
`PEKKA_MAX_STEPS` limits model replies, not the number of commands within a
reply. The cost summary uses provider-reported cost, which can be zero when the
provider does not include it.

Pekka reaches D1 through its [HTTP API](src/database/d1.ts), so each database
operation is an HTTPS request from the machine running Pekka. Workspace files
remain in Daytona.

## How it works

1. The CLI connects to the named Daytona sandbox and creates an OpenRouter model client.
2. The [agent loop](src/agent/loop.ts) sends the task and available tool definitions to the model.
3. Pekka executes requested tools and sends their results back to the model until it gives a reply without a tool call or reaches the step limit.

The available tools are `run_command`, `read_file`, `write_file`,
`edit_file`, `web_search`, `web_scrape`, `read_memory`, `write_memory`,
`list_skills`, `load_skill`, `schedule_job`, `list_scheduled_jobs`,
`cancel_scheduled_job`, `get_email_address`, and `send_email`.
Shell and file operations run on the Daytona computer.
`write_file` replaces the entire target file. `edit_file` replaces an exact
piece of text in an existing file and leaves the rest unchanged; the text must
match exactly once unless `replace_all` is set. Web search calls Tavily or Exa
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

The tests use a fake computer and an in-memory SQLite database in place of D1,
so they do not need API keys. They do not exercise a live Daytona sandbox,
OpenRouter model, or D1 database. To add a tool, define it in
`src/tools/` and register it in [src/tools/index.ts](src/tools/index.ts).

### Permission gate

Approval review is **off by default**: every action that is not hard-blocked (see below) runs without asking, including in scheduled and non-streaming runs. Set `PEKKA_REQUIRE_APPROVAL=true` to turn on the review described in the rest of this section.

Reads run automatically: file and memory reads, skill loading, web research, scheduled-job listings, and read-only Gmail, Notion and GitHub tools. Plain `pwd`, `whoami`, `uname`, `ls`, `cat`, `head`, `tail` and `wc` commands with allowed options also run automatically, using `/usr/bin` executables. Shell operators, redirects, substitutions, scripts and commands outside this allowlist require review.

Commands requiring review, file and memory writes, scheduling changes, and plugin mutations require one-time approval of the exact arguments. In a streaming web run, the chat shows **Deny** and **Approve once**. Interactive CLI runs prompt in the terminal. Requests expire after five minutes; denial, disconnect or expiry prevents the pending action from executing. Approvals are held in memory and cannot be replayed. Only the owning user can review a request; plugin access must still be enabled when the approved tool executes.

Destructive deletion and disk commands, destructive Git operations, privilege/system changes, and directly piping downloaded scripts into a shell are blocked by command-pattern checks. These checks are conservative heuristics, not a complete shell security sandbox: other arbitrary commands require human review. New tools default to review unless their trusted implementation explicitly declares a read-only effect.

Scheduled runs, noninteractive CLI runs and non-streaming API runs have no reviewer. They can read, but actions requiring approval are rejected. There are no permanent approval grants or automatic plugin-write exemptions.

### Notion plugin

Open **Plugins** to add Notion. A Notion public OAuth connection must first be configured on the Pekka server:

1. Create a [Notion public connection](https://developers.notion.com/guides/get-started/authorization). Enable read content, insert content, and update content capabilities for search, reading, page creation, and appending text.
2. Set `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`, and `NOTION_REDIRECT_URI` in `.env`. Register the exact redirect URI in Notion, for example `http://127.0.0.1:3000/api/plugins/notion/callback`. Open Pekka using that same host and port.
3. Generate `PEKKA_PLUGIN_KEY` with `openssl rand -hex 32`, save it in `.env`, and keep it stable. It encrypts the OAuth tokens stored in D1; losing the key requires reconnecting Notion. Restart the API after configuration changes.
4. Click **Connect Notion**, choose the pages to share on Notion's consent screen, then turn on **Allow Pekka access**. Connecting leaves access off until you enable it.

Each user connects their own Notion workspace, and the connection applies to all of that user's bots. With access enabled, ask Pekka to search Notion, read a page and its blocks, create a page beneath a shared page, or append text. Access is checked on every tool request. Turning it off blocks subsequent calls; requests already sent to Notion may finish. **Disconnect** disables access, revokes the token at Notion, and removes the saved credentials. If revocation fails, access stays disabled and you can retry disconnecting.

OAuth tokens never enter browser storage, model prompts, or the bot's computer. With sign-in on, set `NOTION_REDIRECT_URI` to `<PEKKA_URL>/api/plugins/notion/callback`.

### Gmail plugin

Bots can read, search, send and reply to mail in your own Gmail account. This is separate from each bot's own AgentMail address.

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project and enable the **Gmail API**.
2. Under **Google Auth Platform**, set up the consent screen (audience **External**), add the `https://www.googleapis.com/auth/gmail.modify` scope, and add your Google account as a test user.
3. Create an OAuth client of type **Web application** and add the exact redirect URI, for example `http://127.0.0.1:3000/api/plugins/gmail/callback`. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` in `.env`, along with `PEKKA_PLUGIN_KEY` (see the Notion plugin section). Open Pekka using that same host and port, then restart the API.
4. Open **Plugins**, click **Connect Gmail**, allow Gmail access on Google's consent screen, then turn on **Allow Pekka to access Gmail**. Connecting leaves access off until you enable it.

While the app's publishing status is **Testing**, Google expires the connection after 7 days, so you have to reconnect. To keep it longer, set the status to **In production** without submitting for verification. Google then shows an "unverified app" warning that you can click through for your own account.

Each user connects their own Gmail. With sign-in on, set `GOOGLE_REDIRECT_URI` to `<PEKKA_URL>/api/plugins/gmail/callback`. While the consent screen is in **Testing**, only the test users you add can connect Gmail.

Bots get `gmail_search` (Gmail search syntax), `gmail_read_message`, `gmail_read_thread`, `gmail_send`, `gmail_create_draft`, `gmail_list_labels` and `gmail_modify_labels` (mark read or unread, archive, star). Reads are automatic; sends, drafts and label changes require one-time approval through the permission gate. Scheduled runs cannot send mail without a reviewer. The `gmail.modify` scope cannot permanently delete mail. Access is checked on every request. **Disconnect** revokes the token at Google and removes the saved credentials. Tokens are encrypted with `PEKKA_PLUGIN_KEY` and never reach model prompts or the bot's computer.

### Telegram plugin

Bots can message you on Telegram after you approve the exact message during an interactive run:

1. Create a bot with [@BotFather](https://t.me/BotFather) and set `TELEGRAM_BOT_TOKEN` in `.env`. Use a dedicated bot without a webhook: Pekka reads the bot's updates with `getUpdates` to link your chat. Restart the API.
2. Open **Plugins**, click **Link Telegram**, open the `t.me` link and press **Start**. Pekka links the private chat that sent the one-time code, which expires after 10 minutes.
3. Turn on **Allow bots to message you on Telegram**. Linking leaves access off until you enable it.

One Telegram bot serves every user, and each user links their own chat. Bots get one tool, `telegram_send_message`, which sends plain text to their user's linked chat only, prefixed with the bot's name. Access is checked on every message. **Disconnect** removes the linked chat. The bot token stays on the server and never enters model prompts or the bot's computer.

### GitHub plugin

Bots can list repositories, read issues and pull requests (including comments and changed-file patches), create issues, comment, and open draft pull requests from existing branches. The GitHub tools use the server's [GitHub CLI](https://cli.github.com/); install `gh` on the Pekka server. They use each user's saved token rather than the server operator's CLI login.

1. Create a [GitHub OAuth app](https://github.com/settings/developers). Set its authorization callback URL to the exact Pekka URL, for example `http://127.0.0.1:3000/api/plugins/github/callback`.
2. Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `GITHUB_REDIRECT_URI` in `.env`, along with the stable `PEKKA_PLUGIN_KEY` described above. With sign-in enabled, use `<PEKKA_URL>/api/plugins/github/callback`. Restart the API.
3. Open **Plugins**, expand **GitHub**, click **Add GitHub**, and authorize the connection. Turn on **Allow Pekka to access GitHub** to enable bot access. Connecting or reconnecting always leaves access off.

The OAuth app requests GitHub's [`repo` scope](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps), which grants broad repository access, including private repositories, subject to organization policy. The exposed tools are limited to repository, issue, and pull-request operations; they do not merge pull requests or delete repositories. Writes act as the connected user and should only be requested when you want them published. A pull request requires an existing head branch; the tools do not push commits.

Credentials are encrypted in D1 and stay on the server, outside browser storage, model prompts, and bot sandboxes. Access is checked on every request, and expiring OAuth tokens are refreshed when needed. **Disconnect** disables access, revokes the token at GitHub, and removes the saved connection. If revocation fails, access stays disabled and Disconnect can be retried. Requests already sent may finish.
