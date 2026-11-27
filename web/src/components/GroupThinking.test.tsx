import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../shared/i18n.ts";
import type { AssistantSummary, GroupItem, GroupSummary, RouterActivity } from "../../../shared/types.ts";
import "../i18n/en/index.ts";

const state = vi.hoisted(() => ({
  assistants: [] as AssistantSummary[],
  assistantTopics: [] as any[],
  groups: [] as GroupSummary[],
  groupItems: {} as Record<string, GroupItem[]>,
  groupPages: {} as Record<string, any>,
  groupActivity: {} as Record<string, Record<string, RouterActivity>>,
  groupGen: {} as Record<string, number>,
  items: {} as Record<string, any[]>,
  itemGen: {} as Record<string, number>,
  itemPages: {} as Record<string, any>,
  pending: {} as Record<string, any[]>,
  composerDrafts: new Map<string, any>(),
  jobs: {} as Record<string, any>,
  approvals: {} as Record<string, any>,
  drafts: {} as Record<string, any>,
  cards: {} as Record<string, any>,
  delegations: {} as Record<string, any>,
  routines: [] as any[],
  livePages: {} as Record<string, any>,
  stars: [] as any[],
  sel: null as string | null,
  gsel: "g-home" as string | null,
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

vi.mock("../store.ts", () => ({
  useApp: () => state,
  assistantSessionKey: (aid: string, tid?: string | null) => (tid ? `${aid}@${tid}` : aid),
  pendingKeyOf: (s: any) => (s.gsel ? `group:${s.gsel}` : s.sel),
  composerDraft: () => ({ text: "", quote: null, attachments: [] }),
  chatItems: () => [],
  groupChatItems: (s: any, gid: string | null) => (gid ? s.groupItems[gid] ?? [] : []),
  groupById: (s: any, gid: string | null) => s.groups.find((g: any) => g.id === gid),
  groupSpeaking: (s: any, g: GroupSummary) => {
    const active = s.groupActivity[g.id] ?? {};
    return g.members.filter((id) => Boolean(active[id]));
  },
  pendingOf: () => undefined,
  photoUrl: (p: string) => p,
  fileUrl: (p: string) => p,
  openAssistantMain: vi.fn(),
  openAssistantTopic: vi.fn(),
  openNewAssistantTopic: vi.fn(),
  closeAssistantTopic: vi.fn(),
  reopenAssistantTopic: vi.fn(),
  renameAssistantTopic: vi.fn(),
  closeTopic: vi.fn(),
  reopenTopic: vi.fn(),
  selectGroup: vi.fn(),
  openGroupHome: vi.fn(),
  openTopic: vi.fn(),
  pinTopic: vi.fn(),
  select: vi.fn(),
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
  send: vi.fn(),
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

import { Chat, ChatPage } from "./Chat.tsx";

const at = "2026-11-27T09:00:00Z";

function resetState() {
  setLocale("zh-CN");
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
    { id: "hob", name: "Hob", duty: "主助手", sprite: "hob", primary: true, pinned: true, hidden: false, notify: true, createdAt: at, unread: 0, busy: false },
    { id: "server", name: "服务器", duty: "运维检查", sprite: "server", primary: false, pinned: false, hidden: false, notify: true, createdAt: at, unread: 0, busy: false },
  ];
  state.groups = [
    { id: "g-home", name: "家里机器", purpose: "存储、备份和服务", ownerId: "hob", members: ["hob", "server"], createdAt: at, unread: 0, busy: ["server"] },
    { id: "t-disk", parentId: "g-home", name: "清理下载目录", purpose: "存储、备份和服务", ownerId: "hob", members: ["hob", "server"], createdAt: at, unread: 0, busy: ["server"] },
  ];
  state.groupItems = {
    "g-home": [{ kind: "user", id: "u-1", at, text: "看下下载目录", speaker: "user" }],
    "t-disk": [{ kind: "user", id: "u-2", at, text: "磁盘占用呢", speaker: "user" }],
  };
  state.groupActivity = {};
  state.gsel = "g-home";
}

describe("GroupThinking 群成员实时活动", () => {
  beforeEach(resetState);
  afterEach(() => {
    setLocale("zh-CN");
    vi.unstubAllGlobals();
  });

  it("成员有工具活动时显示成员名与活动文字，并切到 work 动作", () => {
    state.groupActivity["g-home"] = {
      server: { state: "tool", label: "正在读取：downloads" },
    };
    const html = renderToStaticMarkup(<Chat />);
    expect(html).toContain("服务器：正在读取：downloads");
    expect(html).toContain("av-work");
    expect(html).not.toContain("服务器 正在思考…");
  });

  it("没有具体活动或只有默认思考标签时显示「{name} 正在思考…」", () => {
    state.groupActivity["g-home"] = {
      server: { state: "thinking", label: "" },
    };
    let html = renderToStaticMarkup(<Chat />);
    expect(html).toContain("服务器 正在思考…");
    expect(html).toContain("av-think");

    state.groupActivity["g-home"] = {
      server: { state: "thinking", label: "正在思考…" },
    };
    html = renderToStaticMarkup(<Chat />);
    expect(html).toContain("服务器 正在思考…");
    expect(html).not.toContain("服务器：正在思考…");
  });

  it("两个成员同时忙时各显示各的活动与名字", () => {
    state.groups[0]!.busy = ["hob", "server"];
    state.groupActivity["g-home"] = {
      hob: { state: "thinking", label: "先等服务器排查完再汇总" },
      server: { state: "tool", label: "正在运行：du -sh /data/downloads/*" },
    };
    const html = renderToStaticMarkup(<Chat />);
    expect(html).toContain("Hob：先等服务器排查完再汇总");
    expect(html).toContain("服务器：正在运行：du -sh /data/downloads/*");
    expect(html).toContain("av-think");
    expect(html).toContain("av-work");
  });

  it("群话题页与手机端同样显示成员实际活动", () => {
    state.gsel = "t-disk";
    state.groupActivity["t-disk"] = {
      server: { state: "tool", label: "正在读取：downloads" },
    };
    expect(renderToStaticMarkup(<Chat />)).toContain("服务器：正在读取：downloads");
    expect(renderToStaticMarkup(<ChatPage />)).toContain("服务器：正在读取：downloads");
  });

  it("英文界面按英文格式显示活动与默认思考", () => {
    setLocale("en");
    state.assistants[1]!.name = "Ops";
    state.groups[0]!.busy = ["hob", "server"];
    state.groupActivity["g-home"] = {
      hob: { state: "thinking", label: "Thinking…" },
      server: { state: "tool", label: "Reading: downloads" },
    };
    const html = renderToStaticMarkup(<Chat />);
    expect(html).toContain("Hob is thinking…");
    expect(html).toContain("Ops: Reading: downloads");
  });
});
