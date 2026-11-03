// 对话里的 markdown 渲染；原始 HTML 不进入 DOM。
import { Marked } from "marked";
import type katex from "katex";
import { iconSvg } from "./icons.tsx";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type Katex = typeof katex;
let math: Katex | undefined;
let loading: Promise<void> | undefined;

/** 只有遇到公式定界符时加载公式引擎和本地字体。 */
export function loadMath(): Promise<void> {
  return loading ??= import("./math.ts").then((module) => { math = module.default; });
}

export function hasMath(text: string): boolean {
  let found = false;
  markdown.walkTokens(markdown.lexer(text), (token) => {
    if (token.type === "inlineMath" || token.type === "displayMath") found = true;
  });
  return found;
}

function formula(source: string, display: boolean, raw: string): string {
  if (!math) return escapeHtml(raw);
  try {
    // 写错的公式抛错 → 原样显示源码
    return math.renderToString(source, { displayMode: display, throwOnError: true, trust: false });
  } catch {
    return escapeHtml(raw);
  }
}

const markdown = new Marked({
  extensions: [
    {
      name: "displayMath", level: "block",
      start(src) { return src.search(/\$\$|\\\[/); },
      tokenizer(src) {
        const match = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])(?:\n|$)/.exec(src);
        if (match) return { type: "displayMath", raw: match[0], text: match[1] ?? match[2] };
      },
      renderer(token) { return `<div class="math-display">${formula(String(token.text), true, token.raw.trimEnd())}</div>`; },
    },
    {
      name: "inlineMath", level: "inline",
      start(src) { return src.search(/\$|\\\(/); },
      tokenizer(src) {
        const match = /^(?:\$(?!\$|\s)([^$`\n]*?[^$`\s])\$(?!\d)|\\\((.+?)\\\))/.exec(src);
        if (match) return { type: "inlineMath", raw: match[0], text: match[1] ?? match[2] };
      },
      renderer(token) { return formula(String(token.text), false, token.raw); },
    },
  ],
  renderer: {
    html(token) { return escapeHtml(token.text ?? ""); },
    code(token) {
      const lang = token.lang?.trim().split(/\s+/)[0] ?? "";
      const head = lang ? `<div class="code-head">${escapeHtml(lang)}</div>` : "";
      return `<div class="code-block">${head}<button type="button" class="code-copy" aria-label="复制代码" title="复制代码">${iconSvg("copy", 15)}</button><pre><code>${escapeHtml(token.text)}\n</code></pre></div>`;
    },
  },
});

const SAFE_HREF = /^(https?:|mailto:|\/|#|\.)/i;
export function renderMarkdown(text: string): string {
  const html = markdown.parse(text, { async: false, gfm: true, breaks: true }) as string;
  return html.replace(/<a href="([^"]*)"/g, (_m, href: string) =>
    SAFE_HREF.test(href.trim()) ? `<a target="_blank" rel="noreferrer" href="${href}"` : "<a",
  );
}

/**
 * 把一条回复按顶层表格切开：表格单独成卡片（框内左右滑），前后的文字还是气泡。
 * 没有表格就原样一段。代码块里的 | 不算表格（marked 按顶层 token 切）。
 */
export function splitTables(text: string): { table: boolean; md: string }[] {
  const parts: { table: boolean; md: string }[] = [];
  for (const token of markdown.lexer(text, { gfm: true })) {
    const table = token.type === "table";
    const last = parts.at(-1);
    if (last && !last.table && !table) last.md += token.raw;
    else parts.push({ table, md: token.raw });
  }
  const out = parts.filter((part) => part.table || part.md.trim());
  return out.length ? out : [{ table: false, md: text }];
}
