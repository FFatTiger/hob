// 对话里的 markdown 渲染。单独一个文件：node 环境的测试也能直接调。
import { Marked } from "marked";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 原文不预转义：预转义会让 marked 对代码段再转义一次，引号显示成 &amp;quot;。
 * 原始 HTML 一律当文本输出（覆盖 html renderer），模型输出里的 <script> 之类不会变成真标签。
 */
const markdown = new Marked({
  renderer: {
    html(token) {
      return escapeHtml(token.text ?? "");
    },
  },
});

/** 链接只放行 http(s)、mailto 和站内相对地址：javascript: 这类地址点了会执行脚本。 */
const SAFE_HREF = /^(https?:|mailto:|\/|#|\.)/i;

export function renderMarkdown(text: string): string {
  const html = markdown.parse(text, { async: false, gfm: true, breaks: true }) as string;
  return html.replace(/<a href="([^"]*)"/g, (_m, href: string) =>
    SAFE_HREF.test(href.trim()) ? `<a target="_blank" rel="noreferrer" href="${href}"` : "<a",
  );
}
