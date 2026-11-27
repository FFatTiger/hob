import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval, AssistantSummary, AssistantTopicSummary, GroupItem, GroupSummary, Item } from "../../shared/types.ts";

const makeAssistant = (id: string, name: string, extra: Partial<AssistantSummary> = {}): AssistantSummary => ({
  id,
  name,
  duty: "测试",
  sprite: "hob",
  primary: id === "hob",
  pinned: false,
  hidden: false,
  notify: true,
  createdAt: "2026-01-01T00:00:00Z",
  unread: 0,
  busy: false,
  ...extra,
});

const makeGroup = (id: string, name: string, parentId?: string): GroupSummary => ({
  id,
  name,
  purpose: "协作",
  ownerId: "hob",
  members: ["hob"],
  createdAt: "2026-01-01T00:00:00Z",
  unread: 0,
  busy: [],
  ...(parentId ? { parentId } : {}),
});

const msg = (id: string, text = id): Item => ({ kind: "assistant", id, at: "2026-01-01T00:00:00Z", text });
const gmsg = (id: string, text = id): GroupItem => ({ kind: "assistant", id, speaker: "hob", at: "2026-01-01T00:00:00Z", text });

describe("消息定位与分页加载", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("location", { search: "", hash: "" });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("window", {
      innerWidth: 1440,
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.stubGlobal("document", {
      visibilityState: "visible",
      hasFocus: () => true,
      querySelectorAll: () => [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("单聊、助手话题、群、群话题跳到未加载的较早消息时都会拉取旧页并设置 scrollTarget", async () => {
    const { realApi } = await import("../src/api.ts");
    const store = await import("../src/store.ts");
    const plannerTopic: AssistantTopicSummary = {
      id: "tp-1",
      assistantId: "planner",
      name: "季度预算",
      createdAt: "2026-01-01T00:00:00Z",
      createdBy: "user",
      unread: 0,
      busy: false,
    };
    Object.assign(store.getState(), {
      assistants: [makeAssistant("hob", "Hob"), makeAssistant("planner", "规划", { topics: { enabledAt: "2026-01-01T00:00:00Z" } })],
      assistantTopics: [plannerTopic],
      groups: [makeGroup("g-1", "项目群"), makeGroup("gt-1", "上线清单", "g-1")],
    });

    vi.spyOn(realApi, "visibility").mockResolvedValue(undefined);
    vi.spyOn(realApi, "profile").mockResolvedValue({ assistant: store.getState().assistants[0]!, rules: [], routines: [], worklog: [] });
    vi.spyOn(realApi, "items").mockImplementation(async (_id, before) => {
      if (!before) return { items: [msg("m-new")], hasMore: true, jobs: [], approvals: [], drafts: [] };
      return { items: [msg("m-old")], hasMore: false, jobs: [], approvals: [], drafts: [] };
    });
    vi.spyOn(realApi, "assistantTopicItems").mockImplementation(async (_aid, _tid, before) => {
      if (!before) return { items: [msg("tp-new")], hasMore: true, jobs: [], approvals: [], drafts: [] };
      return { items: [msg("tp-old")], hasMore: false, jobs: [], approvals: [], drafts: [] };
    });
    vi.spyOn(realApi, "groupItems").mockImplementation(async (gid, before) => {
      if (!before) return { items: [gmsg(`${gid}-new`)], hasMore: true, jobs: [], approvals: [] };
      return { items: [gmsg(`${gid}-old`)], hasMore: false, jobs: [], approvals: [] };
    });

    // 1. 单聊较早消息
    await store.jumpToHistory({ kind: "assistant", id: "hob" }, "m-old");
    expect(store.getState().sel).toBe("hob");
    expect(store.getState().items.hob.map((i) => i.id)).toEqual(["m-old", "m-new"]);
    expect(store.getState().scrollTarget).toMatchObject({ key: "hob", itemId: "m-old", ready: true });

    // 2. 助手话题较早消息
    await store.jumpToHistory({ kind: "topic", id: "tp-1" }, "tp-old");
    expect(store.getState().sel).toBe("planner");
    expect(store.getState().tsel).toBe("tp-1");
    expect(store.getState().items["planner@tp-1"].map((i) => i.id)).toEqual(["tp-old", "tp-new"]);
    expect(store.getState().scrollTarget).toMatchObject({ key: "planner@tp-1", itemId: "tp-old", ready: true });

    // 3. 群综合较早消息
    await store.jumpToHistory({ kind: "group", id: "g-1" }, "g-1-old");
    expect(store.getState().gsel).toBe("g-1");
    expect(store.getState().groupItems["g-1"].map((i) => i.id)).toEqual(["g-1-old", "g-1-new"]);
    expect(store.getState().scrollTarget).toMatchObject({ key: "group:g-1", itemId: "g-1-old", ready: true });

    // 4. 群话题较早消息
    await store.jumpToHistory({ kind: "group", id: "gt-1" }, "gt-1-old");
    expect(store.getState().gsel).toBe("gt-1");
    expect(store.getState().groupItems["gt-1"].map((i) => i.id)).toEqual(["gt-1-old", "gt-1-new"]);
    expect(store.getState().scrollTarget).toMatchObject({ key: "group:gt-1", itemId: "gt-1-old", ready: true });
  });

  it("手机端跳到开启多话题助手的主对话消息时直接进对话页而非话题列表", async () => {
    vi.stubGlobal("window", {
      innerWidth: 390,
      screen: { width: 390 },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    const { realApi } = await import("../src/api.ts");
    const store = await import("../src/store.ts");
    Object.assign(store.getState(), {
      assistants: [makeAssistant("planner", "规划", { topics: { enabledAt: "2026-01-01T00:00:00Z" } })],
      assistantTopics: [],
      groups: [],
    });
    vi.spyOn(realApi, "visibility").mockResolvedValue(undefined);
    vi.spyOn(realApi, "profile").mockResolvedValue({ assistant: store.getState().assistants[0]!, rules: [], routines: [], worklog: [] });
    vi.spyOn(realApi, "items").mockResolvedValue({ items: [msg("main-1")], hasMore: false, jobs: [], approvals: [], drafts: [] });

    await store.jumpToHistory({ kind: "assistant", id: "planner" }, "main-1");
    expect(store.getState().mobile).toBe("chat");
    expect(store.getState().scrollTarget).toMatchObject({ key: "planner", itemId: "main-1", ready: true });
  });

  it("审批与当前对话引用跳转走同一套定位状态，不重复重载已加载分页", async () => {
    const { realApi } = await import("../src/api.ts");
    const store = await import("../src/store.ts");
    const ap: Approval = {
      id: "ap-1",
      assistantId: "hob",
      title: "确认继续？",
      options: [{ key: "A", label: "继续" }],
      status: "pending",
      source: "router",
      createdAt: "2026-01-01T00:00:00Z",
    };
    Object.assign(store.getState(), {
      assistants: [makeAssistant("hob", "Hob")],
      approvals: { "ap-1": ap },
      groups: [],
    });
    vi.spyOn(realApi, "visibility").mockResolvedValue(undefined);
    vi.spyOn(realApi, "profile").mockResolvedValue({ assistant: store.getState().assistants[0]!, rules: [], routines: [], worklog: [] });
    const itemsSpy = vi.spyOn(realApi, "items").mockImplementation(async (_id, before) => {
      if (!before) return { items: [{ kind: "question", id: "q-1", at: "2026-01-01T00:00:00Z", approvalId: "ap-1" }, msg("latest")], hasMore: true, jobs: [], approvals: [ap], drafts: [] };
      return { items: [msg("quoted-old")], hasMore: false, jobs: [], approvals: [], drafts: [] };
    });

    await store.jumpToApproval("ap-1");
    expect(store.getState().scrollTarget).toMatchObject({ key: "hob", domId: "approval-ap-1", ready: true });
    expect(itemsSpy).toHaveBeenCalledTimes(1);

    // 已经在当前对话里点引用一条旧消息：保留当前会话，只往前拉分页
    await store.jumpToCurrentItem("quoted-old");
    expect(itemsSpy).toHaveBeenCalledTimes(2);
    expect(store.getState().items.hob.map((i) => i.id)).toEqual(["quoted-old", "q-1", "latest"]);
    expect(store.getState().scrollTarget).toMatchObject({ key: "hob", itemId: "quoted-old", ready: true });
  });
});
