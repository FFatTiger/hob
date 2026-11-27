import { useEffect, useState } from "react";
import type { DesktopScreen, DesktopScreenUser } from "../../shared/types.ts";
import { desktopMockScene } from "./mock.ts";
import { realApi as api } from "./api.ts";
import { MOCK, getState, subscribeConnection, subscribeEvents } from "./store.ts";
import { t } from "../../shared/i18n.ts";

export interface DesktopScreensSnapshot { screens: DesktopScreen[]; profiles: Record<string, string>; users: Record<string, DesktopScreenUser[]>; error?: string }

const EMPTY: DesktopScreensSnapshot = { screens: [], profiles: {}, users: {} };

let shared: DesktopScreensSnapshot = EMPTY;
let version = 0;
let initialized = false;
const listeners = new Set<() => void>();
let stopSubscriptions: (() => void) | null = null;

function setShared(update: DesktopScreensSnapshot | ((old: DesktopScreensSnapshot) => DesktopScreensSnapshot)) {
  shared = typeof update === "function" ? update(shared) : update;
  for (const listener of listeners) listener();
}

async function refreshShared() {
  const current = version;
  try {
    const result = await api.desktopScreens();
    setShared((old) => ({
      profiles: result.profiles,
      screens: version === current ? result.screens : old.screens,
      users: version === current ? (result.users ?? {}) : old.users,
    }));
  } catch (error) {
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
    if (status === "open" || status === "reconnect") {
      initialized = true;
      void refreshShared();
    } else if (status === "down") {
      initialized = false;
      setShared((old) => ({ ...old, screens: [], users: {} }));
    }
  });
  stopSubscriptions = () => {
    unsubEvents();
    unsubConn();
    stopSubscriptions = null;
  };
  if (!initialized && getState().phase === "ready") {
    initialized = true;
    void refreshShared();
  }
}

/** 测试用：重置共享快照状态。 */
export function resetDesktopScreensForTest(): void {
  stopSubscriptions?.();
  shared = EMPTY;
  version = 0;
  initialized = false;
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
    if (listeners.size === 0) {
      stopSubscriptions?.();
      initialized = false;
    }
  };
}

/** 复用全局实时连接共享云桌面快照：首次和重连拉一次，其余由服务端推送。 */
export function useDesktopScreens(): DesktopScreensSnapshot {
  const [snapshot, setSnapshot] = useState<DesktopScreensSnapshot>(() => (MOCK ? EMPTY : shared));
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
