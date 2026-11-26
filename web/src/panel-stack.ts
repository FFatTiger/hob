import { t } from "../../shared/i18n.ts";
import type { DesktopScreenUser, Place } from "../../shared/types.ts";

export interface FilePreviewState {
  path: string;
  full: boolean;
  title?: string;
  liveId?: string;
  find?: string;
  page?: number;
}

export type PanelPage =
  | { kind: "routine"; id: string }
  | { kind: "newRoutine"; groupId?: string; topicId?: string }
  | { kind: "assistant" }
  | { kind: "groupSettings"; id: string }
  /** 群信息里点了某个成员：右栏换成这个助手的信息页，群聊留在中间 */
  | { kind: "member"; id: string }
  | { kind: "routines" | "skills" | "knowledge" | "rules" | "topicRules" | "topicModels"; groupId?: string; topicId?: string }
  | { kind: "jobs" }
  | { kind: "job"; id: string; round?: number; full?: boolean; instant?: boolean; jumpApprovalId?: string }
  | ({ kind: "file" } & FilePreviewState);

function samePage(a: PanelPage, b: PanelPage): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "routine" && b.kind === "routine") return a.id === b.id;
  if (a.kind === "job" && b.kind === "job") return a.id === b.id;
  if (a.kind === "member" && b.kind === "member") return a.id === b.id;
  if (a.kind === "file" && b.kind === "file") return a.liveId || b.liveId ? a.liveId === b.liveId : a.path === b.path;
  return true;
}

/** 打开已在栈里的页面时，退回该层并更新参数。 */
export function pushPage(stack: PanelPage[], page: PanelPage): PanelPage[] {
  const index = stack.findIndex((entry) => samePage(entry, page));
  return [...(index < 0 ? stack : stack.slice(0, index)), page];
}

export function selectPanelStack(stack: PanelPage[], previous: string | null, next: string, keep: boolean): PanelPage[] {
  return previous !== next && !keep ? [] : stack;
}

/** 右栏现在讲的是哪个助手：栈里有群成员页就是那个成员，否则是选中的助手。 */
export function panelAssistant(stack: readonly PanelPage[], sel: string | null): string {
  const member = stack.findLast((page) => page.kind === "member");
  return member?.kind === "member" ? member.id : sel ?? "hob";
}

/**
 * 右栏的云桌面看哪个助手的屏幕。
 * 群信息页（选中群或话题、没推进成员页）：本群成员里屏幕正在跑的那个，群主排前；都没在跑时落在群主身上。
 * watch 是会被看作「正在看」的屏幕：群信息页上是全体成员的，谁的屏幕被唤醒都能自动展开。
 * 其余：右栏讲的那个助手。
 */
export type PanelDeskStatus = "active" | "elsewhere" | "idle" | "off";

export interface PanelDeskState {
  aid: string;
  screenId?: string;
  /** 本会话正在用且屏幕正在运行：显示内嵌小屏、可自动展开 */
  running: boolean;
  status: PanelDeskStatus;
  usedBy?: DesktopScreenUser;
  watch: string[];
  activeWatch: string[];
}

/**
 * 右栏的云桌面看哪个助手的屏幕，以及在这个会话里怎么呈现：
 * - active：屏幕正被当前会话（或本会话的任务）使用且正在运行 → 内嵌小屏、可自动展开
 * - elsewhere：屏幕正被其他会话使用 → 显示「「…」正在用」
 * - idle：云桌面已接入但当前没人用 → 显示「空闲」
 * - off：云桌面未配置或未连接
 * 群信息页（选中群或话题、没推进成员页）：先挑正被这个会话用着的成员，其次被别处用着的，其次空闲的；综合汇总本群及全部话题。
 */
