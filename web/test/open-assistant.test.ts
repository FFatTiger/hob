import { beforeAll, describe, expect, it, vi } from "vitest";

// 点助手（首页行、置顶头像）进的是它的对话；它手下有任务在等（等助手回复），不该把人带进任务
const waitingJob = { id: "t-1", assistantId: "a", title: "整理资料", status: "waiting", createdAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:00.000Z" };
const topicApproval = {
  id: "ap-tp-1",
  assistantId: "planner",
  topicId: "tp-1",
  title: "确认周六上门时间",
  options: [{ key: "A", label: "周六上午" }],
  status: "pending",
  source: "router",
  createdAt: "2026-01-01T00:05:00.000Z",
};
vi.mock("../src/api.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/api.ts")>();
  return {
    ...original,
    realApi: {
      ...original.realApi,
      me: async () => ({}),
      bootstrap: async () => ({
        assistants: [
          { id: "a", name: "甲", primary: true, unread: 0 },
          { id: "planner", name: "日程统筹", primary: false, unread: 1, topics: { enabledAt: "2026-01-01T00:00:00.000Z" } },
        ],
        assistantTopics: [{ id: "tp-1", assistantId: "planner", name: "搬家筹备", createdAt: "2026-01-01T00:00:00.000Z", createdBy: "user", unread: 1, busy: false }],
        jobs: [waitingJob],
        routines: [],
        approvals: [topicApproval],
        settings: { settings: { general: { theme: "light", locale: "zh-CN" } } },
      }),
      groups: async () => [],
      projects: async () => [],
      items: async () => ({ items: [], hasMore: false, jobs: [waitingJob], approvals: [] }),
      assistantTopicItems: async () => ({
        items: [{ kind: "question", id: "q-1", at: "2026-01-01T00:05:00.000Z", approvalId: "ap-tp-1" }],
        hasMore: false,
        jobs: [],
        approvals: [topicApproval],
      }),
      readAssistantTopic: async () => undefined,
      profile: async () => ({ assistant: { id: "planner", name: "日程统筹", primary: false, topics: { enabledAt: "2026-01-01T00:00:00.000Z" } }, rules: [] }),
      visibility: async () => undefined,
      events: () => () => undefined,
    },
  };
});
vi.mock("../src/theme.ts", () => ({ resolveTheme: () => ({ dark: false }), updateStatusColor: () => undefined, updateManifest: () => undefined, isNarrow: () => window.innerWidth < 768 }));

let store: typeof import("../src/store.ts");
let route: typeof import("../src/route.ts");
beforeAll(async () => {
  vi.stubGlobal("location", { search: "", hash: "" });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1; });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: true, addEventListener: () => undefined }), innerWidth: 390 });
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => undefined, getElementById: () => null, documentElement: { classList: { toggle: () => undefined }, style: {} } });
  store = await import("../src/store.ts");
  route = await import("../src/route.ts");
});

describe("点助手", () => {
  it("有任务在等时照样进对话，不打开任务", async () => {
    await store.start();
    store.openAssistant("a");
    await vi.waitFor(() => expect(store.getState().sel).toBe("a"));
    expect(store.getState().mobile).toBe("chat");
    expect(store.getState().panelStack.some((page) => page.kind === "job")).toBe(false);
  });

  it("等你处理里点击带 topicId 的提问卡所属助手时跳到对应话题路由", async () => {
    await store.start();
    store.openAssistant("planner");
    await vi.waitFor(() => expect(store.getState().tsel).toBe("tp-1"));
    const s = store.getState();
    expect(s.sel).toBe("planner");
    expect(route.routeHash(s, false)).toBe("#/chat/planner/topic/tp-1");
  });
});
