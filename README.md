<p align="center"><img src="src/web/logo.svg" alt="Pekka logo" width="120" /></p>

# Pekka

An open-source AI workspace with bots that run commands, write files, remember instructions, and work with your connected apps.

Start with **Chief of Staff**, which can delegate tasks to specialist bots. Each bot has its own persistent [Daytona](https://daytona.io) computer. Models run through [OpenRouter](https://openrouter.ai); bot data is stored in [Cloudflare D1](https://developers.cloudflare.com/d1/).

## Setup

You need Node.js 22.13+, pnpm 11.3+ within version 11, OpenRouter and Daytona API keys, and a Cloudflare D1 database. Your Cloudflare API token needs **Account → D1 → Edit** permission.

```bash
pnpm install
cp .env.example .env
```

Keep your existing `.env` if you already have one. Fill in:

```dotenv
OPENROUTER_API_KEY=...
DAYTONA_API_KEY=...
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_D1_DATABASE_ID=...
```

```bash
pnpm pekka db check
pnpm api
```

Open **[localhost:3000](http://127.0.0.1:3000)** and give Chief of Staff a task. Database tables are created automatically.

## Usage

- **Bots:** create specialists and edit their instructions, memory, and skills in the web app.
- **Skills:** ask a bot to save a way of working as a skill. It follows the built-in `skill-creator` skill and keeps the result for itself; its **Skills** panel lists what it has. To give every bot a skill, run `pnpm pekka skills add <folder>`.
- **Computer view:** open it from a bot's chat to watch the commands it runs, their output, and the files it reads or changes. Sessions are ephemeral, so it shows only tasks run while the page is open.
- **Plugins:** connect Gmail, Calendar, Drive, Contacts, Notion, GitHub, or Telegram, then enable access. Credentials and callback URLs are listed in [.env.example](.env.example).
- **Schedules:** create tasks under **Scheduled** and keep `pnpm pekka scheduler` running in another terminal.
- **CLI:** run a task with `pnpm pekka run "Create hello.txt with a short greeting"`.

Bot files stay in Daytona. Chat history stays in your browser; export it from **Settings** before clearing browser data.

Actions run without approval prompts by default. Set `PEKKA_REQUIRE_APPROVAL=true` to enable review; scheduled tasks then cannot perform actions requiring approval.

## Langfuse traces

Create a [Langfuse](https://langfuse.com) project and copy its API keys from project settings into `.env` (or your deployment's environment):

```dotenv
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_TRACING_ENVIRONMENT=development
```

Use your project's region URL, such as `https://us.cloud.langfuse.com`, or your self-hosted URL. Restart Pekka, run a task, then open **Tracing** in Langfuse. Each task records an agent observation with nested OpenRouter generations and tool calls, including delegated bots and context summarization. Generations include prompts, replies, token usage, reported cost, and timing; tools include inputs, outputs, and errors. Traces are associated with the Pekka user ID and bot metadata.

Web chat turns are grouped into sessions by user, bot, and chat history. Tracing sends task content, conversation context, memory included in prompts, and tool inputs/outputs to your Langfuse project. Configured server secrets, bearer tokens, and credential fields are masked; other personal or confidential task content remains visible. Tracing is disabled without both keys or when `LANGFUSE_TRACING_ENABLED=false`. Export failures do not fail tasks. Pekka flushes observations when each top-level run finishes and shuts down tracing when the CLI or local API exits. The integration follows Langfuse's [TypeScript instrumentation](https://langfuse.com/docs/observability/sdk/instrumentation).

## Development

```bash
pnpm typecheck
pnpm test
```
