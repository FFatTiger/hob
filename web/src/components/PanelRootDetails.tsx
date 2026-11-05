import { useEffect, useState } from "react";
import type { KnowledgeEntry } from "../../../shared/knowledge.ts";
import { plainText } from "../../../shared/plain-text.ts";
import { fileIcon } from "../file-icons.ts";
import { Icon } from "../icons.tsx";
import { groupSidebarFiles, routineSummary, sidebarInfoValues, sidebarJobs } from "../sidebar-data.ts";
import { loadAssistantSkills, loadSidebarCollections, loadSidebarFiles, openAssistantPanel, openFilePreview, openJob, openJobs, openSidebarPage, useApp } from "../store.ts";
import { fmtBytes, fmtDuration, fmtElapsed, fmtWhen } from "../util.ts";

export function PanelRootDetails() {
  const s = useApp();
  const aid = s.sel ?? "hob";
  const profile = s.profiles[aid];
  const a = profile?.assistant ?? s.assistants.find((item) => item.id === aid);
  const routines = s.routines.filter((item) => item.assistantId === aid);
  const jobs = sidebarJobs(Object.values(s.jobs), aid).recent;
  const skills = s.assistantSkills[aid];
  const [tab, setTab] = useState<"任务" | "文件" | "日志">("任务");
  const [files, setFiles] = useState<KnowledgeEntry[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [collectionsError, setCollectionsError] = useState("");
  const [collectionsLoading, setCollectionsLoading] = useState(true);
  useEffect(() => { setTab("任务"); setFiles([]); setMore(false); setError(""); void loadAssistantSkills(aid); }, [aid]);
  useEffect(() => { void loadSidebarCollections().catch((e: unknown) => setCollectionsError(e instanceof Error ? e.message : String(e))).finally(() => setCollectionsLoading(false)); }, []);
  useEffect(() => {
    if (tab !== "文件") return;
    let current = true;
    setLoading(true); setError("");
    void loadSidebarFiles(aid).then((page) => { if (current) { setFiles(page.entries); setMore(page.hasMore); } }).catch((e: unknown) => { if (current) setError(e instanceof Error ? e.message : String(e)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [aid, tab]);
  const loadMore = async (retry = false) => {
    setLoading(true); setError("");
    try { const page = await loadSidebarFiles(aid, retry ? undefined : files.at(-1)?.updatedAt); setFiles(retry ? page.entries : [...files, ...page.entries]); setMore(page.hasMore); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };
  const collections = (a?.knowledge ?? []).map((id) => s.knowledge.collections.find((c) => c.id === id)?.name).filter((name): name is string => !!name);
  const values = sidebarInfoValues(skills?.skills.length ?? 0, collections, profile?.rules.length ?? 0);
  const groups = groupSidebarFiles(files);
  return <>
    <div className="sidebar-info">
      <button className="sidebar-instructions" onClick={openAssistantPanel}><small>补充说明</small><span className={a?.instructions ? "" : "muted"}>{a?.instructions || "添加这个助手特有的做法"}</span><b>›</b></button>
      <button onClick={() => openSidebarPage("routines")}><Icon name="clock" size={15} /><span>定时任务</span><small>{routineSummary(routines, s.settings.settings.general.timezone)}</small><b>›</b></button>
      <button onClick={() => openSidebarPage("skills")}><Icon name="mem" size={15} /><span>技能</span><small>{skills?.error ? "加载失败" : !skills || skills.loading ? "正在加载…" : values.skills}</small><b>›</b></button>
      <button onClick={() => openSidebarPage("knowledge")}><Icon name="archive" size={15} /><span>知识库</span><small>{collectionsError ? "加载失败" : collectionsLoading ? "正在加载…" : values.knowledge}</small><b>›</b></button>
      <button onClick={() => openSidebarPage("rules")}><Icon name="rule" size={15} /><span>执行前确认</span><small>{values.rules}</small><b>›</b></button>
    </div>
    <div className="sidebar-tabs"><div className="seg" style={{ "--seg-count": 3, "--seg-index": ["任务", "文件", "日志"].indexOf(tab) } as React.CSSProperties}>{(["任务", "文件", "日志"] as const).map((name) => <button key={name} className={tab === name ? "on" : ""} onClick={() => setTab(name)}>{name}</button>)}</div></div>
    {tab === "任务" ? <div className={jobs.length ? "sidebar-list" : "sidebar-empty"}>{jobs.length ? jobs.map((job) => <button className="sidebar-item" key={job.id} onClick={() => openJob(job.id)}><Icon name={job.status === "running" ? "spin" : job.status === "done" ? "check" : job.status === "failed" || job.status === "stuck" ? "close" : job.status === "stopped" ? "stop" : "pause"} className={job.status === "running" ? "spin" : ""} size={16} /><span><strong>{job.routineId ? "⏱ " : ""}{job.title}</strong><small>{fmtWhen(job.startedAt ?? job.createdAt)}{job.status === "running" || job.status === "waiting" ? ` · 已进行 ${fmtElapsed(job.startedAt ?? job.createdAt)}` : job.durationMs !== undefined ? ` · 用时 ${fmtDuration(job.durationMs)}` : ""}</small></span><b>›</b></button>) : <div className="empty">分派的任务会显示在这里</div>}{jobs.length ? <button className="sidebar-more" onClick={() => openJobs(aid)}>全部任务 ›</button> : null}</div> : null}
    {tab === "文件" ? <div className={files.length || loading || error ? "sidebar-list" : "sidebar-empty"}>{([["本周", groups.week], ["更早", groups.older]] as const).map(([label, items]) => items.length ? <div key={label}><div className="sidebar-group-label">{label}</div>{items.map((entry) => <button className="sidebar-item" key={entry.id} onClick={() => openFilePreview(entry.path, entry.name)}><Icon name={fileIcon(entry.name)} size={18} /><span><strong>{entry.name}</strong><small>{fmtBytes(entry.size)} · {fmtWhen(entry.updatedAt)}</small></span><b>›</b></button>)}</div> : null)}{!files.length && !loading && !error ? <div className="empty">还没有产出文件</div> : null}{error ? <div className="badline">加载失败：{error} <button onClick={() => void loadMore(!files.length)}>重试</button></div> : null}{more && !error ? <button className="sidebar-more" disabled={loading} onClick={() => void loadMore()}>更多</button> : null}</div> : null}
    {tab === "日志" ? <div className={profile?.worklog.length ? "sidebar-list" : "sidebar-empty"}>{profile?.worklog.length ? profile.worklog.map((w, i) => <div className="wl" key={`${w.at}-${i}`}><span className="t">{fmtWhen(w.at)}</span><span>{plainText(w.text)}</span></div>) : <div className="empty">还没有工作日志</div>}</div> : null}
  </>;
}
