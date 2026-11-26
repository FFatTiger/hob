import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantTopicSummary, Delegation, Draft, Job, TopicConfigView } from "../../../shared/types.ts";

const state = vi.hoisted(() => ({
  sel: "planner" as string | null,
  gsel: null as string | null,
  tsel: "tp-move" as string | null,
  panelStack: [] as any[],
  nowWide: false,
  assistants: [] as any[],
  assistantTopics: [] as AssistantTopicSummary[],
  groups: [] as any[],
  groupProfiles: {} as Record<string, any>,
  assistantTopicConfigs: {} as Record<string, { value?: TopicConfigView; error?: string }>,
  profiles: {} as Record<string, any>,
  jobs: {} as Record<string, Job>,
  routines: [] as any[],
  approvals: {} as Record<string, any>,
  delegations: {} as Record<string, Delegation>,
  drafts: {} as Record<string, Draft>,
  livePages: {} as Record<string, any>,
  assistantSkills: {} as Record<string, any>,
  sidebarJobs: {} as Record<string, any>,
  sidebarFiles: {} as Record<string, any>,
  knowledge: { collections: [], collectionsLoaded: true, loading: false, error: null },
  desktop: { profiles: {}, screens: [], users: {} } as any,
  settings: {
    settings: {
      general: { timezone: "UTC" },
      models: {
        conversation: { ref: "p/global-chat", thinking: "low" },
        work: { ref: "p/global-work", thinking: "high" },
        roster: [
          { ref: "p/global-chat", note: "" },
          { ref: "p/global-work", note: "" },
          { ref: "p/asst-chat", note: "" },
          { ref: "p/asst-work", note: "" },
          { ref: "p/topic-work", note: "" },
        ],
      },
      image: { source: "off" },
      providers: [{ kind: "builtin", id: "p" }],
    },
  },
  openSidebarPage: vi.fn(),
  loadAssistantTopicConfig: vi.fn(async () => undefined),
  loadSidebarJobs: vi.fn(async () => undefined),
  loadSidebarFiles: vi.fn(async () => undefined),
  createDraft: vi.fn(async () => undefined),
  enableAssistantTopics: vi.fn(async () => null),
}));

