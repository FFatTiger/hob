// 右栏：进行中的任务 + 定时任务列表 / 定时任务编辑 / 助手设置 / 应用设置。
import { useEffect, useRef, useState } from "react";
import { commandSummary } from "../../../shared/command.ts";
import type { ActivityLine, Assistant, CustomProp, Job, ModelInfo, ModelsView, Routine, Rule, ThinkingLevel } from "../../../shared/types.ts";
import { Icon } from "../icons.tsx";
import { byEnded, byStarted } from "../home.ts";
import { useRows } from "../motion.ts";
import { fitThinking } from "../model-list.ts";
import { COLOR_IDS, COLORS, customSprite, parseSprite, PROP_IDS, PROPS, spriteId } from "../../../shared/sprites.ts";
import { Avatar } from "../sprites.tsx";
import {
  addRule,
  backToNow,
  closeSheet,
  collapsePanel,
  createRoutine,
  deleteRule,
  deleteRoutine,
  jumpToJob,
  jumpToDelegation,
  loadModels,
  mergeAssistant,
  openAssistantPanel,
  openJob,
  openJobs,
  openNewRoutine,
  openRoutine,
  patchAssistant,
  updateRule,
  runRoutine,
  saveRoutine,
  useApp,
} from "../store.ts";
import { cronText, fmtWhen, parseCron, scheduleCron, WEEK, type Schedule } from "../util.ts";

export const STATUS_TEXT: Record<Job["status"], string> = {
  queued: "排队中",
  running: "进行中",
  waiting: "待确认",
  done: "已完成",
  stuck: "受阻",
  failed: "失败",
  stopped: "已停止",
};

// 活动行存的是单字代码（任务统计也按它数），显示时换成书面动词
const VERB_LABEL: Record<string, string> = { 读: "读取", 跑: "运行", 改: "修改", 写: "写入", 搜: "搜索" };

/** 活动行的动词和正文；命令去掉 cd/timeout/ssh 外壳。 */
export function activityParts(line: ActivityLine): [string, string] {
  return [VERB_LABEL[line.verb] ?? line.verb, line.verb === "跑" ? commandSummary(line.text) : line.text];
}

export function Panel({ mobile = false }: { mobile?: boolean }) {
  const s = useApp();
  const kind = s.panel.kind;
  const name = s.assistants.find((a) => a.id === s.sel)?.name ?? "";
  // 手机上这一页是整页：标题写助手名；桌面右栏顶上没有标题
  const title =
    kind === "routine" ? "定时任务" : kind === "newRoutine" ? "新建定时任务" : kind === "now" ? (mobile ? name : "") : "助手设置";
  const back = () => (kind === "now" ? closeSheet() : backToNow());
  // 首次渲染（页面加载）不播切页动画
  const first = useRef(true);
  useEffect(() => {
    first.current = false;
  }, []);
  const view = kind === "routine" ? `routine:${s.panel.id}` : kind;

  return (
    <aside className="panel">
      <div className="phead">
        {kind === "now" ? (
          mobile ? (
            <button className="ib" onClick={closeSheet} title="收起">
              <Icon name="left" size={17} />
            </button>
          ) : null
        ) : (
          <button className="ib" onClick={back} title="返回">
            <Icon name="left" size={17} />
          </button>
        )}
        <span className="t">{title}</span>
        {kind === "now" ? (
          <button className="ib" title="助手设置" onClick={openAssistantPanel}>
            <Icon name="gear" size={17} />
          </button>
        ) : null}
        {/* 手机上是整页，返回就是关；收起右栏只在桌面有 */}
        {mobile ? null : (
          <button className="ib" title="收起右栏" onClick={collapsePanel}>
            <Icon name="dbl" size={17} />
          </button>
        )}
      </div>
      <div
        className={`pbody${first.current ? "" : kind === "now" ? " from-left" : " from-right"}`}
        key={first.current ? "first" : view}
      >
        {kind === "routine" ? (
          <RoutineEditor key={s.panel.kind === "routine" ? s.panel.id : ""} id={s.panel.kind === "routine" ? s.panel.id : ""} />
        ) : kind === "newRoutine" ? (
          <NewRoutine />
        ) : kind === "assistant" ? (
          <AssistantSettings key={s.sel ?? "hob"} />
        ) : (
          <PanelNow />
        )}
      </div>
    </aside>
  );
}

