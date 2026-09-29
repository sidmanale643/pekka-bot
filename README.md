# Pekka

An open-source AI agent with its own computer in the cloud. Give it a whole
job, not just a question: it runs commands, writes files and checks its own
work on a persistent [Daytona](https://daytona.io) sandbox until the job is done.

Models come from [OpenRouter](https://openrouter.ai), so you can use any model
there that supports tool calling. The default is GLM 5.3 Flash.

## Quick start

```bash
pnpm install
cp .env.example .env   # add your OpenRouter and Daytona API keys
pnpm pekka run "Find the three most-starred TypeScript repos created this month and summarise them in report.md"
```

Create a named bot with a role and a job description:

```bash
pnpm pekka bot create --name "Scout" --role "Open-source researcher" --job "Find promising new TypeScript repositories and write a report"
pnpm pekka bot list
pnpm pekka bot run "Scout"
```

Bot profiles are saved in `.pekka/bots.json` in the current directory. Running a
bot sends its name, role and job to the model; the job is also its task.

`src/database/d1.ts` provides a D1 query service. To use it, create a D1
database in Cloudflare and set the three `CLOUDFLARE_*` values shown in
`.env.example`. No tables are created by the service. Bot profiles still use
the local JSON file until database storage is wired into the app.

The first run creates a sandbox called `pekka-computer`. Later runs reuse it,
so files from earlier tasks are still there. It stops itself after 15 idle minutes.

## How it works

```
task ──► agent loop ──► model (OpenRouter)
             │  ▲
   tool call ▼  │ result
           tools ──► computer (Daytona sandbox)
```

The loop in [`src/agent/loop.ts`](src/agent/loop.ts) asks the model what to do,
runs the tools it picks, sends back the results, and repeats until the model
replies without calling a tool.

| Folder | What's in it |
|---|---|
| `src/agent/` | The loop, the system prompt, and tool-call handling |
| `src/model/` | The `Model` interface and the OpenRouter client |
| `src/computer/` | The `Computer` interface, the Daytona version, and a fake for tests |
| `src/tools/` | One file per tool: `run_command`, `read_file`, `write_file`, `web_search` |

Set `TAVILY_API_KEY` to enable `web_search`. Set `EXA_API_KEY` as a fallback;
the tool also works with Exa alone. Search results include source URLs.

To add a tool, create a file in `src/tools/` with `defineTool` and add it to
[`src/tools/index.ts`](src/tools/index.ts).

## Development

```bash
pnpm test        # unit tests; no API keys needed
pnpm typecheck
```
