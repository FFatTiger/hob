import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantSummary, AssistantTopicSummary, Bootstrap, Item } from "../../shared/types.ts";
import { pushTarget } from "../../server/src/push.ts";

describe("issue 269 step 3 frontend store & target fixes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("location", { search: "", hash: "" });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      innerWidth: 1440,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.stubGlobal("document", {
      visibilityState: "visible",
      hasFocus: () => true,
      querySelectorAll: () => [],
    });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(performance.now());
      return 1;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function makeBootstrap(extra: Partial<Bootstrap> = {}): Bootstrap {
    const planner: AssistantSummary = {
      id: "planner",
      name: "日程统筹",
      duty: "搬家与预约",
      sprite: "page",
      primary: false,
      pinned: true,
      hidden: false,
      notify: true,
      topics: { enabledAt: "2026-11-26T00:00:00Z" },
      createdAt: "2026-11-26T00:00:00Z",
      unread: 0,
      busy: false,
    };
    const bird: AssistantSummary = {
      id: "bird",
      name: "简报",
      duty: "每日资讯",
      sprite: "mail",
      primary: false,
      pinned: false,
      hidden: false,
      notify: true,
      createdAt: "2026-11-26T00:00:00Z",
      unread: 0,
      busy: false,
    };
    const topic: AssistantTopicSummary = {
      id: "tp-move",
      assistantId: "planner",
      name: "搬家筹备",
      createdAt: "2026-11-26T01:00:00Z",
      createdBy: "user",
      unread: 0,
      busy: false,
    };
    return {
      assistants: [planner, bird],
      assistantTopics: [topic],
      jobs: [],
      routines: [],
      approvals: [],
      delegations: [],
      settings: {
        revision: 1,
        settings: {
          general: { theme: "system", timezone: "Asia/Shanghai", proxy: "", noProxy: "", aboutYou: { name: "", language: "", notes: "" } },
          models: { conversation: { ref: "p/m1", thinking: "low" }, work: { ref: "p/m1", thinking: "low" }, roster: [] },
          work: { maxJobs: 3, jobStallMinutes: 15, routerStallMinutes: 5 },
          push: { email: "" },
          usage: { prices: {} },
          providers: [],
          search: { provider: "off" },
          image: { source: "off" },
          desktop: { enabled: false, url: "", tokenConfigured: false },
        },
      } as unknown as Bootstrap["settings"],
      ...extra,
    };
  }

  it("报告 5：服务端 pushTarget 与前端 activeTarget 在四类会话上完全一致", async () => {
    const store = await import("../src/store.ts");
    const base = store.getState();

    // 1. 助手单聊 / 主对话
    expect(store.activeTarget({ ...base, page: "main", sel: "planner", gsel: null, tsel: null, newTopic: null, mobile: "chat" }, false))
      .toBe(pushTarget("planner"));

    // 2. 助手话题
    expect(store.activeTarget({ ...base, page: "main", sel: "planner", gsel: null, tsel: "tp-move", newTopic: null, mobile: "chat" }, false))
      .toBe(pushTarget("planner", { topicId: "tp-move" }));

    // 3. 群综合
    expect(store.activeTarget({ ...base, page: "main", sel: null, gsel: "g-ops", tsel: null, newTopic: null, mobile: "chat" }, false))
      .toBe(pushTarget("planner", { groupId: "g-ops" }));

    // 4. 群话题
    expect(store.activeTarget({ ...base, page: "main", sel: null, gsel: "gt-123", tsel: null, newTopic: null, mobile: "chat" }, false))
      .toBe(pushTarget("planner", { groupId: "gt-123" }));
  });

  it("报告 3：jumpToHistory 支持 kind=topic，打开所属助手话题并定位消息", async () => {
    const topicItems: Item[] = [
      { kind: "assistant", id: "a-1", at: "2026-11-26T01:05:00Z", text: "搬家清单已整理好" },
    ];
    const { realApi } = await import("../src/api.ts");
    const store = await import("../src/store.ts");
    const boot = makeBootstrap();
    Object.assign(store.getState(), { assistants: boot.assistants, assistantTopics: boot.assistantTopics, groups: [] });

    vi.spyOn(realApi, "visibility").mockResolvedValue(undefined);
    vi.spyOn(realApi, "profile").mockResolvedValue({ assistant: boot.assistants[0]!, rules: [], routines: [], worklog: [] });
    vi.spyOn(realApi, "readAssistantTopic").mockResolvedValue(undefined);
    const topicItemsSpy = vi.spyOn(realApi, "assistantTopicItems").mockResolvedValue({
      items: topicItems,
      approvals: [],
      jobs: [],
      drafts: [],
      hasMore: false,
    });

    await store.jumpToHistory({ kind: "topic", id: "tp-move" }, "a-1");

    expect(topicItemsSpy).toHaveBeenCalledWith("planner", "tp-move");
    expect(store.getState().page).toBe("main");
    expect(store.getState().sel).toBe("planner");
    expect(store.getState().tsel).toBe("tp-move");
    expect(store.getState().notice).not.toBe("原消息已不在");
  });

  it("报告 6：sendNewAssistantTopic 发出后离开页面，请求回来只更新列表和 items，不篡改选中态", async () => {
    let resolveCreate!: (value: { topic: AssistantTopicSummary; item?: Item }) => void;
    const createPromise = new Promise<{ topic: AssistantTopicSummary; item?: Item }>((resolve) => {
      resolveCreate = resolve;
    });

    const { realApi } = await import("../src/api.ts");
    const store = await import("../src/store.ts");
    const boot = makeBootstrap();
    Object.assign(store.getState(), { assistants: boot.assistants, assistantTopics: boot.assistantTopics, groups: [] });

    vi.spyOn(realApi, "visibility").mockResolvedValue(undefined);
    vi.spyOn(realApi, "profile").mockResolvedValue({ assistant: boot.assistants[0]!, rules: [], routines: [], worklog: [] });
    vi.spyOn(realApi, "items").mockResolvedValue({ items: [], approvals: [], jobs: [], drafts: [], hasMore: false });
    vi.spyOn(realApi, "markRead").mockResolvedValue(undefined);
    vi.spyOn(realApi, "createAssistantTopic").mockReturnValue(createPromise);

    // 1. 离开回首页场景
    store.openNewAssistantTopic("planner");
    store.setText("整理下月搬家计划");
    const pendingSend = store.send();
    store.goHome();

    const createdTopic: AssistantTopicSummary = {
      id: "tp-fresh",
      assistantId: "planner",
      name: "整理下月搬家计划",
      createdAt: "2026-11-26T02:00:00Z",
      createdBy: "user",
      unread: 0,
      busy: true,
    };
    const createdItem: Item = { kind: "user", id: "u-1", at: "2026-11-26T02:00:00Z", text: "整理下月搬家计划" };
    resolveCreate({ topic: createdTopic, item: createdItem });
    await pendingSend;

    expect(store.getState().sel).toBeNull();
    expect(store.getState().tsel).toBeNull();
    expect(store.getState().sideHome).toBe(true);
    expect(store.getState().assistantTopics.some((t) => t.id === "tp-fresh")).toBe(true);
    expect(store.getState().items["planner@tp-fresh"]).toEqual([createdItem]);

    // 2. 切到另一个助手场景
    let resolveCreate2!: (value: { topic: AssistantTopicSummary; item?: Item }) => void;
    const createPromise2 = new Promise<{ topic: AssistantTopicSummary; item?: Item }>((resolve) => {
      resolveCreate2 = resolve;
    });
    vi.spyOn(realApi, "createAssistantTopic").mockReturnValueOnce(createPromise2);

    store.openNewAssistantTopic("planner");
    store.setText("第二件事");
    const pendingSend2 = store.send();
    await store.select("bird");

    const createdTopic2: AssistantTopicSummary = {
      id: "tp-second",
      assistantId: "planner",
      name: "第二件事",
      createdAt: "2026-11-26T03:00:00Z",
      createdBy: "user",
      unread: 0,
      busy: true,
    };
    resolveCreate2({ topic: createdTopic2, item: { kind: "user", id: "u-2", at: "2026-11-26T03:00:00Z", text: "第二件事" } });
    await pendingSend2;

    expect(store.getState().sel).toBe("bird");
    expect(store.getState().tsel).toBeNull();
    expect(store.getState().assistantTopics.some((t) => t.id === "tp-second")).toBe(true);
    expect(store.getState().items["planner@tp-second"]).toHaveLength(1);
  });
});
