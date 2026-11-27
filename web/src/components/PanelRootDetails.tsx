import { t } from "../../../shared/i18n.ts";
import { byStarted } from "../home.ts";
import { panelAssistant } from "../panel-stack.ts";
import { DelayedText, Empty } from "./Empty.tsx";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { fileIcon } from "../file-icons.ts";
import { Icon } from "../icons.tsx";
import { jobStatusIcon } from "./status-meta.tsx";
import { DetailRow } from "./DetailRow.tsx";
import { groupSidebarFiles, routineSummary, sidebarInfoValues } from "../sidebar-data.ts";
import { assistantSessionKey, loadAssistantSkills, loadAssistantTopicConfig, loadGroupProfile, loadSidebarCollections, loadSidebarFiles, loadSidebarJobs, openFilePreview, openJob, openPlugins, openSidebarPage, useApp } from "../store.ts";
import { fmtBytes, fmtDuration, fmtElapsed, fmtWhen } from "../util.ts";

function LoadingRow() { return <div className="sidebar-loading" role="status"><DelayedText text={t("正在读取…")} /></div>; }

export function PanelRootDetails({ groupId, topicId, part, desktopRow, modelsRow, replyModeRow }: { groupId?: string; topicId?: string; part?: "info" | "tabs"; desktopRow?: ReactNode; modelsRow?: ReactNode; replyModeRow?: ReactNode } = {}) {
  const s = useApp();
  const aid = groupId ?? panelAssistant(s.panelStack, s.sel);
  const currentGroup = groupId ? s.groups.find((item) => item.id === groupId) : undefined;
  const isTopic = Boolean(currentGroup?.parentId);
  const isAssistantTopic = Boolean(!groupId && topicId);
  const cacheKey = groupId ?? (topicId ? assistantSessionKey(aid, topicId) : aid);
  const skillsId = currentGroup?.parentId ?? aid;
  const groupProfile = groupId ? s.groupProfiles[groupId] : undefined;
  const topicConfig = isAssistantTopic ? s.assistantTopicConfigs?.[cacheKey] : undefined;
  const profile = s.profiles[aid];
  const a = profile?.assistant ?? s.assistants.find((item) => item.id === aid);
  const routines = s.routines.filter((item) => groupId ? (isTopic ? item.groupId === groupId : item.groupId === groupId || s.groups.some((g) => g.id === item.groupId && g.parentId === groupId)) : item.assistantId === aid && !item.groupId && (!topicId || item.topicId === topicId));
  const skills = s.assistantSkills[skillsId];
  // 页签的键不跟语言走，显示的标签渲染时再翻
  const [tab, setTab] = useState<"jobs" | "files">("jobs");
  const [collectionsError, setCollectionsError] = useState("");
  const [collectionsLoading, setCollectionsLoading] = useState(!s.knowledge.collectionsLoaded);
  const jobsPage = s.sidebarJobs?.[cacheKey];
  const filesPage = s.sidebarFiles?.[cacheKey];
  const files = filesPage?.items ?? [];
  const jobs = Object.values({ ...Object.fromEntries((jobsPage?.items ?? []).map((job) => [job.id, job])), ...s.jobs }).filter((job) => groupId ? (isTopic ? job.groupId === groupId : job.groupId === groupId || s.groups.some((g) => g.id === job.groupId && g.parentId === groupId)) : job.assistantId === aid && !job.groupId && (!topicId || job.topicId === topicId)).sort(byStarted);
  const seenJobs = useRef<{ key: string; ids: Set<string> } | null>(null);
  const jobsReady = useRef(false);
  if (!seenJobs.current || seenJobs.current.key !== cacheKey) { seenJobs.current = { key: cacheKey, ids: new Set() }; jobsReady.current = false; }
  const freshJobs = jobsPage?.loaded ? new Set(jobs.filter((job) => !seenJobs.current!.ids.has(job.id)).map((job) => job.id)) : new Set<string>();
  useEffect(() => { if (!jobsPage?.loaded) { jobsReady.current = false; return; } jobs.forEach((job) => seenJobs.current?.ids.add(job.id)); jobsReady.current = true; });
  useEffect(() => {
    setTab("jobs");
    if (part !== "tabs") {
      void loadAssistantSkills(skillsId);
      if (groupId) void loadGroupProfile(groupId);
      else if (topicId) void loadAssistantTopicConfig(aid, topicId);
    }
    if (part !== "info") void loadSidebarJobs(aid, false, topicId);
  }, [aid, skillsId, groupId, topicId, part]);
  useEffect(() => { if (!groupId && !topicId && !s.knowledge.collectionsLoaded) { setCollectionsLoading(true); setCollectionsError(""); void loadSidebarCollections().catch((e: unknown) => setCollectionsError(e instanceof Error ? e.message : String(e))).finally(() => setCollectionsLoading(false)); } }, [groupId, topicId, s.knowledge.collectionsLoaded]);
  useEffect(() => { if (tab === "files") void loadSidebarFiles(aid, false, topicId); }, [aid, topicId, tab]);
  const page = tab === "jobs" ? jobsPage : filesPage;
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !page?.hasMore || page.loading || page.error) return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) void (tab === "jobs" ? loadSidebarJobs(aid, true, topicId) : loadSidebarFiles(aid, true, topicId)); }, { root: element.closest(".panel") });
    observer.observe(element);
    return () => observer.disconnect();
  }, [aid, topicId, tab, page?.hasMore, page?.loading, page?.error, page?.cursor]);
  const collections = (a?.knowledge ?? []).map((id) => s.knowledge.collections.find((c) => c.id === id)?.name).filter((name): name is string => !!name);
  const ruleCount = groupId ? groupProfile?.value?.rules.length ?? 0 : isAssistantTopic ? topicConfig?.value?.rules.length ?? 0 : profile?.rules.length ?? 0;
  const values = sidebarInfoValues(skills?.skills.length ?? 0, collections, ruleCount);
  const groups = groupSidebarFiles(files);
  const topicLabel = (id?: string) => {
    if (!id || groupId || isAssistantTopic || !a?.topics) return "";
    const topic = (s.assistantTopics ?? []).find((item) => item.id === id && item.assistantId === aid);
    return topic ? `${t("「{name}」", { name: topic.name })} · ` : "";
  };
  return <>
    {part !== "tabs" ? <div className="group-card sidebar-info">
      <button onClick={() => openSidebarPage("routines", groupId, topicId)}><Icon name="clock" size={15} /><span>{t("定时任务")}</span><small>{routineSummary(routines, s.settings.settings.general.timezone)}</small><b>›</b></button>
      {desktopRow}
      <button onClick={() => openSidebarPage("skills", skillsId)}><Icon name="book" size={15} /><span>{t("技能")}</span><small>{skills?.error ? t("加载失败") : !skills?.loaded ? <DelayedText key={skillsId} text={t("正在加载…")} /> : isTopic ? (skills.skills.length ? `${t("本群共用")} · ${values.skills}` : t("本群共用")) : isAssistantTopic ? (skills.skills.length ? `${t("跟随助手")} · ${values.skills}` : t("跟随助手")) : values.skills}</small><b>›</b></button>
      {!groupId && !isAssistantTopic ? <button onClick={() => openPlugins()}><Icon name="plugin" size={15} /><span>{t("插件")}</span><b>›</b></button> : null}
      {!groupId && !isAssistantTopic ? <button onClick={() => openSidebarPage("knowledge")}><Icon name="archive" size={15} /><span>{t("知识库")}</span><small>{collectionsError ? t("加载失败") : collectionsLoading ? <DelayedText text={t("正在加载…")} /> : values.knowledge}</small><b>›</b></button> : null}
      <button onClick={() => openSidebarPage(isTopic || isAssistantTopic ? "topicRules" : "rules", groupId, topicId)}><Icon name="rule" size={15} /><span>{t("规则")}</span><small>{groupId && groupProfile?.error ? t("加载失败") : groupId && !groupProfile?.value ? <DelayedText text={t("正在加载…")} /> : isAssistantTopic && topicConfig?.error ? t("加载失败") : isAssistantTopic && !topicConfig?.value ? <DelayedText text={t("正在加载…")} /> : values.rules}</small><b>›</b></button>
      {modelsRow}
      {replyModeRow}
    </div> : null}
    {part !== "info" ? <>
    <div className="sidebar-tabs"><div className="seg" style={{ "--seg-count": 2, "--seg-index": tab === "jobs" ? 0 : 1 } as React.CSSProperties}>{([{ key: "jobs", label: t("任务") }, { key: "files", label: t("文件") }] as const).map(({ key, label }) => <button key={key} className={tab === key ? "on" : ""} onClick={() => setTab(key)}>{label}</button>)}</div></div>
    <div key={tab} className="sidebar-tab-content"><div className="group-card sidebar-list">
      {tab === "jobs" ? jobs.map((job) => <div className={`srow${jobsReady.current && freshJobs.has(job.id) ? " enter" : ""}`} key={job.id}><div className="srowclip"><DetailRow leading={jobStatusIcon(job.status, 16)} title={<>{job.routineId ? "⏱ " : ""}{job.title}</>} detail={`${groupId ? `${s.assistants.find((item) => item.id === job.assistantId)?.name ?? job.assistantName ?? job.assistantId} · ` : topicLabel(job.topicId)}${fmtWhen(job.startedAt ?? job.createdAt)}${job.status === "running" || job.status === "waiting" ? ` · ${t("已进行 {time}", { time: fmtElapsed(job.startedAt ?? job.createdAt) })}` : job.durationMs !== undefined ? ` · ${t("用时 {duration}", { duration: fmtDuration(job.durationMs) })}` : ""}`} onClick={() => openJob(job.id)} /></div></div>) : ([ [t("本周"), groups.week], [t("更早"), groups.older] ] as const).map(([label, items]) => items.length ? <div key={label}><div className="sidebar-group-label">{label}</div>{items.map((entry) => <DetailRow key={entry.id} leading={<Icon name={fileIcon(entry.name)} size={18} />} title={entry.name} detail={`${topicLabel(entry.source?.topicId)}${fmtBytes(entry.size)} · ${fmtWhen(entry.updatedAt)}`} onClick={() => openFilePreview(entry.path, entry.name)} />)}</div> : null)}
      {page?.loaded && !(tab === "jobs" ? jobs.length : files.length) && !page.error ? <Empty>{tab === "jobs" ? t("分派的任务会显示在这里") : t("还没有产出文件")}</Empty> : null}
      {page?.error ? <div className="badline">{t("加载失败：{error}", { error: page.error })} <button onClick={() => void (tab === "jobs" ? loadSidebarJobs(aid, page.failedMore, topicId) : loadSidebarFiles(aid, page.failedMore, topicId))}>{t("重试")}</button></div> : null}
      {(!page?.loaded && !page?.error) || page?.loadingMore ? <LoadingRow /> : null}
      {page?.hasMore && !page.error ? <div ref={sentinel} /> : null}
    </div></div></> : null}
  </>;
}
