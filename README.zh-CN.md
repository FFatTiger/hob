# Hob

**一个自己部署、真正动手干活的私人助手。** 你只跟主助手 Hob 说话：它把要做的事交给后台任务执行，有风险的操作先问你；同一类活反复出现时，它会提议分出一个专门的助手。

[English](README.md) · [架构说明](docs/architecture.md) · MIT 许可证

> 目前界面只有中文。Hob 是单用户应用，运行在你自己的电脑或服务器上。

![Hob：与主助手的对话、正在运行的任务和实时执行过程](docs/screenshots/chat.png)

## 能做什么

**一条对话，真实干活。** 用平常的话提要求，Hob 会派出任务在后台执行，任务有自己的命令行、文件和工具。任务卡上能看到进度和用时，点开可以实时看每一步，中途补充要求，或者直接停止。

**从习惯里长出来的助手。** 同类要求反复出现时，Hob 会提议创建专门的助手，比如「写作」「服务器」「记账」。每个助手有自己的对话、职责、执行前确认规则、定时任务和工作日志，都在同一个面板里设置。

**看得见的委派。** Hob 把事交给合适的助手后，在自己的对话里留一张委派卡，上面有状态、关联任务和待确认的问题，问题可以直接在卡上回答。派活会带上你的原话；在接收助手的对话中说话可以接手转交，在对话中回复也能结束待答提问。

**可以接着做。** 助手可以读取文件和完整任务结果，并续做已结束的任务，每轮分别保留卡片和报告。不再需要的助手可以归档，对话和历史任务仍会保留。

**先问，再记住。** 每个助手都有执行前确认规则。选一次「一直允许」就会记成规则，以后同类操作不再问。

**定时任务。** 每日简报、周报、月底对账，按 cron 式的时间表运行，任务卡和结果发到对应助手的对话里。定时任务也可以绑定已保存的助手技能。

**知识库。** 整理、搜索和预览文件，将知识库绑定给助手，并从出处跳转到原文段落。配置向量模型后可混合检索，也支持为 PDF 文字建立索引。

**云桌面。** 可选的独立容器为每个助手提供屏幕和浏览器，也可允许指定助手使用公共屏幕。你可以观看或接管，使用剪贴板同步和本机输入法。

**更清晰的工作区。** 右栏集中展示助手信息、任务、文件和日志，文件预览可停靠在对话旁。助手头像会标出完成未读的工作。

**用页面代替大段文字。** 讲流程、做对比、写调研时，助手可以交一页图文页面。页面在侧栏打开，模型边写边显示。

**自带的能力：**

