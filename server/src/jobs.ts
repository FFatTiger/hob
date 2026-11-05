import { homedir } from "node:os";
import { copyFileSync, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type, type ImageContent } from "@earendil-works/pi-ai";
import { commandSummary } from "../../shared/command.ts";
import type {
  ActivityLine,
  Approval,
  ApprovalOption,
  Job,
  JobsPage,
  JobRound,
  JobStatus,
  JobStep,
  RoutineRun,
} from "../../shared/types.ts";
import { IMAGE_TYPES, isImagePath } from "../../shared/media.ts";
import { newId } from "./ids.ts";
import { availableDesktopTools, type DesktopToolSession } from "./desktop-tools.ts";
import { imageConfigured } from "./image.ts";
import { boundKnowledge, findKnowledgeTool, searchKnowledgeTool } from "./knowledge-tools.ts";
import { MCP_SESSION_TOOLS, mcpEnabled, mcpServerDisplay } from "./mcp.ts";
import { jobModel } from "./models.ts";
import { overviewTool } from "./overview.ts";
import { pageTool } from "./pages.ts";
import { pushApproval, pushJobEnd } from "./push.ts";
import { buildWorkerPrompt, type Abilities, type PromptSettings } from "./prompt.ts";
import { availableSkills } from "./skills.ts";
import { enabledAssistantSkills, listAssistantSkills, readSkillFiles, recordAssistantSkillUse, saveAssistantSkill, usableAssistantSkills } from "./assistant-skills.ts";
import type { HobRuntime } from "./runtime.ts";
import { showPath } from "./text.ts";
import { monthDayTimeText } from "./time.ts";
import { SEDIMENT_PROMPT_HEAD, STEP_EVENT_LIMIT, deriveSteps, textOfContent, toolStep, withOutput } from "./transcript.ts";
import { registerAskTool, registerImageTool, registerReportTool } from "./worker-tools.ts";
import { searchTools } from "./search.ts";

const WORKER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const ACTIVITY_LIMIT = 200;
const ENDED: JobStatus[] = ["done", "stuck", "failed", "stopped"];

const ALL_ABILITIES: Abilities = { exec: true, write: true, image: true };

/** 助手关掉的能力就不给对应工具（读总是有）。 */
export function workerTools(abilities: Abilities): string[] {
  return WORKER_TOOLS.filter((name) => {
    if (name === "bash") return abilities.exec;
    if (name === "edit" || name === "write") return abilities.write;
    return true;
  });
}

/** 附件里有没有图片（按扩展名判断，不读文件）。 */
export function hasImageFiles(files: string[] | undefined): boolean {
  return (files ?? []).some((file) => isImagePath(file));
}

/** 一张图超过这个大小就不当图片给模型（只留路径），免得把会话撑得太大。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 附件里的图片读成 pi 的图片块（读不出来、太大就跳过，不把整个回合拖死）。任务和对话共用。 */
export function imageContents(files: string[] | undefined): ImageContent[] {
  const out: ImageContent[] = [];
  for (const file of files ?? []) {
    const mimeType = IMAGE_TYPES[extname(file).toLowerCase()];
    if (!mimeType) continue;
    try {
      if (statSync(file).size > MAX_IMAGE_BYTES) continue;
      out.push({ type: "image", data: readFileSync(file).toString("base64"), mimeType });
    } catch {
      // 文件没了或读不了：不带图片，靠任务说明的路径自己去读
    }
  }
  return out;
}

export interface StartJobInput {
  title: string;
  instruction: string;
  cwd?: string;
  /** 交给任务的附件（图片会当图片给模型，其他只在说明里列路径） */
  files?: string[];
  model?: string;
  thinking?: string;
  routineId?: string;
  delegationId?: string;
}

interface WorkerState {
  job: Job;
  session?: AgentSession;
  manager?: SessionManager;
  reported?: { outcome: "done" | "stuck" | "need_approval"; result: string; files?: string[] };
  lastText?: string;
  askedFollowUp: boolean;
  lastActivityAt: number;
  finishTimer?: NodeJS.Timeout;
  ask?: (label: string) => void;
  /** 用户叫停了：收尾期间这个 worker 的 report/追问都不再算数 */
  stopped?: boolean;
  /** 正在跑的工具步骤，按 toolCallId 存：输出更新、跑完都按同一个步骤 id 替换 */
  steps: Map<string, JobStep>;
  readPaths: Map<string, string>;
  /** 你补的话已交给任务、还没被读到（任务做完当前这一步才读）；读到时换成正式的一行 */
  queued: JobStep[];
  /** 任务过程里 MCP 工具的显示名（转义后的服务名 → 配置里的原名） */
  mcpServers: Record<string, string>;
  desktop?: DesktopToolSession;
}

/** 推给助手的任务结果最多带这么多字的报告。 */
const EVENT_SUMMARY_MAX = 3000;

export function jobResultEvent(job: Job, prefix = `任务「${job.title}」`): string {
  const status = job.status === "done" ? "已完成" : job.status === "stuck" ? "受阻" : job.status === "stopped" ? "已停止" : "失败";
  const result = job.summary;
  const header = `${prefix}（${job.id}）${status}。`;
  if (!result) return `${header}\n${job.statusReason ?? "没有结果"}`;
  return result.length > EVENT_SUMMARY_MAX
    ? `${header}\n结果（共 ${result.length} 字，以下是前 3,000 字；全文：${job.reportPath}）：\n${result.slice(0, EVENT_SUMMARY_MAX)}`
    : `${header}\n结果：\n${result}`;
}

