import { beforeAll, describe, expect, it, vi } from "vitest";

const { handlers, visibilityCalls, windowListeners, docListeners, docState } = vi.hoisted(() => ({
  handlers: {} as { onReconnect?: () => void },
  visibilityCalls: [] as { clientId: string; visible: boolean; target: string | null; opts?: { keepalive?: boolean } }[],
  windowListeners: new Map<string, (() => void)[]>(),
  docListeners: new Map<string, (() => void)[]>(),
  docState: { visibilityState: "visible" as DocumentVisibilityState, focused: true },
}));

const group = { id: "g1", name: "团队", purpose: "", ownerId: "hob", members: ["hob"], busy: [], unread: 0, createdAt: "2026-01-01" };

vi.mock("../src/api.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/api.ts")>();
  return {
    ...original,
    realApi: {
      ...original.realApi,
      me: async () => ({}),
      bootstrap: async () => ({
        assistants: [{ id: "hob", name: "Hob", primary: true }],
        jobs: [],
        routines: [],
        approvals: [],
        settings: { settings: { general: { theme: "light", locale: "zh-CN" } } },
      }),
      groups: async () => [group],
      groupItems: async () => ({ items: [], hasMore: false, jobs: [], approvals: [] }),
      projects: async () => [],
      items: async () => ({ items: [], hasMore: false, jobs: [], approvals: [] }),
      profile: async () => ({}),
      visibility: async (clientId: string, visible: boolean, target: string | null, opts?: { keepalive?: boolean }) => {
        visibilityCalls.push({ clientId, visible, target, opts });
      },
      events: (h: { onReconnect: () => void }) => {
        handlers.onReconnect = h.onReconnect;
        return () => undefined;
      },
    },
  };
});

vi.mock("../src/theme.ts", () => ({
  resolveTheme: () => ({ dark: false }),
  updateStatusColor: () => undefined,
  updateManifest: () => undefined,
  isNarrow: () => (globalThis.window?.innerWidth ?? 1440) < 768,
}));

let store: typeof import("../src/store.ts");

function emitWindow(type: string) {
  for (const fn of windowListeners.get(type) ?? []) fn();
}

function emitDoc(type: string) {
  for (const fn of docListeners.get(type) ?? []) fn();
}

beforeAll(async () => {
  vi.stubGlobal("location", { search: "", hash: "" });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
    innerWidth: 1440,
    addEventListener: (type: string, fn: () => void) => {
      const list = windowListeners.get(type) ?? [];
      list.push(fn);
      windowListeners.set(type, list);
    },
  });
  vi.stubGlobal("document", {
    get visibilityState() { return docState.visibilityState; },
    hasFocus: () => docState.focused,
    addEventListener: (type: string, fn: () => void) => {
      const list = docListeners.get(type) ?? [];
      list.push(fn);
      docListeners.set(type, list);
    },
    documentElement: { classList: { toggle: () => undefined }, style: {} },
  });
  store = await import("../src/store.ts");
});

describe("activeTarget", () => {
  it("桌面端：单聊/群聊返回对应目标，首页和设置/知识库页返回 null", () => {
    const base = store.getState();
    expect(store.activeTarget({ ...base, page: "main", sel: "hob", gsel: null }, false)).toBe("assistant:hob");
    expect(store.activeTarget({ ...base, page: "main", sel: null, gsel: "g1" }, false)).toBe("group:g1");
    expect(store.activeTarget({ ...base, page: "main", sel: null, gsel: null }, false)).toBeNull();
    expect(store.activeTarget({ ...base, page: "settings", sel: "hob", gsel: null }, false)).toBeNull();
    expect(store.activeTarget({ ...base, page: "knowledge", sel: null, gsel: "g1" }, false)).toBeNull();
    expect(store.activeTarget({ ...base, page: "plugins", sel: "hob", gsel: null }, false)).toBeNull();
    expect(store.activeTarget({ ...base, page: "stars", sel: "hob", gsel: null }, false)).toBeNull();
  });

  it("窄屏端：仅 mobile=chat 返回目标，list/topics 返回 null", () => {
    const base = store.getState();
    expect(store.activeTarget({ ...base, page: "main", mobile: "list", sel: "hob", gsel: null }, true)).toBeNull();
    expect(store.activeTarget({ ...base, page: "main", mobile: "topics", sel: null, gsel: "g1" }, true)).toBeNull();
    expect(store.activeTarget({ ...base, page: "main", mobile: "chat", sel: "hob", gsel: null }, true)).toBe("assistant:hob");
    expect(store.activeTarget({ ...base, page: "main", mobile: "chat", sel: null, gsel: "g1" }, true)).toBe("group:g1");
  });
});

describe("reportVisibility 去重与重连补报", () => {
  it("状态未变不重复上报，切对话/失焦/pagehide/重连按预期上报", async () => {
    await store.start();
    visibilityCalls.length = 0;

    // 停在首页，状态未变重复触发不发请求
    store.goHome();
    visibilityCalls.length = 0;
    store.reportVisibility();
    expect(visibilityCalls).toHaveLength(0);

    // 切到单聊 -> 上报 assistant:hob
    await store.select("hob");
    expect(visibilityCalls).toHaveLength(1);
    expect(visibilityCalls[0]).toMatchObject({ visible: true, target: "assistant:hob" });

    // 同一状态重复调用 -> 去重不发
    store.reportVisibility();
    expect(visibilityCalls).toHaveLength(1);

    // 切到群聊 -> 上报 group:g1
    await store.openGroupHome("g1");
    expect(visibilityCalls).toHaveLength(2);
    expect(visibilityCalls[1]).toMatchObject({ visible: true, target: "group:g1" });

    // 窗口失焦（blur）-> visible: false
    docState.focused = false;
    emitWindow("blur");
    expect(visibilityCalls).toHaveLength(3);
    expect(visibilityCalls[2]).toMatchObject({ visible: false, target: "group:g1" });

    // 窗口恢复聚焦（focus）-> visible: true
    docState.focused = true;
    emitWindow("focus");
    expect(visibilityCalls).toHaveLength(4);
    expect(visibilityCalls[3]).toMatchObject({ visible: true, target: "group:g1" });

    // SSE 重连 -> 即使状态未变也强制补报一次
    handlers.onReconnect!();
    expect(visibilityCalls).toHaveLength(5);
    expect(visibilityCalls[4]).toMatchObject({ visible: true, target: "group:g1" });

    // pagehide -> 上报 visible: false 且携带 keepalive: true
    emitWindow("pagehide");
    expect(visibilityCalls).toHaveLength(6);
    expect(visibilityCalls[5]).toMatchObject({ visible: false, target: "group:g1", opts: { keepalive: true } });

    // 恢复可见供后续断言
    docState.visibilityState = "visible";
    docState.focused = true;
    emitDoc("visibilitychange");
    expect(visibilityCalls).toHaveLength(7);
    expect(visibilityCalls[6]).toMatchObject({ visible: true, target: "group:g1" });
  });
});
