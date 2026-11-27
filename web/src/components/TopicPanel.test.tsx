import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupProfile, GroupSummary, Job } from "../../../shared/types.ts";

const state = vi.hoisted(() => ({
  sel: null as string | null,
  gsel: "g-1" as string | null,
  panelStack: [] as any[],
  nowWide: false,
  assistants: [
    { id: "po", name: "产品统筹", duty: "产品需求规划", sprite: "hob", primary: false, knowledge: [], busy: false } as any,
    { id: "dev", name: "全栈开发", duty: "工程开发", sprite: "page", primary: false, knowledge: [], busy: false } as any,
    { id: "qa", name: "质量测试", duty: "回归验收", sprite: "mail", primary: false, knowledge: [], busy: false } as any,
  ],
  groups: [] as GroupSummary[],
  groupProfiles: {} as Record<string, { value?: GroupProfile; error?: string }>,
  profiles: {} as Record<string, any>,
  jobs: {} as Record<string, Job>,
  routines: [] as any[],
  approvals: {} as Record<string, any>,
  delegations: {} as Record<string, any>,
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
          { ref: "p/group-work", note: "" },
          { ref: "p/topic-work", note: "" },
          { ref: "p/member-work", note: "" },
          { ref: "p/topic-member-work", note: "" },
        ],
      },
      image: { source: "off" },
      providers: [{ kind: "builtin", id: "p" }],
    },
  },
  patchGroup: vi.fn(async () => null),
  patchGroupMemberModels: vi.fn(async () => null),
  resetGroupRule: vi.fn(async () => null),
  openSidebarPage: vi.fn(),
  loadGroupProfile: vi.fn(async () => undefined),
  loadSidebarJobs: vi.fn(async () => undefined),
  loadSidebarFiles: vi.fn(async () => undefined),
}));

vi.mock("../store.ts", () => ({
  useApp: () => state,
  openAssistantPanel: vi.fn(),
  openGroupSettings: vi.fn(),
  openMemberPanel: vi.fn(),
  archiveGroup: vi.fn(),
  archiveAssistant: vi.fn(),
  patchGroup: state.patchGroup,
  patchAssistant: vi.fn(),
  patchGroupMemberModels: state.patchGroupMemberModels,
  resetGroupRule: state.resetGroupRule,
  loadModels: vi.fn(async () => ({
    models: [
      { ref: "p/global-chat", provider: "p", id: "global-chat", name: "Global Chat", reasoning: true, thinkingLevels: ["off", "low"], input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0 } },
      { ref: "p/global-work", provider: "p", id: "global-work", name: "Global Work", reasoning: true, thinkingLevels: ["off", "high"], input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0 } },
      { ref: "p/group-work", provider: "p", id: "group-work", name: "Group Work", reasoning: true, thinkingLevels: ["off", "high"], input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0 } },
      { ref: "p/topic-work", provider: "p", id: "topic-work", name: "Topic Work", reasoning: true, thinkingLevels: ["off", "high"], input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0 } },
      { ref: "p/member-work", provider: "p", id: "member-work", name: "Member Work", reasoning: true, thinkingLevels: ["off", "high"], input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0 } },
      { ref: "p/topic-member-work", provider: "p", id: "topic-member-work", name: "Topic Member Work", reasoning: true, thinkingLevels: ["off", "high"], input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0 } },
    ],
    updatedAt: null,
    error: null,
  })),
  loadPlugins: vi.fn(async () => undefined),
  loadGroupProfile: state.loadGroupProfile,
  loadAssistantSkills: vi.fn(async () => undefined),
  loadKnowledge: vi.fn(async () => undefined),
  loadSidebarCollections: vi.fn(async () => undefined),
  loadSidebarJobs: state.loadSidebarJobs,
  loadSidebarFiles: state.loadSidebarFiles,
  collapsePanel: vi.fn(),
  openNewRoutine: vi.fn(),
  openJob: vi.fn(),
  openJobs: vi.fn(),
  openSidebarPage: state.openSidebarPage,
  openFilePreview: vi.fn(),
  openKnowledge: vi.fn(),
  jumpToDelegation: vi.fn(),
  setNotice: vi.fn(),
  addRule: vi.fn(async () => null),
  updateRule: vi.fn(async () => null),
  deleteRule: vi.fn(async () => undefined),
  runRoutine: vi.fn(),
  saveRoutine: vi.fn(),
  showNowWide: vi.fn(),
  setNowWide: vi.fn(),
  toggleNowWide: vi.fn(),
  closeTopic: vi.fn(async () => null),
  reopenTopic: vi.fn(async () => null),
}));
vi.mock("../desktop-screens.ts", () => ({ useDesktopScreens: () => state.desktop }));
vi.mock("./PanelHead.tsx", () => ({
  PanelHead: ({ title, children }: { title?: React.ReactNode; children?: React.ReactNode }) => <header>{title}{children}</header>,
  CollapsePanelButton: () => <button title="收起右栏" />,
}));
vi.mock("./use-menu.ts", () => ({ useMenu: () => ({ menu: null, box: { current: null }, toggle: vi.fn(), close: vi.fn() }) }));
vi.mock("../sprites.tsx", () => ({ Avatar: () => <span>头像</span> }));

