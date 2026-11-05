// 地址里的 hash 和页面的对应：#/chat/<助手 id>、#/settings[/<分栏>]。手机首页列表没有 hash。
export const SETTINGS_SECTIONS = ["general", "providers", "models", "memory", "image", "knowledge", "search", "skills", "mcp", "desktop", "work", "push", "about"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

type RouteState = { page: "main" | "settings" | "knowledge"; section: SettingsSection | null; sel: string | null; mobile: "list" | "chat" };

/** 地址里的 hash：#/chat/<助手 id> 或 #/settings[/<分栏>]。刷新时据此回到原来那页。 */
export function parseRoute(hash: string): { sel: string | null; settings: boolean; section: SettingsSection | null; knowledge?: boolean } {
  const [kind, arg] = hash.replace(/^#\/?/, "").split("/");
  let value: string | null = null;
  try {
    value = arg ? decodeURIComponent(arg) : null;
  } catch {
    // 手改坏的 %xx：当成没写
  }
  if (kind === "knowledge") return { sel: null, settings: false, section: null, knowledge: true };
  if (kind === "chat" && value) return { sel: value, settings: false, section: null };
  if (kind === "settings") {
    const section = SETTINGS_SECTIONS.find((s) => s === value) ?? null;
    return { sel: null, settings: true, section };
  }
  return { sel: null, settings: false, section: null };
}

/** 当前页面对应的 hash；手机首页列表没有 hash。 */
export function routeHash(s: RouteState, narrow: boolean): string {
  if (s.page === "knowledge") return "#/knowledge";
  if (s.page === "settings") return s.section ? `#/settings/${s.section}` : "#/settings";
  if (!s.sel || (narrow && s.mobile !== "chat")) return "";
  return `#/chat/${encodeURIComponent(s.sel)}`;
}

