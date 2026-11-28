// 群里 @ 点名：认出输入框里正在写的 @，按名字筛成员，选中后把 @名字 填回去。
// 纯函数，界面在 components/Chat.tsx 的输入框里用。
import type { GroupReplyMode } from "../../shared/types.ts";

export interface MentionAt {
  start: number; // @ 在文本里的位置
  query: string; // @ 后面已经打出来的字
}

/** @ 后面最多认这么多字：超过就不当点名，免得半句话都被当成名字。 */
const MAX_QUERY = 30;

/** Enter and arrow keys used to confirm a Chinese/Japanese IME candidate. */
export function isImeCompositionEvent(event: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean {
  return event.isComposing || event.keyCode === 229;
}

/**
 * 光标前正在输入的 @：从光标往前找最近的 @（中间不能换行）。
 * 已经写完一个名字（名字后面跟了空格）就不算在点名，光标接着往下写不会弹列表。
 */
export function mentionAt(text: string, caret: number, names: string[]): MentionAt | null {
  const head = text.slice(0, caret);
  const at = head.lastIndexOf("@");
  if (at < 0) return null;
  const query = head.slice(at + 1);
  if (query.includes("\n") || query.length > MAX_QUERY) return null;
  if (names.some((name) => query.startsWith(`${name} `))) return null;
  return { start: at, query };
}

/** 按打出来的字筛成员：名字或职责里包含这段字，群主排第一。 */
export function filterMembers<T extends { id: string; name: string; duty: string }>(members: T[], ownerId: string, query: string): T[] {
  const q = query.trim().toLowerCase();
  const hit = (m: T) => !q || m.name.toLowerCase().includes(q) || m.duty.toLowerCase().includes(q);
  return [...members.filter((m) => m.id === ownerId && hit(m)), ...members.filter((m) => m.id !== ownerId && hit(m))];
}

/** 键盘上下选：到头绕回去。 */
export function stepPick(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (index + delta + count) % count;
}

/** 把 @打出来的字 换成 @名字（后面补一个空格），光标落在空格后面。 */
export function applyMention(text: string, at: MentionAt, name: string): { text: string; caret: number } {
  const inserted = `@${name} `;
  const head = text.slice(0, at.start);
  const tail = text.slice(at.start + 1 + at.query.length);
  return { text: head + inserted + tail, caret: head.length + inserted.length };
}

/** 群里点推荐提问时要不要自动补 @成员名：全员回应模式不补，否则会退化成只点名最后一位发言的成员。 */
export function groupSuggestionPrefix(
  g: { ownerId: string; replyMode?: GroupReplyMode } | undefined,
  items: readonly { kind: string; speaker?: string }[],
  assistants: readonly { id: string; name: string }[],
): string {
  if (!g || g.replyMode === "all") return "";
  const last = [...items].reverse().find((item) => item.kind === "assistant");
  if (!last?.speaker || last.speaker === g.ownerId) return "";
  const member = assistants.find((assistant) => assistant.id === last.speaker);
  return member ? `@${member.name} ` : "";
}
