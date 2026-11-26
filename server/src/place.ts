import type { Place } from "../../shared/types.ts";

/** 从 Job / Approval / CardRecord 等记录取出所在会话（只保留有值的字段）。 */
export function placeOf(record?: { groupId?: string; topicId?: string } | null): Place {
  if (record?.groupId) return { groupId: record.groupId };
  if (record?.topicId) return { topicId: record.topicId };
  return {};
}

/** 两个地址是不是同一个会话（未填、groupId 相同、topicId 相同分别匹配）。 */
export function samePlace(a?: Place | null, b?: Place | null): boolean {
  return (a?.groupId || undefined) === (b?.groupId || undefined)
    && (a?.topicId || undefined) === (b?.topicId || undefined);
}

/** 会话键：主对话/单聊是 assistantId，群会话是 `<assistantId>@<gid>`，助手话题是 `<assistantId>@<tid>`。 */
export function sessionKey(assistantId: string, place?: Place | null): string {
  const scope = place?.groupId || place?.topicId;
  return scope ? `${assistantId}@${scope}` : assistantId;
}

/** 校验话题 ID 合法性（拒绝空值、`.`、`..`、`/`、`\\` 等路径别名或穿越字符）。 */
export function isValidTopicId(tid: string): boolean {
  return Boolean(tid) && tid !== "." && !tid.includes("/") && !tid.includes("\\") && !tid.includes("..");
}

/** 展开成记录上的字段（都不填时返回空对象，不写入 undefined 字段）。 */
export function placeFields(place?: Place | null): Place {
  if (place?.groupId) return { groupId: place.groupId };
  if (place?.topicId) return { topicId: place.topicId };
  return {};
}
