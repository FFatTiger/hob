import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DesktopScreen, HobEvent } from "../../shared/types.ts";
import type { DesktopScreensSnapshot } from "../src/desktop-screens.ts";
import { t } from "../../shared/i18n.ts";

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

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }

  receive(data: string) {
    this.onmessage?.({ data });
  }

  fail(readyState: number) {
    this.readyState = readyState;
    this.onerror?.();
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
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
  vi.stubGlobal("EventSource", FakeEventSource);
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
  FakeEventSource.instances = [];
  mocks.desktopScreensCount = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("全局实时连接（WebSocket 优先，不支持时退回 SSE）", () => {
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
    // 连上过 WebSocket 就一直用它重连，不退回 SSE
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("反代不转发 WebSocket 升级时退回一条 SSE，事件照常送达", async () => {
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

    // 握手被代理当成普通 GET（拿到网页而不是 101）：还没打开就关了
    FakeWebSocket.instances[0].drop();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe("/api/events?clientId=tab-1");
    expect(downs).toEqual([]);

    // 之后不再试 WebSocket，始终只有这一条 SSE
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeEventSource.instances).toHaveLength(1);

    const sse = FakeEventSource.instances[0];
    sse.open();
    sse.receive(JSON.stringify({ type: "desktop-control", screen: "a-fjl7", taken: true }));
    sse.receive("not-json");
    expect(received).toEqual([{ type: "desktop-control", screen: "a-fjl7", taken: true }]);

    // 断网时 EventSource 自己重连：断线提示，连回来补拉
    sse.fail(FakeEventSource.CONNECTING);
    sse.open();
    expect(reconnects).toBe(1);
    expect(FakeEventSource.instances).toHaveLength(1);

    // 服务重启时代理回 502，EventSource 关掉不再连：按退避重新建一条，仍然只走 SSE
    sse.fail(FakeEventSource.CLOSED);
    expect(sse.closed).toBe(true);
    expect(downs).toEqual([t("实时连接中断，正在重连"), t("实时连接中断，正在重连")]);
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeEventSource.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeEventSource.instances[1].open();
    expect(reconnects).toBe(2);
    FakeEventSource.instances[1].receive(JSON.stringify({ type: "desktop-control", screen: "a-fjl7", taken: false }));
    expect(received).toHaveLength(2);

    stop();
    expect(FakeEventSource.instances[1].closed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("只在真正连上时通知 open，断过再连上走 onReconnect", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const stop = apiMod.realApi.events(
      {
        onEvent: () => undefined,
        onOpen: () => calls.push("open"),
        onReconnect: () => calls.push("reconnect"),
        onDown: () => calls.push("down"),
      },
      "tab-1",
    );
    // 还在握手（CONNECTING）：什么都不通知
    expect(calls).toEqual([]);
    FakeWebSocket.instances[0].open();
    expect(calls).toEqual(["open"]);
    FakeWebSocket.instances[0].drop();
    await vi.advanceTimersByTimeAsync(1000);
    FakeWebSocket.instances[1].open();
    expect(calls).toEqual(["open", "down", "reconnect"]);
    stop();
  });

  it("退回 SSE 后头一次就没连上：连上时按重连处理，清掉断线提示并补拉", () => {
    const calls: string[] = [];
    const stop = apiMod.realApi.events(
      {
        onEvent: () => undefined,
        onOpen: () => calls.push("open"),
        onReconnect: () => calls.push("reconnect"),
        onDown: () => calls.push("down"),
      },
      "tab-1",
    );
    FakeWebSocket.instances[0].drop();
    const sse = FakeEventSource.instances[0];
    sse.fail(FakeEventSource.CONNECTING);
    sse.open();
    expect(calls).toEqual(["down", "reconnect"]);
    stop();
  });

  it("多处订阅云桌面快照共用唯一连接，不创建 EventSource 且不重复拉取", async () => {
    mockStoreApi();

    const snapshots: Array<DesktopScreensSnapshot> = [];
    // 模拟 App / Panel / PanelNow / JobDetail / DesktopView 5 处同时订阅
    const unsubs = Array.from({ length: 5 }, (_, idx) =>
      desktopScreens.subscribeDesktopScreens((snap) => { snapshots[idx] = snap; }),
    );
    const controlEvents: boolean[] = [];
    const unsubControl = store.subscribeEvents((ev) => {
      if (ev.type === "desktop-control" && ev.screen === "a-fjl7") controlEvents.push(ev.taken);
    });

    await store.start();
    // 全局只有 1 条 WebSocket 连接，0 条 EventSource；还在握手时不算连上，不拉快照
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(store.liveConnected()).toBe(false);
    expect(mocks.desktopScreensCount).toBe(0);

    // 真正连上才拉一次，5 处订阅全部同步拿到快照
    FakeWebSocket.instances[0].open();
    await vi.waitFor(() => expect(mocks.desktopScreensCount).toBe(1));
    for (let i = 0; i < 5; i++) {
      expect(snapshots[i].screens).toEqual(mocks.screens);
      expect(snapshots[i].profiles).toEqual(mocks.profiles);
    }

    // 推送 desktop-screens 与 desktop-control 事件时实时更新
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

  it("一个订阅者出错不拦住其他订阅者，重连后照样补拉并重新上报可见性", async () => {
    const { bootstrap, visibility } = mockStoreApi();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const seen: string[] = [];
    const statuses: string[] = [];
    const unsubs = [
      store.subscribeEvents(() => { throw new Error("坏订阅者"); }),
      store.subscribeEvents((ev) => { seen.push(ev.type); }),
      store.subscribeConnection(() => { throw new Error("坏订阅者"); }),
      store.subscribeConnection((status) => { statuses.push(status); }),
    ];

    await store.login("pw");
    FakeWebSocket.instances[0].open();
    expect(statuses).toEqual(["open"]);
    FakeWebSocket.instances[0].receive(JSON.stringify({ type: "desktop-control", screen: "a-fjl7", taken: false }));
    expect(seen).toEqual(["desktop-control"]);

    vi.useFakeTimers();
    FakeWebSocket.instances[0].drop();
    expect(statuses).toEqual(["open", "down"]);
    expect(store.liveConnected()).toBe(false);
    expect(store.getState().offline).toBe(t("实时连接中断，正在重连"));
    const bootstraps = bootstrap.mock.calls.length;
    visibility.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    FakeWebSocket.instances[1].open();

    // 坏订阅者之后的订阅者、补拉 bootstrap、重新上报可见性都照常进行
    expect(statuses).toEqual(["open", "down", "reconnect"]);
    expect(store.liveConnected()).toBe(true);
    expect(store.getState().offline).toBeNull();
    expect(visibility).toHaveBeenCalledWith(expect.any(String), true, null, undefined);
    await vi.waitFor(() => expect(bootstrap.mock.calls.length).toBe(bootstraps + 1));
    expect(consoleError).toHaveBeenCalled();

    for (const unsub of unsubs) unsub();
    await store.logout();
  });

  it("快照请求晚回来：先发的不覆盖后发的，断线前发出的不把屏幕填回去", async () => {
    mockStoreApi();
    const pending: Array<(value: { screens: DesktopScreen[]; profiles: Record<string, string>; users?: Record<string, never[]> }) => void> = [];
    vi.spyOn(apiMod.realApi, "desktopScreens").mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
    const running: DesktopScreen[] = [{ id: "a-fjl7", running: true, browserRunning: true, viewers: 1, lastActiveAt: null }];
    const idle: DesktopScreen[] = [{ id: "a-fjl7", running: false, browserRunning: false, viewers: 0, lastActiveAt: null }];
    let snap: DesktopScreensSnapshot = { screens: [], profiles: {}, users: {} };
    const unsub = desktopScreens.subscribeDesktopScreens((next) => { snap = next; });

    await store.login("pw");
    FakeWebSocket.instances[0].open();
    expect(pending).toHaveLength(1);
    pending[0]({ screens: running, profiles: mocks.profiles });
    await vi.waitFor(() => expect(snap.screens).toEqual(running));

    // 两次助手变化各拉一次：后发的先回来，先发的晚到不覆盖
    vi.useFakeTimers();
    FakeWebSocket.instances[0].receive(JSON.stringify({ type: "assistant_removed", id: "a-gone" }));
    FakeWebSocket.instances[0].receive(JSON.stringify({ type: "assistant_removed", id: "a-gone-2" }));
    expect(pending).toHaveLength(3);
    pending[2]({ screens: idle, profiles: mocks.profiles });
    await vi.advanceTimersByTimeAsync(0);
    expect(snap.screens).toEqual(idle);
    pending[1]({ screens: running, profiles: mocks.profiles });
    await vi.advanceTimersByTimeAsync(0);
    expect(snap.screens).toEqual(idle);

    // 断线清空屏幕、保留助手到屏幕的对应；断线前发出的请求晚回来也不填回去
    FakeWebSocket.instances[0].receive(JSON.stringify({ type: "assistant_removed", id: "a-gone-3" }));
    FakeWebSocket.instances[0].drop();
    expect(snap.screens).toEqual([]);
    pending[3]({ screens: running, profiles: mocks.profiles });
    await vi.advanceTimersByTimeAsync(0);
    expect(snap.screens).toEqual([]);
    expect(snap.profiles).toEqual(mocks.profiles);

    // 重连后重新拉，以新结果为准
    await vi.advanceTimersByTimeAsync(1000);
    FakeWebSocket.instances[1].open();
    expect(pending).toHaveLength(5);
    pending[4]({ screens: running, profiles: mocks.profiles });
    await vi.advanceTimersByTimeAsync(0);
    expect(snap.screens).toEqual(running);

    unsub();
    await store.logout();
  });

  it("正看着某个对话时断线重连，强制重新上报可见性和当前查看目标", async () => {
    const { visibility } = mockStoreApi();
    await store.login("pw");
    FakeWebSocket.instances[0].open();
    await store.select("a-fjl7");
    expect(visibility).toHaveBeenLastCalledWith(expect.any(String), true, "assistant:a-fjl7", undefined);

    // 断线后再连上：即使前端本地的 visible 和 target 都没变，也必须强制重报（服务端断线时已清掉）
    vi.useFakeTimers();
    visibility.mockClear();
    FakeWebSocket.instances[0].drop();
    await vi.advanceTimersByTimeAsync(1000);
    FakeWebSocket.instances[1].open();
    expect(visibility).toHaveBeenCalledWith(expect.any(String), true, "assistant:a-fjl7", undefined);

    // 推送 desktop-screens 带 users 时保留并在断线时清空
    let snap: DesktopScreensSnapshot = { screens: [], profiles: {}, users: {} };
    const unsub = desktopScreens.subscribeDesktopScreens((next) => { snap = next; });
    FakeWebSocket.instances[1].receive(JSON.stringify({
      type: "desktop-screens",
      screens: mocks.screens,
      users: { "a-fjl7": [{ assistantId: "a-fjl7", place: { topicId: "tp-1" } }] },
    }));
    expect(snap.users["a-fjl7"]).toEqual([{ assistantId: "a-fjl7", place: { topicId: "tp-1" } }]);
    FakeWebSocket.instances[1].drop();
    expect(snap.users).toEqual({});

    unsub();
    await store.logout();
  });
});

/** store 走真实的 realApi.events（假 WebSocket），其余接口打桩。 */
function mockStoreApi() {
  vi.spyOn(apiMod.realApi, "me").mockResolvedValue({} as never);
  vi.spyOn(apiMod.realApi, "login").mockResolvedValue(undefined as never);
  vi.spyOn(apiMod.realApi, "logout").mockResolvedValue(undefined as never);
  const bootstrap = vi.spyOn(apiMod.realApi, "bootstrap").mockResolvedValue({
    assistants: [{ id: "a-fjl7", name: "测试", primary: true }],
    jobs: [],
    routines: [],
    approvals: [],
    settings: { settings: { general: { theme: "light", locale: "zh-CN" } } },
  } as never);
  vi.spyOn(apiMod.realApi, "groups").mockResolvedValue([]);
  vi.spyOn(apiMod.realApi, "stars").mockResolvedValue([] as never);
  vi.spyOn(apiMod.realApi, "items").mockResolvedValue({ items: [], hasMore: false, jobs: [], approvals: [], drafts: [], delegations: [], cards: [] } as never);
  vi.spyOn(apiMod.realApi, "profile").mockResolvedValue({ assistant: { id: "a-fjl7", name: "测试", primary: true }, rules: [], worklog: [], routines: [] } as never);
  const visibility = vi.spyOn(apiMod.realApi, "visibility").mockResolvedValue(undefined);
  vi.spyOn(apiMod.realApi, "desktopScreens").mockImplementation(async () => {
    mocks.desktopScreensCount++;
    return { screens: mocks.screens, profiles: mocks.profiles, users: {} };
  });
  return { bootstrap, visibility };
}
