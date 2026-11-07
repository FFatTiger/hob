// 首页各组：待确认、进行中、日常、收起的助手、最近任务、定时任务。
// 手机首页（Mobile）和桌面左栏（Sidebar）共用这一份，筛选规则在 ../home.ts，
// 两边的头部（我的 / 搜索框 / 新建）各自保留。
import { useState, type ReactNode } from "react";
import type { AssistantSummary, Job } from "../../../shared/types.ts";
import { plainText } from "../../../shared/plain-text.ts";
import { homeGroups } from "../home.ts";
import { assistantStatus } from "../sidebar-data.ts";
import { Icon } from "../icons.tsx";
import { Avatar, type AvatarMark } from "../sprites.tsx";
import { closePanelPages, openJob, openJobs, openRoutine, select, useApp } from "../store.ts";
import { cronText, fmtElapsed, fmtList } from "../util.ts";
import { useAssistantMenu } from "./AssistantMenu.tsx";
import type { PinDragTarget } from "./PinDrag.ts";
import { JOB_STATUS, StatusTag } from "./status-meta.tsx";
import { Empty } from "./Empty.tsx";
import { activityParts } from "./Panel.tsx";

/**
 * 首页头像动不动：在忙的助手进页面时看一圈，之后每 30 秒再看一圈，几个在忙的轮流看、不同时动；一个助手只在一处动，免得桌面左栏加对话页满屏都在动。
 * 助手在回复、或有进行中的任务 / 委派时，它的置顶或列表行在动；桌面上正打开的那个不动（对话底部的小人在动）。
 * 任务行不动，状态那列已经有转圈；只有收起的助手折着时，由它的任务行替它动。
 */
function isBusy(s: ReturnType<typeof useApp>, a: AssistantSummary): boolean {
  return assistantStatus(a, Object.values(s.jobs), Object.values(s.approvals), Object.values(s.delegations)) !== "空闲";
}

/** 在忙吗、轮到第几个看（按助手顺序给在忙的排号，头像按号错开时间看一圈）。 */
function useHomeBusy(a: AssistantSummary | undefined): { busy: boolean; slot: number } {
  const s = useApp();
  if (!a || !isBusy(s, a)) return { busy: false, slot: 0 };
  return { busy: true, slot: s.assistants.filter((x) => isBusy(s, x)).findIndex((x) => x.id === a.id) };
}

/**
 * 头像右下角只显示最要紧的状态：等你确认（?）> 受阻（!）> 正在工作（淡蓝 ···）> 完成未读（绿色对勾）。
 * 受阻和完成未读由最近结束的任务决定，未读清零后不再显示。
 */
function useMark(a: AssistantSummary, busy: boolean): AvatarMark | undefined {
  const s = useApp();
  if (assistantStatus(a, Object.values(s.jobs), Object.values(s.approvals), Object.values(s.delegations)) === "等你确认") return "ask";
  // 只看你上次看过之后结束的任务：早就结束的任务不代表现在的状态
  const last = Object.values(s.jobs)
    .filter((j) => j.assistantId === a.id && j.endedAt && (!a.readAt || j.endedAt > a.readAt))
    .sort((x, y) => (y.endedAt ?? "").localeCompare(x.endedAt ?? ""))[0];
  if (a.unread > 0 && last && (last.status === "stuck" || last.status === "failed")) return "stuck";
  if (busy) return "busy";
  if (a.unread > 0 && last?.status === "done") return "done";
  return undefined;
}

export function Pin({
  a,
  sel,
  size = 52,
  drag,
}: {
  a: AssistantSummary;
  sel?: boolean;
  size?: number;
  /** 置顶头像可以按住拖着换位置：指针事件挂这里，拖完跟的那次点击不打开对话 */
  drag?: Pick<PinDragTarget, "handlers" | "takeMoved">;
}) {
  const menu = useAssistantMenu(a);
  const { busy, slot } = useHomeBusy(a);
  const mark = useMark(a, busy);
  // 长按弹菜单和拖动换位置都要 pointerdown：两个都调，别用一个把另一个盖掉
  return (
    <button
      className={`pin${sel ? " sel" : ""}`}
      onPointerDown={(e) => {
        menu.handlers.onPointerDown(e);
        drag?.handlers.onPointerDown(e);
      }}
      onContextMenu={menu.handlers.onContextMenu}
      onPointerMove={menu.handlers.onPointerMove}
      onPointerUp={menu.handlers.onPointerUp}
      onPointerCancel={menu.handlers.onPointerCancel}
      onClick={() => {
        if (drag?.takeMoved() || menu.takeHeld()) return;
        void select(a.id);
      }}
    >
      <Avatar sprite={a.sprite} prop={a.prop} size={size} motion={busy && !sel ? "peek" : undefined} slot={slot} mark={mark} />
      <div className="nm">{a.name}</div>
      <div className="sub">{a.duty}</div>
    </button>
  );
}

