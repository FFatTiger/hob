import { beforeAll, describe, expect, it, vi } from "vitest";
import { parseRoute } from "../src/route.ts";

const { app, listeners, applied } = vi.hoisted(() => ({
  app: {
    phase: "loading" as "loading" | "ready",
    page: "main" as "main" | "settings" | "knowledge" | "plugins" | "stars",
    section: null as string | null,
    sub: null,
    gsel: null as string | null,
    sel: null as string | null,
    tsel: null as string | null,
    mobile: "list" as const,
    sheet: false,
    panelStack: [] as { kind: string; id?: string }[],
    viewer: null,
    scrollTarget: null as { key: string; itemId?: string; ready: boolean; nonce: number } | null,
  },
  listeners: [] as (() => void)[],
  applied: [] as string[],
}));

const change = (patch: Partial<typeof app>) => {
  Object.assign(app, patch);
  for (const listener of listeners) listener();
};

vi.mock("../src/store.ts", () => ({
  getState: () => app,
  subscribe: (listener: () => void) => {
    listeners.push(listener);
    return () => undefined;
  },
  applyRoute: (hash: string) => {
    applied.push(hash);
    const route = parseRoute(hash);
    if (route.plugins) {
      change({ page: "plugins", sel: null, gsel: null, tsel: null, panelStack: [], scrollTarget: null });
    } else if (route.stars) {
      change({ page: "stars", sel: null, gsel: null, tsel: null, panelStack: [], scrollTarget: null });
    } else if (route.knowledge) {
      change({ page: "knowledge", sel: null, gsel: null, tsel: null, panelStack: [], scrollTarget: null });
    } else if (route.settings) {
      change({ page: "settings", section: route.section, sel: null, gsel: null, tsel: null, panelStack: route.panel ? [route.panel] : [], scrollTarget: null });
    } else if (route.group) {
      change({ page: "main", gsel: route.group, sel: null, tsel: null, panelStack: route.panel ? [route.panel] : [], scrollTarget: null });
    } else if (route.sel) {
      change({ page: "main", sel: route.sel, gsel: null, tsel: route.topic ?? null, panelStack: route.panel ? [route.panel] : [], scrollTarget: null });
    } else {
      change({ page: "main", sel: null, gsel: null, tsel: null, panelStack: route.panel ? [route.panel] : [], scrollTarget: null });
    }
  },
  backPanel: () => undefined,
  leaveChat: () => undefined,
  leaveTopicList: () => undefined,
  goHome: () => undefined,
  closeImageViewer: () => undefined,
  closeKnowledge: () => undefined,
  closePlugins: () => undefined,
  openPlugins: () => undefined,
  closeSettings: () => undefined,
  closeSheet: () => undefined,
  closeSub: () => undefined,
  setMobile: () => undefined,
  setSection: () => undefined,
}));

const urls: string[] = [];
let idx = 0;
let onPop: (event: { state: unknown }) => void = () => undefined;

const loc = {
  pathname: "/",
  search: "",
  hash: "",
};

function setLocFromUrl(url: string) {
  const hashIdx = url.indexOf("#");
  loc.hash = hashIdx >= 0 ? url.slice(hashIdx) : "";
}

beforeAll(async () => {
  vi.stubGlobal("location", loc);
  vi.stubGlobal("window", {
    innerWidth: 1280,
    addEventListener: (_: string, fn: typeof onPop) => {
      onPop = fn;
    },
  });
  vi.stubGlobal("history", {
    get state() {
      return { hobDepth: 0 };
    },
    replaceState: (_state: unknown, _title: string, url: string) => {
      urls[idx] = url;
      setLocFromUrl(url);
    },
    pushState: (_state: unknown, _title: string, url: string) => {
      urls.length = ++idx;
      urls.push(url);
      setLocFromUrl(url);
    },
    go: () => undefined,
  });
  const { startHistory } = await import("../src/history.ts");
  startHistory(() => false);
});

