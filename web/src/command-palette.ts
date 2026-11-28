export interface PaletteKeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing?: boolean;
}

export type GlobalPaletteAction = "toggle" | "close" | null;

/** 全局快捷键判断：避免在已有模态框或输入法组合态时劫持 ⌘K / Escape。 */
export function resolveGlobalPaletteKey(
  event: PaletteKeyEventLike,
  state: { open: boolean; hasOtherModal: boolean },
): GlobalPaletteAction {
  if (event.isComposing) return null;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    if (!state.open && state.hasOtherModal) return null;
    return "toggle";
  }
  if (event.key === "Escape" && state.open) {
    return "close";
  }
  return null;
}

export type InputPaletteAction =
  | { kind: "move"; index: number }
  | { kind: "execute" }
  | { kind: "close" }
  | null;

/** 命令面板输入框按键：输入法组合态时忽略上下键和回车。 */
export function resolveInputPaletteKey(
  event: { key: string; isComposing?: boolean },
  current: number,
  count: number,
): InputPaletteAction {
  if (event.key === "Escape") return { kind: "close" };
  if (event.isComposing) return null;
  if (event.key === "ArrowDown") {
    return { kind: "move", index: count ? (current + 1) % count : 0 };
  }
  if (event.key === "ArrowUp") {
    return { kind: "move", index: count ? (current - 1 + count) % count : 0 };
  }
  if (event.key === "Enter") {
    return { kind: "execute" };
  }
  return null;
}

export function filterPaletteItems<T extends { label: string; keywords: string }>(
  items: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (item) => item.label.toLowerCase().includes(q) || item.keywords.toLowerCase().includes(q),
  );
}
