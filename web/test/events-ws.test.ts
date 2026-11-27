import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DesktopScreen, HobEvent } from "../../shared/types.ts";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(data: unknown) {
    this.onmessage?.({ data });
  }

  drop() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

const mocks = vi.hoisted(() => ({
  desktopScreensCount: 0,
  screens: [{ id: "a-fjl7", running: true, browserRunning: true, viewers: 1, lastActiveAt: null }] as DesktopScreen[],
  profiles: { "a-fjl7": "a-fjl7" } as Record<string, string>,
}));

vi.mock("../src/theme.ts", () => ({
  resolveTheme: () => ({ dark: false }),
  updateStatusColor: () => undefined,
  updateManifest: () => undefined,
  isNarrow: () => false,
}));

let apiMod: typeof import("../src/api.ts");
let store: typeof import("../src/store.ts");
let desktopScreens: typeof import("../src/desktop-screens.ts");

beforeAll(async () => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("EventSource", class ForbiddenEventSource {
    constructor() { throw new Error("不应再创建 EventSource"); }
  });
  vi.stubGlobal("location", { protocol: "http:", host: "192.168.100.50:30148", search: "", hash: "" });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener: () => undefined }), innerWidth: 1280 });
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => undefined, documentElement: { classList: { toggle: () => undefined }, style: {} } });

  apiMod = await import("../src/api.ts");
  store = await import("../src/store.ts");
  desktopScreens = await import("../src/desktop-screens.ts");
});

afterEach(() => {
  desktopScreens.resetDesktopScreensForTest();
  FakeWebSocket.instances = [];
  mocks.desktopScreensCount = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("全局实时连接（纯 WebSocket）", () => {
  it("连接 /api/events/ws，分发事件并在断线后指数退避重连", async () => {
    vi.useFakeTimers();
    const received: HobEvent[] = [];
    let reconnects = 0;
    const downs: string[] = [];

    const stop = apiMod.realApi.events(
      {
        onEvent: (ev) => received.push(ev),
        onReconnect: () => { reconnects++; },
        onDown: (reason) => downs.push(reason),
      },
      "tab-1",
    );

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe("ws://192.168.100.50:30148/api/events/ws?clientId=tab-1");

    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].receive(JSON.stringify({ type: "desktop-control", screen: "a-fjl7", taken: true }));
    FakeWebSocket.instances[0].receive("not-json");
    expect(received).toEqual([{ type: "desktop-control", screen: "a-fjl7", taken: true }]);

    // 断线后 1 秒重连
    FakeWebSocket.instances[0].drop();
    expect(downs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // 再次失败则退避到 2 秒
    FakeWebSocket.instances[1].drop();
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    // 恢复连接触发 onReconnect
    FakeWebSocket.instances[2].open();
    expect(reconnects).toBe(1);

    stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("多处订阅云桌面快照共用唯一连接，不创建 EventSource 且不重复拉取", async () => {
    vi.spyOn(apiMod.realApi, "me").mockResolvedValue({} as never);
    vi.spyOn(apiMod.realApi, "bootstrap").mockResolvedValue({
      assistants: [{ id: "a-fjl7", name: "测试", primary: true }],
      jobs: [],
      routines: [],
      approvals: [],
      settings: { settings: { general: { theme: "light", locale: "zh-CN" } } },
    } as never);
    vi.spyOn(apiMod.realApi, "groups").mockResolvedValue([]);
    vi.spyOn(apiMod.realApi, "stars").mockResolvedValue([]);
    vi.spyOn(apiMod.realApi, "items").mockResolvedValue({ items: [], hasMore: false, jobs: [], approvals: [], drafts: [], delegations: [], cards: [] } as never);
    vi.spyOn(apiMod.realApi, "profile").mockResolvedValue({ assistant: { id: "a-fjl7", name: "测试", primary: true }, rules: [], worklog: [], routines: [] } as never);
    vi.spyOn(apiMod.realApi, "visibility").mockResolvedValue(undefined);
    vi.spyOn(apiMod.realApi, "desktopScreens").mockImplementation(async () => {
      mocks.desktopScreensCount++;
      return { screens: mocks.screens, profiles: mocks.profiles };
    });

    const snapshots: Array<import("../src/desktop-screens.ts").DesktopScreensSnapshot> = [];
    // 模拟 App / Panel / PanelNow / JobDetail / DesktopView 5 处同时订阅
    const unsubs = Array.from({ length: 5 }, (_, idx) =>
      desktopScreens.subscribeDesktopScreens((snap) => { snapshots[idx] = snap; }),
    );
    const controlEvents: boolean[] = [];
    const unsubControl = store.subscribeEvents((ev) => {
      if (ev.type === "desktop-control" && ev.screen === "a-fjl7") controlEvents.push(ev.taken);
    });

    await store.start();
    await vi.waitFor(() => expect(mocks.desktopScreensCount).toBe(1));

    // 全局只有 1 条 WebSocket 连接，0 条 EventSource，5 处订阅全部同步拿到快照
    expect(FakeWebSocket.instances).toHaveLength(1);
    for (let i = 0; i < 5; i++) {
      expect(snapshots[i].screens).toEqual(mocks.screens);
      expect(snapshots[i].profiles).toEqual(mocks.profiles);
    }

    // 推送 desktop-screens 与 desktop-control 事件时实时更新
    FakeWebSocket.instances[0].open();
    const updated: DesktopScreen[] = [{ id: "a-fjl7", running: false, browserRunning: false, viewers: 0, lastActiveAt: null }];
    FakeWebSocket.instances[0].receive(JSON.stringify({ type: "desktop-screens", screens: updated }));
    FakeWebSocket.instances[0].receive(JSON.stringify({ type: "desktop-control", screen: "a-fjl7", taken: true }));
    expect(snapshots[0].screens).toEqual(updated);
    expect(snapshots[4].screens).toEqual(updated);
    expect(controlEvents).toEqual([true]);

    // 断线清空 screens，重连后只拉一次快照
    vi.useFakeTimers();
    FakeWebSocket.instances[0].drop();
    expect(snapshots[0].screens).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    FakeWebSocket.instances[1].open();
    await vi.waitFor(() => expect(mocks.desktopScreensCount).toBe(2));
    expect(snapshots[0].screens).toEqual(mocks.screens);

    unsubControl();
    for (const unsub of unsubs) unsub();
    await store.logout();
  });
});
