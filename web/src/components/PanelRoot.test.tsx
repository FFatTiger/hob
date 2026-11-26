import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { GroupSummary, Job } from "../../../shared/types.ts";

const data = vi.hoisted(() => ({
  sel: "hob" as string | null, gsel: null as string | null, panelStack: [] as any[], nowWide: false,
  assistants: [{ id: "hob", name: "Hob", duty: "主助手", sprite: "hob", primary: true, knowledge: [], busy: false } as any],
  groups: [] as GroupSummary[],
  groupProfiles: {} as Record<string, any>,
  profiles: { hob: { assistant: { id: "hob", name: "Hob", duty: "主助手", sprite: "hob", primary: true, knowledge: [], busy: false } as any, rules: [], worklog: [] } } as Record<string, any>,
  jobs: {} as Record<string, Job>, routines: [] as any[], approvals: {} as Record<string, any>, delegations: {} as Record<string, any>, assistantSkills: { hob: { loading: false, loaded: true, skills: [] as any[], error: null as string | null } } as Record<string, any>,
  knowledge: { collections: [] as any[], collectionsLoaded: false, loading: false, error: null as string | null },
  plugins: { loaded: true, loading: false, error: null as string | null, items: [] as any[] },
  desktop: {
    profiles: { hob: "screen-a" } as Record<string, string>,
    screens: [{ id: "screen-a", running: true, browserRunning: true, viewers: 0, lastActiveAt: null }] as any[],
    users: { "screen-a": [{ assistantId: "hob", place: {} }] } as Record<string, any[]>,
  },
  settings: { settings: { general: { timezone: "UTC" }, models: { conversation: { ref: "p/m", thinking: "low" }, work: { ref: "p/m", thinking: "low" }, roster: [] }, image: { source: "off" }, providers: [] } },
}));
vi.mock("../store.ts", () => ({ useApp: () => data, openAssistantPanel: vi.fn(), openGroupSettings: vi.fn(), openMemberPanel: vi.fn(), archiveGroup: vi.fn(), archiveAssistant: vi.fn(), patchGroup: vi.fn(), patchAssistant: vi.fn(), patchGroupMemberModels: vi.fn(), loadModels: vi.fn(async () => ({ models: [], updatedAt: null, error: null })), loadPlugins: vi.fn(async () => undefined), loadGroupProfile: vi.fn(async () => undefined), loadAssistantSkills: vi.fn(async () => undefined), loadKnowledge: vi.fn(async () => undefined), collapsePanel: vi.fn(), openNewRoutine: vi.fn(), openJob: vi.fn(), openJobs: vi.fn(), openSidebarPage: vi.fn(), openFilePreview: vi.fn(), openKnowledge: vi.fn(), jumpToDelegation: vi.fn(), setNotice: vi.fn(), updateRule: vi.fn(), runRoutine: vi.fn(), saveRoutine: vi.fn(), showNowWide: vi.fn(), setNowWide: vi.fn(), toggleNowWide: vi.fn(), closeTopic: vi.fn(async () => null), reopenTopic: vi.fn(async () => null) }));
vi.mock("../desktop-screens.ts", () => ({ useDesktopScreens: () => data.desktop }));
vi.mock("./PanelHead.tsx", () => ({ PanelHead: ({ children }: { children: React.ReactNode }) => <header>{children}</header>, CollapsePanelButton: () => <button title="收起右栏" /> }));
vi.mock("./use-menu.ts", () => ({ useMenu: () => ({ menu: null }) }));
vi.mock("../sprites.tsx", () => ({ Avatar: () => <span>头像</span> }));
import { Panel } from "./Panel.tsx";
const job = (status: Job["status"]): Job => ({ id: "j", assistantId: "hob", title: "示例任务", instruction: "", status, createdAt: "2026-01-01T00:00:00Z", endedAt: status === "done" ? "2026-01-01T01:00:00Z" : undefined, stats: { reads: 0, commands: 0, edits: 0 }, activity: [] });

