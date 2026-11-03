// 浏览器内的假后端：只有 URL 带 ?mock=1 时才会用它。数据照 docs/design/v2 的 6 张效果图。
import type {
  Approval,
  AssistantSummary,
  Bootstrap,
  Delegation,
  Draft,
  HobEvent,
  ImageKeyView,
  ImageSettings,
  ImageTestResult,
  Item,
  Job,
  JobFilesView,
  JobsPage,
  JobStep,
  FileMeta,
  LoreTestResult,
  MemoryConfig,
  MemoryProvider,
  Profile,
  Routine,
  RoutineRun,
  Rule,
  ThinkingLevelMapSetting,
  ModelsView,
  ModelThinkingView,
  ProviderImportItem,
  ProviderSettings,
  ProvidersView,
  PushSubscriptionJson,
  PushView,
  WorklogEntry,
} from "../../shared/types.ts";
import { defaultSearch } from "../../shared/search.ts";
import { ApiError, type HobApi } from "./api.ts";
import { normalizeThinkingMap, thinkingPlan } from "../../shared/thinking.ts";

export type SceneId = "act-demo" | "act-think" | "act-tool" | "act-dark" | "act-home" | "boot" | "bubbles" | "bubbles-dark" | "s1" | "s2" | "s3" | "s4" | "s6" | "mlist" | "mchat" | "d-running" | "d-waiting" | "d-done" | "d-dark" | "d-source" | "d-mobile" | "h-hob" | "h-dark" | "h-source" | "h-settings" | "h-mobile";

/** 每个截图场景对应的界面状态（选中哪个助手、右栏开什么）。 */
export const SCENE_UI: Record<
  SceneId,
  { sel: string | null; panel: string; collapsed: boolean; dark: boolean; mobile: "list" | "chat" }
