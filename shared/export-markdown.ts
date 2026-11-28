import type { Card, CardText } from "./cards.ts";
import { t } from "./i18n.ts";
import { attachmentName } from "./media.ts";
import type {
  Approval,
  CardRecord,
  Delegation,
  Draft,
  GroupItem,
  Item,
  Job,
  JobStatus,
  TodoArchiveWhy,
} from "./types.ts";

const MAX_EXPORT_FILENAME_CHARS = 40;
const ILLEGAL_FILENAME_CHARS = /[/\\<>:"|?*\p{Cc}.]+/gu;

function sanitizeBaseName(raw: string, maxChars: number): string {
  const cleaned = raw
    .replace(ILLEGAL_FILENAME_CHARS, "-")
    .replace(/[\s·•]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return Array.from(cleaned).slice(0, maxChars).join("").replace(/-+$/g, "");
}

/** 将标题与日期规范化为安全的 `<safe>-YYYY-MM-DD.md` 导出文件名。 */
export function safeExportFilename(title: string, dateStr: string): string {
  const base = sanitizeBaseName(title, MAX_EXPORT_FILENAME_CHARS) || "conversation";
  const safeDate = dateStr.replace(/[^0-9-]/g, "") || "export";
  return `${base}-${safeDate}.md`;
}

export interface ExportConversationMessage {
  speaker: string;
  at: string;
  text: string;
  quote?: string;
  files?: string[];
}

export interface ExportItemContext {
  defaultAssistantName: string;
  assistantName(id: string): string | undefined;
  formatTime(iso: string): string;
  job(id: string): Job | undefined;
  approval(id: string): Approval | undefined;
  card(id: string): CardRecord | undefined;
  delegation(id: string): Delegation | undefined;
  draft(id: string): Draft | undefined;
  topic(id: string): { name: string; closedAt?: string; closeNote?: string } | undefined;
}

const cardTextValue = (value: CardText | { content: CardText } | undefined): string => {
  if (!value) return "";
  if (typeof value === "string") return value;
  if ("tag" in value) return value.content;
  return cardTextValue(value.content);
};

/** 将卡片摘要格式化为导出用的可读一行文字。 */
export function cardExportSummary(card: Card): string {
  const title = cardTextValue(card.header?.title).trim() || t("未命名卡片");
  const summary = cardTextValue(card.config?.summary?.content).trim();
  if (summary) return `（${t("卡片「{title}」：{summary}", { title, summary })}）`;
  const elements = card.body.elements;
  const forms = elements.filter((element) => element.tag === "form").length;
  const tables = elements.filter((element) => element.tag === "table").reduce((count, element) => count + element.rows.length, 0);
  const detail = forms
    ? t("表单 {n} 项", { n: forms })
    : tables
      ? t("表格 {n} 行", { n: tables })
      : t("组件 {n} 个", { n: elements.length });
  return `（${t("卡片「{title}」：{summary}", { title, summary: detail })}）`;
}

function jobStatusText(status: JobStatus): string {
  const labels: Record<JobStatus, string> = {
    queued: t("排队中"),
    running: t("进行中"),
    waiting: t("等助手回复"),
    done: t("已完成"),
    stuck: t("受阻"),
    failed: t("失败"),
    stopped: t("已停止"),
  };
  return labels[status];
}

function delegationStatusText(status: Delegation["status"]): string {
  const labels: Record<Delegation["status"], string> = {
    running: t("进行中"),
    waiting: t("等你确认"),
    done: t("已完成"),
    stuck: t("受阻"),
    interrupted: t("已中断"),
    returned: t("已退回"),
    takenOver: t("已被你接手"),
  };
  return labels[status];
}

function todosReasonText(why: TodoArchiveWhy): string {
  const labels: Record<TodoArchiveWhy, string> = {
    done: t("待办已完成"),
    cleared: t("待办已清空"),
    topicClosed: t("话题关闭时收起待办"),
    stale: t("已收起待办"),
  };
  return labels[why];
}

function formatApprovalText(approval: Approval): string | null {
  const parts = [approval.title, approval.detail || approval.login?.reason || approval.login?.site].filter(Boolean);
  if (approval.status === "answered") {
    const answerParts: string[] = [];
    if (approval.questions?.length && approval.answers?.length) {
      const multi = approval.answers.map((ans, idx) => {
        const q = approval.questions?.[idx];
        const picked = ans.text || q?.options.find((opt) => opt.key === ans.key)?.label || ans.key;
        return q ? `${q.title}：${picked}` : picked;
      }).filter(Boolean).join("\n");
      if (multi) answerParts.push(multi);
      if (approval.answerText) answerParts.push(approval.answerText);
    } else {
      const single = approval.answerText || approval.options.find((opt) => opt.key === approval.chosen)?.label;
      if (single) answerParts.push(single);
    }
    const answer = answerParts.filter(Boolean).join("\n");
    if (answer) parts.push(`${t("已回答")}：${answer}`);
  } else if (approval.status === "pending") {
    parts.push(t("待确认"));
  } else if (approval.status === "expired") {
    parts.push(t("已过期"));
  }
  return parts.join("\n\n") || null;
}

/** 将会话条目列表转换成适合 Markdown 导出的结构化消息（跳过内部备注）。 */
export function itemsToExportMessages(
  items: readonly (Item | GroupItem)[],
  ctx: ExportItemContext,
): ExportConversationMessage[] {
  const speakerName = (item: Item | GroupItem, fallback: string) => {
    if (!("speaker" in item) || !item.speaker) return fallback;
    return item.speaker === "user" ? t("用户") : (ctx.assistantName(item.speaker) ?? item.speaker);
  };

  return items.flatMap((item): ExportConversationMessage[] => {
    if (item.kind === "note") return [];

    if (item.kind === "job") {
      const job = ctx.job(item.jobId);
      if (!job) return [];
      const round = item.round !== undefined ? job.rounds?.[item.round] : undefined;
      const summary = round ? (round.summary || round.statusReason) : (job.summary || job.statusReason);
      const status = round ? round.status : job.status;
      const files = (round ? round.files : job.files)?.map(attachmentName).filter(Boolean);
      const owner = ctx.assistantName(job.assistantId) ?? job.assistantName ?? ctx.defaultAssistantName;
      const body = [job.title, summary || jobStatusText(status)].filter(Boolean).join("\n\n");
      if (!body && !files?.length) return [];
      return [{
        speaker: `${owner} · ${t("任务")}`,
        at: ctx.formatTime(item.at),
        text: body,
        ...(files?.length ? { files } : {}),
      }];
    }

    if (item.kind === "card") {
      const record = ctx.card(item.cardId);
      if (!record) return [];
      const fallback = ctx.assistantName(record.owner.assistantId) ?? ctx.defaultAssistantName;
      return [{
        speaker: speakerName(item, fallback),
        at: ctx.formatTime(item.at),
        text: cardExportSummary(record.card),
      }];
    }

    if (item.kind === "file") {
      const name = item.name ? attachmentName(item.name) : item.path ? attachmentName(item.path) : t("文件");
      return [{
        speaker: speakerName(item, ctx.defaultAssistantName),
        at: ctx.formatTime(item.at),
        text: item.meta ?? "",
        files: [name],
      }];
    }

    if (item.kind === "image") {
      if (item.status === "pending") return [];
      const files = item.status === "done" && item.path ? [attachmentName(item.path)] : undefined;
      const text = item.status === "failed"
        ? (item.error ? `${t("图片生成失败")}：${item.error}` : t("图片生成失败"))
        : (item.prompt ? `${t("图片")}：${item.prompt}` : t("图片"));
      return [{
        speaker: speakerName(item, ctx.defaultAssistantName),
        at: ctx.formatTime(item.at),
        text,
        ...(files ? { files } : {}),
      }];
    }

    if (item.kind === "question") {
      const approval = ctx.approval(item.approvalId);
      const text = approval ? formatApprovalText(approval) : null;
      if (!text) return [];
      return [{
        speaker: speakerName(item, ctx.defaultAssistantName),
        at: ctx.formatTime(item.at),
        text,
      }];
    }

    if (item.kind === "todos") {
      const header = todosReasonText(item.why);
      const lines = item.items.map((todo) => {
        if (todo.status === "done") return `- [x] ${todo.text}`;
        if (todo.status === "doing") return `- [ ] ${todo.text}（${t("进行中")}）`;
        return `- [ ] ${todo.text}`;
      });
      return [{
        speaker: `${speakerName(item, ctx.defaultAssistantName)} · ${t("待办")}`,
        at: ctx.formatTime(item.at),
        text: [header, ...lines].join("\n"),
      }];
    }

    if (item.kind === "delegation") {
      const delegation = ctx.delegation(item.delegationId);
      if (!delegation) return [];
      const fromName = ctx.assistantName(delegation.from) ?? ctx.defaultAssistantName;
      const targetName = ctx.assistantName(delegation.to) ?? delegation.to;
      const parts = [
        t("转交给「{name}」（{status}）", { name: targetName, status: delegationStatusText(delegation.status) }),
        delegation.text,
        delegation.reply ? `${t("回复")}：${delegation.reply}` : "",
        delegation.returnedText ? `${t("退回原因")}：${delegation.returnedText}` : "",
      ].filter(Boolean);
      const files = delegation.files?.length ? delegation.files.map(attachmentName) : undefined;
      return [{
        speaker: `${speakerName(item, fromName)} · ${t("转交")}`,
        at: ctx.formatTime(item.at),
        text: parts.join("\n\n"),
        ...(files?.length ? { files } : {}),
      }];
    }

    if (item.kind === "draft") {
      const draft = ctx.draft(item.draftId);
      if (!draft) return [];
      const statusText = draft.status === "created"
        ? t("新助手 · 已创建")
        : draft.status === "dismissed"
          ? t("新助手 · 已取消")
          : t("新助手 · 草稿");
      const text = [`${draft.name}（${statusText}）`, draft.dutyLong || draft.duty].filter(Boolean).join("\n\n");
      return [{
        speaker: speakerName(item, ctx.assistantName(draft.assistantId) ?? ctx.defaultAssistantName),
        at: ctx.formatTime(item.at),
        text,
      }];
    }

    if (item.kind === "topic") {
      const topic = ctx.topic(item.topicId);
      const name = topic?.name ?? item.topicId;
      const parts = [
        topic?.closedAt ? t("创建了话题「{name}」（已关闭）", { name }) : t("创建了话题「{name}」", { name }),
        topic?.closeNote ? `${t("结论")}：${topic.closeNote}` : "",
      ].filter(Boolean);
      return [{
        speaker: speakerName(item, ctx.defaultAssistantName),
        at: ctx.formatTime(item.at),
        text: parts.join("\n\n"),
      }];
    }

    if (item.kind !== "user" && item.kind !== "assistant") return [];
    const files = item.kind === "user" && item.files?.length ? item.files.map(attachmentName) : undefined;
    if (!item.text.trim() && !files?.length) return [];
    const fallbackSpeaker = item.kind === "user"
      ? (item.from ? item.from.name : t("用户"))
      : ctx.defaultAssistantName;
    return [{
      speaker: speakerName(item, fallbackSpeaker),
      at: ctx.formatTime(item.at),
      text: item.text,
      ...(item.quote?.text ? { quote: item.quote.text } : {}),
      ...(files ? { files } : {}),
    }];
  });
}

/** 仅裁掉首尾纯空行，保留正文中 4 空格缩进代码块等行首空白。 */
function stripOuterBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+|(?:\r?\n[ \t]*)+$/g, "");
}

