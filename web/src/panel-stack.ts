export interface FilePreviewState {
  path: string;
  full: boolean;
  title?: string;
  liveId?: string;
  find?: string;
  page?: number;
}

export type PanelPage =
  | { kind: "routine"; id: string }
  | { kind: "newRoutine" }
  | { kind: "assistant" }
  | { kind: "routines" | "skills" | "knowledge" | "rules" }
  | { kind: "jobs" }
  | { kind: "job"; id: string; round?: number }
  | ({ kind: "file" } & FilePreviewState);

function samePage(a: PanelPage, b: PanelPage): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "routine" && b.kind === "routine") return a.id === b.id;
  if (a.kind === "job" && b.kind === "job") return a.id === b.id;
  if (a.kind === "file" && b.kind === "file") return a.liveId || b.liveId ? a.liveId === b.liveId : a.path === b.path;
  return true;
}

/** 打开已在栈里的页面时，退回该层并更新参数。 */
export function pushPage(stack: PanelPage[], page: PanelPage): PanelPage[] {
  const index = stack.findIndex((entry) => samePage(entry, page));
  return [...(index < 0 ? stack : stack.slice(0, index)), page];
}

export function selectPanelStack(stack: PanelPage[], previous: string | null, next: string, keep: boolean): PanelPage[] {
  return previous !== next && !keep ? [] : stack;
}

export function popPage(stack: PanelPage[]): PanelPage[] {
  return stack.slice(0, -1);
}

export function replacePage(stack: PanelPage[], page: PanelPage): PanelPage[] {
  return pushPage(popPage(stack), page);
}

export function removeMissingLivePages(stack: PanelPage[], livePages: Record<string, unknown>): PanelPage[] {
  return stack.filter((page) => page.kind !== "file" || !page.liveId || Boolean(livePages[page.liveId]));
}