vi.mock("../store.ts", () => ({
  useApp: () => state,
  assistantSessionKey: (aid: string, tid?: string | null) => (tid ? `${aid}@${tid}` : aid),
  openAssistantPanel: vi.fn(),
  openGroupSettings: vi.fn(),
  openMemberPanel: vi.fn(),
  archiveGroup: vi.fn(),
  archiveAssistant: vi.fn(),
  patchGroup: vi.fn(async () => null),
  patchAssistant: vi.fn(async () => null),
  patchGroupMemberModels: vi.fn(async () => null),
  patchAssistantTopicConfig: vi.fn(async () => null),
  resetGroupRule: vi.fn(async () => null),
  resetAssistantTopicRule: vi.fn(async () => null),
  addAssistantTopicRule: vi.fn(async () => null),
  updateAssistantTopicRule: vi.fn(async () => null),
  deleteAssistantTopicRule: vi.fn(async () => undefined),
  enableAssistantTopics: state.enableAssistantTopics,
  createDraft: state.createDraft,
  select: vi.fn(),
  setText: vi.fn(),
  focusComposer: vi.fn(),
  photoUrl: (p: string) => p,
  fileUrl: (p: string) => p,
  loadModels: vi.fn(async () => ({
    models: [
      { ref: "p/global-chat", provider: "p", id: "global-chat", name: "Global Chat", reasoning: true, thinkingLevels: ["off", "low"], input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0 } },
      { ref: "p/global-work", provider: "p", id: "global-work", name: "Global Work", reasoning: true, thinkingLevels: ["off", "high"], input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0 } },
      { ref: "p/asst-chat", provider: "p", id: "asst-chat", name: "Asst Chat", reasoning: true, thinkingLevels: ["off", "medium"], input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0 } },
      { ref: "p/asst-work", provider: "p", id: "asst-work", name: "Asst Work", reasoning: true, thinkingLevels: ["off", "high"], input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0 } },
      { ref: "p/topic-work", provider: "p", id: "topic-work", name: "Topic Work", reasoning: true, thinkingLevels: ["off", "high"], input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0 } },
    ],
    updatedAt: null,
    error: null,
  })),
  loadPlugins: vi.fn(async () => undefined),
  loadGroupProfile: vi.fn(async () => undefined),
  loadAssistantTopicConfig: state.loadAssistantTopicConfig,
  loadAssistantSkills: vi.fn(async () => undefined),
  loadKnowledge: vi.fn(async () => undefined),
  loadSidebarCollections: vi.fn(async () => undefined),
  loadSidebarJobs: state.loadSidebarJobs,
  loadSidebarFiles: state.loadSidebarFiles,
  collapsePanel: vi.fn(),
  openNewRoutine: vi.fn(),
  openRoutine: vi.fn(),
  openJob: vi.fn(),
  openJobs: vi.fn(),
  openSidebarPage: state.openSidebarPage,
  openFilePreview: vi.fn(),
  openKnowledge: vi.fn(),
  openPlugins: vi.fn(),
  jumpToDelegation: vi.fn(),
  jumpToJob: vi.fn(),
  setNotice: vi.fn(),
  addRule: vi.fn(async () => null),
  updateRule: vi.fn(async () => null),
  deleteRule: vi.fn(async () => undefined),
  changeAssistantSkill: vi.fn(async () => undefined),
  patchPlugin: vi.fn(async () => undefined),
  runRoutine: vi.fn(),
  saveRoutine: vi.fn(),
  createRoutine: vi.fn(),
  deleteRoutine: vi.fn(),
  showNowWide: vi.fn(),
  setNowWide: vi.fn(),
  toggleNowWide: vi.fn(),
  backPanel: vi.fn(),
  closeTopic: vi.fn(async () => null),
  reopenTopic: vi.fn(async () => null),
  closeAssistantTopic: vi.fn(async () => null),
  reopenAssistantTopic: vi.fn(async () => null),
}));
vi.mock("../desktop-screens.ts", () => ({ useDesktopScreens: () => state.desktop }));
vi.mock("./PanelHead.tsx", () => ({
  PanelHead: ({ title, children }: { title?: React.ReactNode; children?: React.ReactNode }) => <header>{title}{children}</header>,
  CollapsePanelButton: () => <button title="收起右栏" />,
}));
vi.mock("./use-menu.ts", () => ({ useMenu: () => ({ menu: null, box: { current: null }, toggle: vi.fn(), close: vi.fn() }) }));
vi.mock("../sprites.tsx", () => ({ Avatar: () => <span>头像</span> }));
vi.mock("./ImageGen.tsx", () => ({ ImageGenCard: () => <div>图片</div> }));
vi.mock("./Markdown.tsx", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));

import { Panel } from "./Panel.tsx";
import { TopicClose } from "./Topics.tsx";
import { ItemList } from "./Items.tsx";

