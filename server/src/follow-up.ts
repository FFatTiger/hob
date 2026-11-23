import type { AssistantMessage, Context, Message, Model } from "@earendil-works/pi-ai";
import { basename } from "node:path";
import { attachmentName, isImagePath } from "../../shared/media.ts";
import type { GroupItem } from "../../shared/types.ts";

/** 给推荐提问模型的固定系统提示词。 */
export const FOLLOW_UP_SYSTEM_PROMPT = `你在给一段对话想「用户接下来可能会说的话」。这些话会显示在输入框上方，用户点一下就原样发给助手，所以每一句都要是用户自己会说的话：用用户的口吻，简短，具体到这段对话里的事，发出去以后助手能直接接着做。

好的建议来自对话里自然的下一步：助手做完了一件事，用户可能想看看结果、改一处、接着做下一步；助手给了几个方案，用户可能选其中一个；助手说明了做不到的地方，用户可能想换个做法。

有时候不给更好：助手刚问了用户一个问题、正在等回答；事情已经办完、没有自然的下一步；对话只是寒暄或道谢。这时返回空列表。给不出真正有用的，就少给或者不给，不凑数。

只回一个 JSON 数组，例如 ["把结果发我看看", "换成每周跑一次"]；不给就回 []。`;

export interface FollowUpTurn {
  role: "user" | "assistant";
  text: string;
}

type SessionEntryLike = {
  type?: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string; content?: unknown };
};

function contentText(content: unknown, includeToolCalls = false): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const value = part as { type?: string; text?: unknown; name?: unknown };
    if (value.type === "text" && typeof value.text === "string") return value.text;
    if (value.type === "image") return "（图片）";
    if (includeToolCalls && value.type === "toolCall") return `（调用了 ${typeof value.name === "string" ? value.name : "工具"}）`;
    return "";
  }).filter(Boolean).join("\n");
}

function fileMarkers(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  return files.filter((file): file is string => typeof file === "string" && file.length > 0).map((file) => {
    if (isImagePath(file)) return "（图片）";
    return `（文件：${attachmentName(basename(file))}）`;
  });
}

function userText(data: Record<string, unknown>): string {
  const text = typeof data.text === "string" ? data.text : "";
  const parts = [text, ...fileMarkers(data.files)];
  if (data.quote && typeof data.quote === "object" && typeof (data.quote as { text?: unknown }).text === "string") {
    parts.push(`（引用：「${(data.quote as { text: string }).text}」）`);
  }
  return parts.filter(Boolean).join("\n");
}

/** 把 Router 会话中的稳定消息转换成推荐模型看到的固定文字。 */
export function routerHistory(entries: readonly SessionEntryLike[]): FollowUpTurn[] {
  const turns: FollowUpTurn[] = [];
  const hasCustomUser = entries.some((entry) => entry.type === "custom" && entry.customType === "hob.user");
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === "hob.user") {
      const data = entry.data && typeof entry.data === "object" ? entry.data as Record<string, unknown> : {};
      const text = userText(data);
      if (text) turns.push({ role: "user", text });
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    if (entry.message.role === "user") {
      if (hasCustomUser) continue;
      const text = contentText(entry.message.content, false);
      if (text) turns.push({ role: "user", text });
    } else if (entry.message.role === "assistant") {
      const text = contentText(entry.message.content, true);
      if (text) turns.push({ role: "assistant", text });
    }
  }
  return turns;
}

function speakerName(speaker: string, nameOf: (speaker: string) => string): string {
  return nameOf(speaker);
}