function trim(value: string, max = 240): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function activityFor(toolName: string, args: Record<string, unknown>, cwd = ""): ActivityLine | undefined {
  const path = showPath(String(args.path ?? args.file_path ?? args.filePath ?? ""), cwd);
  switch (toolName) {
    case "read":
      return { at: new Date().toISOString(), verb: "读", text: path };
    case "ls":
      return { at: new Date().toISOString(), verb: "读", text: path || "." };
    case "bash":
      return { at: new Date().toISOString(), verb: "跑", text: trim(commandSummary(String(args.command ?? "")), 120) };
    case "edit":
      return { at: new Date().toISOString(), verb: "改", text: path };
    case "write":
      return { at: new Date().toISOString(), verb: "写", text: path };
    case "grep":
      return { at: new Date().toISOString(), verb: "搜", text: trim(String(args.pattern ?? ""), 80) };
    case "find":
      return { at: new Date().toISOString(), verb: "搜", text: trim(String(args.pattern ?? ""), 80) };
    default:
      return undefined;
  }
}

/** 后台任务：一个 Job = 一个隔离的 Worker 会话，结束必须 report。 */
export class JobManager {
  private workers = new Map<string, WorkerState>();
  private queue: string[] = [];
  private followUps = new Map<string, string>();
  private finishing = new Map<string, Promise<void>>();
  private sediments = new Map<string, { cancelled: boolean; session?: AgentSession; task?: Promise<void> }>();
  private replied = new Set<string>();
  private watchdog?: NodeJS.Timeout;

  constructor(private readonly runtime: HobRuntime) {}

  private get store() {
    return this.runtime.store;
  }

  private get bus() {
    return this.runtime.bus;
  }

  /** 提示词用的设置：现读 settings.json，所以改完下一个任务就按新时区算。 */
  private promptSettings(): PromptSettings {
    const { timezone, aboutYou } = this.runtime.settings.settings.general;
    return { timezone, aboutYou, memory: this.runtime.settings.memory().provider };
  }

  jobsFor(assistantId: string): Job[] {
    return this.store.jobs().filter((job) => job.assistantId === assistantId);
  }

  /** 任务记录：全部任务，新的在前，可按助手 / 状态筛选，按 before（上一次最后一页的那条）分页。 */
  page(options: { assistantId?: string; status?: JobStatus; before?: string; limit?: number } = {}): JobsPage {
    const limit = Math.max(1, Math.min(options.limit ?? 30, 200));
    let list = this.store.jobs().reverse();
    if (options.assistantId) list = list.filter((job) => job.assistantId === options.assistantId);
    if (options.status) list = list.filter((job) => job.status === options.status);
    if (options.before) {
      const index = list.findIndex((job) => job.id === options.before);
      if (index !== -1) list = list.slice(index + 1);
    }
    return { jobs: list.slice(0, limit), hasMore: list.length > limit };
  }

  /** 详情页要全文时拉它：从任务会话文件重新推导，长输出落到任务目录下。 */
  transcript(jobId: string): JobStep[] {
    const job = this.store.job(jobId);
    if (!job) return [];
    const steps = deriveSteps(this.store.workerFile(jobId), {
      cwd: job.cwd ?? "",
      save: (stepId, text) => this.store.writeStepOutput(jobId, stepId, text),
      mcpServers: mcpServerDisplay(this.runtime.home),
    });
    return [...steps, ...(this.workers.get(jobId)?.queued ?? [])];
  }