- **联网搜索**：支持 10 个服务商（SearXNG、Exa、Tavily、Brave、Serper、Jina、Firecrawl、Perplexity、You.com、Ollama），按顺序使用，失败时自动换下一个。
- **技能**：读取 Hob 自己的技能目录、通用的 `~/.agents/skills` 和 Lore；可以导入已有技能，也可以由助手自动或按要求沉淀可复用的技能。
- **MCP 服务**：任务可以调用本地命令（stdio）或远程地址（streamable HTTP）的 MCP 服务，可按服务、按工具单独开关；可以从 Claude Code、Cursor、pi 导入已有配置。
- **长期记忆**：保存在本地，或接入 [Lore](https://github.com/FFatTiger/lore)。
- **图像生成**：接 OpenAI 兼容的图像接口，在对话里生图，并通过生成中卡片查看进度。
- **Claude 订阅**：npm 或源码安装时，可使用本机已有的 Claude Code 登录。
- **推送通知**：助手需要你确认、任务结束时通知你。

**手机上也好用。** Hob 可以安装成网页应用，手机上是专门的布局，交互照 Telegram：向左滑动消息即可回复，长按弹出菜单。支持亮色和暗色主题。

![手机上的 Hob：助手列表、委派卡、确认问题](docs/screenshots/mobile.png)

## 快速开始

需要 Node.js 22 或更高版本，以及至少一个模型服务商的 API Key。

```bash
npm install -g hob-bot
HOB_PASSWORD='设一个密码' hob
```

不想全局安装，也可以直接运行一次：`HOB_PASSWORD='设一个密码' npx hob-bot`。

也可以用 Docker（不需要 Node.js，详见 [Docker](#docker)）：

```bash
curl -O https://raw.githubusercontent.com/FFatTiger/hob/main/compose.yaml
echo "HOB_PASSWORD=设一个密码" > .env
docker compose up -d
```

打开 <http://127.0.0.1:30148>，用这个密码登录，然后：

1. 到 **设置 → 服务商** 添加服务商。内置服务商（Anthropic、OpenAI、Google、DeepSeek、OpenRouter 等）只需填 API Key；OpenAI 或 Anthropic 兼容接口也可以用。
2. 到 **设置 → 模型** 选好对话和任务使用的模型。
3. 给 Hob 发一条消息。收到回复，或者出现一张任务卡，就说明配置好了。

首次启动时密码会转成哈希写进 `~/.hob/config.json`，之后启动不用再带 `HOB_PASSWORD`。改密码在 **设置 → 通用**。

## 配置

启动项用环境变量设置。服务商、模型、记忆、搜索、技能、通知等其余设置都在界面里，改完立即生效。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `HOB_HOME` | `~/.hob` | 数据目录 |
| `HOB_PORT` | `30148` | HTTP 端口 |
| `HOB_HOST` | `127.0.0.1` | 监听地址 |
| `HOB_PASSWORD` | — | 登录密码；首次启动必填，除非 `config.json` 里已写了 `password` |
| `HOB_DESKTOP_URL` | — | 部署配置中的云桌面服务地址 |
| `HOB_DESKTOP_TOKEN` / `HOB_DESKTOP_TOKEN_FILE` | — | 云桌面令牌或令牌文件路径；地址和非空令牌同时存在时覆盖界面设置 |
| `HOB_LOCAL_PI_DIR` / `HOB_LOCAL_LORE_HOME` | `~/.pi/agent` / `~/.lore` | 主动从本机导入时使用的来源目录；未设置时使用原来的 `PI_CODING_AGENT_DIR` / `LORE_HOME` |

`config.json` 也可设置 `host`、`port` 和初始 `password`；host 和 port 以环境变量优先。Hob 将引擎和记忆目录隔离到 `HOB_HOME`，并从运行环境移除继承的模型及 Lore 凭据。

对话、任务、记忆、技能、Key 和引擎数据都在 `HOB_HOME` 里。想沿用本机已有的服务商或 Lore 连接，可以在设置里主动导入。备份 `HOB_HOME` 即可保留 Hob 的数据。

**Claude 订阅：** npm 或源码安装时，先安装 Claude Code 并在本机执行 `claude auth login`，然后在 **设置 → 服务商** 启用 Claude 订阅、选择 Pro 或 Max，再到 **设置 → 模型** 选择模型。用量计入 Claude 订阅额度，与 Claude Code 共用。Docker 镜像不支持此功能。Hob 不读取、复制、保存或转发 Claude 凭证，由官方 Claude Code 程序使用已有登录。Claude Code 会在 `~/.claude/projects/` 保存自己的会话记录，此目录不属于 `HOB_HOME`。

## 部署

Hob 是单个 Node 进程。用任意进程管理器运行，前面加一层带 TLS 的反向代理即可。推送通知和安装成应用都需要 HTTPS。用 PM2 的话：

```bash
pm2 start hob --name hob           # npm install -g hob-bot 之后
pm2 start deploy/pm2.config.cjs   # 或者在源码目录里：进程名 hob，端口 30148，数据在 ~/.hob
```

### Docker

```bash
curl -O https://raw.githubusercontent.com/FFatTiger/hob/main/compose.yaml
echo "HOB_PASSWORD=change-me" > .env   # 只有首次启动需要
docker compose up -d
```

这会拉取 `ghcr.io/ffattiger/hob`（amd64 和 arm64，每次发版自动构建）。在源码目录里用 `docker compose up -d --build` 则在本地构建镜像。打开 `http://127.0.0.1:30148`。数据在 `hob-data` 卷里（容器内 `/data`），密码以哈希存在这里，之后可以删掉 `.env`。端口默认只绑本机，方便接反向代理；要局域网直连，把 `compose.yaml` 里的端口改成 `"30148:30148"`。

任务在容器里运行（装好了 git、curl、python3、ripgrep 和 fd）。本地命令类的 MCP 服务也在容器里运行，命令要在镜像里存在（镜像里有 node 和 npx，没有 uvx 等其他语言的包管理器）。要让任务处理宿主机上的项目，先建好 `workspace/` 目录（容器以 uid 1000 运行），取消注释 `./workspace:/workspace` 挂载，把任务的工作目录设在这里。

### 云桌面

云桌面是可选的独立 Linux 容器。每个助手有独立屏幕和浏览器登录状态，首次使用时启动。设置 → 云桌面中可以允许指定助手使用公共屏幕，默认不允许任何助手使用；公共屏幕同一时间只供一个任务使用，其他任务最多等待 10 分钟。没有观看者、浏览器连接和操作的屏幕默认空闲 30 分钟后回收，浏览器登录状态会保留。在根目录 `compose.yaml` 同目录的 `.env` 设置 `HOB_PASSWORD` 后，一条命令启动两项服务：

```bash
docker compose --profile desktop up -d
```

桌面端口不会映射到宿主机；Hob 从共享卷读取自动生成的令牌，设置 → 云桌面会显示「由部署配置」。不加 profile 时 Hob 单独运行，云桌面显示未配置。

也可用 [`desktop/compose.yaml`](desktop/compose.yaml) 或[桌面部署说明](desktop/README.md)中的 `docker run` 单独部署，再在 Hob 设置中填写地址和令牌。没有启动 desktop profile、共享令牌文件不存在或为空时，Hob 使用设置里填写的云桌面；令牌文件出现后，以 Compose 部署为准。登录 Hob 的人都可以观看和接管单块屏幕，网站登录由人自己完成，不让助手代登。受 Google 限制，开启远程调试的浏览器目前无法登录 Google 账号。桌面数据卷里的浏览器 Cookie 是敏感信息；令牌通过 HTTP 明文传输，跨机器连接请使用可信内网或 HTTPS，不要映射 VNC / CDP 端口。

云桌面 v2 在一台 amd64 机器上的实测：镜像占用 2.03 GB；不开屏幕时内存 23.5 MiB，一块 Chrome 屏幕打开 example.com 时 354.9 MiB，三块 Chrome 屏幕打开新标签页时 1017 MiB。页面负载不同，实际占用因机器和页面而异。

前面有反向代理时，桌面画面需要 `/api/desktop/vnc` 支持 WebSocket 升级。nginx 示例：

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

内置 noVNC 客户端使用 MPL-2.0 许可证，Playwright 使用 Apache-2.0。

## 开发

```bash
git clone https://github.com/FFatTiger/hob.git
cd hob
npm install
npm run build
npm start            # 从源码运行，等同于 hob 命令
npm run dev:server   # 后端，改动自动重载，端口 30148
npm run dev:web      # Vite 开发服务器，/api 代理到 30148
npm test             # vitest
npm run typecheck
```

开发地址加上 `?mock=1`，界面会使用浏览器内的模拟后端，不需要模型和服务端。上面的截图就是这样拍的。

技术栈：Node 22 + TypeScript，Hono + SSE，Vite + React，CSS 全部手写。智能体引擎是进程内运行的 [pi](https://github.com/earendil-works/pi) SDK。设计、数据布局和工具列表见 [docs/architecture.md](docs/architecture.md)。

## 许可证

[MIT](LICENSE)

## 社区

本开源项目已链接并认可 [LINUX DO 社区](https://linux.do)。
