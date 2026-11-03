# Hob 架构（v1，2026-10-31 定）

Hob 是常驻助手。你只跟助手说话；活由后台任务去干，干完明说结果，只在要你拍板时才来找你。

## 两个来源合在一起

| 来源 | 拿来的东西 |
|---|---|
| Grok Bot | 助手 = 名字 + 职责 + **一条连续对话** + 自己的记忆和工作日志 + 定时任务；主助手（Hob）负责协调；审批在对话里做选择题；只在要批准时找你 |
| DeepSeek《Super-agent 设计探索》 | **Router 常驻只分派，Worker 隔离执行**；事件驱动（活干完推事件，不轮询对话）；Inline & Spill（大输出落盘，只把摘要带回对话）；Watchdog（卡住、崩溃、不汇报都要变成可见状态）；实验结论：只靠提示词让单会话去委派，5 次里 0 次委派，所以**委派必须是结构上的，不能靠提示词** |
| 其他常驻助手的教训 | 委派太绕；一轮结束就报"完成"；活在别处看不见；助手亲自干活把上下文撑爆（387MB 会话） |

由此得出 v1 的四条硬规则：

1. **助手的对话层手里没有执行工具。** 对话会话（Router）没有 bash/read/edit/write，只有协调工具。要干活只能 `start_job`。委派是结构上的，不靠提示词。
2. **任务必须明说结果。** 任务会话（Worker）结束前必须调用 `report(outcome, summary)`，outcome ∈ 完成 / 卡住 / 等你批。一轮跑完没调用 = 系统追问一次，再不报就记为"卡住：没交代结果"。
3. **结果以事件回到对话。** 任务结束 → 卡片状态更新 → 给所属助手的 Router 推一条事件消息 → Router 用一两句话告诉你。对话里只留摘要，完整报告落盘，卡片能点开看。
4. **任何时候都看得见。** 正在干的活在右栏“正在做”实时显示（读了什么、跑了什么），任务卡片点开能看完整过程。

## 进程和底座

- 单个 Node 22 进程：`server/`（Hono + SSE）+ `web/`（Vite + React，构建后由 server 静态托管）。入口是 `server/src/boot.ts`。
- 底座是 pi SDK `@earendil-works/pi-coding-agent@1.3.0`（引擎），在进程内 `createAgentSession`。界面、提示词、错误信息里不出现 pi：用户不需要知道它。
  - 服务商和凭据全归 Hob 自己管：引擎目录是 `HOB_HOME/engine`（`authPath` 在这里，模型配置 `modelsPath` 是 `HOB_HOME/engine/models.json`），不读不写任何别的工具的配置。
  - 启动时和每次服务商变动，把设置里的服务商套进引擎：内置服务商 `setRuntimeApiKey` / `removeRuntimeApiKey`，兼容接口 `registerProvider` / `unregisterProvider`。
  - 思考档也按 Hob 自己的设置写给引擎（见下文“思考档”）：兼容接口写进模型的 `thinkingLevelMap`，内置服务商写进 `HOB_HOME/engine/models.json` 的 `providers.<id>.modelOverrides`，写完 `refresh()` 一次让引擎重读。
  - 会话文件一律放在 `HOB_HOME` 下（不放进引擎目录）。
  - 不加载用户装的扩展、主题、AGENTS.md；技能只加载下文指定的来源。使用自定义 `ResourceLoader`（见 pi 示例 `examples/sdk/12-full-control.ts`）。工具由 Hob 自己给。

### 启动时的环境隔离（`server/src/boot.ts`）

引擎里有模块在加载时就算好目录（`getAgentDir()`：grep / find 的二进制缓存目录、任务 bash 的 PATH 前缀都从它来），传参管不到，只能先改环境变量再加载引擎。所以入口是 `boot.ts`：它只静态导入 node 内置模块和不碰引擎的小工具，定好环境后 `await import("./main.ts")`。

