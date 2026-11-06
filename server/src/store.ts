import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { newId } from "./ids.ts";
import type {
  Approval,
  Assistant,
  Delegation,
  Draft,
  Job,
  Routine,
  Rule,
  WorklogEntry,
} from "../../shared/types.ts";

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // 半行（进程被杀）直接跳过，不污染整份日志
    }
  }
  return out;
}

/** 助手的本地状态（不属于前后端契约，只存未读位置）。 */
export interface AssistantState {
  readAt?: string;
}

/**
 * HOB_HOME 下的全部 JSON / JSONL 数据。文件都小，直接同步读写，写入走临时文件 + rename。
 */
export class Store {
  constructor(readonly home: string) {}

  init(): void {
    for (const dir of ["assistants", "jobs", "uploads"]) {
      mkdirSync(join(this.home, dir), { recursive: true });
    }
    if (!existsSync(join(this.home, "rules.json"))) {
      const changedAt = new Date().toISOString();
      this.saveGlobalRules([
        ...["删除或覆盖文件、数据和备份", "对外发送（消息、邮件、发布）、付费、充值、改计费", "停止或重启别人正在使用的服务和设备", "修改可能让你失去远程访问的设置（网络、防火墙、登录方式）"].map((text) => ({ id: newId("r-"), text, mode: "ask" as const, changedAt })),
        ...["过去的记录是线索不是现状：动手前先核实实际状态。", "改配置、改数据前先留好退路（备份或记下原值）；改完用实际效果验证，不只看命令返回。", "凭据（密码、密钥、令牌、Cookie）只在用的时候读取，不回显，不写进文件和报告，也不存起来。"].map((text) => ({ id: newId("r-"), text, mode: "allow" as const, changedAt })),
      ]);
    }
  }

