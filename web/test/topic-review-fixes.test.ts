import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantSummary, AssistantTopicSummary, Bootstrap, Item, TopicConfigView } from "../../shared/types.ts";
import { pushTarget } from "../../server/src/push.ts";
import { userFacingEn } from "../../server/src/i18n/en/user-facing.ts";
import { conversationEn } from "../src/i18n/en/conversation.ts";

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

  it("报告 15：patchAssistantTopicConfig 推进请求序号、assistant 模型变更刷新话题配置、assistant_removed 清理 aid@tid 残留", async () => {
    const { realApi } = await import("../src/api.ts");
    const store = await import("../src/store.ts");
    const boot = makeBootstrap();
    Object.assign(store.getState(), { assistants: boot.assistants, assistantTopics: boot.assistantTopics, groups: [] });

    const staleConfig: TopicConfigView = {
      rules: [],
      hiddenRules: [],
      models: {
        conversation: { source: "assistant", pick: { ref: "p/old", thinking: "low" }, inherited: { source: "assistant", pick: { ref: "p/old", thinking: "low" } } },
        work: { source: "global", pick: { ref: "p/m1", thinking: "low" }, inherited: { source: "global", pick: { ref: "p/m1", thinking: "low" } } },
      },
    };
    const savedConfig: TopicConfigView = {
      rules: [],
      hiddenRules: [],
      models: {
        conversation: { source: "topic", pick: { ref: "p/saved", thinking: "low" }, inherited: { source: "assistant", pick: { ref: "p/old", thinking: "low" } } },
        work: { source: "global", pick: { ref: "p/m1", thinking: "low" }, inherited: { source: "global", pick: { ref: "p/m1", thinking: "low" } } },
      },
    };
    const refreshedConfig: TopicConfigView = {
      rules: [],
      hiddenRules: [],
      models: {
        conversation: { source: "topic", pick: { ref: "p/saved", thinking: "low" }, inherited: { source: "assistant", pick: { ref: "p/asst-new", thinking: "low" } } },
        work: { source: "global", pick: { ref: "p/m1", thinking: "low" }, inherited: { source: "global", pick: { ref: "p/m1", thinking: "low" } } },
      },
    };

    // 1. 较早发出的 GET 晚于 PATCH 返回时，不覆盖 PATCH 刚保存的值
    let resolveStaleGet!: (v: TopicConfigView) => void;
    const staleGetPromise = new Promise<TopicConfigView>((r) => { resolveStaleGet = r; });
    const getConfigSpy = vi.spyOn(realApi, "assistantTopicConfig").mockReturnValueOnce(staleGetPromise);
    vi.spyOn(realApi, "patchAssistantTopicConfig").mockResolvedValueOnce(savedConfig);

    const loadPromise = store.loadAssistantTopicConfig("planner", "tp-move");
    const err = await store.patchAssistantTopicConfig("planner", "tp-move", { models: { conversation: { ref: "p/saved", thinking: "low" } } });
    expect(err).toBeNull();
    expect(store.getState().assistantTopicConfigs["planner@tp-move"]?.value?.models.conversation.pick.ref).toBe("p/saved");

    resolveStaleGet(staleConfig);
    await loadPromise;
    expect(store.getState().assistantTopicConfigs["planner@tp-move"]?.value?.models.conversation.pick.ref).toBe("p/saved");

    // 2. assistant SSE 事件里模型变更时，刷新该助手已加载的话题配置
    getConfigSpy.mockResolvedValueOnce(refreshedConfig);
    store.applyEvent({
      type: "assistant",
      assistant: { ...boot.assistants[0]!, models: { conversation: { ref: "p/asst-new", thinking: "low" } } },
    });
    await vi.waitFor(() => {
      expect(store.getState().assistantTopicConfigs["planner@tp-move"]?.value?.models.conversation.inherited.pick.ref).toBe("p/asst-new");
    });

    // 3. assistant_removed 清理 pending、items、itemPages、itemGen、livePages 里的 aid 与 aid@tid 键
    Object.assign(store.getState(), {
      pending: { planner: [{ localId: "p1", to: "planner", at: "", text: "a", status: "sending" }], "planner@tp-move": [{ localId: "p2", to: "planner", topicId: "tp-move", at: "", text: "b", status: "sending" }], bird: [] },
      items: { planner: [], "planner@tp-move": [], bird: [] },
      itemPages: { planner: { hasMore: false, loading: false, error: null }, "planner@tp-move": { hasMore: false, loading: false, error: null }, bird: { hasMore: false, loading: false, error: null } },
      itemGen: { planner: 1, "planner@tp-move": 2, bird: 3 },
      livePages: {
        "call-1": { assistantId: "planner", topicId: "tp-move", callId: "call-1", html: "<p>1</p>", state: "writing" },
        "call-2": { assistantId: "bird", callId: "call-2", html: "<p>2</p>", state: "writing" },
      },
    });
    store.applyEvent({ type: "assistant_removed", id: "planner" });
    const after = store.getState();
    expect("planner" in after.pending || "planner@tp-move" in after.pending).toBe(false);
    expect("planner" in after.items || "planner@tp-move" in after.items).toBe(false);
    expect("planner" in after.itemPages || "planner@tp-move" in after.itemPages).toBe(false);
    expect("planner" in after.itemGen || "planner@tp-move" in after.itemGen).toBe(false);
    expect("call-1" in after.livePages).toBe(false);
    expect("bird" in after.items).toBe(true);
    expect("call-2" in after.livePages).toBe(true);
  });

  it("报告 17：英文词条按 docs/copy.md 统一使用 job model 与 schedules", () => {
    expect(conversationEn["这个话题有 {n} 个定时任务，关闭后暂停，重新打开时恢复"]).toBe(
      "This topic has {n} schedules. They pause when it's closed and resume when it's reopened.",
    );
    expect(conversationEn["{name}的任务模型"]).toBe("{name}'s job model");
    expect(conversationEn["成员任务模型"]).toBe("Member job models");
    expect(conversationEn["成员只能单设任务模型，对话模型在群设置里改"]).toBe(
      "Members can only have their own job model. Change the chat model in group settings.",
    );
    expect(userFacingEn["成员只能单设任务模型，对话模型在群设置里改"]).toBe(
      "Members can only have their own job model. Change the chat model in group settings.",
    );
  });

  it("报告 18：web/public/sw.js 不包含死代码 payload.tag / renotify", () => {
    const sw = readFileSync(resolve(process.cwd(), "web/public/sw.js"), "utf8");
    expect(sw).not.toContain("payload.tag");
    expect(sw).not.toContain("renotify");
  });
});