describe("桌面浏览器前进 / 后退历史同步", () => {
  it("就绪前仅 replaceState，就绪后每次页面/话题/右栏变化压入历史并响应 popstate", async () => {
    // 尚未 ready：replaceState 不压多余历史
    change({ sel: "hob" });
    await Promise.resolve();
    expect(urls).toEqual(["/#/chat/hob"]);

    // ready 之后开始 pushState
    change({ phase: "ready" });
    await Promise.resolve();
    expect(urls).toEqual(["/#/chat/hob"]);

    // 切到助手话题
    change({ sel: "writer", tsel: "tp-1" });
    await Promise.resolve();
    expect(urls).toEqual(["/#/chat/hob", "/#/chat/writer/topic/tp-1"]);

    // 打开话题里的任务右栏页
    change({ panelStack: [{ kind: "job", id: "j-42" }] });
    await Promise.resolve();
    expect(urls).toEqual(["/#/chat/hob", "/#/chat/writer/topic/tp-1", "/#/chat/writer/topic/tp-1/job/j-42"]);

    // 切到群话题
    change({ sel: null, tsel: null, gsel: "g-topic-1", panelStack: [] });
    await Promise.resolve();
    expect(urls.at(-1)).toBe("/#/group/g-topic-1");

    // 切到设置分栏
    change({ page: "settings", section: "memory", gsel: null });
    await Promise.resolve();
    expect(urls.at(-1)).toBe("/#/settings/memory");

    // 浏览器后退：回到群话题
    idx = 3;
    setLocFromUrl(urls[idx]!);
    onPop({ state: { hobDepth: 0 } });
    await Promise.resolve();
    expect(applied.at(-1)).toBe("#/group/g-topic-1");
    expect(app).toMatchObject({ page: "main", gsel: "g-topic-1", sel: null, tsel: null });

    // 再后退：回到助手话题任务页，且不重复 pushState
    const lenBefore = urls.length;
    idx = 2;
    setLocFromUrl(urls[idx]!);
    onPop({ state: { hobDepth: 0 } });
    await Promise.resolve();
    expect(app).toMatchObject({ page: "main", sel: "writer", tsel: "tp-1", panelStack: [{ kind: "job", id: "j-42" }] });
    expect(urls.length).toBe(lenBefore);
  });

  it("跳到某条消息后后退回到原来的对话，且插件/收藏/知识库/滚动不压多余历史", async () => {
    // 回到主对话 #/chat/hob
    change({ page: "main", sel: "hob", gsel: null, tsel: null, panelStack: [], scrollTarget: null });
    await Promise.resolve();
    const afterHob = urls.length;
    expect(urls.at(-1)).toBe("/#/chat/hob");

    // 仅变化 scrollTarget（同会话内滚动/定位）不压历史
    change({ scrollTarget: { key: "hob", itemId: "m-1", ready: true, nonce: 1 } });
    await Promise.resolve();
    expect(urls.length).toBe(afterHob);

    // 命令面板跳到另一对话的消息：压入新历史，再后退回到 #/chat/hob 并清除 scrollTarget
    change({ sel: "book", tsel: null, scrollTarget: { key: "book", itemId: "i-bk-old-1", ready: true, nonce: 2 } });
    await Promise.resolve();
    expect(urls.at(-1)).toBe("/#/chat/book");

    idx = urls.length - 2;
    setLocFromUrl(urls[idx]!);
    onPop({ state: { hobDepth: 0 } });
    await Promise.resolve();
    expect(app).toMatchObject({ page: "main", sel: "hob", tsel: null, scrollTarget: null });

    // 插件、收藏、知识库都可前进/后退
    change({ page: "plugins" });
    await Promise.resolve();
    expect(urls.at(-1)).toBe("/#/plugins");
    change({ page: "stars" });
    await Promise.resolve();
    expect(urls.at(-1)).toBe("/#/stars");
    change({ page: "knowledge" });
    await Promise.resolve();
    expect(urls.at(-1)).toBe("/#/knowledge");

    idx = urls.length - 2;
    setLocFromUrl(urls[idx]!);
    onPop({ state: { hobDepth: 0 } });
    await Promise.resolve();
    expect(app.page).toBe("stars");
  });
});
