import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HobRuntime } from "../src/runtime.ts";
import { nowBlock } from "../src/now.ts";
import { assistantTopicTodosPath, groupTodosPath } from "../src/config.ts";
import { writeTodos } from "../src/todos.ts";

describe("现在", () => {
  it("按助手、状态和时间过滤，并格式化各行", () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-11-04T09:07:00Z"));
    try {
      const jobs = [
        { id: "t-run", assistantId: "hob", title: "统计用量", status: "running", startedAt: "2026-11-04T09:04:00Z" },
        { id: "t-new", assistantId: "hob", title: "刚开始", status: "running", startedAt: "2026-11-04T09:06:30Z" },
        { id: "t-queue", assistantId: "hob", title: "查磁盘", status: "queued" },
        { id: "t-wait", assistantId: "hob", title: "清理日志", status: "waiting" },
        { id: "t-done", assistantId: "hob", title: "读回 CSV 数字", status: "done", endedAt: "2026-11-04T08:58:00Z" },
        { id: "t-stuck", assistantId: "hob", title: "每人明细页", status: "stuck", endedAt: "2026-11-04T09:05:00Z" },
        { id: "t-long", assistantId: "hob", title: "一二三四五六七八九十一二三四五六七八九十一", status: "failed", endedAt: "2026-11-04T09:00:00Z" },
        { id: "t-old", assistantId: "hob", title: "旧", status: "done", endedAt: "2026-11-03T09:06:59Z" },
        { id: "t-routine", assistantId: "hob", title: "定时", status: "done", endedAt: "2026-11-04T09:06:00Z", routineId: "r" },
        { id: "t-other", assistantId: "other", title: "别人的", status: "running" },
      ];
      const store = {
        jobs: () => jobs,
        delegations: () => [{ from: "hob", to: "writer", status: "running", text: "整理周报素材", createdAt: "2026-11-04T03:20:00Z" }],
        approvals: () => [{ assistantId: "hob", status: "pending", title: "发到公众号吗？" }, { assistantId: "other", status: "pending", title: "别人的问题" }],
        assistant: () => ({ name: "写作" }),
      };
      const runtime = { store, home: "/tmp/hob-now-empty", settings: { settings: { general: { timezone: "Asia/Shanghai" } } } } as unknown as HobRuntime;
      expect(nowBlock(runtime, "hob")).toBe([
        "【现在】2026-11-04 17:07 周三",
        "进行中：t-run「统计用量」，运行 3 分钟；t-new「刚开始」，刚开始；t-queue「查磁盘」，排队中；t-wait「清理日志」，等你回复",
        "转交中：写作「整理周报素材」，11:20 起",
        "等用户选：发到公众号吗？",
        "最近结束：t-stuck「每人明细页」17:05 受阻；t-long「一二三四五六七八九十一二三四五六七八九十…」17:00 失败；t-done「读回 CSV 数字」16:58 已完成",
      ].join("\n"));
      expect(nowBlock(runtime, "other")).toBe("【现在】2026-11-04 17:07 周三\n进行中：t-other「别人的」，刚开始\n等用户选：别人的问题");
      expect(nowBlock(runtime, "empty")).toBe("【现在】2026-11-04 17:07 周三");
      jobs.push(...Array.from({ length: 6 }, (_, i) => ({ id: `t-extra${i}`, assistantId: "hob", title: "结束", status: i === 5 ? "stopped" : "done", endedAt: `2026-11-04T09:0${i}:30Z` })));
      const recent = nowBlock(runtime, "hob").split("\n").find((line) => line.startsWith("最近结束："))!;
      expect(recent.split("；")).toHaveLength(5);
      expect(recent).toContain("t-extra5「结束」17:05 已停止");
      expect(recent).not.toContain("t-done");
    } finally { vi.useRealTimers(); }
  });

  it("自己的只列这个会话的，别处的写明出处", () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-11-04T09:07:00Z"));
    try {
      const groups: Record<string, { id: string; name: string; parentId?: string }> = {
        "g-a": { id: "g-a", name: "团队" },
        "g-a1": { id: "g-a1", name: "相册", parentId: "g-a" },
        "g-a2": { id: "g-a2", name: "打印机", parentId: "g-a" },
        "g-b": { id: "g-b", name: "别的团队" },
        "g-b1": { id: "g-b1", name: "服务器", parentId: "g-b" },
      };
      const jobs = [
        { id: "t-g", assistantId: "hob", title: "综合里的", status: "running", startedAt: "2026-11-04T09:04:00Z", groupId: "g-a" },
        { id: "t-topic", assistantId: "hob", title: "话题里的", status: "queued", groupId: "g-a1" },
        { id: "t-sibling", assistantId: "hob", title: "别的话题", status: "running", startedAt: "2026-11-04T09:04:00Z", groupId: "g-a2" },
        { id: "t-other", assistantId: "hob", title: "别的群", status: "running", startedAt: "2026-11-04T09:04:00Z", groupId: "g-b" },
        { id: "t-othertopic", assistantId: "hob", title: "别的群的话题", status: "waiting", groupId: "g-b1" },
        { id: "t-dm", assistantId: "hob", title: "单聊的", status: "running", startedAt: "2026-11-04T09:04:00Z" },
        { id: "t-done", assistantId: "hob", title: "结束的", status: "done", endedAt: "2026-11-04T09:05:00Z", groupId: "g-a" },
        { id: "t-done-else", assistantId: "hob", title: "别处结束的", status: "done", endedAt: "2026-11-04T09:05:00Z", groupId: "g-a2" },
      ];
      const approvals = [
        { assistantId: "hob", status: "pending", source: "router", title: "综合里的问题", groupId: "g-a" },
        { assistantId: "hob", status: "pending", source: "router", title: "话题里的问题", groupId: "g-a2" },
        { assistantId: "hob", status: "pending", source: "router", title: "单聊里的问题" },
        { assistantId: "hob", status: "pending", source: "job", title: "任务里的问题" },
      ];
      const root = (id: string) => groups[id]?.parentId ?? groups[id]?.id;
      const store = { jobs: () => jobs, group: (id: string) => groups[id], groupMatches: (filter: string, id?: string) => !!id && !!root(id) && root(filter) === root(id), delegations: () => [], approvals: () => approvals, assistant: () => ({ name: "写作" }) };
      const runtime = { store, home: "/tmp/hob-now-empty", settings: { settings: { general: { timezone: "Asia/Shanghai" } } } } as unknown as HobRuntime;
      // 综合：看综合 + 本群所有话题；单聊和别的群里的不列
      expect(nowBlock(runtime, "hob", { groupId: "g-a" })).toBe([
        "【现在】2026-11-04 17:07 周三",
        "进行中：t-g「综合里的」，运行 3 分钟",
        "等用户选：综合里的问题",
        "最近结束：t-done「结束的」17:05 已完成",
        "别处进行中：话题「相册」里 t-topic「话题里的」，排队中；话题「打印机」里 t-sibling「别的话题」，运行 3 分钟",
        "别处等用户选：话题「打印机」里「话题里的问题」",
      ].join("\n"));
      // 群话题：只列这个话题的，不列综合和别的话题
      expect(nowBlock(runtime, "hob", { groupId: "g-a1" })).toBe([
        "【现在】2026-11-04 17:07 周三",
        "进行中：t-topic「话题里的」，排队中",
      ].join("\n"));
      // 单聊：自己只列单聊的，别处是它自己所在的所有群和话题
      expect(nowBlock(runtime, "hob")).toBe([
        "【现在】2026-11-04 17:07 周三",
        "进行中：t-dm「单聊的」，运行 3 分钟",
        "等用户选：单聊里的问题",
        "别处进行中：群「团队」里 t-g「综合里的」，运行 3 分钟；群「团队」的话题「相册」里 t-topic「话题里的」，排队中；群「团队」的话题「打印机」里 t-sibling「别的话题」，运行 3 分钟；群「别的团队」里 t-other「别的群」，运行 3 分钟；群「别的团队」的话题「服务器」里 t-othertopic「别的群的话题」，等你回复",
        "别处等用户选：群「团队」里「综合里的问题」；群「团队」的话题「打印机」里「话题里的问题」",
      ].join("\n"));
    } finally { vi.useRealTimers(); }
  });

  it("群会话列出本群所有成员的任务（进行中、别处进行中、最近结束），派发者、执行成员和第三方都能看到，单聊不出现别的助手的任务", () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-11-04T09:07:00Z"));
    try {
      const groups: Record<string, { id: string; name: string; parentId?: string }> = {
        "g-team": { id: "g-team", name: "活动筹备组" },
        "g-t1": { id: "g-t1", name: "活动报名表整理", parentId: "g-team" },
        "g-t2": { id: "g-t2", name: "场地布置", parentId: "g-team" },
        "g-other": { id: "g-other", name: "别的群" },
      };
      const names: Record<string, string> = { po: "统筹", dev: "整理员", qa: "复核员" };
      const jobs = [
        { id: "t-dev", assistantId: "dev", assistantName: "整理员", startedBy: "po", title: "汇总报名表", status: "running", startedAt: "2026-11-04T09:04:00Z", groupId: "g-team" },
        { id: "t-qa", assistantId: "qa", assistantName: "复核员", title: "核对名单", status: "done", endedAt: "2026-11-04T09:05:00Z", groupId: "g-team" },
        { id: "t-topic", assistantId: "dev", assistantName: "整理员", startedBy: "po", title: "去重报名数据", status: "running", startedAt: "2026-11-04T09:02:00Z", groupId: "g-t1" },
        { id: "t-t2", assistantId: "qa", assistantName: "复核员", title: "画座位图", status: "queued", groupId: "g-t2" },
        { id: "t-other-group", assistantId: "dev", assistantName: "整理员", title: "别群任务", status: "running", startedAt: "2026-11-04T09:04:00Z", groupId: "g-other" },
      ];
      const root = (id: string) => groups[id]?.parentId ?? groups[id]?.id;
      const store = {
        jobs: () => jobs,
        group: (id: string) => groups[id],
        groups: () => Object.values(groups),
        groupMatches: (filter: string, id?: string) => !!id && !!root(id) && root(filter) === root(id),
        delegations: () => [],
        approvals: () => [],
        assistant: (id: string) => ({ id, name: names[id] ?? id }),
      };
      const runtime = { store, home: "/tmp/hob-now-empty", settings: { settings: { general: { timezone: "Asia/Shanghai" } } } } as unknown as HobRuntime;

      // 综合里（群主 po）：看到所有成员在综合和各话题的任务，带成员名、话题名、任务 id，不含别的群
      expect(nowBlock(runtime, "po", { groupId: "g-team" })).toBe([
        "【现在】2026-11-04 17:07 周三",
        "进行中：t-dev「汇总报名表」（整理员），运行 3 分钟",
        "最近结束：t-qa「核对名单」（复核员）17:05 已完成",
        "别处进行中：话题「活动报名表整理」里 t-topic「去重报名数据」（整理员），运行 5 分钟；话题「场地布置」里 t-t2「画座位图」（复核员），排队中",
      ].join("\n"));

      // 综合里（执行成员 dev）：自己执行的任务不重复标自己名字，其他成员的标成员名
      expect(nowBlock(runtime, "dev", { groupId: "g-team" })).toBe([
        "【现在】2026-11-04 17:07 周三",
        "进行中：t-dev「汇总报名表」，运行 3 分钟",
        "最近结束：t-qa「核对名单」（复核员）17:05 已完成",
        "别处进行中：话题「活动报名表整理」里 t-topic「去重报名数据」，运行 5 分钟；话题「场地布置」里 t-t2「画座位图」（复核员），排队中",
      ].join("\n"));

      // 群话题 g-t1（执行成员 dev 与群主 po）：只列这个话题的，不出现综合、g-t2 或别的群
      expect(nowBlock(runtime, "dev", { groupId: "g-t1" })).toBe([
        "【现在】2026-11-04 17:07 周三",
        "进行中：t-topic「去重报名数据」，运行 5 分钟",
      ].join("\n"));
      expect(nowBlock(runtime, "po", { groupId: "g-t1" })).toBe([
        "【现在】2026-11-04 17:07 周三",
        "进行中：t-topic「去重报名数据」（整理员），运行 5 分钟",
      ].join("\n"));

      // 单聊（po）：不出现别的助手的任务（哪怕是 po 在群里派给 dev 执行的）
      expect(nowBlock(runtime, "po")).toBe("【现在】2026-11-04 17:07 周三");
    } finally { vi.useRealTimers(); }
  });

  it("排队中带前置依赖写明等谁，群里其他成员的 waiting 任务写等责任人回复", () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-11-04T09:07:00Z"));
    try {
      const groups: Record<string, { id: string; name: string; parentId?: string }> = {
        "g-team": { id: "g-team", name: "研发组" },
      };
      const names: Record<string, string> = { lead: "负责人", dev: "开发", qa: "测试" };
      const jobs = [
        { id: "t-1", assistantId: "dev", assistantName: "开发", title: "打包构建", status: "running", startedAt: "2026-11-04T09:05:00Z", groupId: "g-team" },
        { id: "t-2", assistantId: "qa", assistantName: "测试", title: "跑回归", status: "queued", after: ["t-1"], groupId: "g-team" },
        { id: "t-3", assistantId: "dev", assistantName: "开发", startedBy: "lead", title: "部署预发", status: "waiting", groupId: "g-team" },
      ];
      const store = {
        jobs: () => jobs,
        group: (id: string) => groups[id],
        groups: () => Object.values(groups),
        groupMatches: (filter: string, id?: string) => filter === id,
        delegations: () => [],
        approvals: () => [],
        assistant: (id: string) => ({ id, name: names[id] ?? id }),
      };
      const runtime = { store, home: "/tmp/hob-now-empty", settings: { settings: { general: { timezone: "Asia/Shanghai" } } } } as unknown as HobRuntime;
      expect(nowBlock(runtime, "lead", { groupId: "g-team" })).toBe([
        "【现在】2026-11-04 17:07 周三",
        "进行中：t-1「打包构建」（开发），运行 2 分钟；t-2「跑回归」（测试），排队中（等 t-1）；t-3「部署预发」（开发），等你回复",
      ].join("\n"));
      expect(nowBlock(runtime, "qa", { groupId: "g-team" })).toBe([
        "【现在】2026-11-04 17:07 周三",
        "进行中：t-1「打包构建」（开发），运行 2 分钟；t-2「跑回归」，排队中（等 t-1）；t-3「部署预发」（开发），等负责人回复",
      ].join("\n"));
    } finally { vi.useRealTimers(); }
  });

  it("群会话的等用户选列出全部成员的待回答提问卡，群话题只列本话题，单聊不出现别人的", () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-11-04T09:07:00Z"));
    try {
      const groups: Record<string, { id: string; name: string; parentId?: string }> = {
        "g-team": { id: "g-team", name: "运维群" },
        "g-t1": { id: "g-t1", name: "备份清理", parentId: "g-team" },
      };
      const names: Record<string, string> = { owner: "群主", ops: "运维" };
      const approvals = [
        { assistantId: "ops", status: "pending", source: "router", title: "确认重启吗？", groupId: "g-team" },
        { assistantId: "ops", status: "pending", source: "router", title: "删旧快照吗？", groupId: "g-t1" },
        { assistantId: "ops", status: "pending", source: "job", title: "任务内部提问", groupId: "g-t1" },
        { assistantId: "ops", status: "pending", source: "router", title: "运维单聊问题" },
      ];
      const root = (id: string) => groups[id]?.parentId ?? groups[id]?.id;
      const store = {
        jobs: () => [],
        group: (id: string) => groups[id],
        groups: () => Object.values(groups),
        groupMatches: (filter: string, id?: string) => !!id && !!root(id) && root(filter) === root(id),
        delegations: () => [],
        approvals: () => approvals,
        assistant: (id: string) => ({ id, name: names[id] ?? id }),
      };
      const runtime = { store, home: "/tmp/hob-now-empty", settings: { settings: { general: { timezone: "Asia/Shanghai" } } } } as unknown as HobRuntime;
      expect(nowBlock(runtime, "owner", { groupId: "g-team" })).toBe([
        "【现在】2026-11-04 17:07 周三",
        "等用户选：确认重启吗？（运维）",
        "别处等用户选：话题「备份清理」里「删旧快照吗？」（运维）",
      ].join("\n"));
      expect(nowBlock(runtime, "owner", { groupId: "g-t1" })).toBe([
        "【现在】2026-11-04 17:07 周三",
        "等用户选：删旧快照吗？（运维）",
      ].join("\n"));
      expect(nowBlock(runtime, "owner")).toBe("【现在】2026-11-04 17:07 周三");
    } finally { vi.useRealTimers(); }
  });

  it("群会话列出正在回复的其他成员，综合的话题动态列出下属进行中话题的正在回复与待办进度", () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-11-04T09:07:00Z"));
    const home = mkdtempSync(join(tmpdir(), "hob-now-group-"));
    try {
      const groups: Record<string, { id: string; name: string; parentId?: string; createdAt: string; closedAt?: string }> = {
        "g-team": { id: "g-team", name: "策划群", createdAt: "2026-11-04T01:00:00Z" },
        "g-t1": { id: "g-t1", name: "日程安排", parentId: "g-team", createdAt: "2026-11-04T02:00:00Z" },
        "g-t2": { id: "g-t2", name: "预算核对", parentId: "g-team", createdAt: "2026-11-04T03:00:00Z" },
        "g-closed": { id: "g-closed", name: "已结束项", parentId: "g-team", createdAt: "2026-11-04T04:00:00Z", closedAt: "2026-11-04T05:00:00Z" },
      };
      writeTodos(groupTodosPath(home, "g-t1"), [
        { text: "确认场地", status: "done" },
        { text: "发出通知", status: "doing" },
      ]);
      writeTodos(groupTodosPath(home, "g-t2"), [{ text: "全部完成", status: "done" }]);
      writeTodos(groupTodosPath(home, "g-closed"), [{ text: "未完成项", status: "todo" }]);

      const names: Record<string, string> = { owner: "群主", writer: "文案", design: "设计" };
      const busyByGroup: Record<string, string[]> = {
        "g-team": ["owner", "writer"],
        "g-t1": ["design"],
      };
      const root = (id: string) => groups[id]?.parentId ?? groups[id]?.id;
      const store = {
        jobs: () => [],
        group: (id: string) => groups[id],
        groups: () => Object.values(groups),
        groupMatches: (filter: string, id?: string) => !!id && !!root(id) && root(filter) === root(id),
        delegations: () => [],
        approvals: () => [],
        assistant: (id: string) => ({ id, name: names[id] ?? id }),
      };
      const router = { busyMembers: (gid: string) => busyByGroup[gid] ?? [] };
      const runtime = { store, router, home, settings: { settings: { general: { timezone: "Asia/Shanghai" } } } } as unknown as HobRuntime;

      expect(nowBlock(runtime, "owner", { groupId: "g-team" })).toBe([
        "【现在】2026-11-04 17:07 周三",
        "正在回复：文案",
        "话题动态：话题「日程安排」（g-t1）：设计正在回复，待办 1/2",
      ].join("\n"));
      // 群话题只列本话题正在回复的其他成员，不输出话题动态
      expect(nowBlock(runtime, "owner", { groupId: "g-t1" })).toContain("正在回复：设计");
      expect(nowBlock(runtime, "owner", { groupId: "g-t1" })).not.toContain("话题动态：");
    } finally {
      vi.useRealTimers();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("转交中标明等用户确认、交给群的带话题 id，多话题主对话的话题动态列出各话题的回复、待办与转交", () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-11-04T09:07:00Z"));
    const home = mkdtempSync(join(tmpdir(), "hob-now-main-"));
    try {
      const aid = "coord";
      writeTodos(assistantTopicTodosPath(home, aid, "tp-1"), [
        { text: "收集资料", status: "done" },
        { text: "汇总方案", status: "doing" },
        { text: "发给确认", status: "todo" },
      ]);
      const groups: Record<string, any> = {
        "g-ops": { id: "g-ops", name: "技术组" },
        "g-h1": { id: "g-h1", name: "主线排查", parentId: "g-ops", handover: { by: aid, at: "2026-11-04T08:30:00Z" } },
      };
      const assistantTopics = [
        { id: "tp-1", assistantId: aid, name: "装修采购", createdAt: "2026-11-04T01:00:00Z" },
        { id: "tp-2", assistantId: aid, name: "网络排查", createdAt: "2026-11-04T02:00:00Z" },
      ];
      const delegations = [
        { id: "dg-main", from: aid, to: "buyer", status: "waiting", text: "比价清单", createdAt: "2026-11-04T08:00:00Z" },
        { id: "dg-tp1", from: aid, to: "buyer", status: "waiting", text: "订购瓷砖", createdAt: "2026-11-04T08:15:00Z", fromTopicId: "tp-1" },
      ];
      const names: Record<string, string> = { [aid]: "统筹", buyer: "采购" };
      const store = {
        jobs: () => [],
        group: (id: string) => groups[id],
        groups: () => Object.values(groups),
        assistantTopics: (id: string) => (id === aid ? assistantTopics : []),
        delegations: () => delegations,
        approvals: () => [],
        assistant: (id: string) => ({ id, name: names[id] ?? id, ...(id === aid ? { topics: { enabledAt: "2026-11-01T00:00:00Z" } } : {}) }),
      };
      const router = {
        isBusy: (_aid: string, place?: { topicId?: string }) => place?.topicId === "tp-1",
      };
      const runtime = { store, router, home, settings: { settings: { general: { timezone: "Asia/Shanghai" } } } } as unknown as HobRuntime;
      expect(nowBlock(runtime, aid)).toBe([
        "【现在】2026-11-04 17:07 周三",
        "转交中：采购「比价清单」，16:00 起，等用户确认",
        "交给群的：群「技术组」话题「主线排查」，16:30 起（g-h1）",
        "话题动态：话题「装修采购」（tp-1）：正在回复，待办 1/3，转交采购「订购瓷砖」（16:15 起，等用户确认）",
      ].join("\n"));
    } finally {
      vi.useRealTimers();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