| 变量 | 启动时怎么处理 | 为什么 |
|---|---|---|
| `PI_CODING_AGENT_DIR` | 强制改成 `HOB_HOME/engine` | 引擎的 bin（rg / fd）、凭据、资源都在这里；否则会往用户自己的目录里下载和写文件 |
| `PI_MEMORY_DIR` | 强制改成 `HOB_HOME/memory` | 本地记忆插件在模块加载时就读它；`createRuntime` 也会再指一次 |
| `LORE_HOME` | 强制改成 `HOB_HOME/lore` | Lore 插件读写自己的连接配置 |
| `LORE_BASE_URL`、`LORE_API_TOKEN`、`API_TOKEN`、`LORE_CLIENT_TYPE`、`LORE_SKILLS_ENABLED` | 删掉 | 从 shell 继承的可能是用户别的客户端；Hob 只用自己的配置，也免得任务里的 bash 读到用户的 Token |
| `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`GEMINI_API_KEY`、`GOOGLE_API_KEY`、`DEEPSEEK_API_KEY`、`OPENROUTER_API_KEY`、`XAI_API_KEY`、`GROQ_API_KEY`、`MISTRAL_API_KEY`、`CLAUDECODE`、`CLAUDE_CODE_*` | 删掉（`CLAUDE_CODE_` 按前缀删） | 从启动终端继承的是用户别的客户端的模型凭据，任务里跑的命令能直接读到；Hob 的服务商 Key 只来自自己的 `secrets.json`，删掉后模型列表、服务商、任务都照常 |
| `HOB_LOCAL_PI_DIR`、`HOB_LOCAL_LORE_HOME` | 记下原值（原 `PI_CODING_AGENT_DIR` / `LORE_HOME`，没设就是 `~/.pi/agent` 和 `~/.lore`；用户自己设了这两个就尊重） | 「从本机导入」要读的目录，只记路径、不记密钥 |

结果：任务里跑 pi 命令用的是 Hob 的引擎目录，子进程继承的是 Hob 的变量，没有任何外部客户端的凭据。
- 数据目录 `HOB_HOME`（默认 `~/.hob`），全部是 JSON / JSONL 文件，原子写（写临时文件再 rename）：

```
~/.hob/
  config.json                 启动项：端口、host、密码哈希、cookie 签名密钥
  settings.json               界面可改的设置（主题、时区、关于你、服务商、模型、并发、卡住判定、推送邮箱），带 revision，写入走 CAS
  secrets.json                密钥（0600，原子写），接口只写不读回：provider:<id>、imageApiKey
  engine/                     引擎目录：auth.json（引擎写的凭据）、models.json（Hob 写给引擎的内置服务商思考档）、bin（rg / fd）、资源
  memory/                     本地记忆（捆绑的本地记忆插件）
  lore/                       Lore 连接（config.json，格式 { base_url, api_token }，0600、原子写）
  push.json                   Web Push：VAPID 密钥 + 订阅设备（0600，原子写）
  assistants/<id>/
    profile.json              Assistant（名字、职责、头像、置顶、通知…）
    rules.json                Rule[]   要先问你 / 规矩
    worklog.jsonl             WorklogEntry 每行一条
    router.jsonl              该助手唯一的对话（pi 会话文件）
  routines.json               Routine[]
  approvals.json              Approval[]
  drafts.json                 Draft[]
  delegations.json            Delegation[]（主助手转交记录）
  jobs/<jobId>/
    job.json                  Job
    worker.jsonl              任务会话（pi 会话文件）
    report.md                 完整报告（Spill）
  archive/assistants/<id>-<时间>/  并回 Hob 的助手：整个目录原样移到这里（profile / rules / worklog / router.jsonl）
  uploads/                    输入框上传的文件
  previews/                   设置 → 图像生成「生成测试图片」生成的图
  pages/                      展示页面 HTML 和 Markdown 稿子
