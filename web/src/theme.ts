import type { Theme } from "../../shared/types.ts";

/**
 * 手机布局：取窗口宽度和屏幕宽度里小的那个。iPhone 主屏应用冷启动时 innerWidth 偶尔还是 980 这类默认值，
 * 只看它会先按宽屏画一帧、把状态栏色写成 --side，而 iOS 只认启动那一刻的颜色（index.html 里同样这么判断）。
 */
export function isNarrow(): boolean {
  return Math.min(window.innerWidth || Infinity, window.screen?.width || Infinity) < 768;
}

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

export function updateStatusColor(page: StatusPage, narrow: boolean) {
  const root = document.documentElement;
  root.style.setProperty("--status-background", `var(--${statusSurface(page, narrow)})`);
  const color = getComputedStyle(root).backgroundColor;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
}