function setupFixture() {
  const hob = { id: "hob", name: "Hob", duty: "主助手", sprite: "hob", primary: true, knowledge: [], busy: false };
  const planner = {
    id: "planner",
    name: "日程统筹",
    duty: "搬家与预约",
    sprite: "page",
    primary: false,
    cwd: "/workspace/life",
    topics: { enabledAt: "2026-11-16T09:00:00Z" },
    models: { conversation: { ref: "p/asst-chat", thinking: "medium" }, work: { ref: "p/asst-work", thinking: "high" } },
    knowledge: [],
    busy: false,
  };
  const single = {
    id: "house",
    name: "家庭维护",
    duty: "日常居家维护",
    sprite: "house",
    primary: false,
    cwd: "/workspace/home",
    knowledge: [],
    busy: false,
  };
  const tpMove: AssistantTopicSummary = {
    id: "tp-move",
    assistantId: "planner",
    name: "下月搬家筹备",
    overrides: { models: { work: { ref: "p/topic-work", thinking: "high" } } },
    createdAt: "2026-11-26T01:00:00Z",
    createdBy: "user",
    unread: 0,
    busy: false,
  };
  const tpCheckup: AssistantTopicSummary = {
    id: "tp-checkup",
    assistantId: "planner",
    name: "年度体检预约",
    createdAt: "2026-11-26T02:00:00Z",
    createdBy: "user",
    unread: 0,
    busy: true,
  };
  const configMove: TopicConfigView = {
    rules: [
      { id: "r-parent", text: "删除前先确认", mode: "ask", changedAt: "2026-11-20T00:00:00Z", from: "parent" },
      { id: "r-changed", text: "预定车辆先对比", mode: "allow", changedAt: "2026-11-26T01:00:00Z", from: "parent", changed: true },
      { id: "r-own", text: "纸箱报价超 500 需确认", mode: "ask", changedAt: "2026-11-26T01:05:00Z", from: "topic" },
    ],
    hiddenRules: [
      { id: "r-hidden", text: "发日报前先确认", mode: "ask", changedAt: "2026-11-20T00:00:00Z" },
    ],
    models: {
      conversation: {
        source: "assistant",
        pick: { ref: "p/asst-chat", thinking: "medium" },
        inherited: { source: "assistant", pick: { ref: "p/asst-chat", thinking: "medium" } },
      },
      work: {
        source: "topic",
        pick: { ref: "p/topic-work", thinking: "high" },
        inherited: { source: "assistant", pick: { ref: "p/asst-work", thinking: "high" } },
      },
    },
    cwd: { path: "/workspace/life", source: "assistant" },
  };

  state.sel = "planner";
  state.gsel = null;
  state.tsel = "tp-move";
  state.panelStack = [];
  state.assistants = [hob, planner, single, { id: "legal", name: "法务顾问", duty: "合同审核", sprite: "book", primary: false, knowledge: [], busy: false }];
  state.assistantTopics = [tpMove, tpCheckup];
  state.assistantTopicConfigs = { "planner@tp-move": { value: configMove } };
  state.profiles = {
    hob: { assistant: hob, rules: [] },
    planner: {
      assistant: planner,
      rules: [
        { id: "r-parent", text: "删除前先确认", mode: "ask", changedAt: "2026-11-20T00:00:00Z" },
        { id: "r-changed", text: "预定车辆", mode: "ask", changedAt: "2026-11-20T00:00:00Z" },
        { id: "r-hidden", text: "发日报前先确认", mode: "ask", changedAt: "2026-11-20T00:00:00Z" },
      ],
    },
    house: { assistant: single, rules: [{ id: "r-single", text: "清理旧图", mode: "ask", changedAt: "2026-11-20T00:00:00Z" }] },
  };
  state.assistantSkills = {
    planner: { skills: [{ name: "checklist", title: "清单梳理", description: "拆解清单", path: "/s", version: 1, createdAt: "", updatedAt: "", uses: 1, enabled: true }], loaded: true, loading: false, error: null },
    house: { skills: [{ name: "clean", title: "归档整理", description: "整理", path: "/s2", version: 1, createdAt: "", updatedAt: "", uses: 1, enabled: true }], loaded: true, loading: false, error: null },
  };
  state.routines = [
    { id: "rt-main", assistantId: "planner", name: "每周主对话梳理", instruction: "x", schedules: ["0 9 * * 1"], active: true, createdAt: "2026-11-20T00:00:00Z", runs: [] },
    { id: "rt-move", assistantId: "planner", topicId: "tp-move", name: "跟进搬家报价", instruction: "x", schedules: ["0 10 * * *"], active: true, createdAt: "2026-11-26T01:00:00Z", runs: [] },
    { id: "rt-checkup", assistantId: "planner", topicId: "tp-checkup", name: "刷新体检号源", instruction: "x", schedules: ["0 8 * * *"], active: true, createdAt: "2026-11-26T02:00:00Z", runs: [] },
  ];
  state.jobs = {
    "j-move": { id: "j-move", assistantId: "planner", topicId: "tp-move", title: "搬家比价任务", instruction: "", status: "done", createdAt: "2026-11-26T01:05:00Z", endedAt: "2026-11-26T01:06:00Z", stats: { reads: 1, commands: 0, edits: 0 }, activity: [] },
    "j-checkup": { id: "j-checkup", assistantId: "planner", topicId: "tp-checkup", title: "体检号源任务", instruction: "", status: "running", createdAt: "2026-11-26T02:05:00Z", startedAt: "2026-11-26T02:05:00Z", stats: { reads: 1, commands: 0, edits: 0 }, activity: [] },
  };
  state.delegations = {
    "d-move": { id: "d-move", from: "planner", fromTopicId: "tp-move", to: "legal", text: "审合同", jobIds: [], status: "running", createdAt: "2026-11-26T01:10:00Z" },
    "d-checkup": { id: "d-checkup", from: "planner", fromTopicId: "tp-checkup", to: "house", text: "查体检报销", jobIds: [], status: "running", createdAt: "2026-11-26T02:10:00Z" },
  };
  state.sidebarJobs = {
    "planner@tp-move": { items: [state.jobs["j-move"]!], loaded: true, loading: false, loadingMore: false, hasMore: false, error: null },
    planner: { items: [state.jobs["j-move"]!, state.jobs["j-checkup"]!], loaded: true, loading: false, loadingMore: false, hasMore: false, error: null },
    house: { items: [], loaded: true, loading: false, loadingMore: false, hasMore: false, error: null },
  };
  state.sidebarFiles = {
    "planner@tp-move": { items: [], loaded: true, loading: false, loadingMore: false, hasMore: false, error: null },
    planner: { items: [], loaded: true, loading: false, loadingMore: false, hasMore: false, error: null },
    house: { items: [], loaded: true, loading: false, loadingMore: false, hasMore: false, error: null },
  };
  state.desktop = {
    profiles: { planner: "scr-planner", house: "scr-house" },
    screens: [{ id: "scr-planner", running: true }, { id: "scr-house", running: false }],
    users: { "scr-planner": [{ assistantId: "planner", place: { topicId: "tp-checkup" } }] },
  };
  state.drafts = {
    "d-pending": {
      id: "d-pending",
      assistantId: "hob",
      name: "行程助理",
      duty: "出差行程安排",
      dutyLong: "规划车次航班与行前清单",
      sprite: "rocket",
      routines: [],
      routinesText: "",
      askFirst: ["下单购票"],
      status: "pending",
      createdAt: "2026-11-26T03:00:00Z",
    },
    "d-done": {
      id: "d-done",
      assistantId: "hob",
      name: "日程统筹",
      duty: "搬家与预约",
      dutyLong: "搬家与预约",
      sprite: "page",
      routines: [],
      routinesText: "",
      askFirst: [],
      topics: true,
      status: "created",
      createdAssistantId: "planner",
      createdAt: "2026-11-16T00:00:00Z",
    },
  };
}

