import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantSummary, AssistantTopicSummary, GroupSummary, Job, Routine } from "../../shared/types.ts";

const mocks = vi.hoisted(() => ({
  openAssistant: vi.fn(),
  openGroup: vi.fn(),
  selectGroup: vi.fn(),
  openAssistantTopic: vi.fn(),
  jumpToJob: vi.fn(),
  select: vi.fn(),
  openRoutine: vi.fn(),
  closePanelPages: vi.fn(),
  newAssistant: vi.fn(),
  openStars: vi.fn(),
  openKnowledge: vi.fn(),
  openPlugins: vi.fn(),
  openSettings: vi.fn(),
  setTheme: vi.fn(),
  goHome: vi.fn(),
  jumpToHistory: vi.fn(),
  searchHistory: vi.fn(),
}));

const state = vi.hoisted(() => ({
  page: "main" as "main" | "settings" | "knowledge" | "plugins" | "stars",
  theme: "system" as const,
  assistants: [] as AssistantSummary[],
  assistantTopics: [] as AssistantTopicSummary[],
  groups: [] as GroupSummary[],
  jobs: {} as Record<string, Job>,
  routines: [] as Routine[],
}));

vi.mock("../src/store.ts", () => ({
  useApp: () => state,
  ...mocks,
}));

import { buildLocalPaletteItems, HighlightSnippet } from "../src/components/CommandPalette.tsx";

const assistant = (id: string, name: string, extra: Partial<AssistantSummary> = {}): AssistantSummary => ({
  id,
  name,
  duty: `${name}职责`,
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

const group = (id: string, name: string, parentId?: string, closedAt?: string): GroupSummary => ({
  id,
  name,
  purpose: `${name}说明`,
  ownerId: "hob",
  members: ["hob"],
  createdAt: "2026-01-01T00:00:00Z",
  unread: 0,
  busy: [],
  ...(parentId ? { parentId } : {}),
  ...(closedAt ? { closedAt } : {}),
});

describe("命令面板本地过滤与分组", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.page = "main";
    state.assistants = [
      assistant("hob", "Hob", { primary: true }),
      assistant("book", "读书"),
      assistant("hidden-a", "归档助手", { hidden: true }),
    ];
    state.groups = [
      group("g-1", "研发协作"),
      group("gt-1", "发布检查", "g-1"),
      group("gt-closed", "旧版回顾", "g-1", "2026-01-02T00:00:00Z"),
    ];
    state.assistantTopics = [
      { id: "tp-1", assistantId: "book", name: "系统设计摘录", createdAt: "2026-01-01T00:00:00Z", createdBy: "user", unread: 0, busy: false },
      { id: "tp-closed", assistantId: "book", name: "已结题摘录", createdAt: "2026-01-01T00:00:00Z", createdBy: "user", unread: 0, busy: false, closedAt: "2026-01-02T00:00:00Z" },
    ];
    state.jobs = {
      "j-1": { id: "j-1", assistantId: "hob", title: "排查日志告警", status: "running", createdAt: "2026-01-01T00:00:00Z", stats: { reads: 0, commands: 0, edits: 0 } },
      "j-2": { id: "j-2", assistantId: "book", title: "整理季度书单", status: "done", createdAt: "2026-01-01T00:00:00Z", stats: { reads: 0, commands: 0, edits: 0 } },
    };
    state.routines = [
      { id: "r-1", assistantId: "hob", name: "晨间简报", schedules: ["0 9 * * *"], prompt: "整理简报", active: true, runs: [], createdAt: "2026-01-01T00:00:00Z" },
      { id: "r-2", assistantId: "hob", name: "暂停巡检", schedules: ["0 2 * * *"], prompt: "检查", active: false, runs: [], createdAt: "2026-01-01T00:00:00Z" },
    ];
  });

  it("空查询时按助手、群、话题、任务、定时任务、命令分组，隐藏收起的助手与已关闭话题", () => {
    const items = buildLocalPaletteItems(state, "");
    const groups = [...new Set(items.map((item) => item.group))];
    expect(groups).toEqual(["助手", "群", "话题", "任务", "定时任务", "命令"]);
    const ids = items.map((item) => item.id);
    expect(ids).toContain("a:hob");
    expect(ids).toContain("g:g-1");
    expect(ids).toContain("gt:gt-1");
    expect(ids).toContain("at:tp-1");
    expect(ids).toContain("j:j-1");
    expect(ids).toContain("r:r-1");
    expect(ids).toContain("cmd:settings");
    expect(ids).not.toContain("a:hidden-a");
    expect(ids).not.toContain("gt:gt-closed");
    expect(ids).not.toContain("at:tp-closed");
    expect(ids).not.toContain("j:j-2");
    expect(ids).not.toContain("r:r-2");
  });

  it("输入关键词后同时搜到收起的助手、已关闭话题、历史任务与停用定时任务", () => {
    expect(buildLocalPaletteItems(state, "归档").map((i) => i.id)).toContain("a:hidden-a");
    expect(buildLocalPaletteItems(state, "回顾").map((i) => i.id)).toContain("gt:gt-closed");
    expect(buildLocalPaletteItems(state, "书单").map((i) => i.id)).toContain("j:j-2");
    expect(buildLocalPaletteItems(state, "暂停").map((i) => i.id)).toContain("r:r-2");
  });

  it("执行本地结果和命令会调用对应的 store 动作", () => {
    const items = buildLocalPaletteItems(state, "");
    items.find((i) => i.id === "a:book")!.run();
    expect(mocks.openAssistant).toHaveBeenCalledWith("book");

    items.find((i) => i.id === "g:g-1")!.run();
    expect(mocks.openGroup).toHaveBeenCalledWith("g-1");

    items.find((i) => i.id === "gt:gt-1")!.run();
    expect(mocks.selectGroup).toHaveBeenCalledWith("gt-1", true, false, true);

    items.find((i) => i.id === "at:tp-1")!.run();
    expect(mocks.openAssistantTopic).toHaveBeenCalledWith("book", "tp-1", true);

    items.find((i) => i.id === "j:j-1")!.run();
    expect(mocks.jumpToJob).toHaveBeenCalledWith("hob", "j-1");

    items.find((i) => i.id === "r:r-1")!.run();
    expect(mocks.openRoutine).toHaveBeenCalledWith("r-1");

    items.find((i) => i.id === "cmd:settings")!.run();
    expect(mocks.openSettings).toHaveBeenCalled();

    items.find((i) => i.id === "cmd:theme:dark")!.run();
    expect(mocks.setTheme).toHaveBeenCalledWith("dark");
  });

  it("命中片段组件把关键词包进 mark 高亮", () => {
    const html = renderToStaticMarkup(<HighlightSnippet text="系统设计里的背压与队列控制" query="背压 队列" />);
    expect(html).toContain('<mark class="cmdk-hit">背压</mark>');
    expect(html).toContain('<mark class="cmdk-hit">队列</mark>');
  });
});
