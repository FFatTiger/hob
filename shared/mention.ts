/** 围栏代码、缩进代码块、行内代码与链接地址里的 @ 只用于展示，不触发点名。 */
export function stripCodeForMentions(text: string): string {
  const fences = /^[ \t]*(`{3,}|~{3,})([^\r\n]*)/gm;
  let cursor = 0;
  let cleaned = "";
  for (let open = fences.exec(text); open; open = fences.exec(text)) {
    const [, marker = "", info = ""] = open;
    if (marker[0] === "`" && info.includes("`")) continue;
    // 结束围栏用同一种符号，且至少与起始围栏一样长。
    const closing = new RegExp(`^[ \\t]*${marker[0]}{${marker.length},}[ \\t]*(?=\\r?$)`, "gm");
    closing.lastIndex = fences.lastIndex;
    const end = closing.exec(text);
    cleaned += `${text.slice(cursor, open.index)} `;
    cursor = end ? closing.lastIndex : text.length;
    if (!end) break;
    fences.lastIndex = cursor;
  }
  const withoutFences = cleaned + text.slice(cursor);

  // 4 空格或制表符缩进代码块（前一行是文首或空行）
  const lines = withoutFences.split(/\r?\n/);
  let prevBlank = true;
  let inIndented = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const blank = /^[ \t]*$/.test(line);
    if (blank) {
      prevBlank = true;
      continue;
    }
    const indented = /^(?: {4}|\t)/.test(line);
    if (indented && (prevBlank || inIndented)) {
      lines[i] = " ";
      inIndented = true;
      prevBlank = false;
      continue;
    }
    inIndented = false;
    prevBlank = false;
  }

  return lines
    .join("\n")
    // 行内代码
    .replace(/(?<![`\\])(`+)(?!`)(?:(?!\r?\n[ \t]*\r?\n)[\s\S])*?(?<!`)\1(?!`)/g, " ")
    // Markdown 链接目标 [text](url) 保留链接文字、屏蔽 URL 中的 @
    .replace(/(\[[^\]]*\])\((?:[^()\r\n]|\([^()\r\n]*\))*\)/g, "$1 ")
    // 自动链接 <https://...> / <mailto:...>
    .replace(/<(?:https?:\/\/|mailto:)[^>\s]+>/gi, " ")
    // 裸 URL（如 https://example.com/@qa）
    .replace(/https?:\/\/[^\s<>()]+/gi, " ");
}

export function isMentionPrefixBoundary(prevChar: string | undefined): boolean {
  return prevChar === undefined || !/[A-Za-z0-9._%+-]/.test(prevChar);
}

export function isMentionNameContinuation(name: string, nextChar: string | undefined): boolean {
  return nextChar !== undefined && /[A-Za-z0-9_]$/.test(name) && /[A-Za-z0-9_-]/.test(nextChar);
}

export function extractMentions(text: string, candidates: Array<{ id: string; name: string }>): string[] {
  const cleaned = stripCodeForMentions(text);
  const labels = candidates
    .filter((candidate) => Boolean(candidate.name))
    .map(({ id, name }) => ({ id, label: name }))
    .sort((a, b) => b.label.length - a.label.length);
  const ids = new Set<string>();
  for (let at = 0; at < cleaned.length; at += 1) {
    const ch = cleaned[at];
    if (ch !== "@" && ch !== "＠") continue;
    if (!isMentionPrefixBoundary(cleaned[at - 1])) continue;
    const hit = labels.find(({ label }) => cleaned.startsWith(label, at + 1) && !isMentionNameContinuation(label, cleaned[at + 1 + label.length]));
    if (hit) ids.add(hit.id);
  }
  return [...ids];
}
