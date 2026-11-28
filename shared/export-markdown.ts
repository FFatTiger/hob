import { t } from "./i18n.ts";

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