> = {
  "act-demo": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "act-think": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "act-tool": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "act-dark": { sel: "hob", panel: "now", collapsed: false, dark: true, mobile: "chat" },
  "act-home": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "list" },
  boot: { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "list" },
  bubbles: { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "bubbles-dark": { sel: "hob", panel: "now", collapsed: false, dark: true, mobile: "chat" },
  s1: { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "list" },
  s2: { sel: "bird", panel: "routine:r-daily", collapsed: false, dark: false, mobile: "list" },
  s3: { sel: "page", panel: "assistant", collapsed: false, dark: false, mobile: "list" },
  s4: { sel: "hob", panel: "now", collapsed: true, dark: false, mobile: "list" },
  s6: { sel: "hob", panel: "now", collapsed: false, dark: true, mobile: "list" },
  mlist: { sel: null, panel: "now", collapsed: false, dark: false, mobile: "list" },
  mchat: { sel: "page", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "d-running": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "d-waiting": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "d-done": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "d-dark": { sel: "hob", panel: "now", collapsed: false, dark: true, mobile: "chat" },
  "d-source": { sel: "server", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "d-mobile": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "h-hob": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "h-dark": { sel: "hob", panel: "now", collapsed: false, dark: true, mobile: "chat" },
  "h-source": { sel: "server", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "h-settings": { sel: "server", panel: "assistant", collapsed: false, dark: false, mobile: "chat" },
  "h-mobile": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
};

const uid = (() => {
  let n = 0;
  return (p: string) => `${p}${++n}`;
})();

/** 效果图里的时间都是相对“今天”的，按天回推，截图时看到的日期才自然。 */
function at(daysAgo: number, h: number, m = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

function minsAgo(n: number): string {
  return new Date(Date.now() - n * 60000).toISOString();
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

interface Db {
  assistants: AssistantSummary[];
  items: Record<string, Item[]>;
  jobs: Record<string, Job>;
  delegations: Record<string, Delegation>;
  approvals: Record<string, Approval>;
  drafts: Record<string, Draft>;
  routines: Routine[];
  rules: Record<string, Rule[]>;
  worklog: Record<string, WorklogEntry[]>;
  settings: Bootstrap["settings"];
}

const HOB_TASK_ACTIVITY: Job["activity"] = [
  { at: minsAgo(6), verb: "$", text: "npm run typecheck" },
  { at: minsAgo(5), verb: "读", text: "protocol/src/projection.ts" },
  { at: minsAgo(4), verb: "读", text: "client/src/runtime/store.ts" },
  { at: minsAgo(3), verb: "跑", text: "npm test -w protocol" },
  { at: minsAgo(2), verb: "读", text: "client/src/chat/Transcript.tsx" },
  { at: minsAgo(1), verb: "读", text: "client/src/chat/ToolRow.tsx" },
];

function buildDb(scene: SceneId): Db {
  const s1 = scene === "s1" || scene === "s6";
  const draftPending = scene === "s4";
  // 需要演示“待确认”的场景：桌面的 s1 和手机列表的 mlist（两边截图看同一套内容）
  const pending = s1 || scene === "mlist";
  const publishAnswered = !pending && scene !== "mchat";

  const assistants: AssistantSummary[] = [
    {
      id: "hob",
      name: "Hob",
      duty: "主助手",
      sprite: "hob",
      primary: true,
      pinned: true,
      hidden: false,
      notify: true,
      instructions: "输出用中文短句；编写代码的任务先询问项目目录。",
      createdAt: at(30, 9, 0),
      last: { text: "已交给任务处理，完成后通知你。", at: at(0, 10, 5) },
      unread: 0,
      busy: true,
    },
    {
      id: "page",
      name: "写作",
      duty: "周报和文章",
      sprite: "page",
      primary: false,
      pinned: true,
      hidden: false,
      notify: true,
      instructions: "口语化短句；标题不超过 20 字；配图自行生成；周报每周五提交。",
      models: {
        work: { ref: "faux/smart", thinking: "high" },
        allowed: ["faux/smart", "faux/vision"],
      },
      abilities: { exec: false, write: true, image: true },
      createdAt: at(30, 9, 0),
      last: { text: "好的。每周五 17:00 撰写初稿，存入草稿箱，完成后通知你。", at: at(0, 10, 20) },
      unread: 2,
      busy: false,
    },
    {
      id: "server",
      name: "服务器",
      duty: "线上和机器",
      sprite: "server",
      primary: false,
      pinned: true,
      hidden: false,
      notify: true,
      instructions: "清理日志前先查看保留天数的规则。",
      createdAt: at(28, 9, 0),
      last: { text: "凌晨 3 点清理 2.1GB 旧日志", at: at(1, 3, 5) },
      unread: 0,
      busy: false,
    },
    {
      id: "bird",
      name: "行业动态",
      duty: "每天 6 条行业动态",
      sprite: "bird",
      primary: false,
      pinned: false,
      hidden: false,
      notify: true,
      instructions: "关注 agent 编排和本地部署，不包含融资新闻。",
      createdAt: at(7, 9, 0),
      splitFrom: { from: "hob", at: at(7, 9, 0), conversations: 8 },
      last: { text: "今天 6 条，挑选了 2 条重点", at: at(0, 9, 0) },
      unread: 0,
      busy: false,
    },
    {
      id: "house",
      name: "家里 NAS",
      duty: "相册和备份",
      sprite: "house",
      primary: false,
      pinned: false,
      hidden: false,
      notify: false,
      instructions: "",
      createdAt: at(25, 9, 0),
      last: { text: "相册备份完成，新增 312 张", at: at(0, 7, 30) },
      unread: 0,
      busy: false,
    },
    {
      id: "coin",
      name: "记账",
      duty: "账单和预算",
      sprite: "coin",
      primary: false,
      pinned: false,
      hidden: false,
      notify: false,
      instructions: "",
      createdAt: at(24, 9, 0),
      last: { text: "10 月账单已整理完成，比上月减少 12%", at: at(1, 21, 10) },
      unread: 0,
      busy: false,
    },
    {
      id: "book",
      name: "读书",
      duty: "读书笔记",
      sprite: "book",
      primary: false,
      pinned: false,
      hidden: true,
      notify: false,
      instructions: "",
      createdAt: at(20, 9, 0),
      last: { text: "本周读书笔记已整理完成", at: at(3, 20, 0) },
      unread: 0,
      busy: false,
    },
    {
      id: "leaf",
      name: "健身",
      duty: "每周训练",
      sprite: "leaf",
      primary: false,
      pinned: false,
      hidden: true,
      notify: false,
      instructions: "",
      createdAt: at(18, 9, 0),
      last: { text: "本周三次训练已记录", at: at(2, 19, 0) },
      unread: 0,
      busy: false,
    },
  ];

  const approval = (
    id: string,
    assistantId: string,
    title: string,
    detail: string | undefined,
    options: Approval["options"],
    answered: boolean,
    chosen: Approval["chosen"],
    createdAt: string,
    ruleText?: string,
  ): Approval => ({
    id,
    assistantId,
    title,
    detail,
    options,
    status: answered ? "answered" : "pending",
    chosen: answered ? chosen : undefined,
    source: "router",
    ruleText,
    createdAt,
    answeredAt: answered ? createdAt : undefined,
  });

  const publishOptions: Approval["options"] = [
    { key: "A", label: "发布" },
    { key: "B", label: "暂不发布" },
    { key: "C", label: "以后同类内容直接发布，无需确认", always: true },
  ];

  const approvals: Record<string, Approval> = {
    "ap-publish": approval(
      "ap-publish",
      "page",
      "发到公众号吗？",
      undefined,
      clone(publishOptions),
      publishAnswered,
      "C",
      at(0, 7, 42),
      "发公众号",
    ),
    "ap-split": approval(
      "ap-split",
      "hob",
      "是否创建一个专属助手「行业动态」？",
      s1
        ? "这两周你让我查询了 8 次模型和 agent 产品的动态。创建后它会记住你关注的内容，每天早上 9 点提供一份简报。"
        : "这两周你让我查询了 8 次模型和 agent 产品的动态。",
      [
        { key: "A", label: "创建专属助手" },
        { key: "B", label: "暂不创建" },
      ],
      !pending,
      "A",
      at(0, 10, 15),
    ),
  };

  const draft: Draft = {
    id: "d-bird",
    assistantId: "hob",
    status: draftPending ? "pending" : "created",
    name: "行业动态",
    sprite: "bird",
    duty: "跟踪模型发布、agent 产品和开源项目",
    dutyLong: "跟踪模型发布、agent 产品和开源项目",
    routines: [{ name: "每日简报", instruction: "挑最值得看的几条，最多 6 条", schedule: "0 9 * * *" }],
    routinesText: "每天 09:00 简报，最多 6 条；重要发布随时提醒",
    askFirst: ["花钱订阅", "替你对外发消息"],
    instructions: ["关心 agent 编排和本地部署", "不看融资新闻"],
    carry: { conversations: 8 },
    createdAssistantId: draftPending ? undefined : "bird",
    createdAt: at(0, 10, 17),
  };

  const jobRunning: Job = {
    id: "t-0931",
    assistantId: "hob",
    title: "排查页面卡顿",
    instruction: "排查页面卡顿的原因，不要修改代码。",
    status: "running",
    createdAt: minsAgo(6),
    startedAt: minsAgo(6),
    stats: { reads: 14, commands: 3, edits: 0 },
    cwd: "/srv/example/site",
    activity: clone(HOB_TASK_ACTIVITY),
  };

  const jobDone: Job = {
    id: "t-0927",
    assistantId: "server",
    title: "清理旧日志",
    instruction: "清理三天前的旧日志，不要影响正在运行的服务。",
    status: "done",
    createdAt: at(1, 3, 0),
    startedAt: at(1, 3, 0),
    endedAt: at(1, 3, 5),
    stats: { reads: 4, commands: 2, edits: 0 },
    summary: "已清理 2.1GB 旧日志，服务均正常运行。",
    files: ["/srv/example/reports/log-cleanup-1031.md"],
    activity: [
      { at: at(1, 3, 0), verb: "$", text: "du -sh /var/log/*" },
      { at: at(1, 3, 1), verb: "读", text: "/var/log/nginx" },
      { at: at(1, 3, 3), verb: "跑", text: "find /var/log -mtime +3 -delete" },
      { at: at(1, 3, 5), verb: "说", text: "已清理 2.1GB，服务均正常运行。" },
    ],
  };

  const jobBackup: Job = {
    id: "t-0929",
    assistantId: "house",
    title: "整理相册备份",
    instruction: "把手机里这个月的照片备份到 NAS，重复的跳过。",
    status: "done",
    createdAt: minsAgo(58),
    startedAt: minsAgo(58),
    endedAt: minsAgo(51),
    stats: { reads: 6, commands: 2, edits: 0 },
    summary: "新增 312 张，重复跳过 87 张，占用 4.2GB。",
    activity: [
      { at: minsAgo(57), verb: "读", text: "/mnt/nas/photos" },
      { at: minsAgo(55), verb: "跑", text: "rsync -a --ignore-existing /sdcard/DCIM /mnt/nas/photos/" },
      { at: minsAgo(51), verb: "说", text: "新增 312 张，占用 4.2GB。" },
    ],
  };

  const routines: Routine[] = [
    {
      id: "r-morning",
      assistantId: "hob",
      name: "早报",
      instruction: "汇总昨天交代的事项和今天的重要事项，早上汇报一次。",
      schedules: ["0 8 * * *"],
      active: true,
      createdAt: at(20, 21, 0),
      runs: [{ jobId: "t-0901", at: at(0, 8, 0), status: "done" }],
    },
    {
      id: "r-weekly-reminder",
      assistantId: "hob",
      name: "周报提醒",
      instruction: "周五下午提醒查看本周周报。",
      schedules: ["0 17 * * 5"],
      active: true,
      createdAt: at(20, 21, 2),
      runs: [],
    },
    {
      id: "r-reconcile",
      assistantId: "hob",
      name: "月底对账",
      instruction: "月末核对账单，列出不一致的项目。",
      schedules: ["0 9 28 * *"],
      active: false,
      createdAt: at(19, 10, 0),
      runs: [{ jobId: "t-0820", at: at(4, 9, 0), status: "done" }],
    },
    {
      id: "r-daily",
      assistantId: "bird",
      name: "每日简报",
      instruction:
        "挑模型发布、agent 产品和开源项目里最值得看的几条，每条一句话说清为什么重要。最多 6 条，不看融资新闻。",
      schedules: ["0 9 * * *"],
      active: true,
      createdAt: at(7, 9, 0),
      runs: [
        { jobId: "t-0926", at: at(0, 9, 0), status: "done" },
        { jobId: "t-0925", at: at(1, 9, 0), status: "done" },
        { jobId: "t-0924", at: at(2, 9, 1), status: "done" },
        { jobId: "t-0923", at: at(3, 9, 0), status: "done" },
      ],
    },
    {
      id: "r-weekly-draft",
      assistantId: "page",
      name: "周报初稿",
      instruction: "每周五 17:00 撰写周报初稿，存入草稿箱，完成后通知我。",
      schedules: ["0 17 * * 5"],
      active: true,
      createdAt: at(0, 10, 21),
      runs: [],
    },
  ];

  const asst = (id: string, time: string, text: string, routine?: { id: string; name: string }): Item => ({
    kind: "assistant",
    id,
    at: time,
    text,
    routine,
  });

  const morning =
    "早上好。昨晚交代的两件事均已完成：\n\n- 写作已将周报初稿存入草稿箱\n- 服务器凌晨 3 点清理了 2.1GB 旧日志";

  const hobItems: Item[] = [
    asst("i-h1", at(0, 8, 0), morning),
    { kind: "user", id: "i-h3", at: at(0, 10, 5), text: "页面为什么这么卡？排查一下原因，不要修改代码。" },
    asst("i-h4", at(0, 10, 5), "已交给任务处理，完成后通知你。"),
    { kind: "job", id: "i-h5", at: at(0, 10, 5), jobId: "t-0931" },
    { kind: "question", id: "i-h6", at: at(0, 10, s1 ? 9 : 15), approvalId: "ap-split" },
  ];
  if (!s1) {
    hobItems.push(
      { kind: "user", id: "i-h7", at: at(0, 10, 16), text: "创建专属助手吧。最多 6 条即可，不要包含融资新闻。" },
      asst("i-h8", at(0, 10, 17), "草稿如下，需要修改请直接说明："),
      { kind: "draft", id: "i-h9", at: at(0, 10, 17), draftId: "d-bird" },
    );
  }
  // s4 是“草稿卡 + 右栏收起”那一屏，只保留草稿前后的几段
  const hobList = draftPending ? hobItems.filter((x) => !["i-h2", "i-h3", "i-h4", "i-h5"].includes(x.id)) : hobItems;

  const pageItems: Item[] = [
    asst("i-p1", at(1, 17, 5), "周报初稿已完成，存放在草稿箱。"),
    {
      kind: "user",
      id: "i-p2",
      at: at(1, 17, 6),
      text: scene === "mchat" ? "好，周一发布。" : "标题再短一些。",
    },
    asst(
      "i-p3",
      at(1, 17, 8),
      scene === "mchat" ? "好的，周一发布时我会再提醒你。" : "已改为《这周：Hob 立项》。",
    ),
    asst("i-p4", at(0, 7, 40), "《Grok Bot 能借鉴什么》已完成，3200 字，包含 4 张配图。"),
    {
      kind: "file",
      id: "i-p5",
      at: at(0, 7, 41),
      path: "/srv/example/notes/Grok Bot 能借鉴什么.md",
      name: "Grok Bot 能借鉴什么.md",
      meta: "3200 字 · 4 张图",
    },
    { kind: "question", id: "i-p6", at: at(0, 7, 42), approvalId: "ap-publish" },
  ];
  if (scene !== "mchat") {
    pageItems.push(
      { kind: "note", id: "i-p7", at: at(0, 7, 43), icon: "rule", text: "已记入写作的规则 · 发布公众号无需确认" },
      asst("i-p8", at(0, 7, 44), "已发布。[查看文章](https://mp.weixin.qq.com/)"),
      { kind: "user", id: "i-p9", at: at(0, 10, 20), text: "以后周报也由你负责，周五下午提供初稿。" },
      asst("i-p10", at(0, 10, 20), "好的。每周五 17:00 撰写初稿，存入草稿箱，完成后通知你。"),
      { kind: "note", id: "i-p11", at: at(0, 10, 21), icon: "routine", text: "新增定时任务 · 周报初稿 · 每周五 17:00" },
    );
  }

  const birdItems: Item[] = [
    {
      kind: "note",
      id: "i-b0",
      at: at(7, 9, 0),
      icon: "split",
      text: `${new Date(at(7, 9, 0)).getMonth() + 1}月${new Date(at(7, 9, 0)).getDate()}日 由 Hob 创建 · 迁移 8 段对话、14 条记忆`,
    },
    asst("i-b1", at(1, 9, 0), "昨天 5 条，没有特别要紧的。[看全部 5 条](https://example.com/)", {
      id: "r-daily",
      name: "每日简报",
    }),
    asst("i-b2", at(0, 9, 0), "今天 6 条，挑选 2 条重点：", { id: "r-daily", name: "每日简报" }),
    asst(
      "i-b3",
      at(0, 9, 0),
      "1. DeepSeek 公开 Super-agent 设计：路由只分派，任务隔离执行。\n2. xAI 的 Grok Bot：常驻 Bot 加定时任务，结果直接回到对话。\n\n[看全部 6 条](https://example.com/)",
    ),
    {
      kind: "user",
      id: "i-b4",
      at: at(0, 9, 12),
      text: "这个和 Hob 相比，差异在哪里？",
      quote: { itemId: "i-b3", text: "xAI 的 Grok Bot：常驻 Bot 加定时任务…" },
    },
    asst(
      "i-b5",
      at(0, 9, 12),
      "它的 Bot 有一台云电脑，能直接操作网页；Bot 之间也能互相发消息。定时任务、审批、助手创建，我们均已具备。",
    ),
    { kind: "user", id: "i-b6", at: at(0, 9, 14), text: "以后不需要包含融资新闻。" },
    asst("i-b7", at(0, 9, 14), "好的，已记录。"),
    { kind: "note", id: "i-b8", at: at(0, 9, 14), icon: "memory", text: "记忆已更新 · 不包含融资新闻" },
  ];

  const small = (id: string, a: string, b: string, c: string): Item[] => [
    asst(`${id}-1`, at(1, 20, 0), a),
    { kind: "user", id: `${id}-2`, at: at(1, 20, 2), text: b },
    asst(`${id}-3`, at(1, 20, 3), c),
  ];

  const items: Record<string, Item[]> = {
    hob: hobList,
    page: pageItems,
    bird: birdItems,
    server: [
      ...small(
        "i-s",
        "凌晨清理日志的任务已完成，清理 2.1GB，服务均正常运行。",
        "好的，以后每月清理一次。",
        "已记录：每月 1 号凌晨 3 点清理一次。",
      ),
      { kind: "job", id: "i-s4", at: at(1, 3, 5), jobId: "t-0927" },
    ],
    house: small(
      "i-ho",
      "相册备份已完成，新增 312 张，占用 4.2GB。",
      "硬盘还剩多少？",
      "剩余 1.8TB，可用约半年。",
    ),
    coin: small(
      "i-c",
      "10 月账单已整理完成，比上月减少 12%。",
      "哪一类支出较多？",
      "餐饮和打车，比上月增加 800。",
    ),
    book: small("i-bk", "本周读书笔记已整理完成，共三条。", "发给我看看。", "已放入文件中。"),
    leaf: small("i-lf", "本周三次训练已记录。", "下周增加到四次。", "好的，下周安排四次。"),
  };

  if (scene === "bubbles" || scene === "bubbles-dark") {
    items.hob = [
      { kind: "user", id: "bubble-user", at: minsAgo(3), text: "给我看看公式、代码和媒体。" },
      asst("bubble-text", minsAgo(2), "行内公式 $E=mc^2$，整行公式：\n\n$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$\n\n```js\nconst answer = 42;\n```\n\n```sh\necho hello\n```\n\n价格是 $5 和 $10。"),
      { kind: "file", id: "bubble-audio", at: minsAgo(1), path: "/mock/audio.mp3", name: "语音样本.mp3" },
      { kind: "file", id: "bubble-video", at: minsAgo(1), path: "/mock/video.mp4", name: "视频样本.mp4" },
      { kind: "user", id: "bubble-user-2", at: minsAgo(1), text: "画个简单的表格给我，有几种方式？" },
      asst("bubble-table", minsAgo(0), "主要有四种：\n\n| 方式 | 适合什么情况 | 能不能改 |\n| --- | --- | --- |\n| 聊天里直接画 | 简单的表，看一眼就行 | 让我重画 |\n| 发 Excel 或 CSV 文件 | 要下载、自己改或者算 | 能 |\n| 做成页面 | 能排序、筛选，以后还要更新 | 能 |\n| 做成图片 | 要转发给别人或者发朋友圈 | 不能 |\n\n想要哪种？告诉我放什么内容。"),
    ];
  }

  const delegations: Record<string, Delegation> = {};
  const jobs: Record<string, Job> = { "t-0931": jobRunning, "t-0927": jobDone, "t-0929": jobBackup };
  if (scene.startsWith("d-")) {
    const status = scene === "d-waiting" || scene === "d-mobile" ? "waiting" : scene === "d-done" ? "done" : "running";
    const delegation: Delegation = { id: "dg-demo", from: "hob", to: "server", text: "检查服务器磁盘和服务状态，清理前先确认，不要影响正在运行的服务。", createdAt: minsAgo(6), status, jobIds: ["t-delegated"], approvalIds: [] };
    delegations[delegation.id] = delegation;
    jobs["t-delegated"] = { ...jobRunning, id: "t-delegated", assistantId: "server", delegationId: delegation.id, title: "检查服务器状态", status: status === "waiting" ? "waiting" : status };
    if (status === "waiting") approvals["ap-delegation"] = { id: "ap-delegation", assistantId: "server", title: "清理旧日志吗？", detail: "将清理七天前的日志。", options: [{ key: "A", label: "清理旧日志" }, { key: "B", label: "暂不清理" }], status: "pending", source: "job", jobId: "t-delegated", createdAt: minsAgo(2) };
    items.hob = [{ kind: "user", id: "d-user", at: minsAgo(7), text: "检查一下服务器的磁盘和服务状态。" }, { kind: "delegation", id: "d-card", at: minsAgo(6), delegationId: delegation.id }];
    items.server = [{ kind: "user", id: "d-forward", at: minsAgo(6), text: delegation.text, from: { assistantId: "hob", name: "Hob", delegationId: delegation.id } }, { kind: "job", id: "d-job", at: minsAgo(5), jobId: "t-delegated" }, ...(status === "waiting" ? [{ kind: "question" as const, id: "d-question", at: minsAgo(2), approvalId: "ap-delegation" }] : [])];
  }

  if (scene.startsWith("h-")) {
    const server = assistants.find((assistant) => assistant.id === "server");
    if (server) server.dutyLong = "维护服务器、监控服务状态和磁盘空间；代理配置由其他助手负责。";
    delegations["dg-returned"] = { id: "dg-returned", from: "hob", to: "server", text: "检查代理节点为什么无法连接。", createdAt: minsAgo(4), status: "returned", reply: "退回：代理配置不属于服务器维护职责。", jobIds: [] };
    items.hob = [
      { kind: "user", id: "h-forward", at: minsAgo(8), text: "检查代理节点为什么无法连接。", from: { assistantId: "server", name: "服务器", delegationId: "hb-demo" } },
      { kind: "delegation", id: "h-card", at: minsAgo(4), delegationId: "dg-returned" },
    ];
    items.server = [
      { kind: "user", id: "h-user", at: minsAgo(9), text: "检查代理节点为什么无法连接。" },
      { kind: "note", id: "h-note", at: minsAgo(8), icon: "info", text: "已交回 Hob：代理配置不属于我的职责。", handbackId: "hb-demo" },
      { kind: "user", id: "h-delegation-forward", at: minsAgo(4), text: "检查代理节点为什么无法连接。", from: { assistantId: "hob", name: "Hob", delegationId: "dg-returned" } },
    ];
  }

  if (scene.startsWith("act-")) {
    const hob = assistants.find((a) => a.id === "hob")!;
    hob.busy = true;
    hob.activity = scene === "act-think" || scene === "act-demo" ? { state: "thinking", label: "正在想…" } : { state: "tool", label: "搜索：最新 AI 动态" };
    items.hob = [{ kind: "user", id: "act-user", at: minsAgo(1), text: "帮我搜索最新 AI 动态。" }];
    if (scene === "act-home") assistants.find((a) => a.id === "page")!.busy = true;
  }

  return {
    assistants,
    items,
    jobs,
    delegations,
    approvals,
    drafts: { "d-bird": draft },
    routines,
    rules: {
      hob: [
        { id: "rule-1", text: "花钱", mode: "ask", changedAt: at(10, 9, 0) },
        { id: "rule-2", text: "改线上服务", mode: "ask", changedAt: at(10, 9, 0) },
        { id: "rule-3", text: "清理我的文件", mode: "ask", changedAt: at(3, 9, 0) },
      ],
      page: [
        { id: "rule-4", text: "删除草稿", mode: "ask", changedAt: at(9, 9, 0) },
        { id: "rule-5", text: "花钱", mode: "ask", changedAt: at(9, 9, 0) },
        { id: "rule-6", text: "发公众号", mode: "allow", changedAt: minsAgo(120) },
      ],
      bird: [{ id: "rule-7", text: "花钱订阅", mode: "ask", changedAt: at(7, 9, 0) }],
    },
    worklog: {
      hob: [
        { at: at(0, 10, 5), text: "任务已完成：排查页面卡顿", jobId: "t-0931" },
        { at: at(0, 8, 2), text: "转述写作的审批：发布公众号" },
        { at: at(0, 8, 0), text: "早报：两件事均已完成" },
      ],
      page: [
        { at: at(0, 10, 21), text: "新增定时任务：周报初稿", jobId: "r-weekly-draft" },
        { at: at(0, 7, 44), text: "发布的文章：Grok Bot 能借鉴什么" },
        { at: at(0, 7, 40), text: "完成《Grok Bot 能借鉴什么》，3200 字" },
        { at: at(1, 17, 8), text: "周报初稿修改标题" },
      ],
      bird: [
        { at: at(0, 9, 0), text: "每日简报：今天 6 条", jobId: "t-0926" },
        { at: at(1, 9, 0), text: "每日简报：昨天 5 条", jobId: "t-0925" },
      ],
      server: [{ at: at(1, 3, 5), text: "任务已完成：清理旧日志", jobId: "t-0927" }],
      house: [{ at: at(0, 7, 30), text: "相册备份：新增 312 张" }],
      coin: [{ at: at(1, 21, 10), text: "10 月账单已整理" }],
      book: [],
      leaf: [],
    },
    settings: {
      revision: 1,
      settings: {
        general: {
          theme: scene === "d-dark" || scene === "h-dark" || scene === "act-dark" ? "dark" : "system",
          timezone: "Asia/Tokyo",
          aboutYou: { name: "小林", language: "中文", notes: "" },
        },
        providers: [
          { kind: "builtin", id: "anthropic" },
          {
            kind: "custom",
            id: "my-proxy",
            name: "我的代理",
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:8080/v1",
            models: [{ id: "gpt-x", name: "GPT X", input: ["text", "image"], reasoning: true, contextWindow: 200_000 }],
          },
        ],
        models: {
          roster: [
            { ref: "faux/fast", note: "响应快、成本低，适合日常对话", thinking: "low" },
            { ref: "faux/smart", note: "能力最强但速度较慢，适合复杂问题", thinking: "high" },
            { ref: "faux/vision", note: "支持图像输入，适合截图和图片", thinking: "medium" },
          ],
          conversation: { ref: "faux/fast", thinking: "low" },
          work: { ref: "faux/smart", thinking: "high" },
        },
        image: { source: "off" },
        search: [
          { name: "searxng", enabled: true, baseUrl: "http://127.0.0.1:8888" },
          { name: "exa", enabled: true },
          ...defaultSearch().filter((p) => p.name !== "searxng" && p.name !== "exa"),
        ],
        work: { maxJobs: 2, jobStallMinutes: 15, routerStallMinutes: 6 },
        push: { email: "" },
      },
    },
  };
}

/** 浏览器内假模型名单：界面截图用，不呼叫真模型。 */
const MOCK_MODELS: ModelsView = {
  models: [
    {
      ref: "faux/fast",
      provider: "faux",
      id: "fast",
      name: "Faux Fast",
      reasoning: false,
      thinkingLevels: ["off"],
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 8_192,
      cost: { input: 0.1, output: 0.4 },
    },
    {
      ref: "faux/smart",
      provider: "faux",
      id: "smart",
      name: "Faux Smart",
      reasoning: true,
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      input: ["text"],
      contextWindow: 400_000,
      maxTokens: 32_000,
      cost: { input: 3, output: 15 },
    },
    {
      ref: "faux/vision",
      provider: "faux",
      id: "vision",
      name: "Faux Vision",
      reasoning: true,
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
      input: ["text", "image"],
      contextWindow: 200_000,
      maxTokens: 16_000,
      cost: { input: 2, output: 8 },
    },
    // 两个还没进名单的，用来演示「添加模型」的分组
    {
      ref: "faux/tiny",
      provider: "faux",
      id: "tiny",
      name: "Faux Tiny",
      reasoning: false,
      thinkingLevels: ["off"],
      input: ["text"],
      contextWindow: 64_000,
      maxTokens: 4_096,
      cost: { input: 0.05, output: 0.2 },
    },
    {
      ref: "sample/deep",
      provider: "sample",
      id: "deep",
      name: "Sample Deep",
      reasoning: true,
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      cost: { input: 8, output: 40 },
    },
  ],
  roster: [],
};

/** 假图像生成 Key 状态：演示模式里只看界面。 */
const MOCK_IMAGE_KEY: ImageKeyView = { keyConfigured: true };

/** 演示模式的引擎自带服务商目录。 */
const MOCK_BUILTIN = [
  { id: "anthropic", name: "Anthropic" },
  { id: "openai", name: "OpenAI" },
  { id: "google", name: "Google" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "openrouter", name: "OpenRouter" },
];

/** 演示模式里内置服务商的模型（真数据来自引擎目录，这里只要形状对）。 */
const MOCK_BUILTIN_MODELS: Record<string, { id: string; name: string; reasoning: boolean }[]> = {
  anthropic: [
    { id: "claude-x", name: "Claude X", reasoning: true },
    { id: "claude-x-haiku", name: "Claude X Haiku", reasoning: false },
  ],
  openai: [{ id: "gpt-6-astra", name: "GPT-6 Astra", reasoning: true }],
};

/** 演示模式里一个服务商的模型和思考档：和 Hob 一样按默认规则算，存了自定义就按自定义。 */
function mockThinking(
  provider: ProviderSettings,
  thinking: Record<string, ThinkingLevelMapSetting> | undefined,
): ModelThinkingView[] {
  const models =
    provider.kind === "custom"
      ? provider.models.map((model) => ({
          id: model.id,
          name: model.name?.trim() || model.id,
          reasoning: model.reasoning === true,
        }))
      : (MOCK_BUILTIN_MODELS[provider.id] ?? []);
  return models.map((model) => {
    const ref = `${provider.id}/${model.id}`;
    const custom = thinking?.[ref];
    const plan = thinkingPlan(model.id, model.reasoning, custom, provider.kind === "custom" ? provider.api : undefined);
    return {
      ref,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      levels: plan.levels.map((level) => ({ level, text: plan.chars[level] ?? "" })),
      custom: custom !== undefined,
    };
  });
}

/** 演示模式里的「本机配置」：来源目录和能导入的项。 */
const MOCK_IMPORT_SOURCE = "/Users/me/.pi/agent";
const MOCK_LORE_SOURCE = "/Users/me/.lore";
const MOCK_PROVIDER_IMPORTS: ProviderImportItem[] = [
  { id: "anthropic", kind: "builtin", models: 12, key: "literal", exists: true, selectable: true },
  {
    id: "my-proxy",
    kind: "custom",
    api: "openai-completions",
    baseUrl: "https://proxy.example/v1",
    models: 4,
    key: "literal",
    exists: false,
    selectable: true,
  },
  {
    id: "cmd-proxy",
    kind: "custom",
    api: "anthropic-messages",
    baseUrl: "http://127.0.0.1:8080",
    models: 2,
    key: "command",
    exists: false,
    selectable: true,
    note: "Key 需通过命令获取，请导入后手动填写。",
  },
  {
    id: "work-laptop",
    kind: "builtin",
    models: 6,
    key: "none",
    exists: false,
    selectable: false,
    note: "登录授权类凭据无法导入。",
  },
];
/** 导入时写进设置的服务商（演示模式里只要形状对）。 */
const MOCK_IMPORTED_PROVIDERS: Record<string, ProviderSettings> = {
  anthropic: { kind: "builtin", id: "anthropic" },
  "my-proxy": {
    kind: "custom",
    id: "my-proxy",
    name: "my-proxy",
    api: "openai-completions",
    baseUrl: "https://proxy.example/v1",
    models: [
      { id: "gpt-x", name: "GPT X" },
      { id: "gpt-x-mini" },
    ],
  },
  "cmd-proxy": {
    kind: "custom",
    id: "cmd-proxy",
    name: "cmd-proxy",
    api: "anthropic-messages",
    baseUrl: "http://127.0.0.1:8080",
    models: [{ id: "claude-x" }],
  },
};

/** 假后端：和 realApi 同一套接口，操作真的改内存里的状态并发事件。 */
export function createMock(scene: SceneId = "s1"): HobApi {
  const db = buildDb(scene);
  const listeners = new Set<(ev: HobEvent) => void>();
  const emit = (ev: HobEvent) => listeners.forEach((l) => l(ev));
  const assistant = (id: string) => db.assistants.find((a) => a.id === id);
  /** 模拟模式里的记忆设置：没配 Lore 时缺省本地记忆。 */
  const keys = new Set<string>(["anthropic", "my-proxy"]);
  const providersView = (): ProvidersView => ({
    providers: db.settings.settings.providers.map((provider) => ({ ...provider, keyConfigured: keys.has(provider.id) })),
    builtin: clone(MOCK_BUILTIN),
    settings: clone(db.settings),
    models: Object.fromEntries(
      db.settings.settings.providers.map((provider) => [
        provider.id,
        mockThinking(provider, db.settings.settings.models.thinking),
      ]),
    ),
  });
  const memory: MemoryConfig = {
    revision: db.settings.revision,
    provider: "local",
    providerExplicit: false,
    lore: { configured: false, baseUrl: null, source: "none", tokenConfigured: false },
  };
  /** 模拟模式里已经订阅的设备：看图用的假设备。 */
  const devices: PushView["devices"] = [
    { endpoint: "https://push.example/mock-iphone", label: "iPhone", createdAt: new Date(Date.now() - 3 * 86400_000).toISOString() },
  ];
  const pushView = (): PushView => ({
    publicKey: "BOmockVapidPublicKeyForPreviewOnly",
    email: db.settings.settings.push.email,
    devices: clone(devices),
  });

  /** 模拟模式的任务过程：拿活动流拼一份，只为看界面。 */
  const stepsOf = (job: Job): JobStep[] => {
    const steps: JobStep[] = [];
    job.activity.forEach((line, index) => {
      if (line.verb === "$") return;
      const name = line.verb === "读" ? "read" : line.verb === "跑" ? "bash" : line.verb === "改" ? "edit" : line.verb === "说" ? "report" : "ls";
      steps.push({
        id: `mock-${job.id}-${index}`,
        kind: "tool",
        at: line.at,
        name,
        title: name === "report" ? "提交结果" : `${line.verb} ${line.text}`,
        args:
          name === "bash"
            ? { command: line.text }
            : name === "report"
              ? { outcome: "done", summary: line.text }
              : { path: line.text },
        output: name === "report" ? "结果已记录。" : `${line.text}\n`,
        durationMs: 120,
      });
    });
    if (job.id === "t-0931") steps.push({ id: "mock-search", kind: "tool", at: job.createdAt, name: "web_search", title: "联网搜索：浏览器页面性能优化", args: { query: "浏览器页面性能优化" }, output: "演示结果：网页性能优化指南。", durationMs: 120 });
    return steps;
  };

  function setAssistant(id: string, patch: Partial<AssistantSummary>) {
    const a = assistant(id);
    if (!a) return;
    Object.assign(a, patch);
    emit({ type: "assistant", assistant: clone(a) });
  }

  function pushItem(assistantId: string, item: Item) {
    const list = (db.items[assistantId] ??= []);
    const i = list.findIndex((x) => x.id === item.id);
    if (i >= 0) list[i] = item;
    else list.push(item);
    emit({ type: "item", assistantId, item });
  }

  function touch(assistantId: string, text: string) {
    setAssistant(assistantId, { last: { text, at: new Date().toISOString() } });
  }

  return {
    me: async () => {},
    login: async () => {},
    logout: async () => {},
    bootstrap: async () => ({
      assistants: clone(db.assistants),
      jobs: clone(Object.values(db.jobs)),
      delegations: clone(Object.values(db.delegations)),
      routines: clone(db.routines),
      approvals: clone(Object.values(db.approvals).filter((a) => a.status === "pending")),
      settings: clone(db.settings),
    }),
    settings: async () => clone(db.settings),
    models: async () => ({ ...clone(MOCK_MODELS), roster: clone(db.settings.settings.models.roster) }),
    providers: async () => providersView(),
    putThinking: async (body) => {
      const provider = db.settings.settings.providers.find((item) => body.ref.startsWith(`${item.id}/`));
      const current = provider
        ? mockThinking(provider, db.settings.settings.models.thinking).find((item) => item.ref === body.ref)
        : undefined;
      if (!provider || !current) throw new ApiError(400, `模型 ${body.ref} 不在已配置的服务商里。`);
      const next = { ...(db.settings.settings.models.thinking ?? {}) };
      const levels = body.levels === null ? undefined : normalizeThinkingMap(body.levels);
      if (levels) next[body.ref] = levels;
      else delete next[body.ref];
      db.settings = {
        revision: db.settings.revision + 1,
        settings: {
          ...db.settings.settings,
          models: {
            roster: db.settings.settings.models.roster,
            conversation: db.settings.settings.models.conversation,
            work: db.settings.settings.models.work,
            ...(Object.keys(next).length ? { thinking: next } : {}),
          },
        },
      };
      const thinking = mockThinking(provider, db.settings.settings.models.thinking).find(
        (item) => item.ref === body.ref,
      )!;
      return { settings: clone(db.settings), thinking };
    },
    putProvider: async (id: string, body: unknown) => {
      const input = body as { key?: string } & Record<string, unknown>;
      const next = { ...input, id } as unknown as ProviderSettings;
      delete (next as { key?: string }).key;
      const providers = db.settings.settings.providers.filter((provider) => provider.id !== id);
      db.settings = {
        revision: db.settings.revision + 1,
        settings: { ...db.settings.settings, providers: [...providers, next] },
      };
      if (input.key) keys.add(id);
      return providersView();
    },
    deleteProvider: async (id: string) => {
      db.settings = {
        revision: db.settings.revision + 1,
        settings: {
          ...db.settings.settings,
          providers: db.settings.settings.providers.filter((provider) => provider.id !== id),
        },
      };
      keys.delete(id);
      return providersView();
    },
    discoverProvider: async () => ({
      models: [
        { id: "gpt-x", name: "GPT X" },
        { id: "gpt-x-mini", name: "GPT X mini" },
        { id: "gpt-x-vision" },
      ],
    }),
    providersImport: async () => ({
      source: MOCK_IMPORT_SOURCE,
      items: MOCK_PROVIDER_IMPORTS.map((item) => ({
        ...item,
        exists:
          item.exists || db.settings.settings.providers.some((provider) => provider.id === item.id),
      })),
    }),
    importProviders: async (ids: string[]) => {
      const picked = ids
        .map((id) => MOCK_IMPORTED_PROVIDERS[id])
        .filter((provider): provider is ProviderSettings => provider !== undefined);
      if (!picked.length) throw new ApiError(400, "没有可导入的服务商：请选择状态为可导入的项目。");
      const providers = db.settings.settings.providers.filter(
        (provider) => !picked.some((item) => item.id === provider.id),
      );
      db.settings = {
        revision: db.settings.revision + 1,
        settings: { ...db.settings.settings, providers: [...providers, ...picked] },
      };
      for (const provider of picked) keys.add(provider.id);
      return providersView();
    },
    testProvider: async () => undefined,
    imageKey: async () => clone(MOCK_IMAGE_KEY),
    putImage: async (revision: number, image: ImageSettings, apiKey?: string) => {
      if (revision !== db.settings.revision) throw new ApiError(409, "设置已在别处修改，已刷新");
      db.settings = { revision: db.settings.revision + 1, settings: { ...db.settings.settings, image } };
      return { settings: clone(db.settings), keyConfigured: Boolean(apiKey) || MOCK_IMAGE_KEY.keyConfigured };
    },
    skills: async () => {
      const off = db.settings.settings.skills?.disabled ?? [];
      const skill = (id: string, source: "hob" | "common" | "lore", description: string, content: string, overridden = false) =>
        ({ id, name: id, description, source, content, enabled: !off.includes(`${source}:${id}`), overridden });
      return { skills: [
        skill("weekly-report", "hob", "按固定结构整理本周进展、风险和下周计划，生成可直接发出的周报。", "# 周报\n\n1. 汇总本周完成的事项\n2. 列出风险和需要的支持\n3. 写下周计划"),
        skill("research", "hob", "查阅可靠来源，交叉核对后整理结论，并为每条结论注明出处。", "# 研究\n\n查阅可靠来源，整理结论并注明出处。"),
        skill("server-checkup", "hob", "检查主机的磁盘、内存、服务状态和最近的错误日志，给出处理建议。", "# 主机巡检\n\n逐台检查磁盘、内存、服务与日志。"),
        skill("browser", "common", "在浏览器中打开页面、操作并截图，验证改动是否生效。", "# 浏览器\n\n通过浏览器检查和验证页面。"),
        skill("pdf", "common", "读取、拆分、合并 PDF，提取其中的表格和文字。", "# PDF\n\n处理 PDF 文件。"),
        skill("research", "common", "通用的资料检索流程。", "# research", true),
      ], loreActive: false, loreUrl: null };
    },
    skillsImport: async () => ({ found: true, skipped: [], skills: [{ id: "review", name: "review", description: "检查代码与需求。", exists: false }, { id: "research", name: "research", description: "整理研究结果。", exists: true }] }),
    importSkills: async (_source, ids) => ({ imported: ids, skipped: [], errors: [] }),
    deleteSkill: async () => {},
    search: async () => ({ providers: db.settings.settings.search.map((p) => ({ ...p, keyConfigured: p.name === "exa" || p.name === "tavily" })) }),
    putSearch: async (revision, providers) => {
      if (revision !== db.settings.revision) throw new ApiError(409, "设置已在别处修改，已刷新");
      db.settings = { revision: revision + 1, settings: { ...db.settings.settings, search: providers } };
      return clone(db.settings);
    },
    testSearch: async () => ({ ok: false, error: "演示模式不连接搜索服务商。" }),
    imageTest: async (): Promise<ImageTestResult> => ({
      ok: false,
      error: "演示模式不连接图像生成接口；正式运行时会实际生成图片。",
    }),
    putSettings: async (revision, patch) => {
      if (revision !== db.settings.revision) throw new ApiError(409, "设置已在别处修改，已刷新");
      const models = patch.models ?? {};
      db.settings = {
        revision: db.settings.revision + 1,
        settings: {
          general: {
            ...db.settings.settings.general,
            ...(patch.general ?? {}),
            aboutYou: { ...db.settings.settings.general.aboutYou, ...(patch.general?.aboutYou ?? {}) },
          },
          models: {
            roster: models.roster ?? db.settings.settings.models.roster,
            conversation: models.conversation ?? db.settings.settings.models.conversation,
            work: models.work ?? db.settings.settings.models.work,
            thinkingChoice: models.thinkingChoice ?? db.settings.settings.models.thinkingChoice,
            ...(models.thinking ?? db.settings.settings.models.thinking
              ? { thinking: models.thinking ?? db.settings.settings.models.thinking }
              : {}),
          },
          providers: db.settings.settings.providers,
          image: db.settings.settings.image,
          search: db.settings.settings.search,
          skills: patch.skills ?? db.settings.settings.skills,
          work: { ...db.settings.settings.work, ...(patch.work ?? {}) },
          push: { ...db.settings.settings.push, ...(patch.push ?? {}) },
        },
      };
      return clone(db.settings);
    },
    changePassword: async (old) => {
      if (old !== "test") throw new ApiError(403, "旧密码不正确");
    },
    about: async () => ({
      version: "0.1.0",
      home: "/var/lib/hob",
    }),
    memory: async () => clone({ ...memory, revision: db.settings.revision }),
    putMemory: async (revision, provider: MemoryProvider) => {
      if (revision !== db.settings.revision) throw new ApiError(409, "设置已在别处修改，已刷新");
      if (provider === "lore" && !memory.lore.configured) {
        throw new ApiError(400, "Lore 尚未配置：请先填写服务地址和 Token 并测试连接");
      }
      memory.provider = provider;
      memory.providerExplicit = true;
      db.settings.revision += 1;
      memory.revision = db.settings.revision;
      return clone(memory);
    },
    putLore: async (body) => {
      const baseUrl = body.baseUrl.trim().replace(/\/+$/, "");
      if (!baseUrl) throw new ApiError(400, "Lore 服务地址不能为空");
      const sameBase = memory.lore.baseUrl === baseUrl;
      memory.lore = {
        configured: sameBase ? memory.lore.tokenConfigured : Boolean(body.token),
        baseUrl,
        source: "config",
        tokenConfigured: sameBase ? memory.lore.tokenConfigured : Boolean(body.token),
      };
      return clone({ ...memory, revision: db.settings.revision });
    },
    loreTest: async (body): Promise<LoreTestResult> => {
      const baseUrl = (body.baseUrl ?? memory.lore.baseUrl ?? "").trim().replace(/\/+$/, "");
      if (!baseUrl) return { ok: false, reason: "invalid_url" };
      if (baseUrl.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1|192\.168\.|10\.)/.test(baseUrl)) {
        return { ok: false, reason: "insecure_http" };
      }
      if (!body.token && !memory.lore.tokenConfigured) return { ok: false, reason: "missing_token" };
      return { ok: true, baseUrl };
    },
    loreImport: async () => ({
      source: MOCK_LORE_SOURCE,
      found: true,
      baseUrl: "https://api.loremem.com",
      tokenPresent: true,
    }),
    importLore: async () => {
      memory.lore = {
        configured: true,
        baseUrl: "https://api.loremem.com",
        source: "config",
        tokenConfigured: true,
      };
      return clone({ ...memory, revision: db.settings.revision });
    },
    items: async (assistantId) => ({
      items: clone(db.items[assistantId] ?? []),
      approvals: clone(Object.values(db.approvals)),
      jobs: clone(Object.values(db.jobs)),
      drafts: clone(Object.values(db.drafts)),
      delegations: clone(Object.values(db.delegations)),
      hasMore: false,
    }),
    profile: async (assistantId) => {
      const a = assistant(assistantId);
      if (!a) throw new Error(`没有这个助手：${assistantId}`);
      const p: Profile = {
        assistant: clone(a),
        rules: clone(db.rules[assistantId] ?? []),
        routines: clone(db.routines.filter((r) => r.assistantId === assistantId)),
        worklog: clone(db.worklog[assistantId] ?? []),
      };
      return p;
    },
    sendMessage: async (assistantId, body) => {
      const time = new Date().toISOString();
      const item: Item = {
        kind: "user",
        id: uid("mock-u"),
        at: time,
        text: body.text,
        quote: body.quote,
        files: body.files && body.files.length ? body.files : undefined,
      };
      pushItem(assistantId, item);
      touch(assistantId, body.text);
      setAssistant(assistantId, { busy: true });
      setTimeout(() => {
        pushItem(assistantId, {
          kind: "assistant",
          id: uid("mock-a"),
          at: new Date().toISOString(),
          text: "收到。",
        });
        touch(assistantId, "收到。");
        setAssistant(assistantId, { busy: false });
      }, 320);
      return { item };
    },
    stopAssistant: async (assistantId) => setAssistant(assistantId, { busy: false }),
    markRead: async (assistantId) => setAssistant(assistantId, { unread: 0 }),
    patchAssistant: async (assistantId, patch) => {
      if (!assistant(assistantId)) throw new ApiError(404, "助手不存在。");
      if (patch.rule) {
        const rules = (db.rules[assistantId] ??= []);
        const existing = patch.rule.id === undefined ? undefined : rules.find((item) => item.id === patch.rule!.id);
        if (patch.rule.id !== undefined && !existing) throw new ApiError(404, "规则不存在。");
        const text = patch.rule.text === undefined ? existing?.text ?? "" : patch.rule.text.trim();
        if (!text || text.length > 1000) throw new ApiError(400, "规则内容不能为空或超过 1000 字。");
        if (rules.some((item) => item.id !== patch.rule!.id && item.text === text)) throw new ApiError(400, "规则内容已存在。");
        const mode = patch.rule.mode ?? existing?.mode;
        if (mode !== "ask" && mode !== "allow") throw new ApiError(400, "规则模式无效。");
        const rule: Rule = { id: existing?.id ?? uid("r-"), text, mode, changedAt: new Date().toISOString() };
        if (existing) Object.assign(existing, rule);
        else rules.push(rule);
        emit({ type: "profile", assistantId });
        return { rule: clone(rule) };
      }
      setAssistant(assistantId, patch);
    },
    mergeAssistant: async (assistantId) => {
      const target = assistant(assistantId);
      const primary = db.assistants.find((a) => a.primary);
      if (!target) throw new ApiError(404, "助手不存在");
      if (target.primary || !primary) throw new ApiError(400, "主助手不能并回自己");
      const live = Object.values(db.jobs).filter(
        (job) => job.assistantId === assistantId && (job.status === "running" || job.status === "queued" || job.status === "waiting"),
      );
      if (live.length) throw new ApiError(409, "请等任务结束后再并回");

      const moved = db.routines.filter((r) => r.assistantId === assistantId);
      for (const routine of moved) {
        routine.assistantId = primary.id;
        emit({ type: "routine", routine: clone(routine) });
      }
      const rules = (db.rules[primary.id] ??= []);
      let added = 0;
      for (const rule of db.rules[assistantId] ?? []) {
        if (rules.some((item) => item.text === rule.text)) continue;
        rules.push({ ...rule, id: uid("rule") });
        added += 1;
      }
      db.rules[assistantId] = [];
      const extra = target.instructions.trim();
      if (extra) {
        primary.instructions = [primary.instructions.trim(), `来自「${target.name}」：`, extra].filter(Boolean).join("\n");
        emit({ type: "assistant", assistant: clone(primary) });
      }
      pushItem(primary.id, {
        kind: "note",
        id: uid("mock-n"),
        at: new Date().toISOString(),
        icon: "split",
        text: `已并回「${target.name}」：转来 ${moved.length} 个定时任务、${added} 条规则`,
      });
      db.assistants = db.assistants.filter((a) => a.id !== assistantId);
      emit({ type: "assistant_removed", id: assistantId });
      emit({ type: "profile", assistantId: primary.id });
    },
    deleteRule: async (assistantId, ruleId) => {
      db.rules[assistantId] = (db.rules[assistantId] ?? []).filter((r) => r.id !== ruleId);
      emit({ type: "profile", assistantId });
    },
    answerApproval: async (approvalId, answer) => {
      const ap = db.approvals[approvalId];
      if (!ap || ap.status === "answered") return;
      ap.status = "answered";
      if (answer.key) ap.chosen = answer.key;
      else ap.answerText = (answer.text ?? "").trim();
      ap.answeredAt = new Date().toISOString();
      const option = ap.options.find((o) => o.key === answer.key);
      if (option?.always && ap.ruleText) {
        const rules = (db.rules[ap.assistantId] ??= []);
        rules.push({ id: uid("rule"), text: ap.ruleText, mode: "allow", changedAt: ap.answeredAt });
        pushItem(ap.assistantId, {
          kind: "note",
          id: uid("mock-n"),
          at: ap.answeredAt,
          icon: "rule",
          text: `已记入${assistant(ap.assistantId)?.name ?? ""}的规则 · ${ap.ruleText}无需确认`,
        });
        emit({ type: "profile", assistantId: ap.assistantId });
      }
      emit({ type: "approval", approval: clone(ap) });
      for (const delegation of Object.values(db.delegations)) {
        if ((delegation.approvalIds ?? []).includes(ap.id) || (ap.jobId && delegation.jobIds.includes(ap.jobId))) {
          delegation.status = "running";
          if (ap.jobId && db.jobs[ap.jobId]?.status === "waiting") {
            db.jobs[ap.jobId].status = "running";
            emit({ type: "job", job: clone(db.jobs[ap.jobId]) });
          }
          emit({ type: "delegation", delegation: clone(delegation) });
        }
      }
    },
    retryDelegation: async (id) => {
      const original = db.delegations[id];
      if (!original || original.status !== "interrupted") throw new ApiError(400, "只有已中断的委派可以重新转交");
      const next: Delegation = { ...original, id: uid("dg-"), status: "running", createdAt: new Date().toISOString(), jobIds: [], approvalIds: [], reportedAt: undefined, endedAt: undefined };
      db.delegations[next.id] = next;
      emit({ type: "delegation", delegation: clone(next) });
      pushItem("hob", { kind: "delegation", id: uid("item-"), at: next.createdAt, delegationId: next.id });
      pushItem(next.to, { kind: "user", id: uid("item-"), at: next.createdAt, text: next.text, from: { assistantId: "hob", name: "Hob", delegationId: next.id } });
    },
    createDraft: async (draftId) => {
      const d = db.drafts[draftId];
      if (!d) return;
      d.status = "created";
      d.createdAssistantId = "bird";
      emit({ type: "draft", draft: clone(d) });
      pushItem(d.assistantId, {
        kind: "note",
        id: uid("mock-n"),
        at: new Date().toISOString(),
        icon: "split",
        text: `专属助手已创建 · ${d.name}`,
      });
    },
    dismissDraft: async (draftId) => {
      const d = db.drafts[draftId];
      if (!d) return;
      d.status = "dismissed";
      emit({ type: "draft", draft: clone(d) });
    },
    createRoutine: async (body) => {
      const r: Routine = {
        ...body,
        id: uid("r"),
        createdAt: new Date().toISOString(),
        runs: [],
      };
      db.routines.push(r);
      emit({ type: "routine", routine: clone(r) });
      return clone(r);
    },
    patchRoutine: async (routineId, patch) => {
      const r = db.routines.find((x) => x.id === routineId);
      if (!r) return;
      Object.assign(r, patch);
      emit({ type: "routine", routine: clone(r) });
    },
    deleteRoutine: async (routineId) => {
      db.routines = db.routines.filter((r) => r.id !== routineId);
      emit({ type: "routine_removed", id: routineId });
    },
    runRoutine: async (routineId) => {
      const r = db.routines.find((x) => x.id === routineId);
      if (!r) return;
      const time = new Date().toISOString();
      const job: Job = {
        id: uid("t-"),
        assistantId: r.assistantId,
        title: `${r.name}（立即运行）`,
        instruction: r.instruction,
        status: "running",
        createdAt: time,
        startedAt: time,
        stats: { reads: 0, commands: 0, edits: 0 },
        routineId: r.id,
        activity: [{ at: time, verb: "$", text: `立即运行 ${r.name}` }],
      };
      db.jobs[job.id] = job;
      const run: RoutineRun = { jobId: job.id, at: time, status: "running" };
      r.runs = [run, ...r.runs].slice(0, 20);
      pushItem(r.assistantId, { kind: "job", id: uid("mock-j"), at: time, jobId: job.id });
      emit({ type: "job", job: clone(job) });
      emit({ type: "routine", routine: clone(r) });
      touch(r.assistantId, `运行定时任务：${r.name}`);
    },
    replyJob: async (jobId, text) => {
      const job = db.jobs[jobId];
      if (!job) return;
      job.activity = [...job.activity, { at: new Date().toISOString(), verb: "说", text }];
      emit({ type: "activity", jobId, line: job.activity[job.activity.length - 1], stats: clone(job.stats) });
    },
    transcript: async (jobId) => {
      const job = db.jobs[jobId];
      if (!job) throw new Error(`没有这个任务：${jobId}`);
      return { job: clone(job), steps: stepsOf(job) };
    },
    jobs: async (query = {}) => {
      let list = Object.values(db.jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (query.assistantId) list = list.filter((job) => job.assistantId === query.assistantId);
      if (query.status) list = list.filter((job) => job.status === query.status);
      if (query.before) {
        const index = list.findIndex((job) => job.id === query.before);
        if (index !== -1) list = list.slice(index + 1);
      }
      const limit = query.limit ?? 30;
      const page: JobsPage = { jobs: clone(list.slice(0, limit)), hasMore: list.length > limit };
      return page;
    },
    stopJob: async (jobId) => {
      const job = db.jobs[jobId];
      if (!job) return;
      job.status = "stopped";
      job.endedAt = new Date().toISOString();
      emit({ type: "job", job: clone(job) });
    },
    upload: async (file) => `mock://uploads/${encodeURIComponent(file.name)}`,
    fileUrl: (path, opts) =>
      path.startsWith("/mock/") ? path : `data:text/plain;charset=utf-8,${encodeURIComponent(`mock 模式没有真实文件。\n\n${path}`)}`,
    fileMeta: async (path) => {
      const name = path.split("/").pop() ?? path;
      const dot = name.lastIndexOf(".");
      const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
      const kind: FileMeta["kind"] =
        ext === ".md" ? "markdown" : ext === ".csv" ? "csv" : ext === ".html" ? "html" : ext === ".json" ? "json" : "text";
      return {
        path,
        name,
        size: 2048,
        modifiedAt: new Date().toISOString(),
        mime: "text/plain; charset=utf-8",
        kind,
        text: true,
      };
    },
    jobFiles: async (jobId) => {
      const job = db.jobs[jobId];
      if (!job) throw new ApiError(404, "任务不存在");
      return { files: [], hasMore: false };
    },
    push: async () => pushView(),
    subscribePush: async (subscription: PushSubscriptionJson, label: string) => {
      const rest = devices.filter((device) => device.endpoint !== subscription.endpoint);
      devices.splice(0, devices.length, ...rest, {
        endpoint: subscription.endpoint,
        label: label.trim() || "本机",
        createdAt: new Date().toISOString(),
      });
      return pushView();
    },
    unsubscribePush: async (endpoint: string) => {
      const i = devices.findIndex((device) => device.endpoint === endpoint);
      if (i >= 0) devices.splice(i, 1);
      return pushView();
    },
    testPush: async () => ({ sent: 1, removed: 0 }),
    visibility: async () => {},
    events: (handlers) => {
      listeners.add(handlers.onEvent);
      const timers: ReturnType<typeof setTimeout>[] = [];
      if (scene === "act-demo") {
        timers.push(setTimeout(() => emit({ type: "router-activity", assistantId: "hob", activity: { state: "tool", label: "搜索：最新 AI 动态" } }), 2500));
        timers.push(setTimeout(() => {
          emit({ type: "router-activity", assistantId: "hob", activity: null });
          emit({ type: "item", assistantId: "hob", item: { kind: "assistant", id: "act-answer", at: new Date().toISOString(), text: "正在整理搜索结果…", streaming: true } });
        }, 5500));
        timers.push(setTimeout(() => {
          emit({ type: "item", assistantId: "hob", item: { kind: "assistant", id: "act-answer", at: new Date().toISOString(), text: "已整理好最新动态。" } });
          emit({ type: "assistant", assistant: { ...db.assistants.find((a) => a.id === "hob")!, busy: false, activity: null } });
        }, 7500));
      }
      return () => {
        timers.forEach(clearTimeout);
        listeners.delete(handlers.onEvent);
      };
    },
  };
}
