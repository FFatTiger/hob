import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantSummary, AssistantTopicSummary } from "../../shared/types.ts";
import { visibleLiveCards } from "../src/page-live.ts";

describe("web store topicId SSE 路由与隔离", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("带 topicId 的 item / delta / router-activity / page-live 路由到对应话题且不污染主对话", async () => {
    vi.stubGlobal("location", { search: "", hash: "" });
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      innerWidth: 1440,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.stubGlobal("document", { visibilityState: "visible" });
    const { applyEvent, getState } = await import("../src/store.ts");

    const assistant = {
      id: "writer",
      name: "写作助手",
      duty: "写文档",
      sprite: "page",
      primary: false,
      pinned: false,
      hidden: false,
      notify: true,
      topics: { enabledAt: "2026-11-26T00:00:00.000Z" },
      createdAt: "2026-11-26T00:00:00.000Z",
      unread: 0,
      busy: false,
      activity: null,
    } as AssistantSummary;

    const topic: AssistantTopicSummary = {
      id: "tp-123456",
      assistantId: "writer",
      name: "周报整理",
      createdAt: "2026-11-26T00:00:00.000Z",
      createdBy: "user",
      unread: 0,
      busy: false,
      activity: null,
    };

    Object.assign(getState(), {
      assistants: [assistant],
      assistantTopics: [topic],
      items: {
        writer: [{ kind: "assistant", id: "a-1", at: "2026-11-26T00:00:00.000Z", text: "主对话原消息" }],
        "writer@tp-123456": [],
      },
      livePages: {},
      panelStack: [],
      page: "main",
      sel: "writer",
      tsel: null,
    });

    applyEvent({
      type: "item",
      assistantId: "writer",
      topicId: "tp-123456",
      item: { kind: "assistant", id: "a-1", at: "2026-11-26T00:01:00.000Z", text: "话题消息", streaming: true },
    });
    applyEvent({
      type: "delta",
      assistantId: "writer",
      topicId: "tp-123456",
      itemId: "a-1",
      text: "追加",
    });
    applyEvent({
      type: "router-activity",
      assistantId: "writer",
      topicId: "tp-123456",
      activity: { state: "thinking", label: "正在思考…" },
    });
    applyEvent({
      type: "page-live",
      assistantId: "writer",
      topicId: "tp-123456",
      callId: "call-live-1",
      title: "话题页面",
      summary: "仅在话题内展示",
      html: "<h2>话题</h2>",
      state: "writing",
    });

    expect(getState().items.writer).toEqual([
      { kind: "assistant", id: "a-1", at: "2026-11-26T00:00:00.000Z", text: "主对话原消息" },
    ]);
    expect(getState().items["writer@tp-123456"]).toEqual([
      { kind: "assistant", id: "a-1", at: "2026-11-26T00:01:00.000Z", text: "话题消息追加", streaming: true },
    ]);
    expect(getState().assistants.find((a) => a.id === "writer")?.activity).toBeNull();
    expect(getState().assistantTopics.find((t) => t.id === "tp-123456")?.activity).toEqual({
      state: "thinking",
      label: "正在思考…",
    });
    expect(getState().panelStack).toEqual([]);
    expect(visibleLiveCards(Object.values(getState().livePages), "writer", null)).toEqual([]);
    expect(visibleLiveCards(Object.values(getState().livePages), "writer", "tp-123456").map((p) => p.callId)).toEqual(["call-live-1"]);
  });
});