beforeEach(() => {
  data.sel = "hob";
  data.gsel = null;
  data.panelStack = [];
  data.groups = [];
  data.nowWide = false;
  data.jobs = {};
  data.routines = [];
  data.approvals = {};
  data.delegations = {};
  data.assistants = [{ id: "hob", name: "Hob", duty: "主助手", sprite: "hob", primary: true, knowledge: [], busy: false }];
  data.profiles = { hob: { assistant: { id: "hob", name: "Hob", duty: "主助手", sprite: "hob", primary: true, knowledge: [], busy: false }, rules: [], worklog: [] } };
  data.desktop = {
    profiles: { hob: "screen-a" },
    screens: [{ id: "screen-a", running: true, browserRunning: true, viewers: 0, lastActiveAt: null }],
    users: { "screen-a": [{ assistantId: "hob", place: {} }] },
  };
});
it("助手自己工作时显示执行中但不显示命令行", () => { data.profiles.hob.assistant.busy = true; const html = renderToStaticMarkup(<Panel page={null} />); expect(html).toContain("执行中"); expect(html).not.toContain('class="screen '); });
it("等待确认和排队不显示命令行", () => { data.jobs = { j: job("queued") }; data.approvals = { p: { assistantId: "hob", status: "pending" } }; const waiting = renderToStaticMarkup(<Panel page={null} />); expect(waiting).toContain("等你确认"); expect(waiting).not.toContain('class="screen '); data.approvals = {}; const queued = renderToStaticMarkup(<Panel page={null} />); expect(queued).toContain("排队中"); expect(queued).not.toContain('class="screen '); });
it("运行中显示小屏和说明", () => { data.jobs = { j: job("running") }; const html = renderToStaticMarkup(<Panel page={null} />); expect(html).toContain('class="screen '); expect(html).toContain("任务详情"); expect(html).toContain("执行中"); });
it("运行中的云桌面显示侧栏展开按钮", () => {
  const html = renderToStaticMarkup(<Panel page={null} />);
  expect(html).toContain('aria-label="在侧栏展开"');
});
it("展开后只显示桌面与正在运行任务，收起后恢复根页", () => {
  data.jobs = { j: job("running") };
  data.nowWide = true;
  const focused = renderToStaticMarkup(<Panel page={null} />);
  expect(focused).toContain('class="focus-desktop"');
  expect(focused).toContain('title="缩小右栏"');
  expect(focused.match(/title="收起右栏"/g)).toHaveLength(1);
  expect(focused).toContain('class="focus-job"');
  expect(focused).toContain("示例任务");
  expect(focused).not.toContain('class="sidebar-card"');
  expect(focused).not.toContain('class="screen strip"');
  data.nowWide = false;
  const normal = renderToStaticMarkup(<Panel page={null} />);
  expect(normal).toContain("sidebar-card");
  expect(normal).toContain("任务详情");
});

