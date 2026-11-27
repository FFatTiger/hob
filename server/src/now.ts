import type { HobRuntime } from "./runtime.ts";
import { nowText } from "./time.ts";
import { sessionOrigin } from "./origin.ts";
import { placeOf, samePlace } from "./place.ts";
import { openHandedOverTopics } from "./store.ts";
import { readTodoBook, sessionTodosPath, todoProgress, todosBlockText, todosReminderText } from "./todos.ts";
import type { Job, Place } from "../../shared/types.ts";

/** 还没结束的状态。 */
const ACTIVE = new Set(["running", "queued", "waiting"]);

/**
 * 每条 Router 消息附带的当前状态，不显示在对话里。
 * 范围和用户在这个会话页面上看得到的一样：
 * - 群的综合：综合 + 本群所有话题（群里所有成员的任务、待确认提问、正在回复和话题动态）；
 * - 群话题：只列这个话题（所有成员）；
 * - 单聊 / 主对话 / 助手话题：只列这个助手自己的（不出现别的助手的任务；主对话附带下属话题动态）。
 */
export function nowBlock(runtime: HobRuntime, assistantId: string, current?: Place): string {
  const now = new Date();
  const timezone = runtime.settings.settings.general.timezone;
  const clock = (value: string) => new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
  const short = (value: string) => Array.from(value).length > 20 ? `${Array.from(value).slice(0, 20).join("")}…` : value;
  const nameOf = (id: string, fallback?: string) => fallback ?? runtime.store.assistant?.(id)?.name ?? id;

  const currentGroup = current?.groupId ? runtime.store.group?.(current.groupId) : undefined;
  const isGroup = Boolean(current?.groupId);
  const isGroupTopic = Boolean(currentGroup?.parentId);
  const isGroupGeneral = isGroup && !isGroupTopic;
  const isAssistantMain = !isGroup && !current?.topicId && Boolean(runtime.store.assistant?.(assistantId)?.topics);

  const jobs = runtime.store.jobs().filter((job) => {
    if (isGroup) {
      if (isGroupTopic) return job.groupId === current!.groupId;
      return runtime.store.groupMatches(current!.groupId!, job.groupId);
    }
    return job.assistantId === assistantId;
  });

  const lines = [`【现在】${nowText(timezone, now)}`];
  // 手上的这份待办：每轮都带给模型，它自己清或换；收起的（旧的那几份）不带，历史不进上下文
  const book = readTodoBook(sessionTodosPath(runtime.home, assistantId, current));
  if (book.items.length) {
    lines.push(todosBlockText(book.items, book.updatedAt, timezone, now));
    // 好几轮没更新、还有没做完的：接一句事实，做什么由模型判断（提醒过以后要过几轮才再说）
    const reminder = todosReminderText(runtime.router?.sessionEntries?.(assistantId, current) ?? [], book.items, book.updatedAt);
    if (reminder) lines.push(reminder);
  }

  // 本会话正在回复的其他成员（群的综合、群话题）
  if (isGroup) {
    const speaking = (runtime.router?.busyMembers?.(current!.groupId!) ?? []).filter((id) => id !== assistantId);
    if (speaking.length) lines.push(`正在回复：${speaking.map((id) => nameOf(id)).join("、")}`);
  }

  // 这个会话自己的：单聊就是没有 groupId/topicId 的
  const mine = (where: Place) => samePlace(where, current);
  // 别处的范围和页面可见范围一致：综合看本群所有话题；群话题只看本话题；单聊/主对话/助手话题看本助手在别处的任务与提问
  const elsewhere = (where: Place) => {
    if (mine(where)) return false;
    if (isGroupTopic) return false;
    if (isGroup) return runtime.store.groupMatches(current!.groupId!, where.groupId);
    return true;
  };
  const originOf = (where: Place) => sessionOrigin(runtime.store, where, current, assistantId);
  const stateOf = (job: Job) => {
    if (job.status === "queued") return job.after?.length ? `排队中（等 ${job.after.join("、")}）` : "排队中";
    if (job.status === "waiting") {
      const responder = job.startedBy ?? job.assistantId;
      return responder === assistantId ? "等你回复" : `等${nameOf(responder)}回复`;
    }
    const minutes = job.startedAt ? Math.floor((now.getTime() - new Date(job.startedAt).getTime()) / 60_000) : 0;
    return minutes < 1 ? "刚开始" : `运行 ${minutes} 分钟`;
  };
  const jobLabel = (job: Job) => {
    const label = `${job.id}「${short(job.title)}」`;
    if (!isGroup || job.assistantId === assistantId) return label;
    return `${label}（${nameOf(job.assistantId, job.assistantName)}）`;
  };
  const activeLine = (job: Job) => `${jobLabel(job)}，${stateOf(job)}`;
  const active = jobs.filter((job) => mine(placeOf(job)) && ACTIVE.has(job.status)).map(activeLine);
  if (active.length) lines.push(`进行中：${active.join("；")}`);

  const delegationLine = (item: { to: string; text: string; createdAt: string; status: string }) => {
    const waiting = item.status === "waiting" ? "，等用户确认" : "";
    return `${nameOf(item.to)}「${short(item.text)}」，${clock(item.createdAt)} 起${waiting}`;
  };
  const delegations = runtime.store.delegations().filter((item) => item.from === assistantId && (item.status === "running" || item.status === "waiting") && samePlace(item.fromTopicId ? { topicId: item.fromTopicId } : undefined, current))
    .map(delegationLine);
  if (delegations.length) lines.push(`转交中：${delegations.join("；")}`);

  const handedOver = openHandedOverTopics(runtime.store, assistantId, current)
    .map((topic) => {
      const hostName = runtime.store.group?.(topic.parentId!)?.name ?? topic.parentId!;
      return `群「${hostName}」话题「${short(topic.name)}」，${clock(topic.handover!.at)} 起（${topic.id}）`;
    });
  if (handedOver.length) lines.push(`交给群的：${handedOver.join("；")}`);

  const pending = runtime.store.approvals().filter((item) => {
    if (item.status !== "pending" || item.source === "job") return false;
    if (isGroup) {
      if (isGroupTopic) return item.groupId === current!.groupId;
      return runtime.store.groupMatches(current!.groupId!, item.groupId);
    }
    return item.assistantId === assistantId;
  });
  const approvalLabel = (item: { title: string; assistantId: string }) => (
    !isGroup || item.assistantId === assistantId ? item.title : `${item.title}（${nameOf(item.assistantId)}）`
  );
  const approvals = pending.filter((item) => mine(placeOf(item))).map(approvalLabel);
  if (approvals.length) lines.push(`等用户选：${approvals.join("；")}`);

  const names = { done: "已完成", stuck: "受阻", failed: "失败", stopped: "已停止" } as const;
  const recent = jobs.filter((job) => mine(placeOf(job)) && job.endedAt && !job.routineId && job.status in names && new Date(job.endedAt).getTime() >= now.getTime() - 86_400_000 && new Date(job.endedAt).getTime() <= now.getTime())
    .sort((a, b) => b.endedAt!.localeCompare(a.endedAt!)).slice(0, 5)
    .map((job) => `${jobLabel(job)}${clock(job.endedAt!)} ${names[job.status as keyof typeof names]}`);
  if (recent.length) lines.push(`最近结束：${recent.join("；")}`);

  const elsewhereActive = jobs.filter((job) => elsewhere(placeOf(job)) && ACTIVE.has(job.status)).map((job) => `${originOf(placeOf(job))}里 ${activeLine(job)}`);
  if (elsewhereActive.length) lines.push(`别处进行中：${elsewhereActive.join("；")}`);

  const elsewhereAsk = pending.filter((item) => elsewhere(placeOf(item))).map((item) => {
    const who = isGroup && item.assistantId !== assistantId ? `（${nameOf(item.assistantId)}）` : "";
    return `${originOf(placeOf(item))}里「${item.title}」${who}`;
  });
  if (elsewhereAsk.length) lines.push(`别处等用户选：${elsewhereAsk.join("；")}`);

  // 综合与多话题主对话：下属进行中话题的动态（正在回复、未完成待办、主对话下各话题的转交与交群），带话题 id 便于查询
  const topicStates: string[] = [];
  if (isGroupGeneral) {
    const openTopics = (runtime.store.groups?.() ?? [])
      .filter((topic) => topic.parentId === current!.groupId && !topic.closedAt)
      .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id));
    for (const topic of openTopics) {
      const parts: string[] = [];
      const busy = runtime.router?.busyMembers?.(topic.id) ?? [];
      if (busy.length) parts.push(`${busy.map((id) => nameOf(id)).join("、")}正在回复`);
      const topicBook = readTodoBook(sessionTodosPath(runtime.home, assistantId, { groupId: topic.id }));
      const { done, total } = todoProgress(topicBook.items);
      if (total > 0 && done < total) parts.push(`待办 ${done}/${total}`);
      if (parts.length) topicStates.push(`话题「${short(topic.name)}」（${topic.id}）：${parts.join("，")}`);
    }
  } else if (isAssistantMain) {
    const openTopics = (runtime.store.assistantTopics?.(assistantId) ?? [])
      .filter((topic) => !topic.closedAt)
      .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id));
    for (const topic of openTopics) {
      const parts: string[] = [];
      if (runtime.router?.isBusy?.(assistantId, { topicId: topic.id })) parts.push("正在回复");
      const topicBook = readTodoBook(sessionTodosPath(runtime.home, assistantId, { topicId: topic.id }));
      const { done, total } = todoProgress(topicBook.items);
      if (total > 0 && done < total) parts.push(`待办 ${done}/${total}`);
      const topicDelegations = runtime.store.delegations().filter(
        (item) => item.from === assistantId && item.fromTopicId === topic.id && (item.status === "running" || item.status === "waiting"),
      );
      for (const item of topicDelegations) {
        const waiting = item.status === "waiting" ? "，等用户确认" : "";
        parts.push(`转交${nameOf(item.to)}「${short(item.text)}」（${clock(item.createdAt)} 起${waiting}）`);
      }
      if (parts.length) topicStates.push(`话题「${short(topic.name)}」（${topic.id}）：${parts.join("，")}`);
    }
  }
  if (topicStates.length) lines.push(`话题动态：${topicStates.join("；")}`);

  return lines.join("\n");
}