import { Panel } from "./Panel.tsx";

function setupFixture() {
  const g: GroupSummary = {
    id: "g-1",
    name: "研发协作群",
    purpose: "一起把系统做稳定",
    ownerId: "po",
    members: ["po", "dev", "qa"],
    createdAt: "2026-01-01T00:00:00Z",
    unread: 0,
    busy: ["po"],
    replyMode: "owner",
  };
  const t1: GroupSummary = {
    ...g,
    id: "t-1",
    parentId: "g-1",
    name: "性能优化话题",
    busy: ["dev"],
    replyMode: "all",
    overrides: { replyMode: "all", models: { work: { ref: "p/topic-work", thinking: "high" } }, memberModels: { dev: { work: { ref: "p/topic-member-work", thinking: "high" } } } },
  };
  const t2: GroupSummary = {
    ...g,
    id: "t-2",
    parentId: "g-1",
    name: "安全巡检话题",
    busy: ["qa"],
    replyMode: "owner",
    overrides: {},
  };
  state.groups = [g, t1, t2];
  state.assistantSkills = {
    "g-1": {
      loading: false,
      loaded: true,
      error: null,
      skills: [{ name: "s1", title: "通用排查", description: "排查步骤", path: "/s1", version: 1, uses: 1, enabled: true }],
    },
  };
  state.routines = [
    { id: "r-g", assistantId: "po", groupId: "g-1", name: "群汇总定时", instruction: "汇总", schedules: ["0 9 * * *"], active: true, createdAt: "2026-01-01", runs: [] },
    { id: "r-t1", assistantId: "po", groupId: "t-1", name: "性能巡检定时", instruction: "压测", schedules: ["0 10 * * *"], active: true, createdAt: "2026-01-01", runs: [] },
    { id: "r-t2", assistantId: "po", groupId: "t-2", name: "安全扫描定时", instruction: "扫描", schedules: ["0 11 * * *"], active: true, createdAt: "2026-01-01", runs: [] },
  ];
  state.jobs = {
    "j-g": { id: "j-g", assistantId: "po", groupId: "g-1", title: "整理群目标", instruction: "", status: "running", createdAt: "2026-01-01T01:00:00Z", startedAt: "2026-01-01T01:00:00Z", stats: { reads: 0, commands: 0, edits: 0 }, activity: [] },
    "j-t1": { id: "j-t1", assistantId: "dev", groupId: "t-1", title: "定位慢查询", instruction: "", status: "running", createdAt: "2026-01-01T02:00:00Z", startedAt: "2026-01-01T02:00:00Z", stats: { reads: 0, commands: 0, edits: 0 }, activity: [] },
    "j-t2": { id: "j-t2", assistantId: "qa", groupId: "t-2", title: "校验登录边界", instruction: "", status: "running", createdAt: "2026-01-01T03:00:00Z", startedAt: "2026-01-01T03:00:00Z", stats: { reads: 0, commands: 0, edits: 0 }, activity: [] },
  };
  state.groupProfiles = {
    "g-1": {
      value: {
        group: g,
        rules: [
          { id: "r-p1", text: "发版前确认", changedAt: "2026-01-01T00:00:00Z", from: "parent" },
          { id: "r-p2", text: "只读命令直接执行", changedAt: "2026-01-01T00:00:00Z", from: "parent" },
        ],
        hiddenRules: [],
        replyMode: { value: "owner", source: "group" },
        models: {
          conversation: { source: "global", pick: { ref: "p/global-chat", thinking: "low" }, inherited: { source: "global", pick: { ref: "p/global-chat", thinking: "low" } } },
          work: { source: "group", pick: { ref: "p/group-work", thinking: "high" }, inherited: { source: "global", pick: { ref: "p/global-work", thinking: "high" } } },
        },
        memberModels: {
          po: {
            conversation: { source: "global", pick: { ref: "p/global-chat", thinking: "low" }, inherited: { source: "global", pick: { ref: "p/global-chat", thinking: "low" } } },
            work: { source: "group", pick: { ref: "p/group-work", thinking: "high" }, inherited: { source: "group", pick: { ref: "p/group-work", thinking: "high" } } },
          },
          dev: {
            conversation: { source: "global", pick: { ref: "p/global-chat", thinking: "low" }, inherited: { source: "global", pick: { ref: "p/global-chat", thinking: "low" } } },
            work: { source: "member", pick: { ref: "p/member-work", thinking: "high" }, inherited: { source: "group", pick: { ref: "p/group-work", thinking: "high" } } },
          },
          qa: {
            conversation: { source: "global", pick: { ref: "p/global-chat", thinking: "low" }, inherited: { source: "global", pick: { ref: "p/global-chat", thinking: "low" } } },
            work: { source: "assistant", pick: { ref: "p/global-work", thinking: "high" }, inherited: { source: "assistant", pick: { ref: "p/global-work", thinking: "high" } } },
          },
        },
      },
    },
    "t-1": {
      value: {
        group: t1,
        rules: [
          { id: "r-p1", text: "发版前在预发验证", changedAt: "2026-01-01T00:00:00Z", from: "parent", changed: true },
          { id: "r-own", text: "导出超过十万行拆分", changedAt: "2026-01-01T00:00:00Z", from: "topic" },
        ],
        hiddenRules: [{ id: "r-p2", text: "只读命令直接执行", changedAt: "2026-01-01T00:00:00Z" }],
        replyMode: { value: "all", source: "topic" },
        models: {
          conversation: { source: "global", pick: { ref: "p/global-chat", thinking: "low" }, inherited: { source: "global", pick: { ref: "p/global-chat", thinking: "low" } } },
          work: { source: "topic", pick: { ref: "p/topic-work", thinking: "high" }, inherited: { source: "group", pick: { ref: "p/group-work", thinking: "high" } } },
        },
        memberModels: {
          po: {
            conversation: { source: "global", pick: { ref: "p/global-chat", thinking: "low" }, inherited: { source: "global", pick: { ref: "p/global-chat", thinking: "low" } } },
            work: { source: "topic", pick: { ref: "p/topic-work", thinking: "high" }, inherited: { source: "topic", pick: { ref: "p/topic-work", thinking: "high" } } },
          },
          dev: {
            conversation: { source: "global", pick: { ref: "p/global-chat", thinking: "low" }, inherited: { source: "global", pick: { ref: "p/global-chat", thinking: "low" } } },
            work: { source: "topicMember", pick: { ref: "p/topic-member-work", thinking: "high" }, inherited: { source: "member", pick: { ref: "p/member-work", thinking: "high" } } },
          },
          qa: {
            conversation: { source: "global", pick: { ref: "p/global-chat", thinking: "low" }, inherited: { source: "global", pick: { ref: "p/global-chat", thinking: "low" } } },
            work: { source: "global", pick: { ref: "p/global-work", thinking: "high" }, inherited: { source: "global", pick: { ref: "p/global-work", thinking: "high" } } },
          },
        },
      },
    },
  };
}