it("空闲显示上次和下一次", () => { data.jobs = { j: job("done") }; data.routines = [{ id: "r", assistantId: "hob", name: "每日简报", schedules: ["0 9 * * *"], active: true }]; const html = renderToStaticMarkup(<Panel page={null} />); expect(html).not.toContain('class="screen '); expect(html).toContain("上次"); expect(html).toContain("下一次"); });
it("助手设置不显示补充说明", () => { const html = renderToStaticMarkup(<Panel page={null} />); expect(html).not.toContain("记下这个助手要知道的事实"); });
it("主助手显示转交", () => { data.delegations = { d: { id: "d", from: "hob", to: "someone", status: "waiting" } }; const html = renderToStaticMarkup(<Panel page={null} />); expect(html).toContain("交给「someone」"); expect(html).toContain("等你确认"); });
it("已有知识库时刷新仍显示列表", () => {
  data.knowledge = { collections: [{ id: "k", name: "项目资料" }], collectionsLoaded: true, loading: true, error: null };
  const html = renderToStaticMarkup(<Panel page={{ kind: "knowledge" }} />);
  expect(html).toContain("项目资料");
  expect(html).not.toContain("正在加载…");
  data.knowledge.error = "网络错误";
  const failed = renderToStaticMarkup(<Panel page={{ kind: "knowledge" }} />);
  expect(failed).toContain("项目资料");
  expect(failed).toContain("加载失败：网络错误");
});
it("已有技能时刷新仍显示列表", () => {
  data.assistantSkills.hob = { loading: true, loaded: true, error: null, skills: [{ name: "brief", title: "每日简报", description: "整理动态", path: "/brief", uses: 0, version: 1, enabled: true }] };
  const html = renderToStaticMarkup(<Panel page={{ kind: "skills" }} />);
  expect(html).toContain("每日简报");
  expect(html).not.toContain("正在加载…");
  data.assistantSkills.hob.error = "网络错误";
  const failed = renderToStaticMarkup(<Panel page={{ kind: "skills" }} />);
  expect(failed).toContain("每日简报");
  expect(failed).toContain("加载失败：网络错误");
  data.assistantSkills.hob = { loading: true, loaded: true, error: null, skills: [] };
  const empty = renderToStaticMarkup(<Panel page={{ kind: "skills" }} />);
  expect(empty).toContain("还没有技能");
  expect(empty).not.toContain("正在加载…");
});
it("停止任务的上次显示状态和知识库加载状态", () => {
  data.jobs = { j: { ...job("stopped"), endedAt: "2026-01-01T01:00:00Z" } };
  const html = renderToStaticMarkup(<Panel page={null} />);
  expect(html).toContain("上次");
  expect(html).not.toContain("正在加载…");
  expect(html).not.toContain(">日志</button>");
});

it("助手右栏和编辑页仅在非主助手绑定工作目录时只读展示", () => {
  // 主助手即使数据里意外存在 cwd 也绝不渲染
  data.profiles.hob.assistant.cwd = "/workspace/should-hide";
  expect(renderToStaticMarkup(<Panel page={null} />)).not.toContain("工作目录");
  expect(renderToStaticMarkup(<Panel page={{ kind: "assistant" }} />)).not.toContain("工作目录");

  // 普通助手未绑定 cwd 时不渲染
  data.sel = "dev";
  data.assistants.push({ id: "dev", name: "开发", duty: "写代码", sprite: "page", primary: false, knowledge: [], busy: false });
  data.profiles.dev = { assistant: { id: "dev", name: "开发", duty: "写代码", sprite: "page", primary: false, knowledge: [], busy: false }, rules: [], worklog: [] };
  expect(renderToStaticMarkup(<Panel page={null} />)).not.toContain("工作目录");
  expect(renderToStaticMarkup(<Panel page={{ kind: "assistant" }} />)).not.toContain("工作目录");

  // 普通助手绑定 cwd 后只读展示
  data.profiles.dev.assistant.cwd = "/workspace/hob-web";
  const nowHtml = renderToStaticMarkup(<Panel page={null} />);
  expect(nowHtml).toContain("工作目录");
  expect(nowHtml).toContain("/workspace/hob-web");
  const settingsHtml = renderToStaticMarkup(<Panel page={{ kind: "assistant" }} />);
  expect(settingsHtml).toContain("工作目录");
  expect(settingsHtml).toContain('class="field ro"');
  expect(settingsHtml).toContain("/workspace/hob-web");
  expect(settingsHtml).toContain("创建时已绑定，不可修改。");
});

