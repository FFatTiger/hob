// 任务详情（桌面右侧宽抽屉 / 手机全屏）和任务记录（全部任务）。
import { useEffect, useRef, useState } from "react";
import type { Job, JobFileEntry, JobStatus, JobStep, ModelInfo } from "../../../shared/types.ts";
import { Icon, type IconName } from "../icons.tsx";
import { fileIcon } from "../file-icons.ts";
import { Avatar } from "../sprites.tsx";
import { useLeave } from "../motion.ts";
import { diffLines, groupThinking, jobReason, titleParts, type StepRow } from "../steps.ts";
import {
  backToJobs,
  closeDetail,
  loadJobFiles,
  loadModels,
  loadWorklog,
  moreWorklog,
  openFilePreview,
  openJob,
  replyJob,
  select,
  stopJob,
  useApp,
} from "../store.ts";
import { fmtBytes, fmtDuration, fmtElapsed, fmtTokens, fmtWhen } from "../util.ts";
import { Markdown } from "./Markdown.tsx";

const STATUS: Record<JobStatus, { text: string; icon: IconName; spin?: boolean; bad?: boolean }> = {
  queued: { text: "排队中", icon: "clock" },
  running: { text: "进行中", icon: "spin", spin: true },
  waiting: { text: "待确认", icon: "pause" },
  done: { text: "已完成", icon: "check" },
  stuck: { text: "受阻", icon: "close", bad: true },
  failed: { text: "失败", icon: "close", bad: true },
  stopped: { text: "已停止", icon: "stop" },
};

const THINKING: Record<string, string> = {
  off: "关",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
};

const FILTER_STATUS: JobStatus[] = ["running", "waiting", "queued", "done", "stuck", "failed", "stopped"];

/** 工具图标：每一步都有，时间线的文字才排得齐；不认识的工具用省略号。 */
const TOOL_ICON: Record<string, IconName> = {
  bash: "term",
  overview: "clock",
  generate_image: "image",
  read: "doc",
  write: "edit",
  edit: "edit",
  ls: "doc",
  grep: "search",
  find: "search",
  report: "rule",
  ask_user: "info",
};

/** 是不是还在跑（详情里的“补充/停止”只在这时给）。 */
function active(job: Job): boolean {
  return job.status === "running" || job.status === "queued" || job.status === "waiting";
}

export function StatusTag({ job }: { job: Job }) {
  const st = STATUS[job.status];
  return (
    <span
      className={`jt-st${st.bad ? " bad" : ""}${job.status === "done" ? " ok" : ""}${job.status === "running" ? " live" : ""}`}
    >
      <Icon name={st.icon} size={13} className={`${st.spin ? "spin " : ""}${st.bad ? "bad" : ""}`} />
      {st.text}
    </span>
  );
}

