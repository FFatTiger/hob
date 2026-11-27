import { useEffect, useState } from "react";
import type { DesktopScreen, DesktopScreenUser } from "../../shared/types.ts";
import { desktopMockScene } from "./mock.ts";
import { realApi as api } from "./api.ts";
import { MOCK, liveConnected, subscribeConnection, subscribeEvents } from "./store.ts";
import { t } from "../../shared/i18n.ts";

export interface DesktopScreensSnapshot { screens: DesktopScreen[]; profiles: Record<string, string>; users: Record<string, DesktopScreenUser[]>; error?: string }

const EMPTY: DesktopScreensSnapshot = { screens: [], profiles: {}, users: {} };

// 演示模式不走这里的订阅，shared 一直是 EMPTY
let shared: DesktopScreensSnapshot = EMPTY;
// 推送来的屏幕版本：拉快照期间收到推送，就留着推送的屏幕
let version = 0;
// 最近一次拉快照的序号：先发的请求晚回来，不覆盖后发的
let latest = 0;
// 实时连接断一次加一：断开前发出的请求晚回来，不把断线时清掉的屏幕又填回去
let epoch = 0;
const listeners = new Set<() => void>();
let stopSubscriptions: (() => void) | null = null;

function setShared(update: DesktopScreensSnapshot | ((old: DesktopScreensSnapshot) => DesktopScreensSnapshot)) {
  shared = typeof update === "function" ? update(shared) : update;
  for (const listener of listeners) listener();
}

async function refreshShared() {
  const seq = ++latest;
  const pushed = version;
  const at = epoch;
  const stale = () => seq !== latest || at !== epoch;
  try {
    const result = await api.desktopScreens();
    if (stale()) return;
    setShared((old) => ({
      profiles: result.profiles,
      screens: version === pushed ? result.screens : old.screens,
      users: version === pushed ? (result.users ?? {}) : old.users,
    }));
  } catch (error) {
    if (stale()) return;
    setShared((old) => ({ ...old, error: error instanceof Error ? error.message : String(error) }));
  }
}

function attachShared() {
  if (stopSubscriptions) return;
  const unsubEvents = subscribeEvents((value) => {
    if (value.type === "desktop-screens" && Array.isArray(value.screens)) {
      version++;
      setShared((old) => ({
        profiles: old.profiles,
        screens: value.screens,
        users: value.users && typeof value.users === "object" ? value.users : old.users,
      }));
    } else if (value.type === "assistant" || value.type === "assistant_removed") {
      void refreshShared();
    }
  });
  const unsubConn = subscribeConnection((status) => {
    if (status === "down") {
      // 断线时跟不上屏幕变化，先当都没在跑；助手到屏幕的对应不变，留着
      epoch++;
      setShared((old) => ({ ...old, screens: [], users: {} }));
    } else void refreshShared();
  });
  stopSubscriptions = () => {
    unsubEvents();
    unsubConn();
    stopSubscriptions = null;
  };
  // 第一个订阅者来时已经连着：之前没人跟推送，先拉一次；还没连上就等 open 再拉
  if (liveConnected()) void refreshShared();
}

/** 测试用：重置共享快照状态。 */
export function resetDesktopScreensForTest(): void {
  stopSubscriptions?.();
  shared = EMPTY;
  version = 0;
  latest = 0;
  epoch = 0;
  listeners.clear();
}

/** 订阅共享的云桌面快照：多处订阅只共用全局唯一实时连接与同一份快照。 */
export function subscribeDesktopScreens(listener: (snapshot: DesktopScreensSnapshot) => void): () => void {
  const sync = () => listener(shared);
  listeners.add(sync);
  attachShared();
  sync();
  return () => {
    listeners.delete(sync);
    if (listeners.size === 0) stopSubscriptions?.();
  };
}

/** 复用全局实时连接共享云桌面快照：首次和重连拉一次，其余由服务端推送。 */
export function useDesktopScreens(): DesktopScreensSnapshot {
  const [snapshot, setSnapshot] = useState<DesktopScreensSnapshot>(() => shared);
  useEffect(() => {
    if (MOCK) {
      if (desktopMockScene() === "ready" || desktopMockScene() === "deployed") {
        setSnapshot({
          screens: [{ id: "hob", running: true, browserRunning: true, viewers: 0, lastActiveAt: null }],
          profiles: { hob: "hob" },
          users: { hob: [{ assistantId: "hob", place: {} }] },
        });
      }
      // 演示和验收用：页面里发 hob-mock-desktop 事件（detail 是在不在运行，或完整快照），模拟云桌面状态变化
      const onMock = (event: Event) => {
        const detail = (event as CustomEvent).detail;
        if (detail && typeof detail === "object" && "screens" in detail) {
          const next = detail as Partial<DesktopScreensSnapshot>;
          setSnapshot((old) => ({
            screens: next.screens ?? old.screens,
            profiles: next.profiles ?? old.profiles,
            users: next.users ?? {},
          }));
          return;
        }
        const running = Boolean(detail);
        setSnapshot({
          screens: [{ id: "hob", running, browserRunning: running, viewers: 0, lastActiveAt: null }],
          profiles: { hob: "hob" },
          users: running ? { hob: [{ assistantId: "hob", place: {} }] } : {},
        });
      };
      window.addEventListener("hob-mock-desktop", onMock);
      return () => window.removeEventListener("hob-mock-desktop", onMock);
    }
    return subscribeDesktopScreens(setSnapshot);
  }, []);
  return snapshot;
}

export async function startDesktopScreen(id: string): Promise<void> {
  const response = await fetch(`/api/desktop/screens/${encodeURIComponent(id)}/start`, { method: "POST" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? t("无法启动屏幕。"));
  }
}