it("群与话题右栏及群编辑页按来源只读展示工作目录，未绑定不渲染", () => {
  const baseGroup = (id: string, patch: Partial<GroupSummary> = {}): GroupSummary => ({
    id,
    name: id,
    purpose: "负责项目开发",
    ownerId: "hob",
    members: ["hob"],
    createdAt: "2026-01-01T00:00:00Z",
    unread: 0,
    busy: [],
    ...patch,
  });

  // 未绑定的群综合与编辑页均不显示工作目录
  const gPlain = baseGroup("g-plain", { name: "家里机器" });
  const tPlain = baseGroup("t-plain", { name: "普通话题", parentId: "g-plain" });
  const tOwn = baseGroup("t-own", { name: "独立目录话题", parentId: "g-plain", cwd: "/srv/scripts" });
  const gBound = baseGroup("g-bound", { name: "敏捷团队", cwd: "/workspace/hob" });
  const tFollow = baseGroup("t-follow", { name: "跟随群话题", parentId: "g-bound" });
  data.groups = [gPlain, tPlain, tOwn, gBound, tFollow];

  data.sel = null;
  data.gsel = "g-plain";
  expect(renderToStaticMarkup(<Panel page={null} />)).not.toContain("工作目录");
  expect(renderToStaticMarkup(<Panel page={{ kind: "groupSettings", id: "g-plain" }} />)).not.toContain("工作目录");

  // 未绑定群下的未绑定话题也不显示
  data.gsel = "t-plain";
  expect(renderToStaticMarkup(<Panel page={null} />)).not.toContain("工作目录");

  // 未绑定群下绑定了自身目录的话题显示「工作目录 · 本话题」
  data.gsel = "t-own";
  const ownHtml = renderToStaticMarkup(<Panel page={null} />);
  expect(ownHtml).toContain("工作目录 · 本话题");
  expect(ownHtml).toContain("/srv/scripts");

  // 已绑定群综合显示「工作目录」，编辑页只读展示
  data.gsel = "g-bound";
  const boundHtml = renderToStaticMarkup(<Panel page={null} />);
  expect(boundHtml).toContain("工作目录");
  expect(boundHtml).toContain("/workspace/hob");
  expect(boundHtml).not.toContain("跟随群");
  const groupSettingsHtml = renderToStaticMarkup(<Panel page={{ kind: "groupSettings", id: "g-bound" }} />);
  expect(groupSettingsHtml).toContain('class="field ro"');
  expect(groupSettingsHtml).toContain("/workspace/hob");
  expect(groupSettingsHtml).toContain("创建时已绑定，群内及所有话题共用此目录，不可修改。");

  // 已绑定群下的话题显示「工作目录 · 跟随群」
  data.gsel = "t-follow";
  const followHtml = renderToStaticMarkup(<Panel page={null} />);
  expect(followHtml).toContain("工作目录 · 跟随群");
  expect(followHtml).toContain("/workspace/hob");
  expect(followHtml).not.toContain("本话题");
});