/** 置顶只有一两个时放大、整体居中；三个起每行三个，最后一行不满也居中。 */
export function pinLayout(count: number): { cls: string; size: number } {
  if (count === 1) return { cls: " n1", size: 72 };
  if (count === 2) return { cls: " n2", size: 62 };
  return { cls: "", size: 52 };
}

export function AssistantRow({
  a,
  sel,
  size = 42,
  onClick,
}: {
  a: AssistantSummary;
  sel?: boolean;
  size?: number;
  onClick?: () => void;
}) {
  const menu = useAssistantMenu(a);
  const { busy, slot } = useHomeBusy(a);
  const mark = useMark(a, busy);
  return (
    <button
      className={`list-row home-row${sel ? " sel" : ""}`}
      {...menu.handlers}
      onClick={() => {
        if (menu.takeHeld()) return;
        if (onClick) onClick();
        else void select(a.id);
      }}
    >
      <Avatar sprite={a.sprite} prop={a.prop} size={size} motion={busy && !sel ? "peek" : undefined} slot={slot} mark={mark} />
      <div className="main">
        <div className="l1">
          <span className="nm">{a.name}</span>
          <span className="tm">{fmtList(a.last?.at)}</span>
        </div>
        <div className="pv">{a.last ? plainText(a.last.text) : a.duty}</div>
      </div>
    </button>
  );
}

/** 进行中的任务：哪个助手的，正在做哪一步（最近一行活动）。 */
function liveText(job: Job, owner: AssistantSummary | undefined): string {
  const last = job.activity.at(-1);
  return [owner?.name, last ? activityParts(last).join(" ") : ""].filter(Boolean).join(" · ");
}

/**
 * 点首页的任务行：先进这个任务的助手的对话（手机上就是对话页），再展开任务详情。
 * 助手已经归档 / 不在了就只开详情。
 */
function openJobRow(job: Job, owner: AssistantSummary | undefined) {
  closePanelPages();
  if (owner) void select(job.assistantId);
  openJob(job.id);
}

/**
 * 任务行：右边一列是时间和状态，分别和左边标题、摘要的基线对齐（见 styles.css 的 .row.job）；
 * 左边第二行只放一行摘要，占满宽度。
 */
function JobRow({
  job,
  owner,
  time,
  text,
  size,
  onClick,
  moving,
}: {
  job: Job;
  owner: AssistantSummary | undefined;
  moving?: boolean;
  time: string;
  text: string;
  size: number;
  onClick: () => void;
}) {
  return (
    <button className="list-row home-row job" onClick={onClick}>
      <Face owner={owner} size={size} moving={moving} />
      <span className="nm">{job.routineId ? <Icon name="clock" size={14} /> : null}{job.title}</span>
      <span className="tm">{time}</span>
      <span className="pv">{plainText(text)}</span>
      <StatusTag meta={JOB_STATUS[job.status]} />
    </button>
  );
}

function Section({ title, more, children }: { title: string; more?: ReactNode; children: ReactNode }) {
  return (
    <>
      <div className="gt">
        <span>{title}</span>
        {more}
      </div>
      {children}
    </>
  );
}

function Face({ owner, size, moving }: { owner: AssistantSummary | undefined; size: number; moving?: boolean }) {
  const { slot } = useHomeBusy(owner);
  if (!owner) return <span style={{ width: size, flex: "none" }} />;
  return <Avatar sprite={owner.sprite} prop={owner.prop} size={size} motion={moving ? "peek" : undefined} slot={slot} />;
}

/** 空的那一组显示提示。 */
function Slot({ title, text }: { title: string; text: string }) {
  return (
    <Section title={title}>
      <Empty>{text}</Empty>
    </Section>
  );
}

