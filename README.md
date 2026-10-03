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
- **Computer view:** open it from a bot's chat to watch the commands it runs, their output, and the files it reads or changes. Sessions are ephemeral, so it shows only tasks run while the page is open.
- **Plugins:** connect Gmail, Calendar, Drive, Contacts, Notion, GitHub, or Telegram, then enable access. Credentials and callback URLs are listed in [.env.example](.env.example).
- **Schedules:** create tasks under **Scheduled** and keep `pnpm pekka scheduler` running in another terminal.
- **CLI:** run a task with `pnpm pekka run "Create hello.txt with a short greeting"`.

Bot files stay in Daytona. Chat history stays in your browser; export it from **Settings** before clearing browser data.

Actions run without approval prompts by default. Set `PEKKA_REQUIRE_APPROVAL=true` to enable review; scheduled tasks then cannot perform actions requiring approval.

## Development

```bash
pnpm typecheck
pnpm test
```
