// 群的话题：桌面左栏的二级页、手机的话题列表、开话题对话框。
// 行怎么分组、头像取谁在 ../topics.ts，左栏话题行的待办标签在 ./status-meta.tsx，这里只管画。
import { t } from "../../../shared/i18n.ts";
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DialogShell } from "./DialogShell.tsx";
import type { AssistantSummary, AssistantTopicSummary, GroupSummary, Job, TodoItem } from "../../../shared/types.ts";
import { plainText } from "../../../shared/plain-text.ts";
import { Icon } from "../icons.tsx";
import { Avatar } from "../sprites.tsx";
import {
  closeAssistantTopic,
  closeTopic,
  goHome,
  leaveTopicList,
  openAssistantMain,
  openAssistantTopic,
  openGroupHome,
  openJob,
  openKnowledge,
  openNewAssistantTopic,
  openSettings,
  openTopic,
  pinTopic,
  reopenAssistantTopic,
  reopenTopic,
  selectGroup,
  toggleSideCollapsed,
  useApp,
} from "../store.ts";
import { fmtElapsed, fmtList } from "../util.ts";
import { JOB_STATUS } from "./status-meta.tsx";
import { assistantTopicGroups, ownerGroup, topicFace, topicGroups, topicPreview } from "../topics.ts";
import { GroupCluster, groupPreview } from "./Groups.tsx";
import { todoStamp } from "./status-meta.tsx";
import { UpdateDot, availableVersion } from "./SettingsParts.tsx";
import { useContextBox, useHoldMenu } from "./hold-menu.ts";

/** 群头部第二行：几个成员。 */
export function membersLine(g: GroupSummary): string {
  return t("{n} 位成员", { n: g.members.length });
}

function Unread({ g, waiting = false }: { g: { unread: number; busy: boolean | string[] }; waiting?: boolean }) {
  if (waiting) return <span className="topic-waiting" title={t("等你确认")} aria-label={t("等你确认")}>?</span>;
  if (g.unread > 0) return <span className="topic-unread">{g.unread}</span>;
  const isBusy = Array.isArray(g.busy) ? g.busy.length > 0 : Boolean(g.busy);
  if (isBusy) return <span className="topic-busy" title={t("进行中")} aria-label={t("进行中")} />;
  return null;
}

/** 通用于群话题和助手话题的行数据。 */
export interface TopicRowData {
  id: string;
  name: string;
  purpose?: string;
  ownerId?: string;
  createdAt: string;
  closedAt?: string;
  closeNote?: string;
  pinnedAt?: string;
  last?: { at: string; speaker?: string | "user"; text: string };
  unread: number;
  busy: boolean | string[];
  todos?: TodoItem[];
}

export interface GeneralRowProps {
  g?: GroupSummary;
  title?: string;
  icon?: ReactNode;
  time?: string;
  preview?: string;
  unread?: number;
  busy?: boolean | string[];
  waiting?: boolean;
  sel?: boolean;
  onClick: () => void;
}

/** 「综合」或「主对话」那一行：图标、标题、最后一条的预览、时间、未读。 */
export function GeneralRow({ g, title, icon, time, preview, unread, busy, waiting = false, sel, onClick }: GeneralRowProps) {
  const s = useApp();
  const rowTitle = title ?? t("综合");
  const rowIcon = icon ?? <span className="topic-hash" aria-hidden="true"><Icon name="hash" size={20} /></span>;
  const rowTime = time ?? fmtList(g?.last?.at);
  const rowPreview = preview ?? (g ? groupPreview(g, s.assistants) : "");
  const rowUnread = unread ?? g?.unread ?? 0;
  const rowBusy = busy ?? g?.busy ?? [];
  return (
    <button className={`list-row home-row topic-row general-row${sel ? " sel" : ""}`} onClick={onClick}>
      {rowIcon}
      <div className="main">
        <div className="l1">
          <span className="nm">{rowTitle}</span>
          <span className="tm">{rowTime}</span>
        </div>
        <div className="pv">{rowPreview}</div>
      </div>
      <Unread g={{ unread: rowUnread, busy: rowBusy }} waiting={waiting} />
    </button>
  );
}

