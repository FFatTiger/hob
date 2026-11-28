import { t } from "../../shared/i18n.ts";
import { exportAssistantMarkdown, exportGroupMarkdown, setNotice } from "./store.ts";

/** 在浏览器触发下载一份 UTF-8 Markdown 文件。 */
export function downloadMarkdownFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 导出指定对话（群/群话题或助手/助手话题）为 Markdown 并提示结果。 */
export async function exportConversationMarkdown(
  target: { kind: "group"; id: string } | { kind: "assistant"; id: string; topicId?: string },
): Promise<boolean> {
  const result = target.kind === "group"
    ? await exportGroupMarkdown(target.id)
    : await exportAssistantMarkdown(target.id, target.topicId);
  if (!result.ok) {
    setNotice(t("导出失败：{error}", { error: result.error }));
    return false;
  }
  downloadMarkdownFile(result.data.filename, result.data.content);
  setNotice(t("已导出「{name}」", { name: result.data.filename }));
  return true;
}
