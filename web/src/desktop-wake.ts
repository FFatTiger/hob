import type { DesktopScreen } from "../../shared/types.ts";

interface ScreenState {
  active: boolean;
  /** 上一次看到它时，用户正开着这个会话（电脑端、右栏没被别的页盖住） */
  watched: boolean;
  /** 这一次占用是我们自动展开的，用户还没自己收起：释放后由我们收回 */
  autoExpanded: boolean;
}

/**
 * 云桌面在本会话被唤醒（屏幕从没在本会话使用变成在本会话运行）时，要不要自动把右栏展开。
 * 状态只在当前页面的内存里，按屏幕记。
 */
export class DesktopWakeTracker {
  private readonly states = new Map<string, ScreenState>();
  private lastSessionKey = "";

  /** 右栏「正在做」卸载了：这期间发生的唤醒没人在看，回来以后不补弹。 */
  unwatch(): void {
    for (const state of this.states.values()) state.watched = false;
  }

  /**
   * watched：当前会话看着的候选屏幕（单聊是这个助手的，群信息页是全体成员的）。
   * active：watched 中当前正被本会话使用且在运行的屏幕。
   */
  observe(
    screens: readonly DesktopScreen[],
    watched: readonly string[],
    active: readonly string[],
    eligible: boolean,
    collapsed: boolean,
    nowWide: boolean,
    sessionKey = "",
  ): "expand" | "restore" | undefined {
    // 空列表是连不上云桌面（断线、Hob 重启），状态未知：什么都不动，不然重连会被当成一次唤醒
    if (!screens.length) return undefined;
    if (sessionKey !== this.lastSessionKey) {
      this.lastSessionKey = sessionKey;
      for (const state of this.states.values()) {
        state.watched = false;
        state.autoExpanded = false;
      }
    }
    const ids = new Set([...this.states.keys(), ...screens.map((screen) => screen.id), ...watched]);
    const anyWatchedActive = active.some((id) => watched.includes(id) && screens.some((screen) => screen.id === id && screen.running));
    let action: "expand" | "restore" | undefined;
    for (const id of ids) {
      // 列表里没有这块屏幕，或没有被当前会话使用：不算本会话活跃
      const isActive = screens.some((screen) => screen.id === id && screen.running) && active.includes(id);
      const watching = watched.includes(id) && eligible;
      const previous = this.states.get(id);
      const next: ScreenState = { active: isActive, watched: watching, autoExpanded: false };
      if (previous?.active && isActive) {
        // 自动展开以后用户自己收起了：这一次占用不再管它
        next.autoExpanded = previous.autoExpanded && !(watching && (collapsed || !nowWide));
      } else if (previous && !previous.active && isActive) {
        if (watching && previous.watched && (collapsed || !nowWide)) {
          next.autoExpanded = true;
          action = "expand";
        }
      } else if (previous?.active && !isActive && previous.autoExpanded && nowWide && !anyWatchedActive) {
        action = "restore";
      }
      this.states.set(id, next);
    }
    return action;
  }
}
