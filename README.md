# Hob

**A self-hosted personal assistant that actually does the work.** You talk to one main assistant, Hob. It runs real work as background jobs, asks before anything risky, and when a kind of work keeps coming back, it proposes a dedicated assistant for it.

[中文说明](README.zh-CN.md) · [Architecture](docs/architecture.md) · MIT License

> The interface is currently Chinese-only. Hob is a single-user app you run on your own machine or server.

![Hob: chat with the main assistant, a running job and its live transcript](docs/screenshots/chat.png)

## What you get

**One conversation, real work.** Ask in plain language; Hob turns it into a job that runs in the background with its own shell, files and tools. A job card shows progress and elapsed time. Open it to follow every step live, add instructions mid-way, or stop it.

**Assistants that grow out of your habits.** When the same kind of request repeats, Hob suggests a dedicated assistant ("写作", "服务器", "记账" …). Each one keeps its own conversation, duties, approval rules, schedules and work log, and you configure all of it in one panel.

**Delegation you can see.** Hob hands work to the right assistant and keeps a delegation card in its own chat: status, linked jobs, and any pending question, which you can answer right on the card. Your original words travel with the work; reply in the receiving assistant's chat to take over, or reply in chat to close a pending question.

**Work that can continue.** Assistants can read files, inspect job status, activity and results without interrupting the work, and resume a finished job with separate cards and reports for each round. They estimate job duration and receive reminders when work runs over; completion notices include actual and expected time.

**Asks first, then remembers.** Each assistant has "confirm before running" rules. Pick "always allow" once and it becomes a rule, so you won't be asked about that again.

**Schedules.** Daily briefs, weekly reports, month-end checks: routines run on cron-style schedules and post job cards and results into the assistant's conversation. A routine can also use a saved assistant skill.

**Knowledge bases.** Organize, search and preview files, bind collections to assistants, and follow citations to source passages. An optional embedding model enables hybrid search; PDF text can also be indexed.

**Cloud desktop.** An optional separate container gives each assistant its own screen and browser, with a shared screen for selected assistants. Watch or take control, sync the clipboard, and type with your local input method.

**A clearer workspace.** The right panel brings assistant details, jobs and files together; its two lists load more as you scroll, and nested pages retain their address on refresh. Completed unread work is marked on the assistant's avatar. Archive an assistant when no longer needed while keeping its conversations and job history.

**Pages instead of walls of text.** For processes, comparisons or research, an assistant can answer with a single-page visual document. It opens in the side panel and renders live while the model is still writing.

**Tools that come with it:**

- **Web search** across 10 providers (SearXNG, Exa, Tavily, Brave, Serper, Jina, Firecrawl, Perplexity, You.com, Ollama), used in order with automatic fallback.
- **Skills** from Hob's own skill folder, the shared `~/.agents/skills`, and Lore. Import existing skills or let assistants save reusable ones, edit their instructions with version history, and choose a skill for a job.
- **MCP servers** (stdio or streamable HTTP) that jobs can call, with per-server and per-tool switches; import what you already have from Claude Code, Cursor and pi.
- **Long-term memory**, kept locally or in [Lore](https://github.com/FFatTiger/lore).
- **Image generation** in chat through an OpenAI-compatible image API, with a progress card while it runs.
- **Claude subscription** via an existing local Claude Code login on npm or source installs.
- **Push notifications** when an assistant needs your decision or a job gets stuck or fails.

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
| `HOB_DESKTOP_URL` | — | Cloud desktop service URL for deployment configuration |
| `HOB_DESKTOP_TOKEN` / `HOB_DESKTOP_TOKEN_FILE` | — | Cloud desktop bearer token or path to its token file; with a URL, a nonempty token overrides the UI setting |
| `HOB_LOCAL_PI_DIR` / `HOB_LOCAL_LORE_HOME` | `~/.pi/agent` / `~/.lore` | Optional source directories for explicit local imports; original `PI_CODING_AGENT_DIR` / `LORE_HOME` are used when these are unset |

`config.json` can also set `host`, `port` and the initial `password`; environment variables take precedence for host and port. Hob isolates its engine and memory directories under `HOB_HOME` and removes inherited model and Lore credentials from its runtime environment.

Conversations, jobs, memory, skills, keys and engine state live in `HOB_HOME`. To reuse providers or a Lore connection you already have on the machine, import them explicitly in settings. Back up `HOB_HOME` to preserve Hob's data.

**Claude subscription:** For npm or source installs, install Claude Code and sign in locally with `claude auth login`, then enable Claude subscription under **Settings → Providers**, choose Pro or Max and select the models under **Settings → Models**. Usage counts against the same Claude subscription quota as Claude Code. Docker images do not support this feature. Hob does not read, copy, store or forward Claude credentials; the official Claude Code program uses its existing login. Claude Code writes its own session records under `~/.claude/projects/`, outside `HOB_HOME`.

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

Jobs run inside the container (git, curl, python3, ripgrep and fd are installed). Local-command MCP servers also run inside the container, so their command must exist in the image (node and npx are included; uvx and other language package managers are not). To let jobs work on projects on the host, create `workspace/` (the container runs as uid 1000), uncomment the `./workspace:/workspace` mount and give jobs that directory.

### Cloud desktop

The optional cloud desktop is a separate Linux container. Each assistant has its own screen and browser profile, started on first use. An additional public screen can be enabled for selected assistants in Settings → Cloud desktop; by default no assistant can use it. Only one job uses the public screen at a time, and others wait up to 10 minutes. Screens with no viewers, browser connections or activity are reclaimed after 30 minutes by default; browser login data persists. With the root `compose.yaml` and `HOB_PASSWORD` set in `.env`, start both services with:

```bash
docker compose --profile desktop up -d
```

The desktop is not published to the host network. Hob reads the generated token from a shared volume and shows **由部署配置** in Settings → Cloud desktop. Without the profile Hob runs alone and the desktop is unconfigured.

For an independent deployment, use [`desktop/compose.yaml`](desktop/compose.yaml) or the `docker run` command in [the desktop guide](desktop/README.md), then enter the service URL and token in Hob's settings. When the desktop profile is not running and its shared token file is absent or empty, Hob uses the desktop configured in settings; once the token file appears, the Compose deployment takes precedence. Anyone signed into Hob can view and take over an individual screen; log into websites yourself, not through the assistant. Google currently blocks Google account sign-in in a browser with remote debugging enabled. Browser cookies in the desktop data volume are sensitive. Bearer tokens travel in cleartext over HTTP: use a trusted private network or HTTPS for connections between machines, and do not expose VNC or CDP ports.

Measured for desktop v2 on an amd64 host: image disk usage was 2.03 GB; memory was 23.5 MiB without screens, 354.9 MiB with one Chrome screen on example.com, and 1017 MiB with three Chrome screens on new tabs. The page workloads differ, and actual usage depends on the host and pages.

Behind a reverse proxy, the desktop view needs WebSocket upgrades on `/api/desktop/vnc`. With nginx:

```nginx
location = /api/desktop/vnc {
    proxy_pass http://127.0.0.1:30148;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```

The bundled noVNC client is licensed under MPL-2.0; Playwright is Apache-2.0.

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