/**
 * 置顶下面那一串（收起的助手默认折起来，和手机一样）。
 * 行高（size）按各边的列表来：手机 36，桌面左栏 42。
 * markSel 只在桌面用：高亮当前打开的助手。
 */
export function HomeSections({ size = 42, markSel = false }: { size?: number; markSel?: boolean }) {
  const s = useApp();
  const [folded, setFolded] = useState(true);
  const g = homeGroups(s);
  const owner = (id: string) => s.assistants.find((a) => a.id === id);
  // 收起的助手平时折在日常最后，搜索时直接列出来
  const showHidden = !folded || g.searching;
  // 收起的助手折着时首页上没有它自己的头像：改由它第一条进行中的任务行替它动（一个助手只动一处）
  const stand = new Set<string>();
  const movingJob = (job: Job) => {
    const who = owner(job.assistantId);
    if (!who?.hidden || showHidden || (markSel && who.id === s.sel) || stand.has(who.id)) return false;
    stand.add(who.id);
    return true;
  };

  return (
    <>
      {g.asks.length ? (
        <Section title="等你确认">
          {g.asks.map((ap) => (
            <button className="list-row home-row" key={ap.id} onClick={() => void select(ap.assistantId)}>
              <Face owner={owner(ap.assistantId)} size={size} />
              <div className="main">
                <div className="l1">
                  <span className="nm">{ap.title}</span>
                  <span className="tm">{fmtList(ap.createdAt)}</span>
                </div>
                <div className="pv">{owner(ap.assistantId)?.name ?? ""} · 等待你的选择</div>
              </div>
            </button>
          ))}
        </Section>
      ) : null}

      {g.live.length ? (
        <Section title="进行中">
          {g.live.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              owner={owner(job.assistantId)}
              moving={movingJob(job)}
              time={fmtElapsed(job.startedAt ?? job.createdAt)}
              text={liveText(job, owner(job.assistantId))}
              size={size}
              onClick={() => openJobRow(job, owner(job.assistantId))}
            />
          ))}
        </Section>
      ) : null}

      {g.rows.length || g.hidden.length ? (
        <Section title="日常">
          {g.rows.map((a) => (
            <AssistantRow key={a.id} a={a} size={size} sel={markSel && a.id === s.sel} />
          ))}
          {g.hidden.length && !g.searching ? (
            <button className="fold" onClick={() => setFolded((v) => !v)}>
              <span>收起的助手</span>
              <span>
                {g.hidden.length}
                <Icon name={folded ? "chev" : "down"} size={13} />
              </span>
            </button>
          ) : null}
          <div className={`expand${showHidden ? " open" : ""}`} inert={!showHidden}>
            <div>
              {g.hidden.map((a) => <AssistantRow key={a.id} a={a} size={size} sel={markSel && a.id === s.sel} />)}
            </div>
          </div>
        </Section>
      ) : null}

      {g.recent.length ? (
        <Section
          title="最近任务"
          more={
            <button className="more" onClick={() => openJobs()}>
              全部
            </button>
          }
        >
          {g.recent.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              owner={owner(job.assistantId)}
              time={fmtList(job.endedAt ?? job.createdAt)}
              text={job.summary || job.statusReason || ""}
              size={size}
              onClick={() => openJobRow(job, owner(job.assistantId))}
            />
          ))}
        </Section>
      ) : null}

      {g.routines.length ? (
        <Section title="定时任务">
          {g.routines.map((r) => {
            const run = r.runs[0];
            return (
              <button
                className="list-row home-row"
                key={r.id}
                onClick={() => {
                  closePanelPages();
                  void select(r.assistantId);
                  openRoutine(r.id);
                }}
              >
                <Face owner={owner(r.assistantId)} size={size} />
                <div className="main">
                  <div className="l1">
                    <span className="nm">{r.name}</span>
                    <span className="tm">{cronText(r.schedules[0] ?? "")}</span>
                  </div>
                  <div className="pv">
                    {run ? <>上次运行 {fmtList(run.at)} · <StatusTag meta={JOB_STATUS[run.status]} /></> : "尚未运行"}
                  </div>
                </div>
              </button>
            );
          })}
        </Section>
      ) : null}

      {g.empty ? (
        <>
          <Slot title="最近任务" text="分派的任务会显示在这里" />
          <Slot title="定时任务" text="定时任务会显示在这里" />
        </>
      ) : null}
    </>
  );
}
