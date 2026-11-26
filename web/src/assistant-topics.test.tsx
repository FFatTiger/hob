import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval, AssistantSummary, AssistantTopicSummary, Item, Job, Routine } from "../../shared/types.ts";

const state = vi.hoisted(() => ({
  assistants: [] as AssistantSummary[],
  assistantTopics: [] as AssistantTopicSummary[],
  groups: [] as any[],
  groupItems: {} as Record<string, any[]>,
  groupPages: {} as Record<string, any>,
  groupActivity: {} as Record<string, any>,
  items: {} as Record<string, Item[]>,
  itemGen: {} as Record<string, number>,
  itemPages: {} as Record<string, any>,
  pending: {} as Record<string, any[]>,
  composerDrafts: new Map<string, any>(),
  jobs: {} as Record<string, Job>,
  approvals: {} as Record<string, Approval>,
  drafts: {} as Record<string, any>,
  cards: {} as Record<string, any>,
  delegations: {} as Record<string, any>,
  routines: [] as Routine[],
  livePages: {} as Record<string, any>,
  stars: [] as any[],
  sel: null as string | null,
  gsel: null as string | null,
  tsel: null as string | null,
  newTopic: null as { title: string; cwd: string } | null,
  newTopicBusy: false,
  newTopicError: null as string | null,
  sideCollapsed: false,
  collapsed: false,
  nonce: 0,
  update: null,
  settings: {
    revision: 1,
    settings: {
      general: { theme: "system", timezone: "UTC", proxy: "", noProxy: "", aboutYou: { name: "", language: "", notes: "" } },
      providers: [],
      models: { roster: [{ ref: "p/m", note: "" }], conversation: { ref: "p/m", thinking: "low" }, work: { ref: "p/m", thinking: "high" } },
      image: { source: "off" },
      search: [],
      work: { maxJobs: 2, jobStallMinutes: 15, routerStallMinutes: 6 },
      push: { email: "" },
    },
  },
}));

const spies = vi.hoisted(() => ({
  openAssistantMain: vi.fn(async () => undefined),
  openAssistantTopic: vi.fn(async () => undefined),
  openNewAssistantTopic: vi.fn(),
  closeAssistantTopic: vi.fn(async () => null),
  reopenAssistantTopic: vi.fn(async () => null),
  renameAssistantTopic: vi.fn(async () => null),
}));

vi.mock("./store.ts", () => ({
  useApp: () => state,
  assistantSessionKey: (aid: string, tid?: string | null) => (tid ? `${aid}@${tid}` : aid),
  pendingKeyOf: (s: any) => (s.gsel ? `group:${s.gsel}` : !s.sel ? null : s.newTopic ? `${s.sel}@new` : s.tsel ? `${s.sel}@${s.tsel}` : s.sel),
  composerDraft: (s: any, key?: string | null) => (key ? s.composerDrafts.get(key) : undefined) ?? { text: "", quote: null, attachments: [] },
  chatItems: (s: any, aid: string | null, tid?: string | null) => (aid ? s.items[tid ? `${aid}@${tid}` : aid] ?? [] : []),
  groupChatItems: (s: any, gid: string | null) => (gid ? s.groupItems[gid] ?? [] : []),
  groupById: (s: any, gid: string | null) => s.groups.find((g: any) => g.id === gid),
  groupSpeaking: () => [],
  pendingOf: () => undefined,
  photoUrl: (p: string) => p,
  fileUrl: (p: string) => p,
  openAssistantMain: spies.openAssistantMain,
  openAssistantTopic: spies.openAssistantTopic,
  openNewAssistantTopic: spies.openNewAssistantTopic,
  closeAssistantTopic: spies.closeAssistantTopic,
  reopenAssistantTopic: spies.reopenAssistantTopic,
  renameAssistantTopic: spies.renameAssistantTopic,
  closeTopic: vi.fn(async () => null),
  reopenTopic: vi.fn(async () => null),
  selectGroup: vi.fn(async () => undefined),
  openGroupHome: vi.fn(async () => undefined),
  openTopic: vi.fn(async () => null),
  pinTopic: vi.fn(async () => null),
  select: vi.fn(async () => undefined),
  goHome: vi.fn(),
  leaveChat: vi.fn(),
  leaveTopicList: vi.fn(),
  toggleSideCollapsed: vi.fn(),
  expandPanel: vi.fn(),
  openSheet: vi.fn(),
  openKnowledge: vi.fn(),
  openSettings: vi.fn(),
  openFilePreview: vi.fn(),
  openLivePreview: vi.fn(),
  openNoteGroup: vi.fn(),
  openJob: vi.fn(),
  openLoginDesktop: vi.fn(),
  replyJob: vi.fn(),
  stopJob: vi.fn(),
  retryDelegation: vi.fn(),
  jumpToDelegation: vi.fn(),
  jumpToHandback: vi.fn(),
  createDraft: vi.fn(),
  answer: vi.fn(),
  switchLoginSelf: vi.fn(),
  saveLoginEntry: vi.fn(),
  toggleStar: vi.fn(),
  attach: vi.fn(),
  removeAttachment: vi.fn(),
  setText: vi.fn(),
  setQuote: vi.fn(),
  setSection: vi.fn(),
  setNotice: vi.fn(),
  setNewTopicTitle: vi.fn(),
  setNewTopicCwd: vi.fn(),
  focusComposer: vi.fn(),
  send: vi.fn(async () => undefined),
  stopAssistant: vi.fn(),
  stopAssistantTopic: vi.fn(),
  stopGroup: vi.fn(),
  loadOlderItems: vi.fn(),
  loadOlderGroupItems: vi.fn(),
  retryPending: vi.fn(),
  discardPending: vi.fn(),
}));

vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (node: unknown) => node,
}));

import { AssistantSidebar, ClosedTopic, MobileAssistantTopics, TopicClose } from "./components/Topics.tsx";
import { AssistantTopicCard } from "./components/Items.tsx";
import { Chat } from "./components/Chat.tsx";

const at = (h: number, m = 0) => new Date(2026, 10, 26, h, m).toISOString();

function resetState() {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal("location", { search: "", hash: "" });
  vi.stubGlobal("document", { visibilityState: "visible" });
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    innerWidth: 1440,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  state.assistants = [
    {
      id: "planner",
      name: "日程统筹",
      duty: "搬家与预约",
      sprite: "page",
      primary: false,
      pinned: true,
      hidden: false,
      notify: true,
      topics: { enabledAt: at(8) },
      createdAt: at(8),
      last: { at: at(9, 10), text: "已开启多话题，这里是主对话" },
      unread: 0,
      busy: false,
    },
    {
      id: "single",
      name: "单聊助手",
      duty: "日常记录",
      sprite: "hob",
      primary: false,
      pinned: false,
      hidden: false,
      notify: true,
      createdAt: at(8),
      unread: 0,
      busy: false,
    },
  ];
  state.assistantTopics = [
    {
      id: "tp-1",
      assistantId: "planner",
      name: "下月搬家筹备",
      createdAt: at(9),
      createdBy: "planner",
      unread: 2,
      busy: false,
      last: { at: at(9, 20), text: "周六上午两家可上门" },
      todos: [
        { text: "比价", status: "done" },
        { text: "预约上门", status: "doing" },
      ],
    },
    {
      id: "tp-2",
      assistantId: "planner",
      name: "年度体检",
      createdAt: at(9, 5),
      createdBy: "user",
      unread: 0,
      busy: true,
      last: { at: at(9, 15), text: "正在筛选号源" },
    },
    {
      id: "tp-closed",
      assistantId: "planner",
      name: "防水报价对比",
      createdAt: at(7),
      createdBy: "user",
      closedAt: at(8, 30),
      closeNote: "选定聚氨酯方案",
      unread: 0,
      busy: false,
      last: { at: at(8, 30), text: "已完成" },
    },
  ];
  state.items = {};
  state.jobs = {};
  state.approvals = {};
  state.routines = [];
  state.sel = "planner";
  state.gsel = null;
  state.tsel = null;
  state.newTopic = null;
  state.newTopicError = null;
}

describe("助手多话题二级页组件", () => {
  beforeEach(resetState);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("AssistantSidebar 与 MobileAssistantTopics 渲染主对话、进行中、已关闭与等待状态", () => {
    state.approvals = {
      "ap-main": {
        id: "ap-main",
        assistantId: "planner",
        title: "主对话确认",
        options: [{ key: "A", label: "好" }],
        status: "pending",
        source: "router",
        createdAt: at(9),
      },
      "ap-topic": {
        id: "ap-topic",
        assistantId: "planner",
        topicId: "tp-1",
        title: "话题确认",
        options: [{ key: "A", label: "好" }],
        status: "pending",
        source: "router",
        createdAt: at(9),
      },
    };
    state.tsel = "tp-1";

    const desk = renderToStaticMarkup(<AssistantSidebar />);
    expect(desk).toContain("日程统筹");
    expect(desk).toContain("搬家与预约");
    expect(desk).toContain("主对话");
    expect(desk).toContain("进行中 2");
    expect(desk).toContain("已关闭 1");
    expect(desk).toContain("下月搬家筹备");
    expect(desk).toContain("1/2");
    expect(desk).toContain("选定聚氨酯方案");
    expect(desk).toContain("topic-waiting");
    expect(desk).toContain("topic-busy");
    expect(desk).toContain('title="创建新话题"');

    const mob = renderToStaticMarkup(<MobileAssistantTopics />);
    expect(mob).toContain("主对话");
    expect(mob).toContain("下月搬家筹备");
    expect(mob).toContain("防水报价对比");
  });

  it("没有话题时二级页只显示「主对话」一行和头部「创建新话题」；超过 5 个已关闭显示查看更多", () => {
    state.assistantTopics = [];
    const emptyDesk = renderToStaticMarkup(<AssistantSidebar />);
    expect(emptyDesk).toContain("主对话");
    expect(emptyDesk).toContain('title="创建新话题"');
    expect(emptyDesk).not.toContain("进行中");
    expect(emptyDesk).not.toContain("已关闭");

    state.assistantTopics = Array.from({ length: 6 }, (_, i) => ({
      id: `tp-c${i}`,
      assistantId: "planner",
      name: `已关闭话题 ${i + 1}`,
      createdAt: at(1, i),
      createdBy: "user",
      closedAt: at(2, i),
      unread: 0,
      busy: false,
    }));
    const manyClosed = renderToStaticMarkup(<AssistantSidebar />);
    expect(manyClosed).toContain("已关闭 6");
    expect(manyClosed).toContain("查看全部已关闭的话题");
  });
});