const routineKey = (r: Routine) => r.id;

function PanelNow() {
  const s = useApp();
  const all = Object.values(s.jobs);
  // 右栏只放当前助手自己的东西，主助手也一样（全部助手的任务在首页和任务记录里看）
  const scope = (j: Job) => j.assistantId === (s.sel ?? "hob");
  const isActive = (j?: Job) => !!j && (j.status === "running" || j.status === "queued");
  const running = all.filter((j) => scope(j) && isActive(j)).sort(byStarted)[0];
  const last = all.filter((j) => scope(j) && !isActive(j)).sort(byEnded)[0];
  const job = running ?? last;
  const routines = s.routines.filter((r) => r.assistantId === s.sel);
  const rows = useRows(routines, routineKey, s.sel ?? "");
  const worklog = s.profiles[s.sel ?? "hob"]?.worklog ?? [];

  // 新活动行淡入；打开面板时已经有的行不动
  const lines = (job?.activity ?? []).slice(-8);
  const keys = lines.map((l) => `${l.at}|${l.verb}|${l.text}`);
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(keys);
  const freshLines = new Set(keys.filter((k) => !seen.current!.has(k)));
  useEffect(() => {
    for (const k of keys) seen.current!.add(k);
  });

  return (
    <>
      {job ? (
        <>
          <button className={`screen jd-open${running ? "" : " idle"}`} title="打开任务详情" onClick={() => openJob(job.id)}>
            {lines.map((line, i) =>
              line.verb === "$" ? (
                <div key={keys[i]} className={freshLines.has(keys[i]) ? "new" : undefined}>
                  <span className="p">$</span> {line.text}
                </div>
              ) : (
                <div key={keys[i]} className={freshLines.has(keys[i]) ? "new" : undefined}>
                  <span className="v">{activityParts(line)[0]}</span>
                  {activityParts(line)[1]}
                </div>
              ),
            )}
            {/* 没在跑：不要闪的光标，最后一行写明已经结束，免得以为还在运行 */}
            {running ? (
              <div>
                <span className="cur" />
              </div>
            ) : (
              <div className="end">— {STATUS_TEXT[job.status]} —</div>
            )}
          </button>
          <div className="caprow">
            <button className="cap jd-open" onClick={() => openJob(job.id)}>
              {running ? `进行中 · ${job.title}` : `上一个任务 · ${job.title} · ${STATUS_TEXT[job.status]}`}
            </button>
            <button className="more" onClick={() => openJobs(s.sel ?? "hob")}>
              任务记录
            </button>
          </div>
        </>
      ) : (
        <div className="slot pslot">分派的任务会显示在这里</div>
      )}

      {s.sel === "hob" ? Object.values(s.delegations).filter((delegation) => delegation.status === "running" || delegation.status === "waiting").map((delegation) => {
        const target = s.assistants.find((assistant) => assistant.id === delegation.to);
        return <button className="delegation-panel" key={delegation.id} onClick={() => void jumpToDelegation("hob", delegation.id, false)}><Icon name={delegation.status === "waiting" ? "pause" : "spin"} size={14} className={delegation.status === "running" ? "spin" : ""} />交给「{target?.name ?? delegation.to}」 · {delegation.status === "waiting" ? "等你确认" : "进行中"}</button>;
      }) : null}
      <div className="sech">
        <span>定时任务</span>
        <button
          className="ib"
          style={{ width: 18, height: 18 }}
          title="新建定时任务"
          onClick={openNewRoutine}
        >
          <Icon name="plus" size={16} />
        </button>
      </div>
      {rows.length ? (
        rows.map((row) => (
          <div className={`rtrow${row.state === "still" ? "" : ` ${row.state}`}`} key={row.key}>
            <div className="rtclip">
              <button className={`rt${row.item.active ? "" : " paused"}`} onClick={() => openRoutine(row.key)}>
                <Icon name={row.item.active ? "clock" : "pause"} size={17} />
                <div>
                  <div className="n">{row.item.name}</div>
                  <div className="s">{row.item.active ? cronText(row.item.schedules[0] ?? "") : "已暂停"}</div>
                </div>
              </button>
            </div>
          </div>
        ))
      ) : (
        <div className="empty">这个助手还没有定时任务</div>
      )}

      {worklog.length ? (
        <div className="wlgroup">
          <div className="sech">
            <span>工作日志</span>
          </div>
          {worklog.slice(0, 6).map((w, i) => (
            <div className="wl" key={`${w.at}-${i}`}>
              <span className="t">{fmtWhen(w.at)}</span>
              <span>{w.text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function ScheduleRow({
  value,
  onSave,
  onRemove,
}: {
  value: string;
  onSave: (next: string) => void;
  /** 不止一个执行时间时才能删 */
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const sch = parseCron(value);

  if (!open) {
    return (
      <button className="w" onClick={() => setOpen(true)}>
        <Icon name="clock" size={15} />
        {cronText(value)}
      </button>
    );
  }

  const update = (patch: Partial<Schedule>) => {
    const base: Schedule = sch.kind === "raw" ? { ...sch, kind: "daily" } : sch;
    onSave(scheduleCron({ ...base, ...patch }));
  };
  const time = `${String(sch.hour).padStart(2, "0")}:${String(sch.minute).padStart(2, "0")}`;

  return (
    <div className="w sched-edit">
      <select value={sch.kind} onChange={(e) => update({ kind: e.target.value as Schedule["kind"] })}>
        <option value="daily">每天</option>
        <option value="weekly">每周</option>
        <option value="monthly">每月</option>
        <option value="raw">自定义</option>
      </select>
      {sch.kind === "weekly" ? (
        <select value={sch.weekday} onChange={(e) => update({ weekday: Number(e.target.value) })}>
          {WEEK.map((w, i) => (
            <option key={i} value={i}>
              周{w}
            </option>
          ))}
        </select>
      ) : null}
      {sch.kind === "monthly" ? (
        <input
          type="number"
          min={1}
          max={28}
          value={sch.day}
          onChange={(e) => update({ day: Number(e.target.value) || 1 })}
        />
      ) : null}
      {sch.kind === "raw" ? (
        <input className="rawcron" value={sch.raw} onChange={(e) => onSave(e.target.value)} />
      ) : (
        <input
          type="time"
          value={time}
          onChange={(e) => {
            const [h, m] = e.target.value.split(":").map(Number);
            update({ hour: h || 0, minute: m || 0 });
          }}
        />
      )}
      {onRemove ? (
        <button className="pbtn" onClick={onRemove}>
          删除
        </button>
      ) : null}
      <button className="pbtn" onClick={() => setOpen(false)}>
        完成
      </button>
    </div>
  );
}

/** 新建定时任务：先在本地填写，名称和任务内容都有了才创建（建好后切到它的编辑页）。 */
function NewRoutine() {
  const s = useApp();
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [schedule, setSchedule] = useState("0 9 * * *");
  const [busy, setBusy] = useState(false);
  const ready = name.trim() !== "" && instruction.trim() !== "" && !busy;
  const create = async () => {
    setBusy(true);
    await createRoutine({
      assistantId: s.sel ?? "hob",
      name: name.trim(),
      instruction: instruction.trim(),
      schedules: [schedule],
      active: true,
    });
    setBusy(false);
  };

  return (
    <>
      <div className="lbl">名称</div>
      <label className="field">
        <input autoFocus value={name} placeholder="如「每日简报」" onChange={(e) => setName(e.target.value)} />
      </label>

      <div className="lbl">任务内容</div>
      <label className="field">
        <textarea
          rows={4}
          value={instruction}
          placeholder="到点后交给后台任务执行的内容，写清楚需要什么结果"
          onChange={(e) => setInstruction(e.target.value)}
        />
      </label>

      <div className="lbl">执行时间</div>
      <div className="when">
        <ScheduleRow value={schedule} onSave={setSchedule} />
      </div>

      <div className="ctl">
        <span className="sp" />
        <button className="pbtn" onClick={backToNow}>
          取消
        </button>
        <button className="pbtn solid" disabled={!ready} onClick={() => void create()}>
          创建
        </button>
      </div>
    </>
  );
}

function RoutineEditor({ id }: { id: string }) {
  const s = useApp();
  const r = s.routines.find((x) => x.id === id);
  if (!r) return <div className="empty">这个定时任务已不存在。</div>;

  return (
    <>
      <div className="ctl">
        <button
          className={`tog${r.active ? "" : " off"}`}
          title={r.active ? "暂停" : "启用"}
          onClick={() => void saveRoutine(r.id, { active: !r.active })}
        />
        <span style={{ fontSize: 14 }}>启用</span>
        <span className="sp" />
        <button className="pbtn solid" onClick={() => void runRoutine(r.id)}>
          立即运行
        </button>
      </div>

      <div className="lbl">名称</div>
      <label className="field">
        <input
          defaultValue={r.name}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== r.name) void saveRoutine(r.id, { name: v });
          }}
        />
      </label>

      <div className="lbl">任务内容</div>
      <label className="field">
        <textarea
          rows={4}
          defaultValue={r.instruction}
          onBlur={(e) => {
            if (e.target.value !== r.instruction) void saveRoutine(r.id, { instruction: e.target.value });
          }}
        />
      </label>

      <div className="lbl">执行时间</div>
      <div className="when">
        {r.schedules.map((c, i) => (
          <ScheduleRow
            key={i}
            value={c}
            onSave={(next) => {
              const arr = r.schedules.slice();
              arr[i] = next;
              void saveRoutine(r.id, { schedules: arr });
            }}
            onRemove={
              r.schedules.length > 1
                ? () => void saveRoutine(r.id, { schedules: r.schedules.filter((_, j) => j !== i) })
                : undefined
            }
          />
        ))}
        <button className="w" onClick={() => void saveRoutine(r.id, { schedules: [...r.schedules, "0 9 * * *"] })}>
          <Icon name="plus" size={14} />
          添加执行时间
        </button>
      </div>

      <div className="lbl">运行记录</div>
      {r.runs.length ? (
        r.runs.map((run) => {
          const job = s.jobs[run.jobId];
          const st = job?.status ?? run.status;
          const spinning = st === "running" || st === "queued";
          const bad = st === "failed" || st === "stuck";
          return (
            <button className={`run${bad ? " bad" : ""}`} key={run.jobId} onClick={() => void jumpToJob(r.assistantId, run.jobId)}>
              <span>{fmtWhen(run.at)}</span>
              <Icon name={spinning ? "spin" : bad ? "close" : "check"} size={16} className={spinning ? "spin" : ""} />
            </button>
          );
        })
      ) : (
        <div className="empty">还没有运行记录</div>
      )}

      <div style={{ marginTop: 18 }}>
        <button
          className="pbtn"
          onClick={async () => {
            if (!window.confirm(`删除定时任务「${r.name}」？已有的运行记录会保留在对话里。`)) return;
            await deleteRoutine(r.id);
            backToNow();
          }}
        >
          删除定时任务
        </button>
      </div>
    </>
  );
}

function useAssistantSave(aid: string) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (message !== "已保存") return;
    const timer = setTimeout(() => setMessage(null), 3000);
    return () => clearTimeout(timer);
  }, [message]);
  const save = async (patch: Partial<Assistant>) => {
    setBusy(true);
    const error = await patchAssistant(aid, patch);
    setBusy(false);
    setMessage(error ?? "已保存");
    return !error;
  };
  return { save, busy, message, fail: (error: string) => setMessage(error) };
}

function PanelSaveStatus({ message }: { message: string | null }) {
  return message ? <div role="status" className={message === "已保存" ? "okline" : "badline"}>{message}</div> : null;
}

function PanelText({ value, multiline, placeholder, save }: { value: string; multiline?: boolean; placeholder?: string; save: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const props = { value: text, placeholder, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setText(e.target.value), onBlur: () => { if (text !== value) void save(text).then((ok) => { if (!ok) setText(value); }); }, onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur(); } } };
  return <label className="field">{multiline ? <textarea rows={4} {...props} /> : <input {...props} />}</label>;
}

function AssistantModels({ aid }: { aid: string }) {
  const s = useApp();
  const feedback = useAssistantSave(aid);
  const profile = s.profiles[aid];
  const [view, setView] = useState<ModelsView | null>(null);
  useEffect(() => {
    void loadModels().then(setView);
  }, []);
  const roster = s.settings.settings.models.roster;
  if (!profile) return null;
  const models = profile.assistant.models ?? {};
  const globals = s.settings.settings.models;
  const nameOf = (ref: string) => view?.models.find((model) => model.ref === ref)?.name ?? ref;
  const entryOf = (ref: string) => roster.find((entry) => entry.ref === ref);
  const save = (next: NonNullable<typeof models>) => void feedback.save({ models: next });

  const pick = (key: "conversation" | "work") => (ref: string) => {
    const next = { ...models };
    if (ref) {
      const fallback = key === "conversation" ? globals.conversation.thinking : globals.work.thinking;
      next[key] = { ref, thinking: fitThinking(view?.models.find((model) => model.ref === ref), entryOf(ref)?.thinking ?? fallback) };
    } else {
      delete next[key];
    }
    save(next);
  };

  const allowed = models.allowed ?? [];
  const restrict = (refs: string[]) => {
    const next = { ...models };
    if (refs.length) next.allowed = refs;
    else delete next.allowed;
    save(next);
  };

  const roleRow = (label: string, key: "conversation" | "work") => (
    <>
      <div className="lbl">{label}</div>
      <div className="ctl">
        <select className="pick grow" value={models[key]?.ref ?? ""} onChange={(e) => pick(key)(e.target.value)}>
          <option value="">跟随全局（{nameOf(key === "conversation" ? globals.conversation.ref : globals.work.ref)}）</option>
          {roster.map((entry) => (
            <option key={entry.ref} value={entry.ref}>
              {nameOf(entry.ref)}
            </option>
          ))}
        </select>
      </div>
    </>
  );

  return (
    <>
      <PanelSaveStatus message={feedback.message} />
      {roleRow("对话模型", "conversation")}
      {roleRow("默认任务模型", "work")}

      <div className="lbl">可分派的模型</div>
      <div className="ctl">
        <button className={`pbtn${allowed.length ? "" : " solid"}`} onClick={() => restrict([])}>
          全部
        </button>
        <button
          className={`pbtn${allowed.length ? " solid" : ""}`}
          onClick={() => restrict(roster.map((entry) => entry.ref))}
        >
          指定
        </button>
        <span className="note" style={{ margin: 0 }}>
          {allowed.length ? `已选 ${allowed.length} 个` : `可用模型共 ${roster.length} 个`}
        </span>
      </div>
      {allowed.length ? (
        <div className="chips" style={{ marginTop: 8 }}>
          {roster.map((entry) => {
            const on = allowed.includes(entry.ref);
            return (
              <button
                key={entry.ref}
                className={`chip${on ? " on" : ""}`}
                onClick={() =>
                  restrict(on ? allowed.filter((ref) => ref !== entry.ref) : [...allowed, entry.ref])
                }
              >
                {nameOf(entry.ref)}
              </button>
            );
          })}
        </div>
      ) : null}
    </>
  );
}

function AssistantAbilities({ aid }: { aid: string }) {
  const s = useApp();
  const feedback = useAssistantSave(aid);
  const profile = s.profiles[aid];
  if (!profile) return null;
  const abilities = profile.assistant.abilities ?? { exec: true, write: true, image: true };
  // 设置里没有图像模型时，图像生成开关没有意义：显示成灰的，点了也没用
  const imageReady = s.settings.settings.image.source !== "off";
  const save = (patch: Partial<typeof abilities>) =>
    void feedback.save({ abilities: { ...abilities, ...patch } });

  const row = (label: string, on: boolean, onToggle: () => void, hint?: string) => (
    <>
      <div className="ctl">
        <span style={{ fontSize: 14 }}>{label}</span>
        <span className="sp" />
        <button className={`tog${on ? "" : " off"}`} title={on ? "关闭" : "开启"} onClick={onToggle} />
      </div>
      {hint ? <div className="note">{hint}</div> : null}
    </>
  );

  return (
    <>
      <div className="lbl">能力</div>
      <PanelSaveStatus message={feedback.message} />
      {row("执行命令", abilities.exec, () => save({ exec: !abilities.exec }), "开启后，任务可以运行命令，并可通过命令访问网络。")}
      {row("修改文件", abilities.write, () => save({ write: !abilities.write }), "开启后，任务可以创建和修改文件。")}
      {imageReady ? (
        row(
          "图像生成",
          abilities.image,
          () => save({ image: !abilities.image }),
          "开启后，任务可以生成图片，图片以缩略图显示在对话中。",
        )
      ) : (
        <>
          <div className="ctl" style={{ marginTop: 8 }}>
            <span style={{ fontSize: 14, color: "var(--text3)" }}>图像生成</span>
            <span className="sp" />
            <button className="tog off" disabled title="需要先在 设置 → 图像生成 中完成配置" />
          </div>
          <div className="note">需要先在 设置 → 图像生成 中完成配置。</div>
        </>
      )}
      <div className="note">读取文件始终可用。</div>
    </>
  );
}

/** 换头像：自画的道具（有就排第一个）+ 内置道具，都按当前颜色预览，下面一排换颜色。 */
function SpritePicker({ aid, sprite, prop, onDone }: { aid: string; sprite: string; prop?: CustomProp; onDone: () => void }) {
  const feedback = useAssistantSave(aid);
  const parsed = parseSprite(sprite) ?? { prop: "hob" as const, color: "slate" as const };
  const pick = (next: string) => {
    if (next !== sprite) void feedback.save({ sprite: next });
  };
  return (
    <>
      <PanelSaveStatus message={feedback.message} />
      <div className="sprite-pick">
        {prop ? (
          <button
            className={parsed.prop === "custom" ? "on" : undefined}
            title="自画道具"
            onClick={() => pick(customSprite(parsed.color))}
          >
            <Avatar sprite={customSprite(parsed.color)} prop={prop} size={34} />
          </button>
        ) : null}
        {PROP_IDS.map((p) => (
          <button
            key={p}
            className={p === parsed.prop ? "on" : undefined}
            title={PROPS[p].label}
            onClick={() => pick(spriteId(p, parsed.color))}
          >
            <Avatar sprite={spriteId(p, parsed.color)} size={34} />
          </button>
        ))}
      </div>
      <div className="sprite-colors">
        {COLOR_IDS.map((c) => (
          <button
            key={c}
            className={c === parsed.color ? "on" : undefined}
            title={COLORS[c].name}
            style={{ background: COLORS[c].o }}
            onClick={() => pick(parsed.prop === "custom" ? customSprite(c) : spriteId(parsed.prop, c))}
          />
        ))}
        <button className="pbtn" onClick={onDone}>
          完成
        </button>
      </div>
    </>
  );
}

function RuleRow({ aid, rule }: { aid: string; rule: Rule }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(rule.text);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const cancel = useRef(false);
  useEffect(() => {
    if (message !== "已保存") return;
    const timer = setTimeout(() => setMessage(null), 3000);
    return () => clearTimeout(timer);
  }, [message]);
  const save = async (patch: { text?: string; mode?: "ask" | "allow" }) => {
    setBusy(true);
    const error = await updateRule(aid, { id: rule.id, ...patch });
    setBusy(false);
    setMessage(error ?? "已保存");
    if (!error) setEditing(false);
  };
  const commitText = () => {
    if (cancel.current) { cancel.current = false; return; }
    const value = text.trim();
    if (value === rule.text) { setEditing(false); return; }
    if (!value) { setMessage("规则内容不能为空。"); return; }
    void save({ text: value });
  };
  return (
    <div className="rule-wrap">
      <div className="rule">
        {editing ? (
          <input className="rule-input" autoFocus value={text} maxLength={1000} disabled={busy}
            onChange={(e) => setText(e.target.value)} onBlur={commitText}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") { cancel.current = true; setText(rule.text); setEditing(false); }
            }} />
        ) : (
          <button className="rule-text" onClick={() => { cancel.current = false; setText(rule.text); setEditing(true); }} disabled={busy} title="编辑规则">{rule.text}</button>
        )}
        <span className="v">
          <button className="rule-mode" disabled={busy} onClick={() => void save({ mode: rule.mode === "ask" ? "allow" : "ask" })} title="切换确认方式">{rule.mode === "ask" ? "需确认" : "直接执行"}</button>
          <button className="del" title="删除这条规则" disabled={busy} onClick={() => setConfirming(true)}><Icon name="close" size={13} /></button>
        </span>
      </div>
      {confirming ? <div className="rule-confirm"><span>确定删除这条规则？</span><button className="pbtn" onClick={() => setConfirming(false)}>取消</button><button className="pbtn danger" onClick={() => void deleteRule(aid, rule.id)}>确认删除</button></div> : null}
      {message ? <div className={message === "已保存" ? "okline" : "badline"} role="status">{message}</div> : null}
    </div>
  );
}

