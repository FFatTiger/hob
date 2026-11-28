export type DesktopShortcutAction =
  | { kind: "toggle-side" }
  | { kind: "toggle-panel" }
  | { kind: "go-home" }
  | { kind: "pin"; index: number };

export interface ShortcutEventLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
}

export interface ShortcutContext {
  inChat: boolean;
  inEditable: boolean;
  hasModal: boolean;
}

export function isEditableElement(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  const tag = el.tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

/** 解析桌面全局快捷键：⌘\ 切左栏、⌘. 切右栏、⇧⌘H 回首页、Alt+1~9 切置顶对话。 */
export function resolveDesktopShortcut(
  event: ShortcutEventLike,
  ctx: ShortcutContext,
): DesktopShortcutAction | null {
  if (event.defaultPrevented || event.isComposing || ctx.hasModal) return null;
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();

  if (mod && !event.altKey && !event.shiftKey && (event.code === "Backslash" || event.key === "\\")) {
    return ctx.inChat ? { kind: "toggle-side" } : null;
  }
  if (mod && !event.altKey && !event.shiftKey && (event.code === "Period" || event.key === ".")) {
    return ctx.inChat ? { kind: "toggle-panel" } : null;
  }
  if (mod && event.shiftKey && !event.altKey && (event.code === "KeyH" || key === "h")) {
    return { kind: "go-home" };
  }
  if (event.altKey && !mod && !event.shiftKey) {
    if (ctx.inEditable) return null;
    // macOS Option+数字会输出特殊符号（如 Option+1 -> ¡），优先匹配物理键码 Digit1~Digit9
    const codeMatch = event.code ? /^Digit([1-9])$/.exec(event.code) : null;
    const digit = codeMatch ? Number(codeMatch[1]) : /^[1-9]$/.test(event.key) ? Number(event.key) : 0;
    if (digit >= 1 && digit <= 9) return { kind: "pin", index: digit - 1 };
  }
  return null;
}