/** 桌面主界面嵌入右栏；手机和设置页保留全屏 / 覆盖层。 */
export function JobOverlay({ embedded = false }: { embedded?: boolean }) {
  const s = useApp();
  const detail = s.detail;
  const presence = useLeave(Boolean(detail), 180);
  const last = useRef(detail);
  if (detail) last.current = detail;

  useEffect(() => {
    if (!detail) return;
    const onKey = (event: KeyboardEvent) => {
      // 文件预览盖在上面时 Esc 先关它
      if (event.key === "Escape" && !s.filePreview) closeDetail();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail, s.filePreview]);

  const shown = detail ?? last.current;
  if (!presence.mounted || !shown) return null;
  const back = shown.kind === "job" && s.worklog;
  return (
    <div className={`${embedded ? "jd-embedded" : "jd-overlay"}${presence.leaving ? " leaving" : ""}`} onClick={embedded ? undefined : closeDetail}>
      <div className="jd" onClick={(event) => event.stopPropagation()}>
        <div className="jdhead">
          <button className="ib" title={back ? "返回任务记录" : "关闭"} onClick={back ? backToJobs : closeDetail}>
            <Icon name="left" size={18} />
          </button>
          <span className="t">{shown.kind === "jobs" ? "任务记录" : "任务"}</span>
          <button className="ib" title="关闭" onClick={closeDetail}>
            <Icon name="close" size={17} />
          </button>
        </div>
        {shown.kind === "jobs" ? <WorklogPage /> : <JobDetail key={shown.id} id={shown.id} />}
      </div>
    </div>
  );
}

function JobDetail({ id }: { id: string }) {
  const s = useApp();
  const job = s.jobs[id];
  const steps = s.steps[id];
  const body = useRef<HTMLDivElement>(null);
  // 在跑的任务打开时停在最新一步；已结束的从头看（结果排在最前）
  const pinned = useRef(job ? active(job) : true);
  const [models, setModels] = useState<ModelInfo[] | null>(null);

  useEffect(() => {
    void loadModels().then((view) => setModels(view?.models ?? null));
  }, []);

  // 在跑时自动跟到底部；往上翻过就不强拉
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = body.current;
    // 刚补了一句（最后一行是等待读取的补充）：不管翻到哪都拉到底，让人看到它发出去了
    const sent = steps?.[steps.length - 1]?.queued;
    if (el && (pinned.current || sent)) {
      el.scrollTop = el.scrollHeight;
      pinned.current = true;
    }
  }, [steps?.length, steps?.[steps.length - 1]?.id]);

  if (!job) {
    return (
      <div className="jdbody">
        <div className="empty">无法读取这个任务。</div>
      </div>
    );
  }

  const owner = s.assistants.find((a) => a.id === job.assistantId);
  const ended = !active(job);
  const modelName = job.model ? (models?.find((model) => model.ref === job.model)?.name ?? job.model) : "";
  const started = job.startedAt ?? job.createdAt;
  const elapsed = job.durationMs ?? (active(job) ? Date.now() - new Date(started).getTime() : undefined);
  const usage = job.usage;
  const reason = jobReason(job);
  // 思考过程并到它后面那一步里，不单独占行
  const timeline = steps === undefined ? undefined : groupThinking(steps);

  return (
    <>
      <div className="jdbody" ref={body}>
        <div className="jd-title">{job.title}</div>
        <div className="jd-meta">
          <StatusTag job={job} />
          {owner || job.assistantName ? (
            <span className="jd-owner">
              {owner ? <Avatar sprite={owner.sprite} prop={owner.prop} size={16} /> : null}
              {owner?.name ?? job.assistantName}
            </span>
          ) : null}
          <span>{fmtWhen(started)}</span>
          {elapsed !== undefined ? <span>用时 {fmtDuration(elapsed)}</span> : null}
        </div>
        {job.model || usage ? (
          <div className="jd-meta dim">
            {job.model ? (
              <span className={modelName === job.model ? "mono" : undefined} title={job.model}>
                {modelName}
              </span>
            ) : null}
            {job.thinking ? <span>思考 {THINKING[job.thinking] ?? job.thinking}</span> : null}
            {job.modelReason ? <span>{job.modelReason}</span> : null}
            {usage ? (
              <span>
                输入 {fmtTokens(usage.input)} · 输出 {fmtTokens(usage.output)}
                {usage.cost > 0 ? ` · $${usage.cost.toFixed(4)}` : ""}
              </span>
            ) : null}
          </div>
        ) : null}
        {reason ? <div className="jd-reason">{reason}</div> : null}
        {ended ? <Report job={job} /> : null}
        <div className="lbl">任务内容</div>
        <div className="jd-instruction">{job.instruction}</div>

        <div className="lbl">执行过程</div>
        <div className="jd-timeline">
          {timeline === undefined ? (
            <div className="empty">正在读取执行过程…</div>
          ) : timeline.rows.length || timeline.thinking ? (
            <>
              {timeline.rows.map((step) => (
                <Step key={step.id} step={step} cwd={job.cwd} />
              ))}
              {timeline.thinking ? <ThinkingLive text={timeline.thinking} /> : null}
            </>
          ) : (
            <div className="empty">还没有执行步骤。</div>
          )}
        </div>

        <Outputs job={job} />

        {ended ? null : <Report job={job} />}
      </div>

      {active(job) ? <ReplyBox job={job} /> : null}
    </>
  );
}