export function panelDesk(
  stack: readonly PanelPage[], sel: string | null, gsel: string | null,
  groups: readonly { id: string; parentId?: string; ownerId: string; members: string[] }[],
  desktop: {
    screens: readonly { id: string; running: boolean }[];
    profiles: Record<string, string>;
    users?: Record<string, readonly DesktopScreenUser[]>;
  },
  place?: Place,
  multiTopic = false,
): PanelDeskState {
  const isRunning = (screenId?: string) => !!screenId && desktop.screens.some((screen) => screen.id === screenId && screen.running);
  const isKnown = (screenId?: string) => !!screenId && desktop.screens.some((screen) => screen.id === screenId);
  const usersOf = (screenId?: string) => (screenId ? desktop.users?.[screenId] ?? [] : []);

  const memberOpen = stack.some((page) => page.kind === "member");
  const currentGroup = gsel ? groups.find((group) => group.id === gsel) : undefined;
  const selected = currentGroup && !memberOpen ? currentGroup : undefined;
  const root = selected?.parentId ? groups.find((group) => group.id === selected.parentId) ?? selected : selected;
  const ids = root ? [root.ownerId, ...root.members.filter((id) => id !== root.ownerId)] : [panelAssistant(stack, sel)];
  const watch = ids.flatMap((id) => desktop.profiles[id] ? [desktop.profiles[id]!] : []);

  const matchesHere = (user: DesktopScreenUser): boolean => {
    if (gsel) {
      if (currentGroup && !currentGroup.parentId) {
        return user.place.groupId === currentGroup.id || groups.some((topic) => topic.id === user.place.groupId && topic.parentId === currentGroup.id);
      }
      return user.place.groupId === gsel && !user.place.topicId;
    }
    if (place?.topicId) return user.place.topicId === place.topicId && !user.place.groupId;
    if (multiTopic) return !user.place.groupId;
    return !user.place.groupId && !user.place.topicId;
  };

  const activeWatch = ids.flatMap((id) => {
    const screenId = desktop.profiles[id];
    if (!screenId || !isRunning(screenId)) return [];
    return usersOf(screenId).some(matchesHere) ? [screenId] : [];
  });

  const activeAid = ids.find((id) => {
    const screenId = desktop.profiles[id];
    return isRunning(screenId) && usersOf(screenId).some(matchesHere);
  });
  if (activeAid) {
    return { aid: activeAid, screenId: desktop.profiles[activeAid], running: true, status: "active", watch, activeWatch };
  }

  const elsewhereAid = ids.find((id) => isKnown(desktop.profiles[id]) && usersOf(desktop.profiles[id]).some((user) => !matchesHere(user)));
  if (elsewhereAid) {
    const screenId = desktop.profiles[elsewhereAid];
    const usedBy = usersOf(screenId).find((user) => !matchesHere(user)) ?? usersOf(screenId)[0];
    return { aid: elsewhereAid, ...(screenId ? { screenId } : {}), running: false, status: "elsewhere", ...(usedBy ? { usedBy } : {}), watch, activeWatch };
  }

  const idleAid = ids.find((id) => isRunning(desktop.profiles[id])) ?? ids.find((id) => isKnown(desktop.profiles[id]));
  if (idleAid) {
    return { aid: idleAid, screenId: desktop.profiles[idleAid], running: false, status: "idle", watch, activeWatch };
  }

  const fallbackAid = ids[0]!;
  const screenId = desktop.profiles[fallbackAid];
  return { aid: fallbackAid, ...(screenId ? { screenId } : {}), running: false, status: "off", watch, activeWatch };
}

/** 格式化「别处正在用」的会话名称，供右栏显示「「{where}」正在用」。 */
export function desktopUserWhere(
  user: DesktopScreenUser,
  groups: readonly { id: string; parentId?: string; name: string }[],
  assistants: readonly { id: string; name: string; topics?: unknown }[],
  gsel: string | null,
  assistantTopics?: readonly { id: string; name: string }[],
): string {
  const currentGroup = gsel ? groups.find((group) => group.id === gsel) : undefined;
  const currentRootId = currentGroup ? (currentGroup.parentId ?? currentGroup.id) : undefined;
  if (user.place.groupId) {
    const target = groups.find((group) => group.id === user.place.groupId);
    if (!target) return user.place.groupId;
    if (target.parentId) {
      if (currentRootId && target.parentId === currentRootId) return target.name;
      const parent = groups.find((group) => group.id === target.parentId);
      return parent ? `${parent.name} · ${target.name}` : target.name;
    }
    if (currentRootId && target.id === currentRootId) return t("综合");
    return target.name;
  }
  if (user.place.topicId) {
    const topic = assistantTopics?.find((item) => item.id === user.place.topicId);
    return topic?.name ?? user.place.topicId;
  }
  const assistant = assistants.find((item) => item.id === user.assistantId);
  if (!gsel && assistant?.topics) return t("主对话");
  return t("{name} · 单聊", { name: assistant?.name ?? user.assistantId });
}

export function popPage(stack: PanelPage[]): PanelPage[] {
  return stack.slice(0, -1);
}

export function replacePage(stack: PanelPage[], page: PanelPage): PanelPage[] {
  return pushPage(popPage(stack), page);
}

export function pageKey(page: PanelPage): string {
  return `${page.kind}:${"id" in page ? page.id : "path" in page ? page.liveId ?? page.path : ""}`;
}

export type GonePage = { page: PanelPage; index: number; leaving: boolean };

/** 栈从 previous 变成 next 时退掉的页和它原来在第几层。退回去（栈变短）才滑出去；换掉栈顶时旧页垫在新页下面，等新页盖上再卸。 */
export function gonePages(previous: PanelPage[], next: PanelPage[]): GonePage[] {
  const keys = new Set(next.map(pageKey));
  const leaving = next.length < previous.length;
  return previous.flatMap((page, index) => (keys.has(pageKey(page)) ? [] : [{ page, index, leaving }]));
}

/** 栈里的页加上还没退完的页，按原来的层次排：后面的盖在前面的上面。 */
export function layerList(stack: PanelPage[], gone: GonePage[]): { page: PanelPage; leaving: boolean }[] {
  const list = stack.map((page) => ({ page, leaving: false }));
  for (const g of gone) list.splice(Math.min(g.index, list.length), 0, { page: g.page, leaving: g.leaving });
  return list;
}

export function removeMissingLivePages(stack: PanelPage[], livePages: Record<string, unknown>): PanelPage[] {
  return stack.filter((page) => page.kind !== "file" || !page.liveId || Boolean(livePages[page.liveId]));
}