describe("P3 群话题右栏与成员行", () => {
  beforeEach(() => {
    state.sel = null;
    state.gsel = "g-1";
    state.panelStack = [];
    setupFixture();
  });

  it("话题里任务、定时、正在做、成员圆点只显示本话题的，底部只有关闭话题", () => {
    state.gsel = "t-1";
    const html = renderToStaticMarkup(<Panel page={null} />);

    // 身份卡：话题名与群信息
    expect(html).toContain("<strong>性能优化话题</strong>");
    expect(html).toContain("群「研发协作群」· 群主 · 产品统筹 · 3 位成员");

    // 定时任务：只有 t-1 的 1 个
    expect(html).toContain("<span>定时任务</span><small>1 个 · ");
    // 技能：本群共用
    expect(html).toContain("<span>技能</span><small>本群共用 · 1 个</small>");
    // 规则：合成后的 2 条
    expect(html).toContain("<span>规则</span><small>2 条</small>");
    // 模型入口：有话题覆盖显示本话题
    expect(html).toContain("<span>模型</span><small>本话题</small>");
    // 没点名时：本话题 · 全员回应
    expect(html).toContain("<span>没点名时</span><small>本话题 · 全员回应</small>");

    // 正在做 & 任务页签：只含 j-t1，不含 j-g 与 j-t2
    expect(html).toContain("进行中 · 1");
    expect(html).toContain("定位慢查询");
    expect(html).not.toContain("整理群目标");
    expect(html).not.toContain("校验登录边界");

    // 成员圆点只有 dev（在 t-1 有进行中任务且正在发言），po/qa 没有圆点；行内没有状态文字
    const devIdx = html.indexOf("全栈开发");
    const qaIdx = html.indexOf("质量测试");
    const poSection = html.slice(html.indexOf("成员随群"), devIdx);
    const devSection = html.slice(devIdx, qaIdx);
    const qaSection = html.slice(qaIdx);
    expect(poSection).not.toContain('class="gm-dot"');
    expect(devSection).toContain('class="gm-dot"');
    expect(qaSection).not.toContain('class="gm-dot"');
    expect(html).not.toContain(">空闲<");
    expect(html).not.toContain('<em class="busy">');

    // 底部只有「关闭这个话题」，没有「结束这个群」
    expect(html).toContain("关闭这个话题");
    expect(html).not.toContain("结束这个群");
  });

  it("综合照旧汇总全群并带话题名，成员行下拉显示生效模型且无状态文字，底部只有结束这个群", () => {
    state.gsel = "g-1";
    const html = renderToStaticMarkup(<Panel page={null} />);

    expect(html).toContain("<strong>研发协作群</strong>");
    expect(html).toContain("<span>定时任务</span><small>3 个 · ");
    expect(html).toContain("进行中 · 3");
    expect(html).toContain("整理群目标");
    expect(html).toContain("定位慢查询");
    expect(html).toContain("校验登录边界");
    expect(html).toContain("「性能优化话题」");
    expect(html).toContain("「安全巡检话题」");

    // 综合里三个成员都在各自地方进行中/发言，都有圆点
    expect(html.match(/class="gm-dot"/g)).toHaveLength(3);
    expect(html).not.toContain(">空闲<");

    // 成员行下拉显示生效模型，跟随项带 following 类与来源 title
    expect(html).toContain('aria-label="产品统筹的任务模型"');
    expect(html).toContain('title="跟随本群 · p/group-work"');
    expect(html).toContain('aria-label="全栈开发的任务模型"');
    expect(html).toContain('title="p/member-work"');
    expect(html).toContain('aria-label="质量测试的任务模型"');
    expect(html).toContain('title="跟随助手 · p/global-work"');

    // 综合没有话题模型入口行，底部只有「结束这个群」
    expect(html).not.toContain("<span>模型</span>");
    expect(html).toContain("结束这个群");
    expect(html).not.toContain("关闭这个话题");
  });

  it("话题内成员行：topicMember 不带 following、跟随项分别标出来源", () => {
    state.gsel = "t-1";
    const html = renderToStaticMarkup(<Panel page={null} />);
    expect(html).toContain('title="跟随本话题默认 · p/topic-work"');
    expect(html).toContain('title="p/topic-member-work"');
    expect(html).toContain('title="跟随全局 · p/global-work"');
    expect(html).toContain("成员随群");
  });

  it("话题规则页逐条标出跟随群、本话题改过、本话题的，并显示恢复跟随与已停用规则", () => {
    state.gsel = "t-1";
    // 追加一条未改的跟随群规则
    state.groupProfiles["t-1"]!.value!.rules.unshift({
      id: "r-p0",
      text: "删除前先备份",
      changedAt: "2026-01-01T00:00:00Z",
      from: "parent",
    });
    const html = renderToStaticMarkup(<Panel page={{ kind: "topicRules", groupId: "t-1" }} />);
    expect(html).not.toContain("rule-mode");
    expect(html).toContain("删除前先备份");
    expect(html).toContain("跟随群");
    expect(html).toContain("发版前在预发验证");
    expect(html).toContain("本话题改过");
    expect(html).toContain("导出超过十万行拆分");
    expect(html).toContain("本话题的");
    expect(html).toContain("已在本话题停用");
    expect(html).toContain("只读命令直接执行");
    expect(html.match(/恢复跟随/g)).toHaveLength(2);
  });

  it("综合规则页显示本群默认说明", () => {
    state.gsel = "g-1";
    const html = renderToStaticMarkup(<Panel page={{ kind: "rules", groupId: "g-1" }} />);
    expect(html).toContain("本群默认，没单独改过的话题都会用。");
  });

  it("话题模型页显示话题默认（对话/任务）和各成员任务模型的来源与恢复跟随", () => {
    state.gsel = "t-1";
    const html = renderToStaticMarkup(<Panel page={{ kind: "topicModels", groupId: "t-1" }} />);
    expect(html).toContain("话题默认");
    expect(html).toContain("跟随全局 · p/global-chat");
    expect(html).toContain("本话题 · p/topic-work");
    expect(html).toContain("成员任务模型");
    expect(html).toContain("跟随本话题默认 · p/topic-work");
    expect(html).toContain("本话题 · p/topic-member-work");
    expect(html).toContain("跟随全局 · p/global-work");
    expect(html).toContain("成员只能单设任务模型，对话模型在群设置里改");
    expect(html.match(/恢复跟随/g)).toHaveLength(2);
  });
});