function ReplyBox({ job }: { job: Job }) {
  const [text, setText] = useState("");
  const sendable = text.trim().length > 0;
  const submit = () => {
    if (!sendable) return;
    const value = text.trim();
    setText("");
    // 发不出去就把字还回输入框，不让它悄悄丢掉
    void replyJob(job.id, value).then((ok) => { if (!ok) setText((current) => current || value); });
  };
  return (
    <div className="jd-foot">
      <input
        value={text}
        placeholder="补充说明或更正方向"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) submit();
        }}
      />
      <button className="pbtn solid" disabled={!sendable} onClick={submit}>
        发送
      </button>
      {job.status === "running" ? (
        <button className="pbtn" onClick={() => void stopJob(job.id)}>
          停止
        </button>
      ) : null}
    </div>
  );
}

function Step({ step, cwd }: { step: StepRow; cwd?: string }) {
  const [open, setOpen] = useState(false);
  const content = useLeave(open, 180);

  if (step.kind === "text") {
    if (step.from === "user") {
      return (
        <div className={`jd-mine${step.queued ? " queued" : ""}`}>
          {step.text}
          {step.queued ? <div className="jd-mine-note">已送达，当前这一步做完后读取</div> : null}
        </div>
      );
    }
    return (
      <div className="jd-textrow">
        {step.thinking ? <ThinkingBlock text={step.thinking} open={false} /> : null}
        <Markdown className="jd-text" text={step.text ?? ""} />
      </div>
    );
  }

  const title = step.title ?? step.name ?? "";
  const parts = titleParts(title);
  return (
    <div className={`jd-tool${step.isError ? " bad" : ""}${open ? " open" : ""}`}>
      <button className="jd-tool-head" onClick={() => setOpen((value) => !value)}>
        <span className="ico">
          {step.running ? (
            <Icon name="spin" size={14} className="spin" />
          ) : (
            <Icon name={TOOL_ICON[step.name ?? ""] ?? (/^(lore|memory)_/.test(step.name ?? "") ? "mem" : "more")} size={14} />
          )}
        </span>
        <span className="tt">
          {parts.map((part, index) => (
            <span key={index} className={part.mono ? "mono" : undefined}>
              {part.text}
            </span>
          ))}
        </span>
        {step.thinking ? (
          <span className="blb" title="有思考过程">
            <Icon name="bulb" size={13} />
          </span>
        ) : null}
        <span className="tm">{step.isError ? "出错" : step.durationMs && step.durationMs >= 1000 ? fmtDuration(step.durationMs) : ""}</span>
        <Icon name={open ? "down" : "chev"} size={13} />
      </button>
      <div className={`expand${open ? " open" : ""}`} inert={!open}>
        <div>{content.mounted ? <StepBody step={step} cwd={cwd} /> : null}</div>
      </div>
    </div>
  );
}

/**
 * 归到这一步的思考过程：灰色一段，可以收起。
 * 工具步骤展开时默认展开它（先看思考再看做了什么）；回复文字下面默认收起，不把时间线描得太长。
 */
function ThinkingBlock({ text, open: startOpen }: { text: string; open: boolean }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <div className="jd-think-in">
      <button
        className="jd-think-head"
        title={open ? "收起思考过程" : "展开思考过程"}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="ico">
          <Icon name="bulb" size={13} />
        </span>
        <span className="tt">思考过程</span>
        <Icon name={open ? "down" : "chev"} size={12} />
      </button>
      {open ? <div className="jd-think-body">{text}</div> : null}
    </div>
  );
}

/** 最后一段思考后面还没有步骤：任务还在想，单留一行。 */
function ThinkingLive({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="jd-think">
      <button onClick={() => setOpen((value) => !value)}>
        <span className="ico">
          <Icon name="bulb" size={14} />
        </span>
        <span className="tt">思考中</span>
        <Icon name={open ? "down" : "chev"} size={13} />
      </button>
      {open ? <div className="jd-think-body">{text}</div> : null}
    </div>
  );
}

