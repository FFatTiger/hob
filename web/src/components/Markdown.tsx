import { useEffect, useState } from "react";
import { copyText } from "../clipboard.ts";
import { iconSvg } from "../icons.tsx";
import { hasMath, loadMath, renderMarkdown } from "../markdown.ts";
import { setNotice } from "../store.ts";

export function Markdown({ text, className, streaming }: { text: string; className?: string; streaming?: boolean }) {
  const [, refresh] = useState(0);
  useEffect(() => {
    let active = true;
    if (hasMath(text)) void loadMath().then(() => { if (active) refresh((n) => n + 1); }).catch(() => {});
    return () => { active = false; };
  }, [text]);
  return <div className={className} onClick={(event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".code-copy");
    if (!button) return;
    event.stopPropagation();
    const code = button.closest(".code-block")?.querySelector("code")?.textContent ?? "";
    void copyText(code.endsWith("\n") ? code.slice(0, -1) : code).then((ok) => {
      if (!ok) { setNotice("复制失败：浏览器不允许写入剪贴板"); return; }
      button.innerHTML = iconSvg("check", 15);
      button.setAttribute("aria-label", "已复制");
      window.setTimeout(() => { button.innerHTML = iconSvg("copy", 15); button.setAttribute("aria-label", "复制代码"); }, 1500);
    });
  }} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) + (streaming ? '<span class="cur"></span>' : "") }} />;
}