function RuleCreator({ aid }: { aid: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"ask" | "allow">("ask");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (message !== "已保存") return;
    const timer = setTimeout(() => setMessage(null), 3000);
    return () => clearTimeout(timer);
  }, [message]);
  const cancel = () => { setEditing(false); setText(""); setMode("ask"); setMessage(null); };
  const save = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    setMessage(null);
    const error = await addRule(aid, text.trim(), mode);
    setBusy(false);
    if (error) { setMessage(error); return; }
    setText("");
    setMode("ask");
    setEditing(false);
    setMessage("已保存");
  };
  return <div className="rule-wrap">
    {editing ? <form className="rule-new" onSubmit={(e) => { e.preventDefault(); void save(); }} onKeyDown={(e) => { if (e.key === "Escape" && !busy) { e.preventDefault(); cancel(); } }}>
      <input className="rule-input" autoFocus aria-label="规则文字" placeholder="输入规则内容" maxLength={1000} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
      <div className="ctl">
        <select className="pick" aria-label="规则确认方式" value={mode} disabled={busy} onChange={(e) => setMode(e.target.value as "ask" | "allow")}><option value="ask">需确认</option><option value="allow">直接执行</option></select>
        <span className="sp" />
        <button type="button" className="pbtn" disabled={busy} onClick={cancel}>取消</button>
        <button type="submit" className="pbtn solid" disabled={busy || !text.trim()}>{busy ? "正在保存…" : "保存"}</button>
      </div>
    </form> : <button className="rule-add" onClick={() => { setMessage(null); setEditing(true); }}>＋ 新增规则</button>}
    {message ? <div className={message === "已保存" ? "okline" : "badline"} role="status">{message}</div> : null}
  </div>;
}