  async start(assistantId: string, input: StartJobInput): Promise<Job> {
    const assistant = this.store.assistant(assistantId);
    if (!assistant) throw new Error(`助手不存在：${assistantId}`);
    if (input.cwd?.trim()) {
      const canonical = (path: string): string => {
        const absolute = resolve(path);
        let parent = absolute;
        while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
        return resolve(realpathSync(parent), relative(parent, absolute));
      };
      const path = relative(canonical(this.runtime.home), canonical(input.cwd));
      if (!path || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))) {
        throw new Error("不能在 Hob 的数据目录里干活；不填 cwd 就在任务自己的目录里做。");
      }
    }
    await this.runtime.models.get();
    const requested =
      input.model || input.thinking
        ? { ...(input.model ? { model: input.model } : {}), ...(input.thinking ? { thinking: input.thinking } : {}) }
        : undefined;
    const picked = jobModel({
      settings: this.runtime.settings.settings.models,
      assistant,
      catalog: this.runtime.models,
      ...(requested ? { requested } : {}),
      ...(hasImageFiles(input.files) ? { hasImages: true } : {}),
    });
    const id = this.nextJobId();
    const job: Job = {
      id,
      assistantId,
      assistantName: assistant.name,
      title: input.title,
      instruction: input.instruction,
      status: "queued",
      createdAt: new Date().toISOString(),
      stats: { reads: 0, commands: 0, edits: 0 },
      activity: [],
      cwd: input.cwd?.trim() ? input.cwd : this.store.workDir(id),
      model: picked.model.ref,
      thinking: picked.model.thinking,
      ...(picked.modelReason ? { modelReason: picked.modelReason } : {}),
      ...(input.files?.length ? { inputs: input.files } : {}),
      ...(input.routineId ? { routineId: input.routineId } : {}),
      ...(input.delegationId ? { delegationId: input.delegationId } : {}),
    };
    this.store.saveJob(job);
    if (job.delegationId) this.runtime.delegations.addJob(job.delegationId, job.id);
    await this.runtime.router.addItem(assistantId, { kind: "job", jobId: job.id });
    this.bus.emit({ type: "job", job });
    this.publishBusy(assistantId);
    this.queue.push(job.id);
    this.pump();
    return job;
  }

  /** 任务会改变“忙不忙”（前端用它显示“正在想”），所以状态一变就告诉前端。 */
  private publishBusy(assistantId: string): void {
    const assistant = this.store.assistant(assistantId);
    if (assistant) this.bus.emit({ type: "assistant", assistant: this.runtime.router.summary(assistant) });
  }

  private nextJobId(): string {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = newId("t-", 4);
      if (!this.store.job(candidate)) return candidate;
    }
    return newId("t-", 8);
  }

  /** 并发名额：settings 的 maxJobs（改完立即生效，排队里的会接着启动）。 */
  private runningCount(): number {
    return this.store.jobs().filter((job) => job.status === "running" || job.status === "waiting").length;
  }

  pump(): void {
    const max = this.runtime.settings.settings.work.maxJobs;
    while (this.queue.length && this.runningCount() < max) {
      const id = this.queue.shift()!;
      const job = this.store.job(id);
      if (!job || job.status !== "queued") continue;
      const followUp = this.followUps.get(id);
      this.followUps.delete(id);
      void this.launch(job, followUp).catch((error) => this.failLaunch(job, error));
    }
  }

  private async failLaunch(job: Job, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.finish(job.id, "failed", undefined, message);
  }

  private async launch(job: Job, followUp?: string): Promise<void> {
    const running: Job = {
      ...job,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.store.saveJob(running);
    this.bus.emit({ type: "job", job: running });

    const assistant = this.store.assistant(running.assistantId);
    // 生图要两头都满足：助手开着，而且设置里真配了图像模型
    const baseAbilities = assistant?.abilities ?? ALL_ABILITIES;
    const abilities: Abilities = {
      ...baseAbilities,
      image: baseAbilities.image && imageConfigured(this.runtime.settings.settings.image),
    };
    const knowledge = await boundKnowledge(this.runtime, running.assistantId);
    const customTools = [registerReportTool(this.runtime, running.id), registerAskTool(this.runtime, running.id), findKnowledgeTool(this.runtime)];
    if (knowledge.length) customTools.push(searchKnowledgeTool(this.runtime, running.assistantId));
    if (abilities.image) customTools.push(registerImageTool(this.runtime, running.id));
    if (this.runtime.settings.settings.general.showPage !== false) customTools.push(pageTool(this.runtime, running.assistantId, false));
    customTools.push(...searchTools(this.runtime.home, () => this.runtime.settings.settings.search));
    const desktop = await availableDesktopTools(this.runtime, running.assistantId, !!this.runtime.models.find(running.model ?? this.runtime.settings.settings.models.work.ref)?.input.includes("image"));
    if (this.store.job(running.id)?.status !== "running") { await desktop?.dispose(); return; }
    if (desktop) customTools.push(...desktop.tools());
    // 定时跑的就是 Worker：主助手的任务要看得到各助这段时间的动静才能写早报
    if (assistant?.primary) customTools.push(overviewTool(this.runtime));
    // MCP：配置里有启用中的服务才加载（改完配置，之后新开的任务生效）
    const mcp = mcpEnabled(this.runtime.home);
    const ownSkills = enabledAssistantSkills(this.runtime.home, running.assistantId);
    const ownNames = new Set(ownSkills.map((skill) => skill.name));
    const opened = await this.runtime.pi.open({
      file: this.store.workerFile(running.id),
      cwd: running.cwd ?? homedir(),
      model: running.model ?? this.runtime.settings.settings.models.work.ref,
      thinking: running.thinking ?? this.runtime.settings.settings.models.work.thinking,
      memory: this.runtime.settings.memory().provider,
      skills: [...ownSkills, ...availableSkills(this.runtime.home, undefined, this.runtime.settings.settings.skills?.disabled).filter((skill) => !ownNames.has(skill.name))],
      disabledSkills: this.runtime.settings.settings.skills?.disabled,
      systemPrompt: () =>
        buildWorkerPrompt(this.store, running.id, { ...this.promptSettings(), abilities, knowledgeNames: knowledge.map((collection) => collection.name) }),
      tools: [
        ...workerTools(abilities),
        ...customTools.map((tool) => tool.name),
        ...(mcp ? MCP_SESSION_TOOLS : []),
      ],
      customTools,
      mcp,
    });
    if (this.store.job(running.id)?.status !== "running") { opened.session.dispose(); await desktop?.dispose(); return; }
    const mcpServers = mcpServerDisplay(this.runtime.home);

    const worker: WorkerState = {
      job: running,
      session: opened.session,
      manager: opened.manager,
      askedFollowUp: false,
      lastActivityAt: Date.now(),
      steps: new Map(),
      readPaths: new Map(),
      queued: [],
      mcpServers,
      desktop,
    };
    this.workers.set(running.id, worker);
    if (followUp !== undefined) {
      const step: JobStep = { id: `q${Date.now()}-0`, kind: "text", at: new Date().toISOString(), from: "user", text: followUp, queued: true };
      worker.queued.push(step);
      this.emitStep(worker, step);
    }
    const images = followUp === undefined ? imageContents(running.inputs) : [];

    opened.session.subscribe((event) => {
      if (worker.stopped) return;
      if (event.type === "tool_execution_start") {
        if (event.toolName === "read" && typeof event.args?.path === "string") worker.readPaths.set(event.toolCallId, event.args.path);
        this.recordActivity(worker, event.toolName, event.args ?? {});
        const step = toolStep({
          id: event.toolCallId,
          name: event.toolName,
          args: event.args ?? {},
          at: new Date().toISOString(),
          cwd: worker.job.cwd ?? "",
          mcpServers: worker.mcpServers,
          running: true,
        });
        worker.steps.set(event.toolCallId, step);
        this.emitStep(worker, step);
        return;
      }
      if (event.type === "tool_execution_update") {
        const step = worker.steps.get(event.toolCallId);
        if (step) this.emitStep(worker, this.withStepOutput(worker, step, textOfContent(event.partialResult?.content)));
        return;
      }
      if (event.type === "tool_execution_end") {
        if (event.toolName === "read" && !event.isError) {
          const readPath = worker.readPaths.get(event.toolCallId);
          if (readPath) {
            try { this.recordSkillUse(worker, readPath); }
            catch (error) { console.error("记录技能用量失败：", error); }
          }
        }
        worker.readPaths.delete(event.toolCallId);
        const step =
          worker.steps.get(event.toolCallId) ??
          toolStep({ id: event.toolCallId, name: event.toolName, args: {}, cwd: worker.job.cwd ?? "", mcpServers: worker.mcpServers });
        worker.steps.delete(event.toolCallId);
        this.emitStep(
          worker,
          this.withStepOutput(worker, step, textOfContent(event.result?.content), {
            isError: event.isError,
            durationMs: event.durationMs,
          }),
        );
        return;
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        const text = textOfContent(event.message.content).trim();
        if (text) worker.lastText = text;
        worker.lastActivityAt = Date.now();
        this.recordSteps(worker, event.message);
        this.addUsage(worker, event.message);
        return;
      }
      if (event.type === "message_start" || event.type === "agent_start") {
        worker.lastActivityAt = Date.now();
        if (event.type === "message_start" && event.message.role === "user") {
          // 补的那句被任务读到了：id 和 transcript 推导出来的一样，前端拿它换掉「等待读取」那行
          const text = textOfContent(event.message.content).trim();
          const index = worker.queued.findIndex((step) => step.text === text);
          if (index >= 0) {
            worker.queued.splice(index, 1);
            this.emitStep(worker, { id: `u${event.message.timestamp}`, kind: "text", at: new Date(event.message.timestamp).toISOString(), from: "user", text });
          }
        }
        return;
      }
      if (event.type === "agent_settled") void this.onSettled(worker);
    });

    void opened.session
      .prompt(followUp ?? running.instruction, images.length ? { images } : undefined)
      .catch(async (error: unknown) => {
        if (!worker.stopped) await this.finish(running.id, "failed", undefined, error instanceof Error ? error.message : String(error));
      });
  }

  private recordSkillUse(worker: WorkerState, path: string): void {
    const job = this.store.job(worker.job.id);
    if (!job) return;
    let absolute: string;
    try { absolute = realpathSync(resolve(job.cwd ?? homedir(), path)); }
    catch { return; }
    const skill = usableAssistantSkills(this.runtime.home, job.assistantId).find((item) => existsSync(item.path) && realpathSync(item.path) === absolute);
    if (!skill || job.skillsUsed?.includes(skill.name)) return;
    recordAssistantSkillUse(this.runtime.home, job.assistantId, skill.name);
    const next = { ...job, skillsUsed: [...(job.skillsUsed ?? []), skill.name] };
    this.store.saveJob(next);
    worker.job = next;
    this.bus.emit({ type: "job", job: next });
    this.bus.emit({ type: "skills", assistantId: job.assistantId });
  }

  private recordActivity(worker: WorkerState, toolName: string, args: Record<string, unknown>): void {
    worker.lastActivityAt = Date.now();
    const line = activityFor(toolName, args);
    if (!line) return;
    const job = this.store.job(worker.job.id);
    if (!job) return;
    const stats = { ...job.stats };
    if (line.verb === "读") stats.reads += 1;
    else if (line.verb === "跑") stats.commands += 1;
    else if (line.verb === "改" || line.verb === "写") stats.edits += 1;
    const activity = [...job.activity, line].slice(-ACTIVITY_LIMIT);
    const next = { ...job, stats, activity };
    this.store.saveJob(next);
    worker.job = next;
    this.bus.emit({ type: "activity", jobId: job.id, line, stats });
  }

  /** 推一步给前端；同一个 id 到了就是替换。 */
  private emitStep(worker: WorkerState, step: JobStep): void {
    this.bus.emit({ type: "job_step", jobId: worker.job.id, step });
  }

  /** 工具结果装进步骤：事件里只给 4KB，全文落盘给路径（详情页要全文时拉 transcript）。 */
  private withStepOutput(
    worker: WorkerState,
    step: JobStep,
    full: string,
    extra: { isError?: boolean; durationMs?: number } = {},
  ): JobStep {
    const jobId = worker.job.id;
    return withOutput(step, full, {
      limit: STEP_EVENT_LIMIT,
      ...extra,
      save: (stepId, text) => this.store.writeStepOutput(jobId, stepId, text),
    });
  }

  /** 助手消息里的说明文字和思考摘要也进时间线（工具步骤已由执行事件推过了）。 */
  private recordSteps(worker: WorkerState, message: { timestamp?: number; content?: unknown }): void {
    const blocks: any[] = Array.isArray(message.content) ? (message.content as any[]) : [];
    const stamp = message.timestamp ?? Date.now();
    const at = new Date(stamp).toISOString();
    blocks.forEach((block, index) => {
      if (block?.type === "text") {
        const text = String(block.text ?? "").trim();
        if (text) this.emitStep(worker, { id: `t${stamp}-${index}`, kind: "text", at, from: "assistant", text });
        return;
      }
      if (block?.type === "thinking") {
        const text = String(block.thinking ?? "").trim();
        if (text && !block.redacted) this.emitStep(worker, { id: `k${stamp}-${index}`, kind: "thinking", at, text });
      }
    });
  }

  /** token 和花费累加到任务上，详情顶部实时看得到。 */
  private addUsage(worker: WorkerState, message: { usage?: { input: number; output: number; cost: { total: number } } }): void {
    const usage = message.usage;
    if (!usage) return;
    const job = this.store.job(worker.job.id);
    if (!job) return;
    const before = job.usage ?? { input: 0, output: 0, cost: 0 };
    const next: Job = {
      ...job,
      usage: {
        input: before.input + usage.input,
        output: before.output + usage.output,
        cost: Number((before.cost + usage.cost.total).toFixed(6)),
      },
    };
    this.store.saveJob(next);
    worker.job = next;
    this.bus.emit({ type: "job", job: next });
  }

  private async onSettled(worker: WorkerState): Promise<void> {
    if (worker.stopped) return;
    const job = this.store.job(worker.job.id);
    if (!job || job.status === "done" || job.status === "stuck" || job.status === "failed" || job.status === "stopped") return;
    if (worker.reported) {
      await this.applyReport(worker.job.id);
      return;
    }
    if (worker.askedFollowUp) {
      await this.finish(worker.job.id, "stuck", undefined, "未提交结果");
      return;
    }
    worker.askedFollowUp = true;
    const session = worker.session;
    if (!session) {
      await this.finish(worker.job.id, "stuck", undefined, "未提交结果");
      return;
    }
    await session.prompt("你还没有调用 report 提交结果。请现在调用 report(outcome, result)。");
  }

  /** report 工具收到结果后由 worker-tools 调用。 */
  async applyReport(workerId: string): Promise<void> {
    const worker = this.workers.get(workerId);
    if (!worker?.reported || worker.stopped) return;
    const status: JobStatus = worker.reported.outcome === "done" ? "done" : "stuck";
    // 不写原因：outcome 只说明模型自己认为没做完，状态词（受阻、待确认）卡片上已经写过一遍，
    // 当原因存下来就会重复。真正的原因由看门狗和停止操作给。
    await this.finish(workerId, status, worker.reported.result, undefined, worker.reported.files);
  }

  reportFromTool(jobId: string, data: { outcome: "done" | "stuck" | "need_approval"; result: string; files?: string[] }): void {
    const worker = this.workers.get(jobId);
    if (!worker) return;
    worker.reported = data;
    worker.finishTimer ??= setTimeout(() => void this.applyReport(jobId), 200);
  }

  private async finish(
    jobId: string,
    status: JobStatus,
    summary?: string,
    reason?: string,
    files?: string[],
  ): Promise<void> {
    const pending = this.finishing.get(jobId);
    if (pending) return pending;
    const task = this.finishOnce(jobId, status, summary, reason, files);
    this.finishing.set(jobId, task);
    try { await task; } finally { this.finishing.delete(jobId); }
    const job = this.store.job(jobId);
    const steps = status === "done" && job?.status === "done" ? this.transcript(jobId) : [];
    // 自动沉淀：用户中途接着说过话；或者没照着技能做、而且是定时执行或动手 20 次以上。
    // 照着技能顺利做完的不再沉淀，免得每天跑完都改一版。
    const followed = this.replied.has(jobId) || steps.some((step) => step.from === "user" && step.text !== "沉淀技能");
    const fresh = !job?.skillsUsed?.length && (Boolean(job?.routineId) || steps.filter((step) => step.kind === "tool").length >= 20);
    if (job?.status === "done" && status === "done" && (followed || fresh)) this.startSediment(jobId);
  }

  private async finishOnce(jobId: string, status: JobStatus, summary?: string, reason?: string, files?: string[]): Promise<void> {
    const job = this.store.job(jobId);
    if (!job || ENDED.includes(job.status)) return;
    const worker = this.workers.get(jobId);
    if (worker) worker.stopped = true;
    if (worker?.finishTimer) clearTimeout(worker.finishTimer);
    this.followUps.delete(jobId);
    await worker?.desktop?.dispose();
    await this.settle(job, status, { summary, reason, files, lastText: worker?.lastText });

    if (worker?.session) {
      worker.session.dispose();
    }
    this.workers.delete(jobId);
    this.pump();
  }

  /** 写 report.md、工作日志、推事件。 */
  private async settle(
    job: Job,
    status: JobStatus,
    options: { summary?: string; reason?: string; files?: string[]; lastText?: string },
  ): Promise<void> {
    const endedAt = new Date().toISOString();
    // 报告原样保留（不压成一行、不截断）：任务详情和 report.md 要完整的；只有推给助手的事件太长时才截
    const cleanSummary = options.summary?.trim() ? options.summary : undefined;
    const statusText = status === "done" ? "已完成" : status === "stuck" ? "受阻" : status === "stopped" ? "已停止" : "失败";
    const reportPath = this.store.writeReport(
      job.id,
      [
        `# ${job.title}`,
        "",
        `状态：${statusText}${options.reason ? `（${options.reason}）` : ""}`,
        `结束时间：${monthDayTimeText(this.runtime.settings.settings.general.timezone)}`,
        "",
        "## 结果",
        "",
        cleanSummary ?? options.lastText ?? "（没有回复）",
        "",
        "## 任务说明",
        "",
        job.instruction,
      ].join("\n"),
    );
    const next: Job = {
      ...job,
      status,
      endedAt,
      reportPath,
      ...(job.startedAt ? { durationMs: Date.parse(endedAt) - Date.parse(job.startedAt) } : {}),
      ...(options.summary !== undefined ? { summary: cleanSummary } : {}),
      ...(options.reason ? { statusReason: options.reason } : {}),
      ...(options.summary !== undefined ? { files: options.files ?? [] } : {}),
    };
    this.store.saveJob(next);
    for (const path of options.files ?? []) void this.runtime.knowledge.collect({ origin: "output", path, description: job.title, assistantId: job.assistantId, jobId: job.id }).catch((error) => console.error("知识库收集失败：", error));
    // 转交里的任务：先把转交重新打开，结果由目标助手接着处理完才回流 Hob（见 DelegationManager.resume）
    const delegationId = !job.routineId && job.delegationId && this.runtime.delegations.resume(job.delegationId) ? job.delegationId : undefined;
    this.bus.emit({ type: "job", job: next });
    pushJobEnd({ push: this.runtime.push, store: this.store }, next);
    this.publishBusy(job.assistantId);
    const assistant = this.store.assistant(job.assistantId);
    this.store.addWorklog(job.assistantId, {
      at: endedAt,
      text: `任务${statusText}：${job.title}`,
      jobId: job.id,
    });
    this.bus.emit({ type: "profile", assistantId: job.assistantId });
    const { note: filesNote, posted } = await this.postFiles(next);
    // 图片已经开了这一组，回复接在图片后面
    const cont = posted ? ({ cont: true } as const) : undefined;

    if (job.routineId) {
      const routine = this.store.routine(job.routineId);
      if (routine) {
        const run: RoutineRun = {
          jobId: job.id, at: endedAt, status,
          ...(next.durationMs !== undefined ? { durationMs: next.durationMs } : {}),
          tools: next.stats.reads + next.stats.commands + next.stats.edits,
          ...(next.usage ? { tokens: next.usage.input + next.usage.output } : {}),
        };
        const runs = [run, ...routine.runs.filter((item) => item.jobId !== job.id)].slice(0, 20);
        const updated = { ...routine, runs };
        this.store.saveRoutine(updated);
        this.bus.emit({ type: "routine", routine: updated });
        await this.runtime.router
          .event(job.assistantId, `${jobResultEvent(next, `定时任务「${routine.name}」`)}${filesNote}`, {
            routine: { id: routine.id, name: routine.name, jobId: job.id },
            ...cont,
          })
          .catch(() => undefined);
      }
    } else if (assistant) {
      const text = `${jobResultEvent(next)}${filesNote}`;
      if (delegationId) void this.runtime.router.relay(job.assistantId, text, delegationId, cont).catch(() => this.runtime.delegations.turnEnded(delegationId, "目标助手处理失败", true));
      else await this.runtime.router.event(job.assistantId, text, cont).catch(() => undefined);
    }
  }

  /**
   * 任务产出的图片先直接发到对话里（前端渲染成缩略图），再告诉助手发了什么、还有哪些别的文件，
   * 免得它再派一个任务去"取回"图片。
   */
  private async postFiles(job: Job): Promise<{ note: string; posted: number }> {
    const posted: string[] = [];
    const others: string[] = [];
    for (const path of job.files ?? []) {
      if (isImagePath(path) && existsSync(path)) {
        // 第一张开新的一组：任务结果不跟在派任务那轮回复后面
        await this.runtime.router.addItem(job.assistantId, {
          kind: "file",
          path,
          name: basename(path),
          ...(posted.length ? {} : { lead: true as const }),
        });
        posted.push(basename(path));
      } else {
        others.push(path);
      }
    }
    const lines: string[] = [];
    if (posted.length) lines.push(`图片已发到对话里：${posted.join("、")}`);
    if (others.length) lines.push(`文件：${others.join("、")}`);
    return { note: lines.length ? `\n${lines.join("\n")}` : "", posted: posted.length };
  }

  async reply(jobId: string, text: string, source: "user" | "router" = "user"): Promise<void> {
    await this.finishing.get(jobId);
    const sediment = this.sediments.get(jobId);
    if (sediment) {
      sediment.cancelled = true;
      await sediment.session?.abort().catch(() => undefined);
      await sediment.task;
    }
    this.replied.add(jobId);
    const job = this.store.job(jobId);
    if (!job) throw new Error("没有这个任务。");
    if (ENDED.includes(job.status)) {
      const { endedAt, statusReason, durationMs, summary, files, reportPath, ...rest } = job;
      const previous = job.rounds ?? [];
      // 这一轮的报告另存一份：下一轮写报告会覆盖原文件。原文件不在了就不存，不让续做因此失败
      const savedReport = reportPath && existsSync(reportPath) ? join(dirname(reportPath), `report.round-${previous.length + 1}.md`) : undefined;
      if (reportPath && savedReport) copyFileSync(reportPath, savedReport);
      const used = previous.reduce((sum, round) => ({ input: sum.input + (round.usage?.input ?? 0), output: sum.output + (round.usage?.output ?? 0), cost: sum.cost + (round.usage?.cost ?? 0) }), { input: 0, output: 0, cost: 0 });
      const usage = job.usage && previous.every((round) => round.usage) ? { input: job.usage.input - used.input, output: job.usage.output - used.output, cost: Number((job.usage.cost - used.cost).toFixed(6)) } : undefined;
      const ended: JobRound = { status: job.status, statusReason, startedAt: job.startedAt, endedAt, durationMs, summary, files, usage, reportPath: savedReport, followUp: text };
      const rounds = [...previous, ended];
      const queued: Job = { ...rest, rounds, status: "queued", startedAt: new Date().toISOString() };
      this.store.saveJob(queued);
      try {
        await this.runtime.router.addItem(job.assistantId, { kind: "job", jobId, round: rounds.length });
      } catch (error) {
        this.store.saveJob(job);
        throw error;
      }
      this.followUps.set(jobId, `用户接着说（${monthDayTimeText(this.runtime.settings.settings.general.timezone)}）：${text}`);
      this.bus.emit({ type: "job", job: queued });
      this.publishBusy(job.assistantId);
      this.queue.push(jobId);
      this.pump();
      return;
    }
    const worker = this.workers.get(jobId);
    if (!worker?.session) throw new Error("这个任务当前未在运行。");
    // 任务卡在 ask_user 等答复：用户在对话里回的话就是答复，不然插话要等提问返回才读得到，任务永远等下去
    const asking = worker.ask ? this.store.approvals().find((item) => item.jobId === jobId && item.status === "pending") : undefined;
    if (asking) {
      const answered: Approval = source === "user"
        ? { ...asking, status: "answered", answerText: text, answeredAt: new Date().toISOString() }
        : { ...asking, status: "expired" };
      this.store.saveApproval(answered);
      this.bus.emit({ type: "approval", approval: answered });
      this.resolveAsk(answered, source === "user" ? `用户没有选给出的选项，而是在对话里回复：${text}` : `助手转达：${text}`);
      return;
    }
    // 先显示出来：任务在跑命令时要等这一步做完才读到，界面上标着「等待读取」
    const step: JobStep = { id: `q${Date.now()}-${worker.queued.length}`, kind: "text", at: new Date().toISOString(), from: "user", text, queued: true };
    worker.queued.push(step);
    this.emitStep(worker, step);
    try {
      if (worker.session.isStreaming) await worker.session.steer(text);
      else void worker.session.prompt(text).catch(() => { worker.queued = worker.queued.filter((item) => item !== step); });
    } catch (error) {
      worker.queued = worker.queued.filter((item) => item !== step);
      throw error;
    }
  }

  startSediment(jobId: string, source: "manual" | "auto" = "auto"): void {
    const job = this.store.job(jobId);
    if (!job) throw new Error("任务不存在");
    if (job.status !== "done" || this.finishing.has(jobId) || this.workers.has(jobId)) throw new Error("只有已完成的任务可以沉淀");
    if (this.sediments.has(jobId)) throw new Error("任务正在沉淀技能");
    const state: { cancelled: boolean; session?: AgentSession; task?: Promise<void> } = { cancelled: false };
    this.sediments.set(jobId, state);
    state.task = this.sedimentRound(job, state, source).catch(async (error) => {
      if (state.cancelled) return;
      const message = error instanceof Error ? error.message : String(error);
      console.error("沉淀技能失败：", error);
      await this.runtime.router.addItem(job.assistantId, { kind: "note", icon: "info", text: `技能沉淀失败：${message}` }).catch((noteError) => console.error("写入沉淀失败提示失败：", noteError));
    }).finally(() => {
      this.sediments.delete(jobId);
      this.bus.emit({ type: "sediment-finished", jobId });
    });
  }

  private async sedimentRound(job: Job, state: { cancelled: boolean; session?: AgentSession }, source: "manual" | "auto"): Promise<void> {
    let calledSave = false;
    let lastText = "";
    const skillTool = {
      name: "save_skill", label: "保存技能",
      description: "保存或修补这个助手的技能。name 只用小写字母、数字和连字符，和已有技能同名就是修补，旧版会保留。content 是 SKILL.md 的正文，不用写开头的 name 和 description。files 放脚本和参考资料，路径以 scripts/ 或 references/ 开头。",
      parameters: Type.Object({
        name: Type.String({ description: "技能的目录名，如 gateway-daily-check。" }),
        title: Type.String({ description: "中文名，如「网关每日巡检」。" }),
        description: Type.String({ description: "一句话写什么时候用，120 字以内。" }),
        content: Type.String({ description: "SKILL.md 正文。" }),
        files: Type.Optional(Type.Array(Type.Object({ path: Type.String(), content: Type.Optional(Type.String()), from: Type.Optional(Type.String()) }), { description: "可选，脚本和参考资料：path 加 content，或 path 加 from（工作目录里已有文件的路径，直接复制）。" })),
      }),
      execute: async (_id: string, params: any) => {
        calledSave = true;
        if (state.cancelled || this.store.job(job.id)?.status !== "done") throw new Error("任务已继续，取消沉淀");
        const files = readSkillFiles(job.cwd ?? this.store.workDir(job.id), params.files);
        const skill = saveAssistantSkill(this.runtime.home, job.assistantId, { ...params, files }, job.id);
        let text = skill.version === 1 ? `已沉淀技能「${skill.title}」` : `已更新技能「${skill.title}」· 第 ${skill.version} 版`;
        const routine = job.routineId && this.store.routine(job.routineId);
        if (routine && !routine.skill) {
          this.runtime.routines.update(routine.id, { skill: skill.name });
          text = `已沉淀技能「${skill.title}」，以后定时执行按它做`;
        }
        await this.runtime.router.addItem(job.assistantId, { kind: "note", icon: "skill", text, path: skill.path });
        this.bus.emit({ type: "skills", assistantId: job.assistantId });
        return { content: [{ type: "text" as const, text: "技能已保存。" }], details: undefined };
      },
    };
    const skills = listAssistantSkills(this.runtime.home, job.assistantId);
    const existing = skills.map((skill) => `${skill.name}：${skill.title} —— ${skill.description}`).join("\n") || "无";
    const message = `${SEDIMENT_PROMPT_HEAD}，下次照着做，更快、更稳。

技能写的是这一类事怎么做，不是这一次的经过。下次接到同类的事，照着它就能一次做成用户要的样子。
- 按做事的顺序写步骤，带上要用的命令、查询和判断点；怎么判断结果对不对，写在对应的那一步里。
- 用户在过程中纠正过的做法、对结果提过的要求，写进去。
- 坑写成一条规则加一句原因，放在它影响的那一步。规则要离开这一次也成立：不写事情经过和这一次的数据；会变的情况不写死，写怎么查。
- 同一条经验只写一次。修补时直接改掉写错的那句，不在后面追加更正。
- 助手的规矩、工具说明里已经有的，不再重复。
- 能写成脚本的写成只读脚本，放在 scripts/，一次输出要看的全部结果。写好后用 bash 真跑一遍，输出对得上再保存。偶尔才用得上的细节放 references/，按主题起文件名。
- 会改东西的步骤只写进文档，不写进脚本，也不要执行。

不写进技能：
- 临时故障和网络错误。环境没装好、没配好导致的失败，只写怎么装好、配好。
- 「某个工具不能用」这类结论：环境修好以后，它还会一直挡着你。
- 这次没走通的尝试：不能写成推荐做法。

下面已有同类技能的，修补它，不要另建；新建时，名字和说明按这一类事来起，不按这一次。没有值得沉淀的，就回复「没有需要沉淀的」，不调用 save_skill。

这个助手已有的技能：${existing}`;
    if (state.cancelled) return;
    const opened = await this.runtime.pi.open({
      file: this.store.workerFile(job.id), cwd: job.cwd ?? homedir(),
      model: job.model ?? this.runtime.settings.settings.models.work.ref,
      thinking: job.thinking ?? this.runtime.settings.settings.models.work.thinking,
      memory: "off", systemPrompt: () => buildWorkerPrompt(this.store, job.id, this.promptSettings()),
      tools: ["read", "ls", "grep", "find", "bash", "save_skill"], customTools: [skillTool],
    });
    state.session = opened.session;
    opened.session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") lastText = textOfContent(event.message.content).trim();
    });
    try {
      if (!state.cancelled) await opened.session.prompt(message);
      if (!state.cancelled && source === "manual" && !calledSave) {
        const reason = lastText && lastText !== "没有需要沉淀的" ? `：${lastText}` : "";
        await this.runtime.router.addItem(job.assistantId, { kind: "note", icon: "skill", text: `「${job.title}」没有可沉淀的做法${reason}` });
      }
    } finally { opened.session.dispose(); }
  }

  async stop(jobId: string): Promise<void> {
    const job = this.store.job(jobId);
    if (!job) throw new Error("没有这个任务。");
    const worker = this.workers.get(jobId);
    if (worker) {
      // 先标记再 abort：终止命令的过程中模型可能接着把 report 跑完，那不能把 stopped 改成完成
      worker.stopped = true;
      worker.ask?.("（任务被停了）");
      worker.ask = undefined;
      // abort 会把正在执行的工具（bash 子进程）一起终止
      await worker.session?.abort().catch(() => undefined);
    }
    await this.finish(jobId, "stopped", undefined, "你叫停了");
  }

  /** Worker 的 ask_user：出审批卡、把任务标成待确认，阻塞到用户答复。 */
  async askQuestion(
    jobId: string,
    input: { title: string; detail?: string; options: ApprovalOption[]; ruleText?: string },
  ): Promise<string> {
    const job = this.store.job(jobId);
    if (!job) throw new Error(`任务不存在：${jobId}`);
    const worker = this.workers.get(jobId);
    const approval: Approval = {
      id: newId("q-"),
      assistantId: job.assistantId,
      title: input.title,
      ...(input.detail ? { detail: input.detail } : {}),
      options: input.options,
      status: "pending",
      source: "job",
      jobId,
      ...(input.ruleText ? { ruleText: input.ruleText } : {}),
      createdAt: new Date().toISOString(),
    };
    this.store.saveApproval(approval);
    // 任务半路来问，是单独的一组，不贴着上一轮回复
    await this.runtime.router.addItem(job.assistantId, { kind: "question", approvalId: approval.id, lead: true });
    this.bus.emit({ type: "approval", approval });
    pushApproval({ push: this.runtime.push, store: this.store }, approval);
    const waiting: Job = { ...job, status: "waiting" };
    this.store.saveJob(waiting);
    this.bus.emit({ type: "job", job: waiting });
    if (worker) worker.job = waiting;
    return await new Promise<string>((resolve) => {
      if (worker) worker.ask = resolve;
      else resolve("（任务未在运行）");
    });
  }

  /** Worker 的 ask_user 等答案时，审批被答复（answer 是回给模型的那句）。 */
  resolveAsk(approval: Approval, answer: string): void {
    const worker = approval.jobId ? this.workers.get(approval.jobId) : undefined;
    const job = approval.jobId ? this.store.job(approval.jobId) : undefined;
    if (job && job.status === "waiting") {
      const next: Job = { ...job, status: "running" };
      this.store.saveJob(next);
      this.bus.emit({ type: "job", job: next });
      if (worker) worker.job = next;
    }
    worker?.ask?.(answer);
    if (worker) {
      worker.ask = undefined;
      worker.lastActivityAt = Date.now();
    }
  }

  startWatchdog(): void {
    this.watchdog ??= setInterval(() => {
      this.checkStalls();
      // 并发小了以后（设置里改的），排队的任务还在等，这里补一次泵
      this.pump();
    }, 30_000);
    this.watchdog.unref?.();
  }

  checkStalls(now = Date.now()): void {
    const idleMs = this.runtime.settings.settings.work.jobStallMinutes * 60_000;
    for (const [jobId, worker] of this.workers) {
      // 在等用户答提问不算没响应：等多久都是用户的事
      if (!worker.ask && now - worker.lastActivityAt > idleMs) {
        void this.finish(jobId, "stuck", undefined, `${Math.round(idleMs / 60_000)} 分钟无响应`);
      }
    }
  }

  stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  /** 进程重启：没跑完的任务标失败。 */
  recover(): void {
    const now = new Date().toISOString();
    for (const job of this.store.jobs()) {
      if (job.status === "running" || job.status === "queued" || job.status === "waiting") {
        const next: Job = { ...job, status: "failed", endedAt: now, statusReason: "Hob 重启，任务中断" };
        this.store.saveJob(next);
        this.bus.emit({ type: "job", job: next });
      }
    }
    for (const approval of this.store.approvals()) {
      if (approval.status === "pending" && approval.source === "job") {
        this.store.saveApproval({ ...approval, status: "expired" });
      }
    }
    this.queue = [];
    this.followUps.clear();
  }

  disposeAll(): void {
    this.stopWatchdog();
    for (const state of this.sediments.values()) { state.cancelled = true; void state.session?.abort(); }
    for (const worker of this.workers.values()) { worker.session?.dispose(); void worker.desktop?.dispose(); }
    this.workers.clear();
  }

  /** 测试用：等所有任务结束。 */
  async waitIdle(timeoutMs = 15_000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const active = this.store
        .jobs()
        .filter((job) => job.status === "running" || job.status === "queued" || job.status === "waiting");
      if (!active.length && !this.finishing.size && !this.sediments.size) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