/** 一行话题：头像、标题、置顶标识与时间、状态标签加预览、未读；进行中支持右键 / 长按置顶。关了的灰一些。 */
export function TopicRow<T extends TopicRowData>({
  g,
  sel,
  face,
  waiting = false,
  pinnable = true,
  onSelect,
  onPin,
}: {
  g: T;
  sel?: boolean;
  face?: ReactNode;
  waiting?: boolean;
  pinnable?: boolean;
  onSelect?: () => void;
  onPin?: (pinned: boolean) => void;
}) {
  const s = useApp();
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const canPin = pinnable && !g.closedAt;
  const hold = useHoldMenu((x, y) => setMenuPos({ x, y }), canPin);
  const menuBox = useContextBox(canPin ? menuPos : null, () => setMenuPos(null));

  const faceId = face === undefined ? topicFace(g) : undefined;
  const faceAssistant = faceId ? s.assistants.find((a) => a.id === faceId) : undefined;
  const avatar = face !== undefined
    ? face
    : faceAssistant
      ? <Avatar sprite={faceAssistant.sprite} prop={faceAssistant.prop} size={36} />
      : <span className="topic-hash" aria-hidden="true"><Icon name="hash" size={18} /></span>;
  const stamp = todoStamp(g);
  const pinned = Boolean(pinnable && !g.closedAt && g.pinnedAt);
  const togglePin = () => {
    setMenuPos(null);
    if (onPin) onPin(!g.pinnedAt);
    else void pinTopic(g.id, !g.pinnedAt);
  };

  return (
    <>
      <button
        className={`list-row home-row topic-row${sel ? " sel" : ""}${g.closedAt ? " closed" : ""}${pinned ? " pinned" : ""}`}
        onPointerDown={canPin ? hold.handlers.onPointerDown : undefined}
        onPointerMove={canPin ? hold.handlers.onPointerMove : undefined}
        onPointerUp={canPin ? hold.handlers.onPointerUp : undefined}
        onPointerCancel={canPin ? hold.handlers.onPointerCancel : undefined}
        onContextMenu={canPin ? hold.handlers.onContextMenu : undefined}
        onClick={() => {
          if (canPin && hold.takeHeld()) return;
          if (onSelect) onSelect();
          else void selectGroup(g.id);
        }}
      >
        {avatar}
        <div className="main">
          <div className="l1">
            <span className="nm">{g.name}</span>
            <span className="topic-l1-end">
              {pinned ? <span className="topic-pin" title={t("已置顶")} aria-label={t("已置顶")}><Icon name="pin" size={12} /></span> : null}
              <span className="tm">{fmtList(g.closedAt ?? g.last?.at)}</span>
            </span>
          </div>
          <div className="pv">
            {stamp ? <span className="topic-stamp" title={stamp.title}>{stamp.text}</span> : null}
            <span className="topic-preview">{topicPreview(g, s.assistants)}</span>
          </div>
        </div>
        <Unread g={g} waiting={waiting} />
      </button>
      {canPin && menuPos ? createPortal(
        <div className="amenu topic-menu" ref={menuBox} role="menu" onContextMenu={(e) => e.preventDefault()}>
          <button type="button" role="menuitem" onClick={togglePin}>
            {g.pinnedAt ? t("取消置顶") : t("置顶")}
          </button>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

/** 已关闭那一节默认列最近 5 个，多了给一个「查看全部」。 */
function ClosedRows<T extends TopicRowData>({
  list,
  showAll,
  onMore,
  isSelected,
  renderFace,
  onSelect,
  pinnable = true,
  isWaiting,
  isBusy,
}: {
  list: T[];
  showAll: boolean;
  onMore: () => void;
  isSelected?: (item: T) => boolean;
  renderFace?: (item: T) => ReactNode;
  onSelect?: (item: T) => void;
  pinnable?: boolean;
  isWaiting?: (item: T) => boolean;
  isBusy?: (item: T) => boolean | string[];
}) {
  const s = useApp();
  const rows = showAll ? list : list.slice(0, 5);
  return (
    <>
      {rows.map((g) => (
        <TopicRow
          key={g.id}
          g={isBusy ? { ...g, busy: isBusy(g) } : g}
          sel={isSelected ? isSelected(g) : s.gsel === g.id}
          face={renderFace ? renderFace(g) : undefined}
          waiting={isWaiting ? isWaiting(g) : false}
          pinnable={pinnable}
          onSelect={onSelect ? () => onSelect(g) : undefined}
        />
      ))}
      {!showAll && list.length > 5 ? (
        <button className="fold gtopic-more" onClick={onMore}>{t("查看全部已关闭的话题")} <Icon name="chev" size={13} /></button>
      ) : null}
    </>
  );
}

/**
 * 桌面左栏的群二级页：返回、群头像和名字、成员和人数、开新话题；下面是综合和话题。
 * 返回只把左栏换回首页，中间照旧开着当前这个对话。
 */
export function GroupSidebar({ groupId }: { groupId?: string }) {
  const s = useApp();
  const g = ownerGroup(s.groups, groupId ?? s.gsel);
  const [creating, setCreating] = useState(false);
  const [showAllClosed, setShowAllClosed] = useState(false);
  if (!g) return null;
  const groups = topicGroups(s.groups, g.id);
  const updateVersion = availableVersion(s.update);

  return (
    <aside className="side gside">
      <div className="gside-head">
        <button className="hob-icon-btn" title={t("返回首页")} onClick={goHome}>
          <Icon name="left" size={20} />
        </button>
        <GroupCluster g={g} assistants={s.assistants} size={30} />
        <span className="gside-id">
          <strong>{g.name}</strong>
          <small>{membersLine(g)}</small>
        </span>
        <button className="hob-icon-btn" title={t("收起左栏")} aria-label={t("收起左栏")} onClick={toggleSideCollapsed}><Icon name="panel" size={18} style={{ transform: "scaleX(-1)" }} /></button>
        <button className="hob-icon-btn" title={t("创建新话题")} onClick={() => setCreating(true)}>
          <Icon name="plus" size={19} />
        </button>
      </div>
      <div className="side-scroll gside-rows">
        <GeneralRow g={g} sel={s.gsel === g.id} onClick={() => void selectGroup(g.id)} />
        {groups.active.length ? <div className="gt"><span>{t("进行中 {n}", { n: groups.active.length })}</span></div> : null}
        {groups.active.map((topic) => <TopicRow key={topic.id} g={topic} sel={s.gsel === topic.id} />)}
        {groups.closed.length ? <div className="gt"><span>{t("已关闭 {n}", { n: groups.closed.length })}</span></div> : null}
        <ClosedRows list={groups.closed} showAll={showAllClosed} onMore={() => setShowAllClosed(true)} />
      </div>
      <div className="side-foot">
        <button className="frow" onClick={openKnowledge}>
          <Icon name="archive" size={18} />
          <span className="sp">{t("知识库")}</span>
        </button>
        <button className="frow" onClick={openSettings}>
          <Icon name="gear" size={18} />
          <span className="sp">
            {t("设置")}
            {updateVersion ? <UpdateDot version={updateVersion} /> : null}
          </span>
        </button>
      </div>
      {creating ? <NewTopicDialog group={g} onClose={() => setCreating(false)} /> : null}
    </aside>
  );
}

/** 手机上的话题列表：页面头部是群，第一行综合，然后进行中的话题，最后是已关闭。 */
export function MobileTopics({ groupId }: { groupId?: string }) {
  const s = useApp();
  const g = ownerGroup(s.groups, groupId ?? s.gsel);
  const [creating, setCreating] = useState(false);
  const [showAllClosed, setShowAllClosed] = useState(false);
  if (!g) return null;
  const groups = topicGroups(s.groups, g.id);
  return (
    <>
      <div className="mhead gtopics-head">
        <button className="hob-icon-btn" title={t("返回")} onClick={leaveTopicList}>
          <Icon name="left" size={22} />
        </button>
        <GroupCluster g={g} assistants={s.assistants} size={30} />
        <span className="gside-id">
          <strong>{g.name}</strong>
          <small>{membersLine(g)}</small>
        </span>
        <span className="sp" />
        <button className="hob-icon-btn" title={t("创建新话题")} onClick={() => setCreating(true)}>
          <Icon name="plus" size={20} />
        </button>
      </div>
      <div className="mlist gtopics-list">
        <GeneralRow g={g} sel={false} onClick={() => void openGroupHome(g.id)} />
        {groups.active.map((topic) => <TopicRow key={topic.id} g={topic} sel={s.gsel === topic.id} />)}
        {groups.closed.length ? <div className="gt"><span>{t("已关闭")}</span></div> : null}
        <ClosedRows list={groups.closed} showAll={showAllClosed} onMore={() => setShowAllClosed(true)} />
      </div>
      {creating ? <NewTopicDialog group={g} onClose={() => setCreating(false)} /> : null}
    </>
  );
}

function assistantRowFlags(s: ReturnType<typeof useApp>, assistantId: string, topicId?: string) {
  const approvals = Object.values(s.approvals ?? {});
  const jobs = Object.values(s.jobs ?? {});
  const waiting = approvals.some(
    (ap) =>
      ap.status === "pending" &&
      ap.assistantId === assistantId &&
      !ap.groupId &&
      (topicId ? ap.topicId === topicId : !ap.topicId) &&
      ap.source !== "job",
  );
  const jobBusy = jobs.some(
    (j) =>
      j.assistantId === assistantId &&
      !j.groupId &&
      (topicId ? j.topicId === topicId : !j.topicId) &&
      (j.status === "running" || j.status === "waiting"),
  );
  return { waiting, jobBusy };
}

function AssistantTopicRows({ a, mobile = false }: { a: AssistantSummary; mobile?: boolean }) {
  const s = useApp();
  const [showAllClosed, setShowAllClosed] = useState(false);
  const topics = assistantTopicGroups(s.assistantTopics ?? [], a.id);
  const mainFlags = assistantRowFlags(s, a.id);
  const topicIcon = <span className="topic-hash" aria-hidden="true"><Icon name="hash" size={18} /></span>;

  const renderTopic = (topic: AssistantTopicSummary) => {
    const flags = assistantRowFlags(s, a.id, topic.id);
    return (
      <TopicRow
        key={topic.id}
        g={{ ...topic, busy: Boolean(topic.busy || flags.jobBusy) }}
        sel={!mobile && s.sel === a.id && s.tsel === topic.id}
        face={topicIcon}
        waiting={flags.waiting}
        pinnable={false}
        onSelect={() => void openAssistantTopic(a.id, topic.id)}
      />
    );
  };

  return (
    <>
      <GeneralRow
        title={t("主对话")}
        icon={<Avatar sprite={a.sprite} prop={a.prop} size={36} />}
        time={fmtList(a.last?.at)}
        preview={a.last ? plainText(a.last.text) : a.duty}
        unread={a.unread}
        busy={Boolean(a.busy || mainFlags.jobBusy)}
        waiting={mainFlags.waiting}
        sel={!mobile && s.sel === a.id && !s.tsel && !s.newTopic}
        onClick={() => void openAssistantMain(a.id)}
      />
      {topics.active.length ? <div className="gt"><span>{t("进行中 {n}", { n: topics.active.length })}</span></div> : null}
      {topics.active.map(renderTopic)}
      {topics.closed.length ? <div className="gt"><span>{t("已关闭 {n}", { n: topics.closed.length })}</span></div> : null}
      <ClosedRows
        list={topics.closed}
        showAll={showAllClosed}
        onMore={() => setShowAllClosed(true)}
        pinnable={false}
        renderFace={() => topicIcon}
        isSelected={(topic) => !mobile && s.sel === a.id && s.tsel === topic.id}
        isBusy={(topic) => Boolean(topic.busy || assistantRowFlags(s, a.id, topic.id).jobBusy)}
        isWaiting={(topic) => assistantRowFlags(s, a.id, topic.id).waiting}
        onSelect={(topic) => void openAssistantTopic(a.id, topic.id)}
      />
    </>
  );
}

/** 桌面左栏的多话题助手二级页：返回首页、助手头像和名字、职责简介、创建新话题；下面是主对话和话题。 */
export function AssistantSidebar({ assistantId }: { assistantId?: string }) {
  const s = useApp();
  const a = s.assistants.find((x) => x.id === (assistantId ?? s.sel));
  if (!a || !a.topics) return null;
  const updateVersion = availableVersion(s.update);
  return (
    <aside className="side gside">
      <div className="gside-head">
        <button className="hob-icon-btn" title={t("返回首页")} onClick={goHome}>
          <Icon name="left" size={20} />
        </button>
        <Avatar sprite={a.sprite} prop={a.prop} size={30} />
        <span className="gside-id">
          <strong>{a.name}</strong>
          <small>{a.duty}</small>
        </span>
        <button className="hob-icon-btn" title={t("收起左栏")} aria-label={t("收起左栏")} onClick={toggleSideCollapsed}>
          <Icon name="panel" size={18} style={{ transform: "scaleX(-1)" }} />
        </button>
        <button className="hob-icon-btn" title={t("创建新话题")} onClick={() => openNewAssistantTopic(a.id)}>
          <Icon name="plus" size={19} />
        </button>
      </div>
      <div className="side-scroll gside-rows">
        <AssistantTopicRows a={a} />
      </div>
      <div className="side-foot">
        <button className="frow" onClick={openKnowledge}>
          <Icon name="archive" size={18} />
          <span className="sp">{t("知识库")}</span>
        </button>
        <button className="frow" onClick={openSettings}>
          <Icon name="gear" size={18} />
          <span className="sp">
            {t("设置")}
            {updateVersion ? <UpdateDot version={updateVersion} /> : null}
          </span>
        </button>
      </div>
    </aside>
  );
}

/** 手机上的多话题助手列表页：头部是助手，第一行主对话，然后进行中与已关闭话题。 */
export function MobileAssistantTopics({ assistantId }: { assistantId?: string }) {
  const s = useApp();
  const a = s.assistants.find((x) => x.id === (assistantId ?? s.sel));
  if (!a || !a.topics) return null;
  return (
    <>
      <div className="mhead gtopics-head">
        <button className="hob-icon-btn" title={t("返回")} onClick={leaveTopicList}>
          <Icon name="left" size={22} />
        </button>
        <Avatar sprite={a.sprite} prop={a.prop} size={30} />
        <span className="gside-id">
          <strong>{a.name}</strong>
          <small>{a.duty}</small>
        </span>
        <span className="sp" />
        <button className="hob-icon-btn" title={t("创建新话题")} onClick={() => openNewAssistantTopic(a.id)}>
          <Icon name="plus" size={20} />
        </button>
      </div>
      <div className="mlist gtopics-list">
        <AssistantTopicRows a={a} mobile />
      </div>
    </>
  );
}

const ACTIVE_JOB: Job["status"][] = ["running", "queued", "waiting"];

/**
 * 右栏「正在做」：这些地方（群和它的话题，或者一个话题）里还没结束的任务，谁在做、在哪、做了多久；点开看任务。
 */
export function PlaceJobs({ ids, where = true }: { ids: string[]; where?: boolean }) {
  const s = useApp();
  const jobs = Object.values(s.jobs)
    .filter((job) => job.groupId && ids.includes(job.groupId) && ACTIVE_JOB.includes(job.status))
    .sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt));
  if (!jobs.length) return null;
  return (
    <div className="group-card gmembers place-jobs">
      <span className="gm-title">{t("进行中 · {n}", { n: jobs.length })}</span>
      {jobs.map((job) => {
        const a = s.assistants.find((x) => x.id === job.assistantId);
        const place = s.groups.find((g) => g.id === job.groupId);
        const parts = [a?.name ?? job.assistantId, where ? (place?.parentId ? t("「{name}」", { name: place.name }) : t("综合")) : "", `${JOB_STATUS[job.status].text} ${fmtElapsed(job.startedAt ?? job.createdAt)}`].filter(Boolean);
        return (
          <button key={job.id} className="gm-row" onClick={() => openJob(job.id)}>
            {a ? <Avatar sprite={a.sprite} prop={a.prop} size={30} /> : null}
            <span>
              <strong>{job.title}</strong>
              <small>{parts.join(" · ")}</small>
            </span>
            <Icon name="chev" size={13} />
          </button>
        );
      })}
    </div>
  );
}

/** 开新话题的小对话框：一个话题名，建好直接进这个话题，失败在框里显示原因。 */
export function NewTopicDialog({ group, onClose }: { group: GroupSummary; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [cwd, setCwd] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    const failure = await openTopic(group.id, title.trim(), group.cwd ? undefined : cwd.trim() || undefined);
    setBusy(false);
    if (failure) setError(failure);
    else onClose();
  };
  return <DialogShell label={t("新话题")} title={t("新话题")} className="topic-create" onClose={onClose} onSubmit={(event) => { event.preventDefault(); void submit(); }} actions={<><button type="button" className="hob-btn" onClick={onClose}>{t("取消")}</button><button type="submit" className="hob-btn hob-btn-primary" disabled={busy || !title.trim()}>{t("创建话题")}</button></>}>
        <label className="gcreate-field">
          <span>{t("话题名")}</span>
          <input autoFocus maxLength={40} value={title} placeholder={t("一件事，如「相册备份出错」")} onChange={(event) => setTitle(event.target.value)} />
        </label>
        {group.cwd ? (
          <div className="gcreate-field">
            <span>{t("工作目录")}</span>
            <div className="field ro" title={group.cwd}>{t("跟随群（{path}）", { path: group.cwd })}</div>
          </div>
        ) : (
          <label className="gcreate-field">
            <span>{t("工作目录（可选）")}</span>
            <input value={cwd} placeholder={t("如 /workspace/app，创建后不可修改")} onChange={(event) => setCwd(event.target.value)} />
          </label>
        )}
        {error ? <div className="gcreate-error">{error}</div> : null}
      </DialogShell>;
}

function isAssistantTopicTarget(topic: { id: string; assistantId?: string; members?: string[] }): topic is AssistantTopicSummary {
  return typeof topic.assistantId === "string" && !("members" in topic && Array.isArray(topic.members));
}

/** 话题的关闭 / 重新打开控件：支持群话题与助手话题，确认时可填选填结论。 */
export function TopicClose({
  topic,
  initialConfirming = false,
  variant = "panel",
  mobile = false,
}: {
  topic: GroupSummary | AssistantTopicSummary;
  initialConfirming?: boolean;
  variant?: "panel" | "header";
  mobile?: boolean;
}) {
  const s = useApp();
  const [confirming, setConfirming] = useState(initialConfirming);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isAssistantTopic = isAssistantTopicTarget(topic);
  const activeRoutines = (s.routines ?? []).filter((r) => (isAssistantTopic ? r.topicId === topic.id : r.groupId === topic.id) && r.active).length;
  const run = (work: () => Promise<string | null>) => {
    setBusy(true);
    setError("");
    void work().then((failure) => {
      setBusy(false);
      if (failure) setError(failure);
      else {
        setConfirming(false);
        setNote("");
      }
    });
  };
  const closeFn = () => (isAssistantTopic ? closeAssistantTopic(topic.assistantId, topic.id, note.trim() || undefined) : closeTopic(topic.id, note.trim() || undefined));
  const reopenFn = () => (isAssistantTopic ? reopenAssistantTopic(topic.assistantId, topic.id) : reopenTopic(topic.id));

  const confirmCard = (
    <div className="group-card sidebar-card-group mergeconfirm">
      {t("关闭「{name}」？", { name: topic.name })}
      {activeRoutines > 0 ? <div style={{ marginTop: 4 }}>{t("这个话题有 {n} 个定时任务，关闭后暂停，重新打开时恢复", { n: activeRoutines })}</div> : null}
      <input
        className="topic-close-note"
        type="text"
        value={note}
        placeholder={t("结论（选填）")}
        onChange={(event) => setNote(event.target.value)}
      />
      {error ? <div className="badline" style={{ marginTop: 6 }}>{error}</div> : null}
      <div className="acts">
        <button className="hob-btn hob-btn-primary" disabled={busy} onClick={() => run(closeFn)}>{t("确认关闭")}</button>
        <button className="hob-btn" onClick={() => { setConfirming(false); setError(""); }}>{t("取消")}</button>
      </div>
    </div>
  );

  if (variant === "header") {
    if (topic.closedAt) return null;
    return (
      <div className="topic-close-header">
        {mobile ? (
          <button className="chead-btn" title={t("关闭这个话题")} aria-label={t("关闭这个话题")} onClick={() => setConfirming((v) => !v)}>
            <Icon name="archive" size={18} />
          </button>
        ) : (
          <button className="topic-close-pill" title={t("关闭这个话题")} aria-label={t("关闭这个话题")} onClick={() => setConfirming((v) => !v)}>
            <Icon name="archive" size={15} />
            <span>{t("关闭这个话题")}</span>
          </button>
        )}
        {confirming ? <div className="topic-close-pop">{confirmCard}</div> : null}
      </div>
    );
  }

  return (
    <>
      {error && !confirming ? <div className="badline">{error}</div> : null}

      {topic.closedAt ? (
        <button className="gm-end" disabled={busy} onClick={() => run(reopenFn)}>{t("重新打开")}</button>
      ) : confirming ? (
        confirmCard
      ) : (
        <button className="gm-end" onClick={() => setConfirming(true)}>{t("关闭这个话题")}</button>
      )}
    </>
  );
}

/** 话题关了：输入框换成一句说明和「重新打开」，closeNote 有就一并写出来。 */
export function ClosedTopic({ g }: { g: GroupSummary | AssistantTopicSummary }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isAssistantTopic = isAssistantTopicTarget(g);
  return (
    <div className="compwrap">
      <div className="col">
        <div className="comp closed-comp">
          <div className="closed-main">
            <strong>{t("这个话题已关闭")}</strong>
            {g.closeNote ? <span className="closed-note">{g.closeNote}</span> : null}
            {error ? <span className="badline">{t("重新打开失败：{error}", { error })}</span> : null}
          </div>
          <button
            className="hob-btn"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError("");
              const work = isAssistantTopic ? reopenAssistantTopic(g.assistantId, g.id) : reopenTopic(g.id);
              void work.then((failure) => {
                setBusy(false);
                if (failure) setError(failure);
              });
            }}
          >
              {t("重新打开")}
          </button>
        </div>
      </div>
    </div>
  );
}
