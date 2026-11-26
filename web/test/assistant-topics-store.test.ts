import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantSummary, AssistantTopicSummary } from "../../shared/types.ts";

describe("助手多话题 store 状态机", () => {
  let innerWidth = 1440;

  beforeEach(() => {
    vi.resetModules();
    innerWidth = 1440;
    vi.stubGlobal("location", { search: "", hash: "" });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      get innerWidth() {
        return innerWidth;
      },
    });
    vi.stubGlobal("document", { visibilityState: "visible", hasFocus: () => true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function setupAssistants(): { primary: AssistantSummary; multi: AssistantSummary; single: AssistantSummary; topic: AssistantTopicSummary } {
    return {
      primary: {
        id: "hob",
        name: "Hob",
        duty: "主助手",
        sprite: "hob",
        primary: true,
        pinned: true,
        hidden: false,
        notify: true,
        createdAt: "2026-11-26T00:00:00Z",
        unread: 0,
        busy: false,
      },
      multi: {
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
        unread: 1,
        busy: false,
      },
      single: {
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
      },
      topic: {
        id: "tp-move",
        assistantId: "planner",
        name: "搬家筹备",
        createdAt: "2026-11-26T01:00:00Z",
        createdBy: "user",
        unread: 2,
        busy: false,
      },
    };
  }

  it("多话题助手桌面 select 开二级页并打开主对话；单会话助手保持原样", async () => {
    const { realApi } = await import("../src/api.ts");
    const store = await import("../src/store.ts");
    const { primary, multi, single, topic } = setupAssistants();

    vi.spyOn(realApi, "items").mockResolvedValue({ items: [], approvals: [], jobs: [], drafts: [], hasMore: false });
    vi.spyOn(realApi, "profile").mockResolvedValue({ assistant: multi, rules: [], routines: [], worklog: [] });
    const markRead = vi.spyOn(realApi, "markRead").mockResolvedValue(undefined);

    Object.assign(store.getState(), { assistants: [primary, multi, single], assistantTopics: [topic] });

    await store.select("planner");
    expect(store.getState().sel).toBe("planner");
    expect(store.getState().tsel).toBeNull();
    expect(store.getState().sideHome).toBe(false);
    expect(store.getState().mobile).toBe("chat");
    expect(markRead).toHaveBeenCalledWith("planner");

    await store.select("bird");
    expect(store.getState().sel).toBe("bird");
    expect(store.getState().tsel).toBeNull();
    expect(store.getState().sideHome).toBe(true);
    expect(store.getState().mobile).toBe("chat");
  });

  it("窄屏下 select 多话题助手先进二级页列表，openAssistantMain 进主对话，leaveChat 回 topics", async () => {
    innerWidth = 390;
    const { realApi } = await import("../src/api.ts");
    const store = await import("../src/store.ts");
    const { primary, multi, single, topic } = setupAssistants();

    vi.spyOn(realApi, "items").mockResolvedValue({ items: [], approvals: [], jobs: [], drafts: [], hasMore: false });
    vi.spyOn(realApi, "profile").mockResolvedValue({ assistant: multi, rules: [], routines: [], worklog: [] });
    const markRead = vi.spyOn(realApi, "markRead").mockResolvedValue(undefined);

    Object.assign(store.getState(), { assistants: [primary, multi, single], assistantTopics: [topic] });

    await store.select("planner");
    expect(store.getState().mobile).toBe("topics");
    expect(markRead).not.toHaveBeenCalled();

    await store.openAssistantMain("planner");
    expect(store.getState().mobile).toBe("chat");
    expect(store.getState().tsel).toBeNull();
    expect(markRead).toHaveBeenCalledWith("planner");

    store.leaveChat();
    expect(store.getState().mobile).toBe("topics");

    await store.select("bird");
    expect(store.getState().mobile).toBe("chat");
    store.leaveChat();
    expect(store.getState().mobile).toBe("list");
  });

  it("新话题空白页不预先创建；未发离开不留空话题；发消息时调用 POST 创建并切换进去", async () => {
    const { realApi } = await import("../src/api.ts");
    const store = await import("../src/store.ts");
    const { primary, multi } = setupAssistants();

    vi.spyOn(realApi, "items").mockResolvedValue({ items: [], approvals: [], jobs: [], drafts: [], hasMore: false });
    vi.spyOn(realApi, "profile").mockResolvedValue({ assistant: multi, rules: [], routines: [], worklog: [] });
    const createTopic = vi.spyOn(realApi, "createAssistantTopic").mockResolvedValue({
      topic: {
        id: "tp-created",
        assistantId: "planner",
        name: "下月出差",
        createdAt: "2026-11-26T02:00:00Z",
        createdBy: "user",
        unread: 0,
        busy: false,
      },
      item: {
        kind: "user",
        id: "u-1",
        at: "2026-11-26T02:00:00Z",
        text: "帮我订下周去上海的高铁票",
      },
    });

    Object.assign(store.getState(), { assistants: [primary, multi], assistantTopics: [] });

    store.openNewAssistantTopic("planner");
    expect(createTopic).not.toHaveBeenCalled();
    expect(store.getState().newTopic).toEqual({ title: "", cwd: "" });
    expect(store.pendingKeyOf(store.getState())).toBe("planner@new");

    // 没发就离开：不建话题、草稿态清空
    await store.openAssistantMain("planner");
    expect(createTopic).not.toHaveBeenCalled();
    expect(store.getState().newTopic).toBeNull();
    expect(store.getState().assistantTopics).toEqual([]);

    // 再次进入新话题，填标题与工作目录并发送第一句话
    store.openNewAssistantTopic("planner");
    store.setNewTopicTitle("下月出差");
    store.setNewTopicCwd("/workspace/trip");
    store.setText("帮我订下周去上海的高铁票");
    await store.send();

    expect(createTopic).toHaveBeenCalledWith("planner", {
      title: "下月出差",
      cwd: "/workspace/trip",
      text: "帮我订下周去上海的高铁票",
    });
    expect(store.getState().newTopic).toBeNull();
    expect(store.getState().tsel).toBe("tp-created");
    expect(store.getState().assistantTopics.map((t) => t.id)).toEqual(["tp-created"]);
    expect(store.getState().items["planner@tp-created"]?.map((i) => i.id)).toEqual(["u-1"]);
    expect(store.composerDraft(store.getState(), "planner@new").text).toBe("");
  });

  it("assistant_topic SSE 更新列表且正在看时自动已读；assistant_removed 一并清理该助手话题", async () => {
    const { realApi } = await import("../src/api.ts");
    const store = await import("../src/store.ts");
    const { primary, multi, single, topic } = setupAssistants();

    vi.spyOn(realApi, "assistantTopicItems").mockResolvedValue({ items: [], approvals: [], jobs: [], drafts: [], hasMore: false });
    vi.spyOn(realApi, "profile").mockResolvedValue({ assistant: multi, rules: [], routines: [], worklog: [] });
    const readTopic = vi.spyOn(realApi, "readAssistantTopic").mockResolvedValue(undefined);

    Object.assign(store.getState(), {
      assistants: [primary, multi, single],
      assistantTopics: [topic],
    });

    await store.openAssistantTopic("planner", "tp-move");
    expect(readTopic).toHaveBeenCalledWith("planner", "tp-move");

    store.applyEvent({
      type: "assistant_topic",
      topic: { ...topic, unread: 3, last: { at: "2026-11-26T03:00:00Z", text: "新消息" } },
    });
    expect(readTopic).toHaveBeenCalledTimes(2);
    expect(store.getState().assistantTopics.find((t) => t.id === "tp-move")?.unread).toBe(0);

    // 另一位助手的话题不受影响，被移除助手的话题全部清掉且回到主助手
    const otherTopic: AssistantTopicSummary = { ...topic, id: "tp-other", assistantId: "bird" };
    Object.assign(store.getState(), {
      assistantTopics: [store.getState().assistantTopics[0]!, otherTopic],
    });
    store.applyEvent({ type: "assistant_removed", id: "planner" });
    expect(store.getState().assistantTopics.map((t) => t.id)).toEqual(["tp-other"]);
    expect(store.getState().sel).toBe("hob");
    expect(store.getState().tsel).toBeNull();
    expect(store.getState().newTopic).toBeNull();
    expect(store.getState().sideHome).toBe(true);
  });
});