```

## 核心对象（契约在 `shared/types.ts`，前后端共用，改它要两边一起改）

- **Assistant（助手）**：主助手 `id = "hob"` 唯一内置，首次启动自动创建；其余都是用户数据，不写死任何角色。`duty` 是职责简介，`dutyLong` 是详细职责；创建助手时从草稿复制，旧助手启动时从对应的已创建草稿幂等回填。长期记忆不属于某个助手（见下文“记忆”），助手自己特有的做法写在 `instructions`（补充说明）里。
- **Item（对话条目）**：对话 = 有序的 Item 列表。用户消息、助手回复从 pi 会话的消息得出；卡片类（question / job / draft / note / file）用 pi 的自定义条目 `customType: "hob.item"` 存在同一个 `router.jsonl` 里，**不进模型上下文**。卡片的可变状态（审批是否已选、任务进度、草稿是否已建）在 approvals.json / jobs / drafts.json 里，条目只存 id 引用，渲染时合并。
- **Job（任务）**：一次隔离执行 = Hob 进程里的一个 Worker pi 会话（`cwd` 给了就在那个目录干，不给就用 `HOB_HOME/jobs/<id>/work`）。任务记录带干活用的 `model` / `thinking`、`usage`（token 和花费）、`durationMs`；过程从 `worker.jsonl` 推导成 JobStep 列表（`server/src/transcript.ts`），实时动作走 `job_step` 事件。`assistantName` 记下建任务时的助手名，助手并回 Hob 后任务详情照样显示。
- **Approval（审批）**：选择题卡片。来源可以是 Router（不阻塞，答案作为下一条用户消息回到 Router）或 Worker（Worker 的 `ask_user` 工具阻塞等答案）。带 `always` 的选项（"以后这类直接…"）选中后自动写一条 `mode: "allow"` 的 Rule，并在对话里出一行"已记进 X 的规矩 · …"。审批仍属于提问的助手；转交回合或关联任务提出的审批，也在主助手的委派卡内展示同一条审批，两处调用同一答复接口。
- **Routine（定时）**：cron 表达式（`croner` 库）。到点 = 为所属助手开一个 local Job，结果作为带"⏱ 名字"标签的助手消息回到对话。运行记录 = 该定时产生的 Job 列表。
- **Draft（新助手草稿）**：Hob 提议分出助手时生成。点"创建"才真正建助手，并把草稿里的补充说明写进新助手的 `instructions`、在新助手对话开头写一行"X月X日 从 Hob 分出 · 带走 N 段对话"。

## 并回 Hob

助手只能收起、不能删；要消掉一个助手就并回 Hob（`POST /api/assistants/:id/merge`，和"分出"对称）。

- 拒绝：主助手（"主助手不能并回自己"）、助手不存在、这个助手还有进行中 / 排队 / 等待确认的任务（"请等任务结束后再并回"）。
- 定时任务的 `assistantId` 改成主助手并按新的助手重排调度；规则追加到主助手（按文字去重，同一条只留主助手原来那条，模式照旧）；补充说明非空时接在主助手那段后面，前面一行 `来自「<名字>」：`。长期记忆本来就共用一份，不动。
- 这个助手还没答复的审批记为 `expired`，卡片不再挂着。
- 整个助手目录（profile / rules / worklog / router.jsonl / state）用同盘 rename 移进 `HOB_HOME/archive/assistants/<id>-<时间>/`，不复制、不删除；历史任务留在 `jobs/`，`Job.assistantName` 补上当时的助手名，任务详情里不会因为找不到助手而报错。
- 主助手对话里出一行"已并回「<名字>」：转来 N 个定时任务、M 条规则"（写不进这行就不动数据，返回原因）；然后推 `assistant_removed`：前端从列表移除，正看着它的切到主助手，草稿卡里指向它的"已创建 · 查看"变成"已并回 Hob"且不能再点。

## Router（对话层）

每个助手一个常驻的 pi 会话（懒加载，空闲 30 分钟释放内存，下次用再从 `router.jsonl` 打开）。

- 系统提示词：身份（名字、职责）、你的规矩（rules）、补充说明（instructions）、记忆一节（按记忆提供者，见下）、其他助手名单（仅 Hob）、工作方式（不亲自执行、怎么开任务、只在规矩要求或不可逆时问、中文短句）。每次开新一轮前重建（规矩/补充说明改了下一轮就生效）。
- 模型：设置 → 模型里的对话模型（没选就没有，回复时出一条说明提示去配服务商）。
- 工具（全部是 Hob 自定义工具，无 pi 内置工具）：

| 工具 | 作用 |
|---|---|
| `start_job(title, instruction, cwd?)` | 开任务，立即返回 jobId；对话里出任务卡片。`cwd` 指定在哪个目录干活（写代码、改项目这类活传项目目录），不给就在任务自己的工作目录里 |
| `reply_job(jobId, text)` / `stop_job(jobId)` | 给在跑的任务补话 / 停掉 |
| `ask_user(title, detail?, options[])` | 出选择题卡片（不阻塞）；options 最多 3 个，可标 `always` |
| `set_rule(text, mode)` / `remove_rule(ruleId)` | 改要先问你；对话里出"已记进 X 的规矩 · …" |
| `create_routine` / `update_routine` / `delete_routine` | 改定时；对话里出"新增定时 · 名字 · 时间" |
| `propose_assistant(...)` | 仅 Hob：出新助手草稿卡（sprite 可填 custom + prop_art 自画一件道具） |
| `set_avatar(sprite, color?, prop_art?, assistant?)` | 换头像：内置道具/颜色，或 custom（+ prop_art 自画）；主助手可传 assistant 给其他助手换；成功后推 assistant 事件，对话里出一行「已换头像」 |
| `overview(sinceHours = 24)` | 仅 Hob：只读，各助手这段时间的工作日志、结束的任务、在跑的任务、未答审批（写早报/汇总用） |
| `message_assistant(assistantId, text)` | 仅 Hob：创建持久化委派卡并在目标对话显示「转自 Hob」，目标回合及关联任务结束后只向 Hob 回流一次结果，本轮结束 |
| `hand_back_to_hob(text, reason)` | 仅非主助手：不归自己职责的事交回 Hob；普通回合在双方对话中留下可互相定位的条目，转交回合则退回委派，本轮结束 |
| `send_file(path)` | 把任务产出的文件作为文件卡片发到对话 |
| `show_page(title, summary, html)` | 助手写正文 HTML 片段，Hob 套上自带样式（亮暗跟随）和离线 CSP 存为单页，发页面卡后结束本轮；对话生成时通过实时事件展示草稿；通用设置可关闭 |
| `web_search(query, depth?, max?)` / `web_fetch(url, raw?)` | 已启用联网搜索时可直接搜索或读取网页，搜索服务商按设置的优先级使用 |

- 事件消息（任务结束、定时结果、别的助手回复、审批答案）以用户角色进入 Router 上下文，但前缀固定的标记 `[hob-event]`，**不渲染成用户气泡**。
- 对话按“同一次回复”分组：组内条目贴着，组间拉开。事件之后的第一条带 `lead`（由会话条目推导，实时推送的条目算法相同）；任务直接发进对话的条目（提问卡、第一张产出图片）落盘时自带 `lead`，有图片时任务结束事件带 `cont`，回复接在图片后面，不另起一组。
- 出卡片的工具（`start_job` / `ask_user` / `propose_assistant` / `message_assistant`）的工具结果带 `terminate: true`：pi 在一批工具结果全部 terminate 时停止本批之后的模型请求，所以出了卡片这一轮就结构上结束，模型不会再补一句“卡在上面了”。同一批里混了别的工具（如 `set_rule`）就不提前结束，这是 pi 的规则。
- Router 正在回复时你又发消息 → `steer`；Router 空闲时来事件 → 直接开新一轮；忙时来事件 → `followUp`。

## 委派给其他助手

- 助手之间是以 Hob 为中心的星形关系，不互相直接调用。Hob 提示词列出其他助手的职责简介、详细职责和需确认规则，供它选择目标。
- 委派记录存入 `delegations.json`。目标对话立即显示转来消息，目标忙时排队处理；仅转交回合创建的任务关联到委派。Router 审批记在委派记录上，Worker 审批通过关联任务定位。
- 委派卡内的审批与目标对话引用同一审批，答复只提交一次。目标回合和所有关联任务结束且没有待答审批后，服务端同步写入 `reportedAt`，再向 Hob 推一次包含回复和任务报告的事件。转交回合调用 `hand_back_to_hob` 时委派标为 `returned`、记录退回原因，回流事件提醒 Hob 不要再转给同一个助手；不额外生成转来消息。重启时没有在跑任务的未完成委派标为已中断，可从卡片重新转交。

## Worker（任务层）

- 每个 local Job 一个独立 pi 会话，cwd 默认 `HOB_HOME/jobs/<jobId>/work`（启动时建好；`start_job` 显式给了 cwd 才用给的）。产出文件只能写在这个目录，读可以读任何地方；要给用户看的文件用 `report` 的 files 交回（落盘后 `/api/files` 能读）。
- 工具：开启展示页面时有 `show_page`（生成页面卡，返回文件路径，任务继续）；启用联网搜索时有 `web_search`、`web_fetch`；pi 内置 `read, bash, edit, write, grep, find, ls`（内置工具自带截断并把完整输出写进临时文件 = Spill），加 Hob 的 `report(outcome, summary, files?)`、`ask_user(title, detail?, options[])`（阻塞等答案）；主助手的任务（定时就是它）另有只读的 `overview(sinceHours = 24)`，用来写早报/汇总；配了图像生成且该助手开着图像生成时再加 `generate_image(prompt, size?, refs?)`（见下文“图像生成”）。
- 系统提示词：所属助手的职责、规矩（"要先问你"的事做之前必须 `ask_user`）、补充说明、记忆一节、任务说明、必须以 `report` 收尾。
- 模型：设置 → 模型里的任务执行模型（没选就退到对话模型，还没有就用模型列表里第一个可用的，思考 `high`）。
- 并发：同时最多 `settings.work.maxJobs`（默认 2）个任务，多的排队（状态 `queued`），改设置立即生效。
- 活动流：从 Worker 的工具事件生成 ActivityLine（`读 路径` / `跑 命令` / `改 路径` / `搜 模式`），统计 reads / commands / edits，实时推给前端，Job 里保留最近 200 行。
- report 的 summary 进卡片和 Router 事件（≤ 600 字）；完整的最后一条回复和 summary 写 `report.md`。
- Watchdog：
  - `settings.work.jobStallMinutes`（默认 15 分钟）没有任何事件 → `stuck`（原因"N 分钟没动静"），不杀，推事件；
  - 一轮结束没 report → 自动追问一次，再不报 → `stuck`（"没交代结果"）；
  - 进程重启时还在 running/queued/waiting 的 Job → `failed`（"Hob 重启，任务中断"）。

## 记忆（长期记忆）

记忆是所有助手共用的一份（关于用户的事实、偏好、约定），不属于某个助手；助手自己的做法放在它的规矩和补充说明里。

- 设置 → 记忆三选一：**本地记忆**（捆绑 `pi-memory` 0.4.2）/ **Lore**（捆绑 `@local/lore-pi-extension` 1.12.4）/ **关闭**。两个插件随 Hob 固定版本（`pi-memory` 在 package.json 钉死版本；Lore 插件不在 npm 上，源码放在 `vendor/lore-pi-extension/` 按路径加载），绝不安装任何东西，**绝不同时加载**（加载时断言）。
- 加载方式：Router 和 Worker 会话各开一份 pi 会话时，`PiHost` 用 `DefaultResourceLoader` 只挂当前提供者的那一个插件入口（`noExtensions: true`，用户自己装的扩展一份都不加载），工具放行按插件工具名（`memory_*` / `scratchpad` / `lore_*`）。本地记忆强制 `PI_MEMORY_EXIT_SUMMARY=0`，`memory_search` 在注册前过滤掉（没带 qmd，只会报错）。本地记忆目录是 `HOB_HOME/memory`（插件在模块加载时就读 `PI_MEMORY_DIR`，所以 `createRuntime` 在打开任何会话之前把它指好）。
- 缺省解析：从没选过时，看 Hob 自己的 `HOB_HOME/lore/config.json`（启动时 `LORE_HOME` 指到这里，插件读的也是它）——地址和 Token 都有 → Lore，否则本地记忆；选过就按选过的。存在 `settings.json` 的顶层 `memory.provider`。
- Lore 连接只读写 `HOB_HOME/lore/config.json`（0600、原子写、保留不认识的键），不读环境变量、不碰其他 Lore 客户端的配置；函数显式收 `home`。Token 只写不读，接口只报 `tokenConfigured`；换地址不换 Token 时旧 Token 清掉。明文 http 只允许本机 / 局域网 / Tailscale / IPv6 ULA 与 link-local / `.local`，公网必须 https。
- 选 Lore 但连接没配好 → 接口 400（fail-closed），**绝不静默回退到本地记忆**。连不上也不回退，测试连接把原因（地址无效 / 公网用了 http / 缺 Token / Token 被拒 / 连不上）原样显示。
- 切换生效：新会话立即生效；空闲的 Router 立刻释放，在回复的等这一轮跑完再释放，下一轮按新提供者重新打开。
- 提示词里的「记忆」一节按当前提供者逐轮生成（本地记忆讲 `memory_read`/`memory_write`，Lore 讲在 Lore 里查/记），关闭时不出这一节。
- 写成功：Router 调用 `memory_write` / `lore_create_node` / `lore_update_node` 成功后，对话里出一行「记忆已更新 · 写入内容第一行（最多 30 字）」。
- 老数据：启动时发现 `assistants/<id>/memories.json`，把每条作为一行追加进该助手的 `instructions`，然后删掉文件（一次性，不是兼容层）。

## 技能

任务可用的技能来自 `HOB_HOME/skills`、Lore 插件发现的工作副本以及 `~/.agents/skills`，同名按此顺序优先。任务只加载启用的技能；对话层只列出名称和说明。引擎的默认技能目录与项目技能不加载。停用状态保存在设置中，不修改技能文件。设置页可从 pi、Claude Code、Codex 的本机技能目录复制到 Hob，限制大小并跳过越界链接；通用技能和 Lore 技能不由 Hob 删除。

## 从本机导入（可选）

用户主动点才导入；只读来源文件，绝不写回、不改它们的权限和时间戳。任何接口都不返回 Key / Token 明文。来源目录是启动时记下的 `HOB_LOCAL_PI_DIR` / `HOB_LOCAL_LORE_HOME`。

- **服务商**（`server/src/imports.ts`）：读 `HOB_LOCAL_PI_DIR/models.json` 和 `auth.json`。
  - `models.json` 的 `providers.<id>` → 兼容接口：回显示名用 id；模型里 `id / name / input / reasoning / contextWindow / maxTokens` 映射成设置的字段，`thinkingLevelMap` 进 Hob 的自定义思考档（`settings.models.thinking[<ref>]`），其它字段（`compat`、`cost`、模型级 `api`…）原样进模型的 `extra`；服务商级的 `compat`、`headers`、`authHeader` 等进 `CustomProviderSettings.extra`，注册进引擎时原样透传（模型级同名字段优先，和引擎的规则一致）。界面不编辑 extra。
  - Key：字面值直接用；值是环境变量引用（`$NAME` / `${NAME}`）时取变量值，变量不存在就不带 Key；`!` 开头的是命令，**不执行**，导入时不带 Key。
  - `auth.json` 里 `type: "api_key"` 的条目 → 内置服务商（引擎认识这个 id 才列出）；`oauth` 的列出来但不可选。
  - 同一 id 只列一次（models.json 先）；导入同 id 覆盖，Key 写进 `secrets.json` 的 `provider:<id>`，然后套进引擎。
- **Lore 连接**：读 `HOB_LOCAL_LORE_HOME/config.json` 的 `base_url` / `api_token`，写进 `HOB_HOME/lore/config.json`（和保存 Lore 连接同一条路径），来源文件不动。

## 图像生成

- 设置 → 图像生成二选一：**关闭** / **OpenAI 兼容接口**（服务地址、模型名、默认尺寸）。
- OpenAI 兼容接口的 Key 存 `HOB_HOME/secrets.json`（`imageApiKey`），0600、原子写，接口只报 `keyConfigured`，永不回显。
- 没配就没有图像生成能力：Worker 不注册 `generate_image`，提示词里写「不能做：图像生成」；配了且助手的「能力 → 图像生成」开着才注册。
- 生成：`server/src/image.ts` 的 `generateImage`。无参考图打 `POST {baseUrl}/images/generations`（JSON），有参考图打 `POST {baseUrl}/images/edits`（multipart 的 `image` 字段）。返回 `b64_json` 或 `url` 都支持，统一按 MIME 落成 png/jpg/webp/gif。
- 失败给具体原因：连不上（地址不通）、Key 被拒（401/403 带接口原话）、404 提示检查 /v1 和模型名、超时。
- 任务工具 `generate_image(prompt, size?, refs?)`：图片存任务工作目录，返回绝对路径；任务要以 `report` 的 `files` 交回才会显示。
- 图片进对话：`report.files` 里的图片在任务结束后作为 `file` 条目进对话（非图片文件留在任务卡和报告里），`send_file` 发图片也一样；前端渲染成内联缩略图（最大宽 320、圆角），点开全屏。`GET /api/files` 按扩展名给 content-type。

## 设置（settings.json / secrets.json）

- 界面能改的东西都在 `HOB_HOME/settings.json`：`{ revision, settings: { general, providers, models, image, work } }`。
  - `general`：`theme`（system / light / dark）、`timezone`（默认系统时区）、`aboutYou`（称呼、语言、其他说明）。
  - `models`：`roster`（能用哪些模型 + 每句定位 + 默认思考档）、`conversation` / `work` 两个角色、`thinking`（每个模型的自定义思考档，键是 `"服务商/模型"`；没存就用默认规则，见“思考档”）。
  - `providers`：`ProviderSettings[]`，只有 `kind: "builtin"`（引擎自带服务商，只填 Key）和 `kind: "custom"`（兼容接口：`id` slug、`name`、`api`、`baseUrl`、`models[]`，每个模型可带 `extra` 原样透传给引擎）。Key 在 `secrets.json` 的 `provider:<id>`，接口只给 `keyConfigured`。写入走 `PUT /api/providers/:id`。
  - `search`：联网搜索服务商顺序、开关和服务地址，密钥手动填写并存入 `secrets.json` 的 `search:<name>`。搜索与抓取工具对 Router 和 Worker 可用。
  - `image`：`{ source: "off" }` / `{ source: "openai", baseUrl, model, size? }`，写入走 `PUT /api/image`。
  - `work`：`maxJobs`（1–8）、`jobStallMinutes`、`routerStallMinutes`。
- `GET /api/settings` 返回整份（带 revision）；`PUT /api/settings {revision, patch}` 按节合并，revision 不是当前的 → 409，前端重新拉取并提示。
- 改完即生效：时区影响提示词里的“现在时间”和定时调度，并发和卡住判定下一轮/下一次检查就用新值。
- `aboutYou` 进了所有助手的系统提示词（“关于用户”一节：填了哪行出哪行，全空就不出）。
- 密码：`config.json` 只存 scrypt 哈希（带盐）；首次启动时把明文 `password` 或 `HOB_PASSWORD` 转成哈希写回。`POST /api/password {old, new}` 旧的不对 → 403。
- 密钥（服务商 Key、图像生成 Key）存 `HOB_HOME/secrets.json`，0600、原子写，接口只写不读回。

## 思考档

思考档（off / minimal / low / medium / high / xhigh / max，界面上是关闭 / 最低 / 低 / 中 / 高 / 很高 / 最高）也是 Hob 自己管的：**只看 Hob 设置，不跟本机 pi 的配置挂钩，引擎模型注册表里自带的 `thinkingLevelMap` 也不用**。本机那份只在「从本机导入」时复制一次进来。

- 规则写在 `shared/thinking.ts` 一处（前后端和演示模式共用）：
  - 默认范围：会推理的模型 off … max；模型 id 含 `gpt`（不分大小写）的只到 xhigh；不推理的只有 off。
  - 默认字符：不填。引擎自己会按各协议的默认值翻译（off 不写才不会发出非法的 `reasoning_effort`，Anthropic 的 minimal 也能翻成 low）。
  - `xhigh` / `max` 是引擎默认不开的两档，要开就得写个值：一般写档名；Google 那套只有 low / medium / high，写档名会被引擎当成不认识的档而抛错，所以写 `high`。
  - 存了自定义档位就按自定义：开了的档（字符可以留空）+ 删掉的档（`null`）；没写到的键按默认范围算。
- 存的位置：`HOB_HOME/settings.json` 的 `settings.models.thinking`，键是模型 ref（`"服务商/模型"`），值是档位 → 字符：字符串 = 用户指定的字符，空串 = 开着但按服务商协议默认，`null` = 这一档不要；没这个键就是默认规则。导入时只把本机写明的键原样复制过来，之后和本机无关。
- 写给引擎（`ProviderService.applyTo`）：**稀疏的 `thinkingLevelMap`**，只放需要的键——用户自己填的字符、要开的 `xhigh` / `max`、删掉的档写 `null`。没改过的 off、minimal…high 一律不写（写了引擎就原样发出去，那正是各协议值不一样的坑）。兼容接口进模型的 `thinkingLevelMap`（`engineModels`）；内置服务商写进 `HOB_HOME/engine/models.json` 的 `providers.<id>.modelOverrides.<模型 id>.thinkingLevelMap`，写完 `refresh()` 一次引擎配置。
- 一律不拒、只往下收：设置保存和 `start_job` 都只校验档位本身合法（7 个标准档之一）；某个模型没这一档时，默认档和显式填的档都按 `fitThinking` 往下取最近的一档，任务详情显示实际用的档。
- 只能启用/删掉这 7 个标准档，不能造第 8 个档（引擎只认这 7 个）。`off` 可以改字符但不能删。删掉的档不用管协议：不写就是关（xhigh / max 本来就不写就等于关）。
- 编辑：设置 → 服务商 → 服务商详情 → 模型 → 思考档（推理模型才有这一节）。字符去首尾空白、最长 40 字；留空就是服务商协议自己的默认，不合法 400 并说清哪一档。存完 `ModelCatalog.reset()`，下一轮对话 / 下一个任务就用新的档。

## 对话富文本

对话和任务详情的 Markdown 使用 marked；公式按需动态加载 KaTeX（含本地 CSS 和字体，关闭 trust），代码块支持单独复制。音频在浏览器内解码生成波形，无法解码时显示进度条；视频使用浏览器原生播放器。

## HTTP / 实时

- 登录：`POST /api/login {password}` → HttpOnly cookie（签名随机 token，存内存 + `config.json` 里的 secret）。其余 `/api/*` 都要 cookie。
- REST（详见 `shared/types.ts` 的 `Api` 注释）：
  - `GET /api/bootstrap` → 助手列表（带最后一句、未读、是否在忙）、在跑和最近的任务、定时、未答审批、设置（带 revision）
  - `GET /api/settings` / `PUT /api/settings {revision, patch}` → 读 / 按节合并写设置
  - `GET /api/providers` → 已配的服务商、引擎自带的服务商目录、整份设置，以及每个已配置服务商的模型和思考档（`models`，键是服务商 id；内置服务商列出引擎目录里的全部模型）；`POST /api/providers/test` 测试连接（内置服务商发起少量模型调用，兼容接口访问模型列表，失败不保存配置）
  - `PUT /api/models/thinking {ref, levels}` → 存一个模型的自定义思考档（`null` = 恢复默认），返回新 revision 的整份设置和这个模型现在的思考档、`PUT /api/providers/:id`（新建或改，Key 可选留空沿用）、`DELETE /api/providers/:id`、`POST /api/providers/discover {api, baseUrl, apiKey?, id?}`（从兼容接口拉模型列表）、`GET /api/providers/import`（本机能导入的服务商，不带 Key）、`POST /api/providers/import {ids}`（导入所选，同 id 覆盖）
  - `GET /api/models`（可用模型 + 名单里哪些不可用）
  - `POST /api/password {old, new}`、`GET /api/about`（版本、数据目录）
  - `GET /api/assistants/:id/items?before&limit` → 条目 + 引用到的 approvals/jobs/drafts
  - `GET /api/assistants/:id/profile` → 助手 + rules + routines + 最近工作日志
  - `POST /api/assistants/:id/messages {text, quote?, files?}`、`POST /api/assistants/:id/stop`、`POST /api/assistants/:id/read`
  - `PATCH /api/assistants/:id`（助手设置或 `{ rule: { id?, text?, mode? } }` 保存规则；不传 id 时必须提供文字和模式并新增，返回规则）、`DELETE /api/assistants/:id/rules/:rid`、`POST /api/assistants/:id/merge`（并回 Hob，见上文）
  - `GET /api/memory`、`PUT /api/memory {revision, provider}`、`PUT /api/memory/lore {baseUrl, token?}`、`POST /api/memory/lore-test`（记忆提供者与 Lore 连接，见上文“记忆”）、`GET /api/memory/lore/import`（本机的 Lore 连接，不带 Token）、`POST /api/memory/lore/import`（导进 Hob 自己的配置）
  - `GET /api/image`（Key 配没配）、`PUT /api/image {revision, image, apiKey?}`（Key 只写不读，留空 = 沿用）、`POST /api/image/test {image?, apiKey?}`（试一张，失败也是 200，原因在 `error` 里）
  - `GET /api/push`（publicKey + 已订阅设备）、`POST /api/push/subscribe {subscription, label}`、`DELETE /api/push/subscribe {endpoint}`、`POST /api/push/test {endpoint?}`（推送，见下文“PWA 与推送”）
  - `POST /api/visibility {clientId, visible}`（页面在不在前台，只存内存；SSE 断开即视为不可见）
  - `POST /api/delegations/:id/retry`（重新转交已中断的委派）
  - `POST /api/approvals/:id {key}` 或 `{text}`（用户没选选项、自己写的一段，空白和超长都是 400）、`POST /api/drafts/:id/create`、`POST /api/drafts/:id/dismiss`
  - `POST /api/routines`、`PATCH /api/routines/:id`、`DELETE /api/routines/:id`、`POST /api/routines/:id/run`
  - `POST /api/jobs/:id/reply {text}`、`POST /api/jobs/:id/stop`
  - `GET /api/jobs?assistantId&status&before&limit` → 工作记录：全部任务，新的在前，分页
  - `GET /api/jobs/:id/transcript` → 任务过程（步骤列表，从 `worker.jsonl` 推导；单步输出超 20KB 时截断并给出全文路径）
  - `POST /api/uploads`（multipart）、`GET /api/files?path=`（只允许 HOB_HOME 和任务 report/产出文件）
- 实时：`GET /api/events`（SSE）。`page-live` 推送对话页面的完整草稿及完成或失败状态；进行中的草稿在内存中，可从对话条目接口恢复。`router-activity` 推送助手对话的思考 / 工具状态和中文标签（思考中的标签是模型当前思考的最后一段，压成一行，节流约 200ms；不进对话记录），文字开始输出、停止或结束时清空；当前状态只存内存，并随助手概要返回供刷新和重连恢复。Worker 的 `activity` 仍是独立的任务活动流。事件类型见 `HobEvent`。前端断线重连后重新拉 bootstrap 和当前对话（EventSource 自带重连）。连接上带 `clientId`，断开时服务端把这台客户端的可见性一起清掉。

## PWA 与推送

- 可安装：`web/public/manifest.webmanifest`（Hob，standalone）+ `web/public/icons/` 的图标（192 / 512 any、512 maskable、apple-touch-icon 180、favicon 32）。图标由 `node scripts/make-icons.mjs` 把 hob 像素火苗截图生成，出图提交进仓库。
- Service worker（`web/public/sw.js`，手写，无依赖）：导航 network-first（断网回退缓存的 index.html），`/assets/*`、`/icons/*`、`/fonts/*` cache-first，`/api/*` 一律不拦不缓存。只在生产构建里注册（`web/src/pwa.ts`）。新版本装好不自动接管，页面提示「有新版本 · 刷新」，点了才 `skipWaiting`。
- iOS：`env(safe-area-inset-*)` 给列表页、对话页输入框、全屏页头部留出安全区。
- Web Push：`web-push`，VAPID 密钥首次用时生成，和订阅一起存 `HOB_HOME/push.json`（0600、原子写）；subject 是 `mailto:` + 设置 → 通知里填的邮箱（没填用 `mailto:hob@localhost`）。推送在出审批（该助手开了“需要我拍板时通知我”）和任务卡住/失败时发出，标题是助手名，点开跳 `/?a=<助手id>`。只要有一个可见的页面客户端就不推；推送服务回 404/410 的订阅自动删掉。页面里不再用浏览器 `Notification` 提醒。

## 前端

- 照 `docs/design/v2/index.html` 做（那是唯一的视觉真相源：CSS 变量、尺寸、组件都直接搬）。截图 `s1~s6.png` 是验收对照。
- 头像：都是 Hob 的像素小火苗，换一种颜色、带一件职责道具（安全帽、放大镜、Wi-Fi…），数据和画法在 `shared/sprites.ts`，前端画成 SVG。sprite 记成「道具」或「道具:颜色」；库里没有贴合职责的道具时，AI 可以自己画一件：sprite 记成 `custom` 或 `custom:颜色`，画法存在 `Assistant.prop`（`{ art, pal, dx }`，格式和 PROPS 里的一项相同；校验在 `shared/sprites.ts` 的 `validateCustomProp`，前后端共用，最多 16 行 × 16 字符、最多 6 种颜色、不能动火苗的 o y e 和描边 k、不能盖住眼睛、至少 6 个像素），草稿同样能带一份；自画道具在头像选择器里排第一个，换成内置道具后画法保留、能换回来；建助手时模型按职责挑道具（道具表同时生成提示词里的那行说明），和已有助手撞了就自动换颜色（自画的图案各不相同，不算撞）；助手设置里可以换道具和颜色。
- 桌面三栏：左栏助手（置顶大头像 + 分组列表 + 收起的助手 + 底部设置）、中间对话、右栏（正在做 + 定时 / 定时编辑 / 助手设置，可收起）。设置是整页：桌面左侧分栏导航 + 右侧内容，手机先列表再进入。
- 设置页：通用、服务商、模型、记忆、图像生成、任务、通知、关于都是真页面。
- 手机（宽 < 768px）：列表页（顶部在跑的任务行 + 助手）和对话页两级。
- 浅色为主，深色按系统或设置切换（index.html 里的 `.dark` 变量）。
- 不用 UI 组件库、不用 CSS 框架；React + 手写 CSS。

## 不做（v1）

多用户、事件型触发（邮件/Webhook）、表情回应、助手之间群聊、终端命令硬拦截（审批靠规矩 + ask_user）。
