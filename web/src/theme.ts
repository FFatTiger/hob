import type { Theme } from "../../shared/types.ts";

export function resolveTheme(theme: Theme, systemDark: boolean) {
  const dark = theme === "dark" || (theme === "system" && systemDark);
  return { dark, color: dark ? "#1b1b1d" : "#f6f6f4" };
}

interface StatusPage {
  phase: "loading" | "login" | "ready" | "error";
  page: "main" | "settings" | "knowledge";
  sheet: boolean;
  panelStack: Array<{ kind: string; full?: boolean }>;
}

export function statusSurface(page: StatusPage, narrow: boolean): "bg" | "side" | "panel" {
  // 手机上加载 / 登录页和首页同色：iOS 只认启动时的颜色，启动后再变它不跟，首页就会一直是加载时的颜色
  if (page.phase !== "ready") return narrow ? "bg" : "side";
  const top = page.panelStack.at(-1);
  if (top?.kind === "file" && (narrow || top.full)) return "bg";
  if (narrow) return top?.kind === "job" || top?.kind === "jobs" || page.page === "settings" || page.page === "knowledge" ? "bg" : top || page.sheet ? "panel" : "bg";
  return page.page === "settings" || page.page === "knowledge" ? "bg" : "side";
}

const LIGHT_MANIFEST = "/manifest.webmanifest?v=4";
const DARK_MANIFEST = "/manifest-dark.webmanifest?v=4";

/**
 * 装到主屏后，iOS 画启动屏和状态栏用的是 manifest 里的 background_color / theme_color。
 * manifest 只有一份、不跟系统主题走，所以按当前主题换一份深色的；index.html 里预判过一次，
 * 这里在主题真正确定下来后再对一次（服务端保存的主题可能和本地缓存不一致）。
 */
export function updateManifest(dark: boolean) {
  const link = document.getElementById("manifest");
  if (link) link.setAttribute("href", dark ? DARK_MANIFEST : LIGHT_MANIFEST);
}

export function updateStatusColor(page: StatusPage, narrow: boolean) {
  const root = document.documentElement;
  root.style.setProperty("--status-background", `var(--${statusSurface(page, narrow)})`);
  const color = getComputedStyle(root).backgroundColor;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
}