/** 把群时间线中的一条消息写成一句稳定事实。 */
export function groupLine(item: GroupItem, nameOf: (speaker: string) => string = (speaker) => speaker === "user" ? "用户" : speaker): string {
  const who = speakerName(item.speaker, nameOf);
  switch (item.kind) {
    case "user": {
      const text = [item.text, ...(item.files ?? []).map((file) => isImagePath(file) ? "（图片）" : `（文件：${attachmentName(basename(file))}）`), item.quote ? `（引用：「${item.quote.text}」）` : ""].filter(Boolean).join("\n");
      return text ? `${who}：${text}` : "";
    }
    case "assistant":
    case "note":
      return item.text ? `${who}：${item.text}` : "";
    case "job":
      return `${who}：（调用了 start_job）`;
    case "question":
      return `${who}：（调用了 ask_user）`;
    case "file":
      return `${who}：（调用了 send_file）`;
    case "image":
      return `${who}：（调用了 generate_image）`;
    case "draft":
      return `${who}：（调用了 create_assistant）`;
    case "delegation":
      return `${who}：（调用了 message_assistant）`;
    case "topic":
      return `${who}：（调用了 open_topic）`;
    case "card":
      return `${who}：（调用了 send_card）`;
    case "todos":
      return "";
  }
}

/** 把群时间线中的消息转换成推荐模型看到的固定文字。 */
export function groupHistory(items: readonly GroupItem[], nameOf: (speaker: string) => string = (speaker) => speaker === "user" ? "用户" : speaker): FollowUpTurn[] {
  return items.map((item) => groupLine(item, nameOf)).filter(Boolean).map((text) => ({ role: "user" as const, text }));
}

export function historyText(turns: readonly FollowUpTurn[]): string {
  return turns.map((turn) => `${turn.role === "user" ? "用户" : "助手"}：${turn.text}`).join("\n");
}

function estimatedTokens(text: string): number {
  return Math.ceil([...text].length / 4);
}

/** 超过窗口一半时，从前面整块丢掉最老的一半消息。 */
export function trimHistory(turns: readonly FollowUpTurn[], contextWindow: number): FollowUpTurn[] {
  const total = estimatedTokens(historyText(turns));
  if (!Number.isFinite(contextWindow) || contextWindow <= 0 || total <= contextWindow / 2) return [...turns];
  return turns.slice(Math.ceil(turns.length / 2));
}

function assistantMessage(text: string, model: Model<any>): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
  } as AssistantMessage;
}

export function followUpContext(systemPrompt: string, turns: readonly FollowUpTurn[], model: Model<any>): Context {
  const trimmed = trimHistory(turns, model.contextWindow);
  return {
    systemPrompt,
    messages: [
      ...trimmed.map((turn) => turn.role === "user"
        ? { role: "user" as const, content: `用户：${turn.text}`, timestamp: 0 }
        : assistantMessage(`助手：${turn.text}`, model)),
      { role: "user", content: "上面是到目前为止的对话。给出用户接下来可能说的话。", timestamp: 0 },
    ],
  };
}

function assistantText(message: AssistantMessage): string {
  return contentText(message.content, false).trim();
}

/** 从回复里取第一个合法 JSON 数组，并按代码约束清理。 */
export function parseSuggestions(text: string): string[] {
  const start = text.indexOf("[");
  if (start < 0) return [];
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(text.slice(start, end)); } catch { return []; }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) return [];
  const seen = new Set<string>();
  return parsed.map((value) => value.trim()).filter((value) => {
    if (!value || [...value].length > 40 || seen.has(value)) return false;
    seen.add(value);
    return true;
  }).slice(0, 3);
}

export async function generateFollowUpSuggestions(
  runtime: { completeSimple: (model: Model<any>, context: Context, options?: Record<string, unknown>) => Promise<AssistantMessage> },
  model: Model<any>,
  turns: readonly FollowUpTurn[],
): Promise<string[]> {
  try {
    const response = await runtime.completeSimple(model, followUpContext(FOLLOW_UP_SYSTEM_PROMPT, turns, model), {
      reasoning: "off",
      maxTokens: 256,
      signal: AbortSignal.timeout(30_000),
      disableContinuation: true,
    });
    if (response.stopReason === "error" || response.stopReason === "aborted") return [];
    return parseSuggestions(assistantText(response));
  } catch (error) {
    console.error("推荐提问生成失败：", error instanceof Error ? error.message : String(error));
    return [];
  }
}