it("云桌面在单聊和群话题下按占用者呈现：本会话在用内嵌小屏、别处在用提示来源、无人用显示空闲", () => {
  const g: GroupSummary = { id: "g-1", name: "网站项目", purpose: "开发", ownerId: "hob", members: ["hob", "dev"], createdAt: "2026-01-01T00:00:00Z", unread: 0, busy: [] };
  const t1: GroupSummary = { ...g, id: "t-1", name: "深色模式", parentId: "g-1" };
  const t2: GroupSummary = { ...g, id: "t-2", name: "登录改版", parentId: "g-1" };
  data.assistants = [
    { id: "hob", name: "Hob", duty: "主助手", sprite: "hob", primary: true, knowledge: [], busy: false },
    { id: "dev", name: "开发", duty: "写代码", sprite: "page", primary: false, knowledge: [], busy: false },
  ];
  data.groups = [g, t1, t2];
  data.desktop = {
    profiles: { hob: "screen-a", dev: "screen-dev" },
    screens: [
      { id: "screen-a", running: true, browserRunning: true, viewers: 0, lastActiveAt: null },
      { id: "screen-dev", running: true, browserRunning: true, viewers: 0, lastActiveAt: null },
    ],
    users: { "screen-dev": [{ assistantId: "dev", jobId: "j-1", place: { groupId: "t-2" } }] },
  };

  // 单聊看 dev：dev 正在 t-2 用 → 不内嵌小屏，显示「网站项目 · 登录改版」正在用
  data.sel = "dev";
  data.gsel = null;
  const singleElsewhere = renderToStaticMarkup(<Panel page={null} />);
  expect(singleElsewhere).not.toContain('class="now-desk"');
  expect(singleElsewhere).toContain("「网站项目 · 登录改版」正在用");

  // 群话题 t-1：dev 在 t-2 用 → 显示「登录改版」正在用，不内嵌小屏
  data.sel = null;
  data.gsel = "t-1";
  const topicElsewhere = renderToStaticMarkup(<Panel page={null} />);
  expect(topicElsewhere).not.toContain('class="now-desk"');
  expect(topicElsewhere).toContain("「登录改版」正在用");

  // 切换到 t-2：本话题在用 → 内嵌 dev 的小屏
  data.gsel = "t-2";
  const topicActive = renderToStaticMarkup(<Panel page={null} />);
  expect(topicActive).toContain('class="now-desk"');
  expect(topicActive).toContain("开发 · 实时");
  expect(topicActive).not.toContain("正在用");

  // 无人使用时即使屏幕仍 running 也显示空闲，不内嵌小屏
  data.desktop.users = {};
  const topicIdle = renderToStaticMarkup(<Panel page={null} />);
  expect(topicIdle).not.toContain('class="now-desk"');
  expect(topicIdle).toContain("<span>云桌面</span><small>空闲</small>");
});

it("群成员详情页只读显示对话模型与来源并提示在群设置里改，仅留默认任务模型下拉", () => {
  const g: GroupSummary = { id: "g-1", name: "产品群", purpose: "协作", ownerId: "hob", members: ["hob"], createdAt: "2026-01-01T00:00:00Z", unread: 0, busy: [] };
  const t1: GroupSummary = { ...g, id: "t-1", name: "深色模式", parentId: "g-1" };
  data.groups = [g, t1];
  data.sel = null;
  data.gsel = "g-1";
  data.panelStack = [{ kind: "member", id: "hob" }];
  const pick = { ref: "p/m", thinking: "low" as const };
  const topicPick = { ref: "p/topic-chat", thinking: "medium" as const };
  data.groupProfiles = {
    "g-1": {
      value: {
        group: g,
        rules: [],
        memberModels: {
          hob: {
            conversation: { source: "group", pick, inherited: { source: "group", pick } },
            work: { source: "group", pick, inherited: { source: "group", pick } },
          },
        },
      },
    },
    "t-1": {
      value: {
        group: t1,
        rules: [],
        memberModels: {
          hob: {
            conversation: { source: "topic", pick: topicPick, inherited: { source: "group", pick } },
            work: { source: "topic", pick, inherited: { source: "topic", pick } },
          },
        },
      },
    },
  };
  const html = renderToStaticMarkup(<Panel />);
  expect(html).toContain("在「产品群」里");
  expect(html).toContain("只在本群生效");
  expect(html).toContain('aria-label="默认任务模型"');
  expect(html).not.toContain('aria-label="对话模型"');
  expect(html).toContain('<div class="group-member-model-row ro"><span>对话模型</span>');
  expect(html).toContain("跟随本群 · p/m");
  expect(html).toContain("成员只能单设任务模型，对话模型在群设置里改");

  // 在话题里进成员详情页：显示该话题，并跟随本话题的对话模型
  data.gsel = "t-1";
  const topicHtml = renderToStaticMarkup(<Panel />);
  expect(topicHtml).toContain("在「深色模式」里");
  expect(topicHtml).toContain("只在本话题生效");
  expect(topicHtml).toContain("本话题 · p/topic-chat");
  expect(topicHtml).toContain("跟随本话题默认 · p/m");
});