function editPairs(step: JobStep): { oldText: string; newText: string }[] {
  const edits = (step.args as { edits?: unknown } | undefined)?.edits;
  if (!Array.isArray(edits)) return [];
  return edits.map((edit) => ({
    oldText: String((edit as { oldText?: unknown })?.oldText ?? ""),
    newText: String((edit as { newText?: unknown })?.newText ?? ""),
  }));
}

/** 步骤里的文件路径：能定位到绝对路径就点开预览，不能就按原样显示。 */
function PathLink({ path, cwd }: { path: string; cwd?: string }) {
  if (!path) return null;
  const abs = path.startsWith("/") ? path : cwd ? `${cwd.replace(/\/+$/, "")}/${path}` : null;
  if (!abs) return <div className="jd-kv mono">{path}</div>;
  return (
    <button className="jd-kv mono jd-path" title={abs} onClick={() => openFilePreview(abs)}>
      {path}
    </button>
  );
}

function StepBody({ step, cwd }: { step: StepRow; cwd?: string }) {
  const args = step.args ?? {};
  const pairs = editPairs(step);
  return (
    <div className="jd-tool-body">
      {step.thinking ? <ThinkingBlock text={step.thinking} open /> : null}
      {pairs.length ? (
        <>
          <PathLink path={String(args.path ?? "")} cwd={cwd} />
          {pairs.map((pair, index) => (
            <Diff key={index} before={pair.oldText} after={pair.newText} />
          ))}
        </>
      ) : (
        <Args step={step} args={args} cwd={cwd} />
      )}
      {step.output ? <LongText text={step.output} className="jd-out mono" /> : null}
      {step.outputPath ? (
        <button className="jd-file" onClick={() => openFilePreview(step.outputPath!)}>
          <Icon name="doc" size={12} />
          完整输出
        </button>
      ) : null}
    </div>
  );
}

function Args({ step, args, cwd }: { step: JobStep; args: Record<string, unknown>; cwd?: string }) {
  if (step.name === "bash") return <LongText text={String(args.command ?? "")} className="jd-arg mono" lines={8} />;
  if (step.name === "write") {
    return (
      <div className="jd-kv-wrap">
        <PathLink path={String(args.path ?? "")} cwd={cwd} />
        <span className="jd-kv-len">{String(args.contentLength ?? 0)} 字</span>
      </div>
    );
  }
  if (step.name === "read" || step.name === "ls" || step.name === "edit") {
    return <PathLink path={String(args.path ?? "")} cwd={cwd} />;
  }
  const text = JSON.stringify(args, null, 2);
  if (text === "{}") return null;
  return <LongText text={text} className="jd-arg mono" lines={6} />;
}

function Diff({ before, after }: { before: string; after: string }) {
  const [all, setAll] = useState(false);
  const lines = diffLines(before, after);
  const shown = all ? lines : lines.slice(0, 24);
  return (
    <div className="jd-diff">
      {shown.map((line, index) => (
        <div className={`dl ${line.sign === "-" ? "del" : line.sign === "+" ? "add" : ""}`} key={index}>
          <span className="sg">{line.sign}</span>
          <span className="mono">{line.text || " "}</span>
        </div>
      ))}
      {lines.length > shown.length ? (
        <button className="jd-more" onClick={() => setAll(true)}>
          展开全部 {lines.length} 行
        </button>
      ) : null}
    </div>
  );
}

function LongText({ text, className, lines = 12 }: { text: string; className: string; lines?: number }) {
  const [all, setAll] = useState(false);
  const count = text.split("\n").length;
  return (
    <>
      <pre className={`${className}${all ? " all" : ""}`} style={all ? undefined : { maxHeight: `${lines * 1.6}em` }}>
        {text}
      </pre>
      {count > lines ? (
        <button className="jd-more" onClick={() => setAll(!all)}>
          {all ? "收起" : `展开全部 ${count} 行`}
        </button>
      ) : null}
    </>
  );
}

/** 报告：只放摘要（markdown）；产出文件在下面单独一节。 */
function Report({ job }: { job: Job }) {
  if (!job.summary) return null;
  return (
    <>
      <div className="lbl">报告</div>
      <Markdown className="jd-report" text={job.summary} />
    </>
  );
}

