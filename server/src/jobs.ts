import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { commandSummary } from "../../shared/command.ts";
import type {
  ActivityLine,
  Approval,
  ApprovalOption,
  Job,
  JobsPage,
  JobStatus,
  JobStep,
  RoutineRun,
} from "../../shared/types.ts";
import { IMAGE_TYPES, isImagePath } from "../../shared/media.ts";
import { newId } from "./ids.ts";
import { imageConfigured } from "./image.ts";
import { jobModel } from "./models.ts";
import { overviewTool } from "./overview.ts";
import { pageTool } from "./pages.ts";
import { pushApproval, pushJobEnd } from "./push.ts";
import { buildWorkerPrompt, type Abilities, type PromptSettings } from "./prompt.ts";
import { availableSkills } from "./skills.ts";
import type { HobRuntime } from "./runtime.ts";
import { showPath } from "./text.ts";
import { monthDayTimeText } from "./time.ts";
import { STEP_EVENT_LIMIT, deriveSteps, textOfContent, toolStep, withOutput } from "./transcript.ts";
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

/** 附件里的图片读成 pi 的图片块（读不出来就跳过，不把整个任务拖死）。 */
function imageContents(files: string[] | undefined): ImageContent[] {
  const out: ImageContent[] = [];
  for (const file of files ?? []) {
    const mimeType = IMAGE_TYPES[extname(file).toLowerCase()];
    if (!mimeType) continue;
    try {
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
  reported?: { outcome: "done" | "stuck" | "need_approval"; summary: string; files?: string[] };
  lastText?: string;
  askedFollowUp: boolean;
  lastActivityAt: number;
  finishTimer?: NodeJS.Timeout;
  ask?: (label: string) => void;
  /** 用户叫停了：收尾期间这个 worker 的 report/追问都不再算数 */
  stopped?: boolean;
  /** 正在跑的工具步骤，按 toolCallId 存：输出更新、跑完都按同一个步骤 id 替换 */
  steps: Map<string, JobStep>;
}

/** 推给助手的任务结果最多带这么多字的报告。 */
const EVENT_SUMMARY_MAX = 6000;

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
    return deriveSteps(this.store.workerFile(jobId), {
      cwd: job.cwd ?? "",
      save: (stepId, text) => this.store.writeStepOutput(jobId, stepId, text),
    });
  }

  async start(assistantId: string, input: StartJobInput): Promise<Job> {
    const assistant = this.store.assistant(assistantId);
    if (!assistant) throw new Error(`助手不存在：${assistantId}`);
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
    // 定时跑的任务不出卡片：结果以带「⏱ 名字」的回复回到对话，过程在右栏和运行记录里看
    if (!input.routineId) await this.runtime.router.addItem(assistantId, { kind: "job", jobId: job.id });
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
      void this.launch(job).catch((error) => this.failLaunch(job, error));
    }
  }

  private async failLaunch(job: Job, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.finish(job.id, "failed", undefined, message);
  }

  private async launch(job: Job): Promise<void> {
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
    const customTools = [registerReportTool(this.runtime, running.id), registerAskTool(this.runtime, running.id)];
    if (abilities.image) customTools.push(registerImageTool(this.runtime, running.id));
    if (this.runtime.settings.settings.general.showPage !== false) customTools.push(pageTool(this.runtime, running.assistantId, false));
    customTools.push(...searchTools(this.runtime.home, () => this.runtime.settings.settings.search));
    // 定时跑的就是 Worker：主助手的任务要看得到各助这段时间的动静才能写早报
    if (assistant?.primary) customTools.push(overviewTool(this.runtime));
    const opened = await this.runtime.pi.open({
      file: this.store.workerFile(running.id),
      cwd: running.cwd ?? homedir(),
      model: running.model ?? this.runtime.settings.settings.models.work.ref,
      thinking: running.thinking ?? this.runtime.settings.settings.models.work.thinking,
      memory: this.runtime.settings.memory().provider,
      skills: availableSkills(this.runtime.home, undefined, this.runtime.settings.settings.skills?.disabled),
      disabledSkills: this.runtime.settings.settings.skills?.disabled,
      systemPrompt: () =>
        buildWorkerPrompt(this.store, running.id, { ...this.promptSettings(), abilities }),
      tools: [
        ...workerTools(abilities),
        ...customTools.map((tool) => tool.name),
      ],
      customTools,
    });

    const worker: WorkerState = {
      job: running,
      session: opened.session,
      manager: opened.manager,
      askedFollowUp: false,
      lastActivityAt: Date.now(),
      steps: new Map(),
    };
    this.workers.set(running.id, worker);
    const images = imageContents(running.inputs);

    opened.session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        this.recordActivity(worker, event.toolName, event.args ?? {});
        const step = toolStep({
          id: event.toolCallId,
          name: event.toolName,
          args: event.args ?? {},
          at: new Date().toISOString(),
          cwd: worker.job.cwd ?? "",
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
        const step =
          worker.steps.get(event.toolCallId) ??
          toolStep({ id: event.toolCallId, name: event.toolName, args: {}, cwd: worker.job.cwd ?? "" });
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
        return;
      }
      if (event.type === "agent_settled") void this.onSettled(worker);
    });

    void opened.session
      .prompt(running.instruction, images.length ? { images } : undefined)
      .catch(async (error: unknown) => {
        await this.finish(running.id, "failed", undefined, error instanceof Error ? error.message : String(error));
      });
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
    await session.prompt("你还没有调用 report 提交结果。请现在调用 report(outcome, summary)。");
  }

  /** report 工具收到结果后由 worker-tools 调用。 */
  async applyReport(workerId: string): Promise<void> {
    const worker = this.workers.get(workerId);
    if (!worker?.reported || worker.stopped) return;
    const status: JobStatus = worker.reported.outcome === "done" ? "done" : "stuck";
    // 不写原因：outcome 只说明模型自己认为没做完，状态词（受阻、待确认）卡片上已经写过一遍，
    // 当原因存下来就会重复。真正的原因由看门狗和停止操作给。
    await this.finish(workerId, status, worker.reported.summary, undefined, worker.reported.files);
  }

  reportFromTool(jobId: string, data: { outcome: "done" | "stuck" | "need_approval"; summary: string; files?: string[] }): void {
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
    const job = this.store.job(jobId);
    if (!job || ENDED.includes(job.status)) return;
    const worker = this.workers.get(jobId);
    if (worker?.finishTimer) clearTimeout(worker.finishTimer);
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
    const cleanSummary = options.summary?.trim() || undefined;
    const eventSummary = cleanSummary && cleanSummary.length > EVENT_SUMMARY_MAX
      ? `${cleanSummary.slice(0, EVENT_SUMMARY_MAX)}…（报告过长已截断，完整内容在任务详情）`
      : cleanSummary;
    const statusText = status === "done" ? "已完成" : status === "stuck" ? "受阻" : status === "stopped" ? "已停止" : "失败";
    const reportPath = this.store.writeReport(
      job.id,
      [
        `# ${job.title}`,
        "",
        `状态：${statusText}${options.reason ? `（${options.reason}）` : ""}`,
        `结束时间：${monthDayTimeText(this.runtime.settings.settings.general.timezone)}`,
        "",
        "## 摘要",
        "",
        cleanSummary ?? "（没有摘要）",
        "",
        "## 任务最后一条回复",
        "",
        options.lastText ?? "（没有回复）",
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
      ...(cleanSummary ? { summary: cleanSummary } : {}),
      ...(options.reason ? { statusReason: options.reason } : {}),
      ...(options.files?.length ? { files: options.files } : {}),
    };
    this.store.saveJob(next);
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
        const run: RoutineRun = { jobId: job.id, at: endedAt, status };
        const runs = [run, ...routine.runs.filter((item) => item.jobId !== job.id)].slice(0, 20);
        const updated = { ...routine, runs };
        this.store.saveRoutine(updated);
        this.bus.emit({ type: "routine", routine: updated });
        await this.runtime.router
          .event(job.assistantId, `定时任务「${routine.name}」结果：${eventSummary ?? options.reason ?? statusText}${filesNote}`, {
            routine: { id: routine.id, name: routine.name },
            ...cont,
          })
          .catch(() => undefined);
      }
    } else if (assistant) {
      await this.runtime.router
        .event(
          job.assistantId,
          `任务「${job.title}」${statusText}${eventSummary ? `：${eventSummary}` : options.reason ? `：${options.reason}` : ""}${filesNote}`,
          cont,
        )
        .catch(() => undefined);
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
    if (posted.length) lines.push(`产出的图片已经直接发到对话里了（${posted.join("、")}），用户看得到，不要再发或再派任务去取。`);
    if (others.length) lines.push(`产出文件：${others.join("、")}（要给用户就用 send_file）。`);
    return { note: lines.length ? `\n${lines.join("\n")}` : "", posted: posted.length };
  }

  async reply(jobId: string, text: string): Promise<void> {
    const worker = this.workers.get(jobId);
    if (!worker?.session) throw new Error("这个任务当前未在运行。");
    if (worker.session.isStreaming) await worker.session.steer(text);
    else await worker.session.prompt(text);
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
    if (worker) worker.ask = undefined;
  }

  startWatchdog(): void {
    this.watchdog ??= setInterval(() => {
      const idleMs = this.runtime.settings.settings.work.jobStallMinutes * 60_000;
      for (const [jobId, worker] of this.workers) {
        if (Date.now() - worker.lastActivityAt > idleMs) {
          void this.finish(jobId, "stuck", undefined, `${Math.round(idleMs / 60_000)} 分钟无响应`);
        }
      }
      // 并发小了以后（设置里改的），排队的任务还在等，这里补一次泵
      this.pump();
    }, 30_000);
    this.watchdog.unref?.();
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
  }

  disposeAll(): void {
    this.stopWatchdog();
    for (const worker of this.workers.values()) worker.session?.dispose();
    this.workers.clear();
  }

  /** 测试用：等所有任务结束。 */
  async waitIdle(timeoutMs = 15_000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const active = this.store
        .jobs()
        .filter((job) => job.status === "running" || job.status === "queued" || job.status === "waiting");
      if (!active.length) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
