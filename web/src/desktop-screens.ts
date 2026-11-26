import { useEffect, useState } from "react";
import type { DesktopScreen, DesktopScreenUser } from "../../shared/types.ts";
import { desktopMockScene } from "./mock.ts";
import { realApi as api } from "./api.ts";
import { MOCK } from "./store.ts";
import { t } from "../../shared/i18n.ts";

interface Snapshot { screens: DesktopScreen[]; profiles: Record<string, string>; users: Record<string, DesktopScreenUser[]>; error?: string }

/** 首次和 SSE 重连拉快照，其余变化由服务端推送。 */
export function useDesktopScreens(): Snapshot {
  const [snapshot, setSnapshot] = useState<Snapshot>({ screens: [], profiles: {}, users: {} });
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
          const next = detail as Partial<Snapshot>;
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
    let alive = true;
    let version = 0;
    const refresh = async () => {
      const current = version;
      try {
        const result = await api.desktopScreens();
        if (alive) {
          setSnapshot((old) => ({
            profiles: result.profiles,
            screens: version === current ? result.screens : old.screens,
            users: version === current ? (result.users ?? {}) : old.users,
          }));
        }
      } catch (error) { if (alive) setSnapshot((old) => ({ ...old, error: error instanceof Error ? error.message : String(error) })); }
    };
    const events = new EventSource("/api/events");
    events.onopen = () => { void refresh(); };
    events.onerror = () => { if (alive) setSnapshot((old) => ({ ...old, screens: [], users: {} })); };
    events.onmessage = (event) => {
      try {
        const value = JSON.parse(event.data);
        if (value.type === "desktop-screens" && Array.isArray(value.screens)) {
          version++;
          setSnapshot((old) => ({
            ...old,
            screens: value.screens,
            ...(value.users && typeof value.users === "object" ? { users: value.users as Record<string, DesktopScreenUser[]> } : {}),
          }));
        } else if (value.type === "assistant" || value.type === "assistant_removed") void refresh();
      } catch { /* 忽略无效事件 */ }
    };
    return () => { alive = false; events.close(); };
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
