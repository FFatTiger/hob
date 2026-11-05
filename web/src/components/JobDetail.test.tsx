import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { JobStatus } from "../../../shared/types.ts";

const state = vi.hoisted(() => ({ status: "done" as string, sedimenting: {} as Record<string, boolean> }));
vi.mock("../store.ts", () => ({
  backPanel: vi.fn(), closePanelPages: vi.fn(), closeSheet: vi.fn(), sedimentJob: vi.fn(), fetchFileMeta: vi.fn(), loadJobFiles: vi.fn(), loadModels: vi.fn(),
  loadWorklog: vi.fn(), moreWorklog: vi.fn(), openFilePreview: vi.fn(), openJob: vi.fn(),
  replyJob: vi.fn(), select: vi.fn(), stopJob: vi.fn(),
  useApp: () => ({
    page: "main", panelStack: [{ kind: "job", id: "t-1" }],
    jobs: { "t-1": { id: "t-1", assistantId: "hob", title: "测试任务", instruction: "测试", status: state.status, summary: "报告内容", files: ["/work/结果.md"], createdAt: "2026-11-04T00:00:00Z", stats: { reads: 0, commands: 0, edits: 0 }, activity: [] } },
    steps: {}, assistants: [], worklog: null, sedimenting: state.sedimenting,
  }),
}));

import { JobOverlay } from "./JobDetail.tsx";

describe("任务详情回复", () => {
  it.each<JobStatus>(["done", "stuck", "failed", "stopped"])("%s 显示接着说", (status) => {
    state.status = status;
    expect(renderToStaticMarkup(<JobOverlay />)).toContain('placeholder="接着说…"');
  });
  it("运行中的任务保留补充提示且不显示报告和产出", () => {
    state.status = "running";
    const html = renderToStaticMarkup(<JobOverlay />);
    expect(html).toContain('placeholder="补充说明或更正方向"');
    expect(html).not.toContain("报告内容");
    expect(html).not.toContain("产出文件");
  });
  it("收到沉淀结束事件后按钮恢复可点", async () => {
    vi.stubGlobal("location", { search: "", hash: "" });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener: () => {} }) });
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })));
    try {
      const store = await vi.importActual<typeof import("../store.ts")>("../store.ts");
      state.status = "done";
      await store.sedimentJob("t-1");
      state.sedimenting = store.getState().sedimenting;
      expect(renderToStaticMarkup(<JobOverlay />)).toContain('<button class="panel-action" disabled="">');
      expect(renderToStaticMarkup(<JobOverlay />)).toContain("正在沉淀…");
      store.applyEvent({ type: "sediment-finished", jobId: "another" });
      expect(store.getState().sedimenting["t-1"]).toBe(true);
      store.applyEvent({ type: "sediment-finished", jobId: "t-1" });
      state.sedimenting = store.getState().sedimenting;
      const html = renderToStaticMarkup(<JobOverlay />);
      expect(html).toContain("沉淀成技能");
      expect(html).toContain('<button class="panel-action">');
    } finally {
      state.sedimenting = {};
      vi.unstubAllGlobals();
    }
  });
  it("结束任务按报告、产出、要求、过程、目录排列", () => {
    state.status = "done";
    const html = renderToStaticMarkup(<JobOverlay />);
    const positions = ["报告内容", "产出文件", "任务内容", "执行过程", "工作目录"].map((text) => html.indexOf(text));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).toContain("结果.md");
    expect(html).not.toContain("源码.ts");
  });
});
