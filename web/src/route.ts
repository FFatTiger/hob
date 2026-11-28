// 地址里的 hash 和页面的对应：#/chat/<助手 id>[/<右栏的页>]、#/group/<群 id>[/<右栏的页>]、#/settings[/<分栏>]。首页没有 hash。
import type { PanelPage } from "./panel-stack.ts";

export const SETTINGS_SECTIONS = ["general", "rules", "providers", "models", "memory", "image", "knowledge", "search", "skills", "desktop", "work", "usage", "push", "about"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

type RouteState = { page: "main" | "settings" | "knowledge" | "plugins" | "stars"; pluginId?: string | null; pluginPage?: "installed" | "market" | "new"; section: SettingsSection | null; sel: string | null; gsel?: string | null; tsel?: string | null; mobile: "list" | "topics" | "chat"; panelStack?: PanelPage[] };

function decode(arg: string | undefined): string | null {
  try {
    return arg ? decodeURIComponent(arg) : null;
  } catch {
    return null; // 手改坏的 %xx：当成没写
  }
}

/** 右栏的页：#/chat/<助手>/skills、/job/<id>、/file/<路径> 这样接在助手后面。 */
function parsePanel(kind: string | undefined, arg: string | null): PanelPage | undefined {
  if (kind === "job" || kind === "routine" || kind === "groupSettings" || kind === "member") return arg ? { kind, id: arg } : undefined;
  if (kind === "file") return arg ? { kind, path: arg, full: false } : undefined;
  if (kind === "routines" || kind === "skills" || kind === "knowledge" || kind === "rules" || kind === "topicRules" || kind === "topicModels" || kind === "assistant" || kind === "jobs" || kind === "newRoutine") return { kind };
}

function panelHash(page: PanelPage): string {
  if (page.kind === "job" || page.kind === "routine" || page.kind === "groupSettings" || page.kind === "member") return `/${page.kind}/${encodeURIComponent(page.id)}`;
  if (page.kind === "file") return page.liveId || !page.path ? "" : `/file/${encodeURIComponent(page.path)}`;
  return `/${page.kind}`;
}

/** 地址里的 hash：刷新时据此回到原来那页。 */
export function parseRoute(hash: string): { sel: string | null; topic?: string; group?: string; settings: boolean; section: SettingsSection | null; knowledge?: boolean; stars?: boolean; plugins?: boolean; pluginId?: string | null; pluginPage?: "installed" | "market" | "new"; panel?: PanelPage } {
  const [kind, arg, panel, panelArg, subPanel, subPanelArg] = hash.replace(/^#\/?/, "").split("/");
  const value = decode(arg);
  if (kind === "plugins") {
    if (value === "market" || value === "new") return { sel: null, settings: false, section: null, plugins: true, pluginId: null, pluginPage: value };
    return { sel: null, settings: false, section: null, plugins: true, pluginId: value, pluginPage: "installed" };
  }
  if (kind === "stars") return { sel: null, settings: false, section: null, stars: true };
  if (kind === "knowledge") return { sel: null, settings: false, section: null, knowledge: true };
  if (kind === "jobs" || kind === "job" || kind === "file") {
    const rootPanel = parsePanel(kind, value);
    return rootPanel ? { sel: null, settings: false, section: null, panel: rootPanel } : { sel: null, settings: false, section: null };
  }
  if (kind === "group" && value) return { sel: null, group: value, settings: false, section: null, panel: parsePanel(panel, decode(panelArg)) };
  if (kind === "chat" && value) {
    if (panel === "topic") {
      const topic = decode(panelArg);
      if (!topic) return { sel: value, settings: false, section: null };
      return { sel: value, topic, settings: false, section: null, panel: parsePanel(subPanel, decode(subPanelArg)) };
    }
    return { sel: value, settings: false, section: null, panel: parsePanel(panel, decode(panelArg)) };
  }
  if (kind === "settings") {
    if (value === "mcp") return { sel: null, settings: false, section: null, plugins: true, pluginId: null, pluginPage: "installed" };
    const section = SETTINGS_SECTIONS.find((s) => s === value) ?? null;
    const settingsPanel = section ? parsePanel(panel, decode(panelArg)) : undefined;
    return settingsPanel ? { sel: null, settings: true, section, panel: settingsPanel } : { sel: null, settings: true, section };
  }
  return { sel: null, settings: false, section: null };
}

/** 当前页面对应的 hash；右栏开着的页接在会话后面；首页没有 hash。 */
export function routeHash(s: RouteState, narrow: boolean): string {
  const top = s.panelStack?.at(-1);
  const topHash = top ? panelHash(top) : "";
  if (s.page === "plugins") {
    if (s.pluginId) return `#/plugins/${encodeURIComponent(s.pluginId)}`;
    return s.pluginPage === "market" || s.pluginPage === "new" ? `#/plugins/${s.pluginPage}` : "#/plugins";
  }
  if (s.page === "stars") return "#/stars";
  if (s.page === "knowledge") return "#/knowledge";
  if (s.page === "settings") {
    const base = s.section ? `#/settings/${s.section}` : "#/settings";
    return !narrow && topHash ? `#/settings/${s.section ?? "general"}${topHash}` : base;
  }
  const conv = s.gsel ?? s.sel;
  if (!conv) return !narrow && top && (top.kind === "jobs" || top.kind === "job" || top.kind === "file") && topHash ? `#${topHash}` : "";
  if (narrow && s.mobile !== "chat") return "";
  const topic = !s.gsel && s.tsel ? `/topic/${encodeURIComponent(s.tsel)}` : "";
  return `#/${s.gsel ? "group" : "chat"}/${encodeURIComponent(conv)}${topic}${topHash}`;
}