function AssistantSettings() {
  const s = useApp();
  const aid = s.sel ?? "hob";
  const profile = s.profiles[aid];
  const [picking, setPicking] = useState(false);
  const [merging, setMerging] = useState(false);
  const feedback = useAssistantSave(aid);
  if (!profile) return <div className="empty">正在读取档案…</div>;
  const a = profile.assistant;

  return (
    <>
      <div className="pgroup">
        <div className="sech">
          <span>基本信息</span>
        </div>
        <div className="bigav">
          <Avatar sprite={a.sprite} prop={a.prop} size={68} onClick={() => setPicking((v) => !v)} title="换头像" />
        </div>
        {picking ? <SpritePicker aid={aid} sprite={a.sprite} prop={a.prop} onDone={() => setPicking(false)} /> : null}

        <PanelSaveStatus message={feedback.message} />
        <div className="lbl">名字</div>
        <PanelText value={a.name} save={(name) => {
          if (name.trim()) return feedback.save({ name: name.trim() });
          feedback.fail("名字不能为空。");
          return Promise.resolve(false);
        }} />

        <div className="lbl">职责简介</div>
        <PanelText value={a.duty} save={(duty) => feedback.save({ duty })} />

        <div className="lbl">详细职责</div>
        <PanelText multiline value={a.dutyLong ?? ""} save={(dutyLong) => feedback.save({ dutyLong })} />

        <div className="lbl">补充说明</div>
        <PanelText multiline value={a.instructions} placeholder="这个助手特有的做法，如“周报先列要点再展开”" save={(instructions) => feedback.save({ instructions })} />
      </div>

      <div className="pgroup">
        <div className="sech">
          <span>工作方式</span>
        </div>

        <div className="lbl">执行前确认</div>
        <div className="note">标为「需确认」的事项，助手执行前会先征求你的同意。</div>
        <div className="field" style={{ padding: "2px 12px" }}>
          {profile.rules.length ? (
            profile.rules.map((rule) => <RuleRow key={rule.id} aid={aid} rule={rule} />)
          ) : (
            <div className="empty">还没有需要执行前确认的规则</div>
          )}
          <RuleCreator key={aid} aid={aid} />
        </div>

        <AssistantModels aid={aid} />
        <AssistantAbilities aid={aid} />
      </div>

      <div className="pgroup">
        <div className="sech">
          <span>显示与通知</span>
        </div>

        <div className="lbl">通知</div>
        <div className="ctl">
          <span style={{ fontSize: 14 }}>需要确认时通知我</span>
          <span className="sp" />
          <button
            className={`tog${a.notify ? "" : " off"}`}
            title={a.notify ? "关闭通知" : "开启通知"}
            disabled={feedback.busy}
            onClick={() => void feedback.save({ notify: !a.notify })}
          />
        </div>
        <div className="note">要在手机上接收推送，请先在 设置 → 通知 中开启本机推送。</div>

        {a.primary ? null : (
          <>
            <div className="lbl">位置</div>
            <div className="ctl">
              <span style={{ fontSize: 14 }}>放在顶部</span>
              <span className="sp" />
              <button
                className={`tog${a.pinned ? "" : " off"}`}
                title={a.pinned ? "取消置顶" : "放在顶部"}
                disabled={feedback.busy}
                onClick={() => void feedback.save({ pinned: !a.pinned })}
              />
            </div>
          </>
        )}

        {a.primary ? null : <div className="mergebar"><button className="pbtn" onClick={() => void feedback.save({ hidden: !a.hidden })}>{a.hidden ? "放回列表" : "收起这个助手"}</button></div>}
      </div>
      {a.primary ? null : (
        <div className="pgroup">
          <div className="sech"><span>危险操作</span></div>
          <div className="mergebar">
            {merging ? (
              <div className="mergeconfirm">
                将「{a.name}」并回 Hob？它的定时任务和执行前确认规则会转给 Hob，对话记录会保留归档，这个助手会从列表中移除。
                <div className="acts">
                  <button className="pbtn solid" onClick={() => void mergeAssistant(aid)}>
                    确认并回
                  </button>
                  <button className="pbtn" onClick={() => setMerging(false)}>
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button className="pbtn danger" onClick={() => setMerging(true)}>
                并回 Hob
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