describe("助手话题对话页、主对话话题卡与新话题空白页", () => {
  beforeEach(resetState);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("多话题主对话标题下标「主对话」并渲染 AssistantTopicCard；单会话助手无「主对话」", () => {
    state.items.planner = [
      { kind: "topic", id: "i-1", at: at(9), topicId: "tp-1" },
      { kind: "topic", id: "i-2", at: at(8, 30), topicId: "tp-closed" },
      { kind: "topic", id: "i-3", at: at(7), topicId: "tp-missing" },
    ];
    const mainHtml = renderToStaticMarkup(<Chat />);
    expect(mainHtml).toContain("日程统筹");
    expect(mainHtml).toContain("主对话");
    expect(mainHtml).toContain("下月搬家筹备");
    expect(mainHtml).toContain("进入话题");
    expect(mainHtml).toContain("选定聚氨酯方案");
    expect(mainHtml).toContain("话题已不存在");

    const cardHtml = renderToStaticMarkup(<AssistantTopicCard topicId="tp-1" fresh={false} itemId="i-1" />);
    expect(cardHtml).toContain("下月搬家筹备");
    expect(cardHtml).toContain("周六上午两家可上门");

    state.sel = "single";
    state.items.single = [];
    const singleHtml = renderToStaticMarkup(<Chat />);
    expect(singleHtml).toContain("单聊助手");
    expect(singleHtml).not.toContain("主对话");
  });

  it("话题对话页显示就地改名按钮、关闭按钮与「从主对话转来」，关闭后显示 ClosedTopic", () => {
    state.tsel = "tp-1";
    state.items["planner@tp-1"] = [
      { kind: "user", id: "u-1", at: at(9, 12), text: "请帮我比较搬家报价", forwardedFrom: { assistantId: "planner", itemId: "pm-1" } },
      { kind: "assistant", id: "a-1", at: at(9, 14), text: "好的，已列出三家" },
    ];
    const openHtml = renderToStaticMarkup(<Chat />);
    expect(openHtml).toContain('title="点击修改话题名"');
    expect(openHtml).toContain("关闭这个话题");
    expect(openHtml).toContain("从主对话转来");
    expect(openHtml).toContain("日程统筹在主对话创建了话题");

    const confirmHtml = renderToStaticMarkup(<TopicClose topic={state.assistantTopics[0]!} initialConfirming />);
    expect(confirmHtml).toContain("关闭「下月搬家筹备」？");
    expect(confirmHtml).toContain('placeholder="结论（选填）"');
    expect(confirmHtml).toContain("确认关闭");

    state.tsel = "tp-closed";
    state.items["planner@tp-closed"] = [{ kind: "user", id: "u-c1", at: at(7), text: "做防水对比" }];
    const closedHtml = renderToStaticMarkup(<Chat />);
    expect(closedHtml).toContain("这个话题已关闭");
    expect(closedHtml).toContain("选定聚氨酯方案");
    expect(closedHtml).toContain("重新打开");
    expect(closedHtml).not.toContain("<textarea");

    const closedBar = renderToStaticMarkup(<ClosedTopic g={state.assistantTopics[2]!} />);
    expect(closedBar).toContain("重新打开");
  });

  it("新话题空白页：未绑 cwd 时展示收起的工作目录，已绑 cwd 时隐藏该项", () => {
    state.newTopic = { title: "", cwd: "" };
    const unboundHtml = renderToStaticMarkup(<Chat />);
    expect(unboundHtml).toContain('placeholder="话题名（选填，不填按第一句话生成）"');
    expect(unboundHtml).toContain("工作目录（选填，创建后不可修改）");

    state.assistants[0] = { ...state.assistants[0]!, cwd: "/workspace/life" };
    const boundHtml = renderToStaticMarkup(<Chat />);
    expect(boundHtml).toContain('placeholder="话题名（选填，不填按第一句话生成）"');
    expect(boundHtml).not.toContain("工作目录（选填，创建后不可修改）");
  });
});
