import { basename } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { GroupItem } from "../../shared/types.ts";
import { textOfContent } from "./transcript.ts";

/** 推荐模型收到的固定系统提示词；不要把会变化的内容拼进这里。 */
export const SUGGESTION_SYSTEM_PROMPT = `你在给一段对话想「用户接下来可能会说的话」。这些话会显示在输入框上方，用户点一下就原样发给助手，所以每一句都要是用户自己会说的话：用用户的口吻，简短，具体到这段对话里的事，发出去以后助手能直接接着做。

好的建议来自对话里自然的下一步：助手做完了一件事，用户可能想看看结果、改一处、接着做下一步；助手给了几个方案，用户可能选其中一个；助手说明了做不到的地方，用户可能想换个做法。

有时候不给更好：助手刚问了用户一个问题、正在等回答；事情已经办完、没有自然的下一步；对话只是寒暄或道谢。这时返回空列表。给不出真正有用的，就少给或者不给，不凑数。

只回一个 JSON 数组，例如 ["把结果发我看看", "换成每周跑一次"]；不给就回 []。`;

const USER_TYPE = "hob.user";
const ITEM_TYPE = "hob.item";
const EVENT_TYPE = "hob.event";

export interface SuggestionHistoryOptions {
  nameOf?: (speaker: string | "user") => string;
}

function fileMarker(path: string): string {
  const name = basename(path) || path;
  return /\.(?:png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(name) ? "（图片）" : `（文件：${name}）`;
}

function withFiles(text: string, files: unknown): string {
  const paths = Array.isArray(files) ? files.filter((path): path is string => typeof path === "string" && path.length > 0) : [];
  return [text, ...paths.map(fileMarker)].join("\n");
}

function sessionData(entry: SessionEntry): { text?: string; files?: unknown } | undefined {
  if (entry.type !== "custom" || entry.customType !== USER_TYPE) return undefined;
  return entry.data as { text?: string; files?: unknown };
}

/** 单聊会话转成稳定的消息块。工具结果和内部事件、卡片不进入历史。 */
export function routerSuggestionHistory(entries: SessionEntry[]): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    const data = sessionData(entry);
    if (data) {
      lines.push(`用户：${withFiles(typeof data.text === "string" ? data.text : "", data.files)}`);
      continue;
    }
    if (entry.type === "custom" && entry.customType === ITEM_TYPE) continue;
    if (entry.type === "custom_message" && entry.customType === EVENT_TYPE) continue;
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "assistant") continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (block?.type === "text" && typeof block.text === "string") lines.push(`助手：${block.text}`);
      if (block?.type === "toolCall" && typeof block.name === "string") lines.push(`（调用了 ${block.name}）`);
    }
  }
  return lines;
}

function groupSpeaker(item: GroupItem, nameOf: (speaker: string | "user") => string): string {
  return nameOf(item.speaker);
}

function groupCardLine(item: GroupItem): string | undefined {
  switch (item.kind) {
    case "job": return "start_job";
    case "question": return "ask_user";
    case "file": return "send_file";
    case "image": return "generate_image";
    case "delegation": return "message_assistant";
    case "draft": return "create_assistant";
    case "topic": return "open_topic";
    default: return undefined;
  }
}

/** 群综合或话题时间线转成稳定的消息块；每条都带说话人。 */
export function groupSuggestionHistory(items: GroupItem[], options: SuggestionHistoryOptions = {}): string[] {
  const nameOf = options.nameOf ?? ((speaker: string | "user") => speaker === "user" ? "用户" : speaker);
  const lines: string[] = [];
  for (const item of items) {
    const speaker = groupSpeaker(item, nameOf);
    if (item.kind === "user") {
      lines.push(`${speaker}：${withFiles(item.text, item.files)}`);
      continue;
    }
    if (item.kind === "assistant" || item.kind === "note") {
      lines.push(`${speaker}：${item.text}`);
      continue;
    }
    const tool = groupCardLine(item);
    if (tool) lines.push(`${speaker}：（调用了 ${tool}）`);
  }
  return lines;
}

/**
 * 按消息块裁剪历史。四个字符近似一个 token，因此窗口一半约为 contextWindow * 2 个字符；
 * 超出时整块丢掉最老的一半，保留剩下的消息原文。
 */
export function trimSuggestionHistory(lines: string[], contextWindow: number): string[] {
  const limit = Math.max(1, Math.floor(contextWindow * 2));
  if (lines.join("\n").length <= limit) return lines;
  return lines.slice(Math.ceil(lines.length / 2));
}

export function suggestionHistoryText(lines: string[], contextWindow: number): string {
  return trimSuggestionHistory(lines, contextWindow).join("\n");
}

export function suggestionMessageText(content: unknown): string {
  return textOfContent(content);
}
