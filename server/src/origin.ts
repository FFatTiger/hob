// 一件事（任务、提问卡、待办）所在的会话，从「现在这个会话」看过去叫什么：
// 单聊、主对话、综合、话题「…」、群「…」、群「…」的话题「…」。给模型看的地方都写它，不说「别的会话」。
import type { Place } from "../../shared/types.ts";
import type { Store } from "./store.ts";

export function sessionOrigin(store: Store, where: Place | undefined, current: Place | undefined, assistantId?: string): string {
  const directName = assistantId && store.assistant(assistantId)?.topics ? "主对话" : "单聊";
  if (where?.groupId) {
    const group = store.group(where.groupId);
    // 群已经归档：卡片和结果都落回单聊/主对话，这里也照单聊/主对话说
    if (!group) return directName;
    const here = current?.groupId ? store.group(current.groupId) : undefined;
    const sameGroup = here !== undefined && (here.parentId ?? here.id) === (group.parentId ?? group.id);
    if (sameGroup) return group.parentId ? `话题「${group.name}」` : "综合";
    if (!group.parentId) return `群「${group.name}」`;
    const parent = store.group(group.parentId);
    return `群「${parent?.name ?? group.parentId}」的话题「${group.name}」`;
  }
  if (where?.topicId) {
    const topic = assistantId ? store.assistantTopic(assistantId, where.topicId) : store.assistantTopicById(where.topicId);
    return `话题「${topic?.name ?? where.topicId}」`;
  }
  return directName;
}
