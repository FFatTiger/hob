# Hob

**A self-hosted personal assistant that actually does the work.** You talk to one main assistant, Hob. It runs real work as background jobs, asks before anything risky, and when a kind of work keeps coming back, it proposes a dedicated assistant for it.

[中文说明](README.zh-CN.md) · [Architecture](docs/architecture.md) · MIT License

> The interface is currently Chinese-only. Hob is a single-user app you run on your own machine or server.

![Hob: chat with the main assistant, a running job and its live transcript](docs/screenshots/chat.png)

## What you get

**One conversation, real work.** Ask in plain language; Hob turns it into a job that runs in the background with its own shell, files and tools. A job card shows progress and elapsed time. Open it to follow every step live, add instructions mid-way, or stop it.

**Assistants that grow out of your habits.** When the same kind of request repeats, Hob suggests a dedicated assistant ("写作", "服务器", "记账" …). Each one keeps its own conversation, duties, approval rules, schedules and work log, and you configure all of it in one panel.

**Delegation you can see.** Hob hands work to the right assistant and keeps a delegation card in its own chat: status, linked jobs, and any pending question, which you can answer right on the card. When everything finishes, the result comes back to Hob, so you keep talking in one place.

**Asks first, then remembers.** Each assistant has "confirm before running" rules. Pick "always allow" once and it becomes a rule, so you won't be asked about that again.

**Schedules.** Daily briefs, weekly reports, month-end checks: routines run on cron-style schedules and post results into the assistant's conversation.

**Pages instead of walls of text.** For processes, comparisons or research, an assistant can answer with a single-page visual document. It opens in the side panel and renders live while the model is still writing.

**Tools that come with it:**

- **Web search** across 10 providers (SearXNG, Exa, Tavily, Brave, Serper, Jina, Firecrawl, Perplexity, You.com, Ollama), used in order with automatic fallback.
- **Skills** from Hob's own skill folder, the shared `~/.agents/skills`, and Lore. You can import skills from Claude Code, Codex and pi.
- **Long-term memory**, kept locally or in [Lore](https://github.com/FFatTiger/lore).
- **Image generation** through any OpenAI-compatible image API.
- **Push notifications** when an assistant needs your decision or a job finishes.

**Made for the phone too.** Hob is an installable web app with a mobile layout and Telegram-style gestures: swipe a message to reply, long-press for actions. Light and dark themes follow your system.

![Hob on a phone: assistant list, a delegation card, an approval question](docs/screenshots/mobile.png)

## Quick start

You need Node.js 22 or newer and an API key for at least one model provider.

```bash
npm install -g hob-bot
HOB_PASSWORD='choose-a-password' hob
```

Or run it once without installing: `HOB_PASSWORD='choose-a-password' npx hob-bot`.

With Docker instead (no Node.js needed; details in [Docker](#docker)):

```bash
curl -O https://raw.githubusercontent.com/FFatTiger/hob/main/compose.yaml
echo "HOB_PASSWORD=choose-a-password" > .env
docker compose up -d
```

Open <http://127.0.0.1:30148> and sign in with that password. Then:

1. Go to **设置 → 服务商** (Settings → Providers) and add a provider. Built-in ones (Anthropic, OpenAI, Google, DeepSeek, OpenRouter, …) only need an API key; any OpenAI- or Anthropic-compatible endpoint works too.
2. Go to **设置 → 模型** (Settings → Models) and pick the models for chat and for jobs.
3. Send Hob a message. A reply, or a job card for real work, means you are set.

The password is hashed into `~/.hob/config.json` on first start, so later starts don't need `HOB_PASSWORD`. You can change it under **设置 → 通用**.

## Configuration

Startup options are environment variables. Everything else, including providers, models, memory, search, skills and notifications, lives in the settings UI and takes effect immediately.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOB_HOME` | `~/.hob` | Data directory |
| `HOB_PORT` | `30148` | HTTP port |
| `HOB_HOST` | `127.0.0.1` | Listen address |
| `HOB_PASSWORD` | — | Sign-in password; required on first start unless `password` is set in `config.json` |

Hob is self-contained. Conversations, jobs, memory, skills, keys and its engine state all live in `HOB_HOME`, and it never reads or changes other tools' configuration. To reuse providers or a Lore connection you already have on the machine, import them explicitly in settings. **Back up `HOB_HOME` and you have backed up everything.**

## Deploy

Hob is a single Node process. Run it with any process manager and put a reverse proxy with TLS in front. Push notifications and installing as an app both need HTTPS. With PM2:

```bash
pm2 start hob --name hob           # after npm install -g hob-bot
pm2 start deploy/pm2.config.cjs   # or from a source checkout: process "hob", port 30148, data in ~/.hob
```

### Docker

```bash
curl -O https://raw.githubusercontent.com/FFatTiger/hob/main/compose.yaml
echo "HOB_PASSWORD=change-me" > .env   # only needed on first start
docker compose up -d
```

This pulls `ghcr.io/ffattiger/hob` (amd64 and arm64, built for every release). From a source checkout, `docker compose up -d --build` builds the image locally instead. Open `http://127.0.0.1:30148`. Data lives in the `hob-data` volume (`/data` in the container), and the password is stored there as a hash, so you can delete `.env` afterwards. The port is bound to localhost for a reverse proxy; change it to `"30148:30148"` in `compose.yaml` for direct LAN access.

Jobs run inside the container (git, curl, python3, ripgrep and fd are installed). To let them work on projects on the host, create `workspace/` (the container runs as uid 1000), uncomment the `./workspace:/workspace` mount and give jobs that directory.

## Development

```bash
git clone https://github.com/FFatTiger/hob.git
cd hob
npm install
npm run build
npm start            # same as the `hob` command, from source
npm run dev:server   # API server with reload, port 30148
npm run dev:web      # Vite dev server; proxies /api to 30148
npm test             # vitest
npm run typecheck
```

Add `?mock=1` to the dev URL to run the UI against an in-browser fake backend. No model or server is needed, and the screenshots above were taken that way.

Stack: Node 22 + TypeScript, Hono with SSE, Vite + React with hand-written CSS. The agent engine is the [pi](https://github.com/earendil-works/pi) SDK, used in-process. Read [docs/architecture.md](docs/architecture.md) for the design, data layout and tool list (in Chinese).

## License

[MIT](LICENSE)

## Community

This open-source project is linked with and endorses the [LINUX DO community](https://linux.do).
