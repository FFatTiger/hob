import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantSummary } from "../../shared/types.ts";

describe("web store topicId SSE 最小守卫", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("带 topicId 的 item / delta / router-activity / page-live 事件不会混入主对话", async () => {
    vi.stubGlobal("location", { search: "", hash: "" });
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener() {} }), innerWidth: 1440 });
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
      createdAt: "2026-11-26T00:00:00.000Z",
      unread: 0,
      busy: false,
      activity: null,
    } as AssistantSummary;

    Object.assign(getState(), {
      assistants: [assistant],
      items: { writer: [{ kind: "assistant", id: "a-1", at: "2026-11-26T00:00:00.000Z", text: "主对话原消息" }] },
      livePages: {},
      panelStack: [],
      page: "main",
      sel: "writer",
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
    expect(getState().assistants.find((a) => a.id === "writer")?.activity).toBeNull();
    expect(getState().livePages).toEqual({});
    expect(getState().panelStack).toEqual([]);
  });
});
