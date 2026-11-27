import type { Place } from "./types.ts";

/**
 * 规范化会话目标标识：服务端推送（pushTarget）和前端可见状态上报（activeTarget）共用这一处。
 * - 群 / 群话题："group:<gid>"
 * - 助手话题："assistant:<aid>@<tid>"
 * - 助手单聊 / 主对话："assistant:<aid>"
 */
export function conversationTarget(assistantId: string, place?: Pick<Place, "groupId" | "topicId"> | null): string {
  if (place?.groupId) return `group:${place.groupId}`;
  if (place?.topicId) return `assistant:${assistantId}@${place.topicId}`;
  return `assistant:${assistantId}`;
}