  globalRules(): Rule[] {
    const path = join(this.home, "rules.json");
    if (!existsSync(path)) return [];
    const rules = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(rules)) throw new Error("全局规则文件格式无效");
    return rules as Rule[];
  }

  saveGlobalRules(rules: Rule[]): void {
    writeJsonAtomic(join(this.home, "rules.json"), rules);
  }

  // ---------- 助手 ----------
  private assistantDir(id: string): string {
    return join(this.home, "assistants", id);
  }

  assistants(): Assistant[] {
    const root = join(this.home, "assistants");
    if (!existsSync(root)) return [];
    const out: Assistant[] = [];
    for (const id of readdirSync(root)) {
      const profile = this.assistant(id);
      if (profile) out.push(profile);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  assistant(id: string): Assistant | undefined {
    const profile = readJson<Assistant | null>(join(this.assistantDir(id), "profile.json"), null);
    if (!profile) return undefined;
    // 旧档案没有这个字段
    return { ...profile, instructions: profile.instructions ?? "" };
  }

  saveAssistant(assistant: Assistant): void {
    writeJsonAtomic(join(this.assistantDir(assistant.id), "profile.json"), assistant);
  }

  deleteAssistant(id: string): void {
    rmSync(this.assistantDir(id), { recursive: true, force: true });
  }

  /**
   * 归档助手：整个助手目录移进 archive/assistants/<id>-<时间>/。同盘 rename，不复制也不删数据，
   * 归档里的 profile.json 就是它原来的档案；它的定时存成目录里的 routines.json。
   */
  archiveAssistant(id: string, name: string, routines: Routine[] = []): string {
    if (routines.length) writeJsonAtomic(join(this.assistantDir(id), "routines.json"), routines);
    const target = join(this.home, "archive", "assistants", name);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(this.assistantDir(id), target);
    return target;
  }

  state(id: string): AssistantState {
    return readJson<AssistantState>(join(this.assistantDir(id), "state.json"), {});
  }

  saveState(id: string, state: AssistantState): void {
    writeJsonAtomic(join(this.assistantDir(id), "state.json"), state);
  }

  routerFile(id: string): string {
    return join(this.assistantDir(id), "router.jsonl");
  }

  rules(id: string): Rule[] {
    return readJson<Rule[]>(join(this.assistantDir(id), "rules.json"), []);
  }

  saveRules(id: string, rules: Rule[]): void {
    writeJsonAtomic(join(this.assistantDir(id), "rules.json"), rules);
  }

  worklog(id: string, limit = 30): WorklogEntry[] {
    return readJsonl<WorklogEntry>(join(this.assistantDir(id), "worklog.jsonl")).slice(-limit).reverse();
  }

  addWorklog(id: string, entry: WorklogEntry): void {
    const dir = this.assistantDir(id);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "worklog.jsonl"), `${JSON.stringify(entry)}\n`);
  }

  // ---------- 定时 ----------
  private routinesFile(): string {
    return join(this.home, "routines.json");
  }

  routines(): Routine[] {
    return readJson<Routine[]>(this.routinesFile(), []);
  }

  routine(id: string): Routine | undefined {
    return this.routines().find((r) => r.id === id);
  }

  saveRoutine(routine: Routine): void {
    const all = this.routines().filter((r) => r.id !== routine.id);
    all.push(routine);
    writeJsonAtomic(this.routinesFile(), all);
  }

  deleteRoutine(id: string): void {
    writeJsonAtomic(this.routinesFile(), this.routines().filter((r) => r.id !== id));
  }

  // ---------- 审批 ----------
  private approvalsFile(): string {
    return join(this.home, "approvals.json");
  }

  approvals(): Approval[] {
    return readJson<Approval[]>(this.approvalsFile(), []);
  }

  approval(id: string): Approval | undefined {
    return this.approvals().find((a) => a.id === id);
  }

  saveApproval(approval: Approval): void {
    const all = this.approvals().filter((a) => a.id !== approval.id);
    all.push(approval);
    writeJsonAtomic(this.approvalsFile(), all);
  }

  // ---------- 委派 ----------
  delegations(): Delegation[] {
    return readJson<Delegation[]>(join(this.home, "delegations.json"), []);
  }

  delegation(id: string): Delegation | undefined {
    return this.delegations().find((item) => item.id === id);
  }

  saveDelegation(delegation: Delegation): void {
    const all = this.delegations().filter((item) => item.id !== delegation.id);
    all.push(delegation);
    writeJsonAtomic(join(this.home, "delegations.json"), all);
  }

  // ---------- 草稿 ----------
  private draftsFile(): string {
    return join(this.home, "drafts.json");
  }

  drafts(): Draft[] {
    return readJson<Draft[]>(this.draftsFile(), []);
  }

  draft(id: string): Draft | undefined {
    return this.drafts().find((d) => d.id === id);
  }

  saveDraft(draft: Draft): void {
    const all = this.drafts().filter((d) => d.id !== draft.id);
    all.push(draft);
    writeJsonAtomic(this.draftsFile(), all);
  }

  // ---------- 任务 ----------
  jobDir(id: string): string {
    return join(this.home, "jobs", id);
  }

  jobs(): Job[] {
    const root = join(this.home, "jobs");
    if (!existsSync(root)) return [];
    const out: Job[] = [];
    for (const id of readdirSync(root)) {
      const job = readJson<Job | null>(join(root, id, "job.json"), null);
      if (job) out.push(job);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  job(id: string): Job | undefined {
    return readJson<Job | null>(join(this.jobDir(id), "job.json"), null) ?? undefined;
  }

  saveJob(job: Job): void {
    writeJsonAtomic(join(this.jobDir(job.id), "job.json"), job);
  }

  writeReport(jobId: string, text: string): string {
    const path = join(this.jobDir(jobId), "report.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  }

  workerFile(jobId: string): string {
    return join(this.jobDir(jobId), "worker.jsonl");
  }

  /** 任务过程里超长输出的全文：落在任务目录下，页面按路径去拉。 */
  writeStepOutput(jobId: string, stepId: string, text: string): string {
    const safe = stepId.replace(/[^A-Za-z0-9._-]/g, "_");
    const path = join(this.jobDir(jobId), "steps", `${safe}.txt`);
    if (existsSync(path)) return path;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  }

  /** 本机任务的默认工作目录：产出文件只能落在这里。 */
  workDir(jobId: string): string {
    const path = join(this.jobDir(jobId), "work");
    mkdirSync(path, { recursive: true });
    return path;
  }

  /**
   * 一次性迁移：老的 assistants/<id>/memories.json 每条追加成该助手 instructions 的一行，
   * 然后删掉文件；草稿里的 memories 改名成 instructions。跑过一次就没有了，不是兼容层。
   */
  migrateMemories(): void {
    type OldDraft = Draft & { memories?: string[]; carry: Draft["carry"] & { memories?: number } };
    const drafts = readJson<OldDraft[]>(this.draftsFile(), []);
    if (drafts.some((draft) => !Array.isArray(draft.instructions))) {
      writeJsonAtomic(
        this.draftsFile(),
        drafts.map(({ memories, carry: { memories: _carried, ...carry }, ...draft }) => ({
          ...draft,
          instructions: draft.instructions ?? memories ?? [],
          carry,
        })),
      );
    }
    const root = join(this.home, "assistants");
    if (!existsSync(root)) return;
    for (const id of readdirSync(root)) {
      const file = join(root, id, "memories.json");
      if (!existsSync(file)) continue;
      const lines = readJson<{ text?: string }[]>(file, [])
        .map((memory) => (memory?.text ?? "").trim())
        .filter(Boolean);
      const assistant = this.assistant(id);
      if (assistant && lines.length) {
        const current = assistant.instructions.trim();
        this.saveAssistant({ ...assistant, instructions: [current, ...lines].filter(Boolean).join("\n") });
      }
      rmSync(file, { force: true });
    }
  }

  /** 从已创建的草稿补全旧助手的详细职责，不覆盖已有值。 */
  migrateAssistantDuties(): void {
    const drafts = this.drafts();
    for (const assistant of this.assistants()) {
      if (assistant.dutyLong !== undefined) continue;
      const draft = drafts.find((item) => item.status === "created" && item.createdAssistantId === assistant.id && item.dutyLong);
      if (draft) this.saveAssistant({ ...assistant, dutyLong: draft.dutyLong });
    }
  }

  // ---------- 首次启动 ----------
  ensurePrimary(): Assistant {
    const existing = this.assistant("hob");
    if (existing) return existing;
    const hob: Assistant = {
      id: "hob",
      name: "Hob",
      duty: "主助手",
      sprite: "hob",
      primary: true,
      pinned: true,
      hidden: false,
      notify: true,
      instructions: "",
      createdAt: new Date().toISOString(),
    };
    this.saveAssistant(hob);
    return hob;
  }
}