describe("助手话题右栏、助手设置与草稿卡", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    setupFixture();
  });

  it("助手话题右栏：按当前话题过滤任务、定时、转交、云桌面与底部关闭按钮", () => {
    const html = renderToStaticMarkup(<Panel />);
    expect(html).toContain("日程统筹");
    expect(html).toContain("下月搬家筹备");
    expect(html).toContain("空闲");
    expect(html).not.toContain(">执行中<");
    expect(html).toContain("工作目录 · 跟随助手");
    expect(html).toContain("「年度体检预约」正在用");
    expect(html).toContain("跟随助手 · 1 个");
    expect(html).toContain("3 条");
    expect(html).toContain("模型");
    expect(html).toContain("本话题");
    expect(html).toContain("搬家比价任务");
    expect(html).not.toContain("体检号源任务");
    expect(html).toContain("交给「法务顾问」");
    expect(html).not.toContain("交给「家庭维护」");
    expect(html).toContain("关闭这个话题");
    expect(html).not.toContain("编辑助手");
  });

  it("TopicClose 确认框显示该话题的定时任务暂停说明", () => {
    const html = renderToStaticMarkup(<TopicClose topic={state.assistantTopics[0]!} initialConfirming />);
    expect(html).toContain("关闭「下月搬家筹备」？");
    expect(html).toContain("这个话题有 1 个定时任务，关闭后暂停，重新打开时恢复");
  });

  it("助手话题规则页与模型页复用 P3 组件并标出跟随助手与本话题覆盖", () => {
    state.panelStack = [{ kind: "topicRules" }];
    const rulesHtml = renderToStaticMarkup(<Panel />);
    expect(rulesHtml).toContain("只在本话题生效");
    expect(rulesHtml).toContain("跟随助手");
    expect(rulesHtml).toContain("本话题改过");
    expect(rulesHtml).toContain("本话题的");
    expect(rulesHtml).toContain("已在本话题停用");
    expect(rulesHtml).toContain("恢复跟随");

    state.panelStack = [{ kind: "topicModels" }];
    const modelsHtml = renderToStaticMarkup(<Panel />);
    expect(modelsHtml).toContain("对话模型");
    expect(modelsHtml).toContain("默认任务模型");
    expect(modelsHtml).toContain("跟随助手 · p/asst-chat");
    expect(modelsHtml).toContain("本话题 · p/topic-work");
    expect(modelsHtml).toContain("恢复跟随");
  });

  it("多话题主对话右栏汇总主对话和全部话题并标出话题名；单会话助手右栏不变", () => {
    state.tsel = null;
    const mainHtml = renderToStaticMarkup(<Panel />);
    expect(mainHtml).toContain("编辑助手");
    expect(mainHtml).toContain("搬家比价任务");
    expect(mainHtml).toContain("体检号源任务");
    expect(mainHtml).toContain("「下月搬家筹备」");
    expect(mainHtml).toContain("「年度体检预约」");
    expect(mainHtml).not.toContain("关闭这个话题");

    state.sel = "house";
    state.tsel = null;
    const singleHtml = renderToStaticMarkup(<Panel />);
    expect(singleHtml).toContain("家庭维护");
    expect(singleHtml).toContain("编辑助手");
    expect(singleHtml).not.toContain("关闭这个话题");
    expect(singleHtml).not.toContain("跟随助手");
  });

  it("助手设置页：单会话显示改成多话题按钮，多话题显示开启日期，主助手不显示", () => {
    state.sel = "house";
    state.tsel = null;
    state.panelStack = [{ kind: "assistant" }];
    const singleSettings = renderToStaticMarkup(<Panel />);
    expect(singleSettings).toContain("对话方式");
    expect(singleSettings).toContain("单会话");
    expect(singleSettings).toContain("改成多话题");

    state.sel = "planner";
    const multiSettings = renderToStaticMarkup(<Panel />);
    expect(multiSettings).toContain("对话方式");
    expect(multiSettings).toContain("多话题 · 开启于");
    expect(multiSettings).not.toContain("改成多话题");

    state.sel = "hob";
    const primarySettings = renderToStaticMarkup(<Panel />);
    expect(primarySettings).not.toContain("对话方式");
  });

  it("草稿卡显示对话方式开关（未建成可切换，已创建只读）", () => {
    const html = renderToStaticMarkup(
      <ItemList
        items={[
          { kind: "draft", id: "i-pending", at: "2026-11-26T03:00:00Z", draftId: "d-pending" },
          { kind: "draft", id: "i-done", at: "2026-11-16T00:00:00Z", draftId: "d-done" },
        ]}
      />,
    );
    expect(html).toContain("对话方式");
    expect(html).toContain('aria-label="对话方式"');
    expect(html).toContain("单会话");
    expect(html).toContain("多话题");
  });
});