/**
 * 产出文件：任务报告里交回的文件在前，工作目录里的其余文件跟在后面（修改时间倒序，同路径只一条）。
 * 点击进文件预览。
 */
function Outputs({ job }: { job: Job }) {
  const [dirFiles, setDirFiles] = useState<JobFileEntry[] | null>(null);

  useEffect(() => {
    let live = true;
    setDirFiles(null);
    void loadJobFiles(job.id).then((view) => {
      if (live) setDirFiles(view?.files ?? []);
    });
    return () => {
      live = false;
    };
  }, [job.id]);

  const seen = new Set<string>();
  const rows: { path: string; rel: string; size?: number }[] = [];
  for (const path of job.files ?? []) {
    if (seen.has(path)) continue;
    seen.add(path);
    rows.push({ path, rel: path.split("/").pop() ?? path });
  }
  for (const file of dirFiles ?? []) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    rows.push({ path: file.path, rel: file.rel, size: file.size });
  }
  if (!rows.length) return null;

  return (
    <>
      <div className="lbl">产出文件</div>
      {rows.map((row) => (
        <button className="att plain filecard" key={row.path} onClick={() => openFilePreview(row.path)}>
          <span className="ico">
            <Icon name={fileIcon(row.path)} size={18} />
          </span>
          <span>
            <span className="n" style={{ display: "block" }}>
              {row.rel.split("/").pop()}
            </span>
            <span className="m">
              {row.rel}
              {row.size !== undefined ? ` · ${fmtBytes(row.size)}` : ""}
            </span>
          </span>
        </button>
      ))}
    </>
  );
}

function WorklogPage() {
  const s = useApp();
  const log = s.worklog;
  const assistantId = log?.assistantId ?? null;
  const status = log?.status ?? null;

  return (
    <div className="jdbody">
      <div className="jd-filters">
        <select
          className="pick"
          value={assistantId ?? ""}
          onChange={(event) => void loadWorklog({ assistantId: event.target.value || null, status })}
        >
          <option value="">全部助手</option>
          {s.assistants.map((assistant) => (
            <option key={assistant.id} value={assistant.id}>
              {assistant.name}
            </option>
          ))}
        </select>
        <select
          className="pick"
          value={status ?? ""}
          onChange={(event) => void loadWorklog({ assistantId, status: (event.target.value || null) as JobStatus | null })}
        >
          <option value="">全部状态</option>
          {FILTER_STATUS.map((value) => (
            <option key={value} value={value}>
              {STATUS[value].text}
            </option>
          ))}
        </select>
        <span className="sp" />
        {log ? <span className="dim">{log.jobs.length} 个</span> : null}
      </div>

      {log === null ? (
        <div className="empty">正在读取任务记录…</div>
      ) : log.jobs.length ? (
        <div className="jd-rows">
          {log.jobs.map((row) => {
            const job = s.jobs[row.id] ?? row;
            const owner = s.assistants.find((assistant) => assistant.id === job.assistantId);
            return (
              <button
                className="jd-row"
                key={job.id}
                onClick={() => {
                  // 和首页一样：先进这个任务的助手的对话，再展开详情
                  if (owner) void select(job.assistantId, false, true, true);
                  openJob(job.id);
                }}
              >
                {owner ? <Avatar sprite={owner.sprite} prop={owner.prop} size={26} /> : <span style={{ width: 26 }} />}
                <span className="n">{job.title}</span>
                <StatusTag job={job} />
                <span className="tm">{fmtWhen(job.startedAt ?? job.createdAt)}</span>
                <span className="du">
                  {job.durationMs !== undefined
                    ? fmtDuration(job.durationMs)
                    : active(job)
                      ? fmtElapsed(job.startedAt ?? job.createdAt)
                      : ""}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="empty">没有符合条件的任务。</div>
      )}

      {log?.hasMore ? (
        <button className="pbtn jd-morebtn" onClick={() => void moreWorklog()}>
          {log.loading ? "正在读取…" : "加载更多"}
        </button>
      ) : null}
    </div>
  );
}
