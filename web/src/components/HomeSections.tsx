// 首页各组：待确认、进行中、日常、收起的助手、最近任务、定时任务。
// 手机首页（Mobile）和桌面左栏（Sidebar）共用这一份，筛选规则在 ../home.ts，
// 两边的头部（我的 / 搜索框 / 新建）各自保留。
import { useState, type ReactNode } from "react";
import type { AssistantSummary, Job } from "../../../shared/types.ts";
import { homeGroups } from "../home.ts";
import { Icon } from "../icons.tsx";
import { Avatar } from "../sprites.tsx";
import { openJob, openJobs, openRoutine, select, useApp } from "../store.ts";
import { cronText, fmtElapsed, fmtList } from "../util.ts";
import { useAssistantMenu } from "./AssistantMenu.tsx";
import { StatusTag } from "./JobDetail.tsx";
import { activityParts, STATUS_TEXT } from "./Panel.tsx";

function useHomeBusy(a: AssistantSummary | undefined): boolean {
  const s = useApp();
  return Boolean(a && (a.busy || Object.values(s.jobs).some((j) => j.assistantId === a.id && ["running", "queued", "waiting"].includes(j.status)) || Object.values(s.delegations).some((d) => (d.from === a.id || d.to === a.id) && ["running", "waiting"].includes(d.status))));
}

export function Pin({ a, sel, size = 52 }: { a: AssistantSummary; sel?: boolean; size?: number }) {
  const menu = useAssistantMenu(a);
  const busy = useHomeBusy(a);
  return (
    <button
      className={`pin${sel ? " sel" : ""}`}
      {...menu.handlers}
      onClick={() => {
        if (!menu.takeHeld()) void select(a.id);
      }}
    >
      <Avatar sprite={a.sprite} prop={a.prop} size={size} motion={busy ? "home" : undefined} />
      {a.unread > 0 ? <span className="badge" /> : null}
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
  const busy = useHomeBusy(a);
  return (
    <button
      className={`row${sel ? " sel" : ""}`}
      {...menu.handlers}
      onClick={() => {
        if (menu.takeHeld()) return;
        if (onClick) onClick();
        else void select(a.id);
      }}
    >
      <Avatar sprite={a.sprite} prop={a.prop} size={size} motion={busy ? "home" : undefined} />
      <div className="main">
        <div className="l1">
          <span className="nm">{a.name}</span>
          <span className="tm">{fmtList(a.last?.at)}</span>
        </div>
        <div className="pv">{a.last?.text ?? a.duty}</div>
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
 * 助手已经并回 / 不在了就只开详情。
 */
function openJobRow(job: Job, owner: AssistantSummary | undefined) {
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
}: {
  job: Job;
  owner: AssistantSummary | undefined;
  time: string;
  text: string;
  size: number;
  onClick: () => void;
}) {
  return (
    <button className="row job" onClick={onClick}>
      <Face owner={owner} size={size} />
      <span className="nm">{job.title}</span>
      <span className="tm">{time}</span>
      <span className="pv">{text}</span>
      <StatusTag job={job} />
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

function Face({ owner, size }: { owner: AssistantSummary | undefined; size: number }) {
  const busy = useHomeBusy(owner);
  if (!owner) return <span style={{ width: size, flex: "none" }} />;
  return <Avatar sprite={owner.sprite} prop={owner.prop} size={size} motion={busy ? "home" : undefined} />;
}

/** 空的那一组：虚线框占住位置，框里写这里会出现什么。 */
function Slot({ title, text }: { title: string; text: string }) {
  return (
    <Section title={title}>
      <div className="slot">{text}</div>
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

  return (
    <>
      {g.asks.length ? (
        <Section title="待确认">
          {g.asks.map((ap) => (
            <button className="row" key={ap.id} onClick={() => void select(ap.assistantId)}>
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
                className="row"
                key={r.id}
                onClick={() => {
                  void select(r.assistantId, false, false);
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
                    {run ? `上次运行 ${fmtList(run.at)} · ${STATUS_TEXT[run.status]}` : "尚未运行"}
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
