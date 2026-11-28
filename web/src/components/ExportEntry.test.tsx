import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantTopicSummary, GroupSummary } from "../../../shared/types.ts";

const state = vi.hoisted(() => ({
  sel: "hob" as string | null,
  gsel: null as string | null,
  tsel: null as string | null,
  page: "main" as "main" | "settings" | "knowledge" | "plugins" | "stars",
  theme: "system" as "system" | "light" | "dark",
  panelStack: [] as any[],
  nowWide: false,
  assistants: [
    { id: "hob", name: "Hob", duty: "主助手", sprite: "hob", primary: true, topics: true, knowledge: [], busy: false } as any,
    { id: "dev", name: "开发", duty: "写代码", sprite: "page", primary: false, knowledge: [], busy: false } as any,
  ],
  assistantTopics: [
    { id: "tp-1", assistantId: "hob", name: "架构评审", createdAt: "2026-11-26T00:00:00Z", unread: 0, busy: false } as AssistantTopicSummary,
  ],
  groups: [
    { id: "g-1", name: "研发组", purpose: "技术评审", ownerId: "hob", members: ["hob", "dev"], createdAt: "2026-11-26T00:00:00Z", unread: 0, busy: [] } as GroupSummary,
    { id: "t-1", parentId: "g-1", name: "内存优化", purpose: "技术评审", ownerId: "hob", members: ["hob", "dev"], createdAt: "2026-11-26T00:00:00Z", unread: 0, busy: [] } as GroupSummary,
  ],
  groupProfiles: {} as Record<string, any>,
  assistantTopicConfigs: {} as Record<string, any>,
  profiles: {
    hob: { assistant: { id: "hob", name: "Hob", duty: "主助手", sprite: "hob", primary: true, topics: true, knowledge: [], busy: false }, rules: [], worklog: [] },
    dev: { assistant: { id: "dev", name: "开发", duty: "写代码", sprite: "page", primary: false, knowledge: [], busy: false }, rules: [], worklog: [] },
  } as Record<string, any>,
  jobs: {} as Record<string, any>,
  routines: [] as any[],
  approvals: {} as Record<string, any>,
  delegations: {} as Record<string, any>,
  assistantSkills: { hob: { loading: false, loaded: true, skills: [], error: null }, dev: { loading: false, loaded: true, skills: [], error: null } } as Record<string, any>,
  sidebarJobs: {} as Record<string, any>,
  sidebarFiles: {} as Record<string, any>,
  knowledge: { collections: [], collectionsLoaded: true, loading: false, error: null },
  desktop: { profiles: {}, screens: [], users: {} },
  settings: {
    settings: {
      general: { timezone: "UTC" },
      models: { conversation: { ref: "p/m", thinking: "low" }, work: { ref: "p/m", thinking: "low" }, roster: [] },
      image: { source: "off" },
      providers: [],
    },
  },
}));

vi.mock("../store.ts", () => ({
  useApp: () => state,
  assistantSessionKey: (aid: string, topicId?: string) => (topicId ? `${aid}@${topicId}` : aid),
  openAssistantPanel: vi.fn(),
  openGroupSettings: vi.fn(),
  openMemberPanel: vi.fn(),
  archiveGroup: vi.fn(),
  archiveAssistant: vi.fn(),
  patchGroup: vi.fn(),
  patchAssistant: vi.fn(),
  patchGroupMemberModels: vi.fn(),
  patchAssistantTopicConfig: vi.fn(),
  loadModels: vi.fn(async () => ({ models: [], updatedAt: null, error: null })),
  loadPlugins: vi.fn(async () => undefined),
  loadGroupProfile: vi.fn(async () => undefined),
  loadAssistantTopicConfig: vi.fn(async () => undefined),
  loadAssistantSkills: vi.fn(async () => undefined),
  loadKnowledge: vi.fn(async () => undefined),
  loadSidebarCollections: vi.fn(async () => undefined),
  loadSidebarJobs: vi.fn(async () => undefined),
  loadSidebarFiles: vi.fn(async () => undefined),
  collapsePanel: vi.fn(),
  openNewRoutine: vi.fn(),
  openJob: vi.fn(),
  openJobs: vi.fn(),
  openRoutine: vi.fn(),
  openSidebarPage: vi.fn(),
  openFilePreview: vi.fn(),
  openKnowledge: vi.fn(),
  openPlugins: vi.fn(),
  openSettings: vi.fn(),
  openStars: vi.fn(),
  openAssistant: vi.fn(),
  openAssistantTopic: vi.fn(),
  openGroup: vi.fn(),
  select: vi.fn(),
  selectGroup: vi.fn(),
  goHome: vi.fn(),
  closePanelPages: vi.fn(),
  newAssistant: vi.fn(),
  setTheme: vi.fn(),
  searchHistory: vi.fn(),
  jumpToHistory: vi.fn(),
  jumpToJob: vi.fn(),
  jumpToDelegation: vi.fn(),
  setNotice: vi.fn(),
  updateRule: vi.fn(),
  runRoutine: vi.fn(),
  saveRoutine: vi.fn(),
  showNowWide: vi.fn(),
  setNowWide: vi.fn(),
  toggleNowWide: vi.fn(),
  closeTopic: vi.fn(async () => null),
  reopenTopic: vi.fn(async () => null),
  closeAssistantTopic: vi.fn(async () => null),
  reopenAssistantTopic: vi.fn(async () => null),
  exportAssistantMarkdown: vi.fn(),
  exportGroupMarkdown: vi.fn(),
}));
vi.mock("../desktop-screens.ts", () => ({ useDesktopScreens: () => state.desktop }));
vi.mock("./PanelHead.tsx", () => ({ PanelHead: ({ children }: { children: React.ReactNode }) => <header>{children}</header>, CollapsePanelButton: () => <button title="收起右栏" /> }));
vi.mock("./use-menu.ts", () => ({ useMenu: () => ({ menu: null, box: { current: null }, toggle: vi.fn(), close: vi.fn() }) }));
vi.mock("../sprites.tsx", () => ({ Avatar: () => <span>头像</span> }));