/** 将完整对话格式化为清晰易读的 Markdown 文档。 */
export function formatConversationMarkdown(input: {
  title: string;
  subtitle?: string;
  exportedAt: string;
  messages: ExportConversationMessage[];
}): string {
  const lines: string[] = [`# ${input.title.trim() || "Conversation"}`, ""];
  const metaParts: string[] = [];
  if (input.subtitle?.trim()) metaParts.push(input.subtitle.trim());
  metaParts.push(t("导出时间：{time}", { time: input.exportedAt }));
  lines.push(`> ${metaParts.join(" · ")}`, "");

  if (input.messages.length === 0) {
    lines.push(t("（暂无消息）"), "");
    return lines.join("\n");
  }

  const blocks = input.messages.map((message) => {
    const parts: string[] = [];
    const header = message.at ? `### ${message.speaker} · ${message.at}` : `### ${message.speaker}`;
    parts.push(header);
    if (message.quote?.trim()) {
      const quoted = message.quote.replace(/\r?\n/g, " ").trim();
      parts.push(`> ${t("引用：{text}", { text: quoted })}`);
    }
    if (message.files?.length) {
      parts.push(`_${t("附件：{files}", { files: message.files.join(", ") })}_`);
    }
    const body = stripOuterBlankLines(message.text);
    if (body.trim()) {
      parts.push(body);
    }
    return parts.join("\n\n");
  });

  lines.push(blocks.join("\n\n---\n\n"), "");
  return lines.join("\n");
}