import { Panel } from "./Panel.tsx";
import { buildLocalPaletteItems } from "./CommandPalette.tsx";
import { createMock } from "../mock.ts";

beforeEach(() => {
  state.sel = "hob";
  state.gsel = null;
  state.tsel = null;
  state.page = "main";
  state.panelStack = [];
});

describe("右栏与命令面板导出入口", () => {
  it("右栏在单聊、助手话题、群综合、群话题与手机端都显示导出 Markdown，成员详情页不显示", () => {
    // 助手主对话（桌面与手机）
    expect(renderToStaticMarkup(<Panel page={null} />)).toContain("<span>导出 Markdown</span>");
    expect(renderToStaticMarkup(<Panel mobile page={null} />)).toContain("<span>导出 Markdown</span>");

    // 助手话题
    state.tsel = "tp-1";
    expect(renderToStaticMarkup(<Panel page={null} />)).toContain("<span>导出 Markdown</span>");

    // 群综合与群话题
    state.sel = null;
    state.tsel = null;
    state.gsel = "g-1";
    expect(renderToStaticMarkup(<Panel page={null} />)).toContain("<span>导出 Markdown</span>");
    state.gsel = "t-1";
    expect(renderToStaticMarkup(<Panel page={null} />)).toContain("<span>导出 Markdown</span>");

    // 群成员详情页不显示导出当前对话
    state.panelStack = [{ kind: "member", id: "dev" }];
    expect(renderToStaticMarkup(<Panel />)).not.toContain("导出 Markdown");
  });

  it("命令面板在有当前对话时列出「导出当前对话」，首页或离开主界面时不列出", () => {
    const items = buildLocalPaletteItems(state, "");
    const cmd = items.find((item) => item.id === "cmd:export-markdown");
    expect(cmd?.label).toBe("导出当前对话");
    expect(cmd?.detail).toBe("Hob");

    state.tsel = "tp-1";
    expect(buildLocalPaletteItems(state, "").find((item) => item.id === "cmd:export-markdown")?.detail).toBe("Hob · 架构评审");

    state.sel = null;
    state.tsel = null;
    state.gsel = "t-1";
    expect(buildLocalPaletteItems(state, "").find((item) => item.id === "cmd:export-markdown")?.detail).toBe("研发组 · 内存优化");

    state.gsel = null;
    expect(buildLocalPaletteItems(state, "").find((item) => item.id === "cmd:export-markdown")).toBeUndefined();

    state.sel = "hob";
    state.page = "settings";
    expect(buildLocalPaletteItems(state, "").find((item) => item.id === "cmd:export-markdown")).toBeUndefined();
  });

  it("mock 模式支持导出单聊、助手话题与群对话 Markdown", async () => {
    const mockApi = createMock("s1");
    const hobMd = await mockApi.exportAssistant("hob");
    expect(hobMd.filename).toMatch(/^Hob-\d{4}-\d{2}-\d{2}\.md$/);
    expect(hobMd.content).toContain("# Hob");
    expect(hobMd.content).not.toContain("（暂无消息）");

    const assistantTopicApi = createMock("assistant-topics");
    const boot = await assistantTopicApi.bootstrap();
    const topic = boot.assistantTopics[0]!;
    const assistantTopicMd = await assistantTopicApi.exportAssistant(topic.assistantId, topic.id);
    expect(assistantTopicMd.content).toContain(topic.name);

    const groupApi = createMock("topics");
    const groups = await groupApi.groups();
    const groupTopic = groups.find((g) => Boolean(g.parentId))!;
    const topicMd = await groupApi.exportGroup(groupTopic.id);
    expect(topicMd.filename).toMatch(/-\d{4}-\d{2}-\d{2}\.md$/);
    expect(topicMd.content).toContain(groupTopic.name);
  });
});
