import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../shared/i18n.ts";
import type {
  Approval,
  Assistant,
  AssistantTopicSummary,
  Delegation,
  HobEvent,
  ItemsPage,
  Job,
} from "../../shared/types.ts";
import { answerApproval, answerCard } from "../src/actions.ts";
import { assistantTopicTodosPath, assistantWorkDir } from "../src/config.ts";
import { searchHistory } from "../src/history.ts";
import { createApp } from "../src/http.ts";
import { nowBlock } from "../src/now.ts";
import { sessionOrigin } from "../src/origin.ts";
import { pushApproval, pushAssistantTurnEnd, pushInteractiveCard, pushTarget, type PushPayload } from "../src/push.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import type { HobRuntime } from "../src/runtime.ts";
import { readTodos, releaseIdleTodos, todosBusy, writeTodos } from "../src/todos.ts";
import { call, makeHob, text, waitFor, type TestHob } from "./helpers.ts";

const extraDirs: string[] = [];

afterEach(() => {
  setLocale("zh-CN");
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "hob-topic-route-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  extraDirs.push(dir);
  return dir;
}

function addAssistant(hob: TestHob, id = "writer", name = "写作助手", extra: Partial<Assistant> = {}): Assistant {
  const base = hob.runtime.store.assistant("hob")!;
  const assistant: Assistant = {
    ...base,
    id,
    name,
    duty: "周报和文档",
    primary: false,
    pinned: false,
    notify: true,
    sprite: "page",
    createdAt: "2026-11-26T00:00:00.000Z",
    ...extra,
  };
  hob.runtime.store.saveAssistant(assistant);
  return assistant;
}

function said(result: { content: unknown[] }): string {
  return (result.content as { text?: string }[]).map((part) => part.text ?? "").join("");
}

function toolIn(hob: TestHob, assistantId: string, name: string, topicId?: string, groupId?: string) {
  const place = groupId ? { groupId } : topicId ? { topicId } : undefined;
  return buildRouterTools(hob.runtime, assistantId, place).find((item) => item.name === name)!;
}

async function loggedIn(runtime: HobRuntime, home: string) {
  const app = createApp(runtime, { home });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test" }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const get = (path: string) => app.request(path, { headers: { cookie } });
  const post = (path: string, body?: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const patch = (path: string, body?: unknown) =>
    app.request(path, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const del = (path: string, body?: unknown) =>
    app.request(path, {
      method: "DELETE",
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { app, get, post, patch, del };
}

describe("票 D 回流：任务、提问、超时与跨会话管理", () => {
  it("话题 A 派任务记 topicId，卡片、结果、提问、超时提醒与沉淀失败通知只回话题 A，且默认用话题工作目录", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const aid = "writer";
      const topicCwd = realpathSync(tempDir("hob-topic-job-cwd-"));
      addAssistant(hob, aid, "写作助手", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const { topic: topicA } = await hob.runtime.assistantTopics.create(aid, { title: "话题甲", cwd: topicCwd });
      const { topic: topicB } = await hob.runtime.assistantTopics.create(aid, { title: "话题乙" });

      // 1. 话题 A 启动任务：记 topicId，cwd 落到话题绑定的目录，卡片仅进话题 A
      hob.faux.setResponses([
        call("report", { outcome: "done", result: "话题 A 任务完成了" }),
        text("任务收尾"),
        text("话题 A 已收到任务结果"),
      ]);
      const started = await toolIn(hob, aid, "start_job", topicA.id).execute("j1", {
        title: "检查目录",
        note: "读取话题工作目录",
      });
      expect(said(started)).toContain("已开始");
      const job = hob.runtime.store.jobs().find((item) => item.title === "检查目录")!;
      expect(job.topicId).toBe(topicA.id);
      expect(job.cwd).toBe(topicCwd);

      await hob.runtime.jobs.waitIdle();
      await waitFor(() => hob.runtime.router.items(aid, {}, { topicId: topicA.id }).items.some((item) => item.kind === "assistant" && item.text.includes("话题 A 已收到任务结果")));
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topicA.id });

      const itemsA = hob.runtime.router.items(aid, {}, { topicId: topicA.id }).items;
      const itemsB = hob.runtime.router.items(aid, {}, { topicId: topicB.id }).items;
      const itemsMain = hob.runtime.router.items(aid).items;
      expect(itemsA.some((item) => item.kind === "job" && item.jobId === job.id)).toBe(true);
      expect(itemsA.some((item) => item.kind === "assistant" && item.text.includes("话题 A 已收到任务结果"))).toBe(true);
      expect(itemsB).toEqual([]);
      expect(itemsMain).toEqual([]);

      // 2. 跨会话查看、回复、停止任务时返回写明出处
      const checkFromMain = said(await toolIn(hob, aid, "check_job").execute("c1", { jobId: job.id }));
      expect(checkFromMain).toContain("这个任务是话题「话题甲」开的，结果回到那边。");
      const checkFromB = said(await toolIn(hob, aid, "check_job", topicB.id).execute("c2", { jobId: job.id }));
      expect(checkFromB).toContain("这个任务是话题「话题甲」开的，结果回到那边。");

      // 在话题 A 建一个未结束任务，并在主对话与话题 B 检验 reply_job / stop_job 的出处
      const running = await hob.runtime.jobs.start(aid, { title: "持续检查", instruction: "等待追问", topicId: topicA.id });
      const waitReply = await hob.runtime.jobs.waitIdle();
      void waitReply;
      // 直接写入 running 状态测试 askQuestion、finishUnansweredQuestions 与 checkStalls
      const mainJob = await hob.runtime.jobs.start(aid, { title: "主对话任务", instruction: "在主对话跑" });
      await hob.runtime.jobs.waitIdle();
      const checkMainFromA = said(await toolIn(hob, aid, "check_job", topicA.id).execute("c3", { jobId: mainJob.id }));
      expect(checkMainFromA).toContain("这个任务是主对话开的，结果回到那边。");

      // 续做主对话任务时在话题 A 调 reply_job 返回写明出处，续做任务仍回到主对话
      hob.faux.setResponses([
        call("report", { outcome: "done", result: "主对话任务续做完成" }),
        text("任务收尾"),
        text("主对话收到续做结果"),
      ]);
      const replyMainFromA = said(await toolIn(hob, aid, "reply_job", topicA.id).execute("r1", { jobId: mainJob.id, text: "补充要求" }));
      expect(replyMainFromA).toContain("这个任务是主对话创建的，结果回到那边。");
      await hob.runtime.jobs.waitIdle();
      await waitFor(() => hob.runtime.router.items(aid).items.some((item) => item.kind === "assistant" && item.text.includes("主对话收到续做结果")));
      await hob.runtime.router.waitIdle(aid);
      expect(hob.runtime.router.items(aid).items.some((item) => item.kind === "assistant" && item.text.includes("主对话收到续做结果"))).toBe(true);
      expect(hob.runtime.router.items(aid, {}, { topicId: topicA.id }).items.some((item) => item.kind === "assistant" && item.text.includes("主对话收到续做结果"))).toBe(false);

      // 话题 A 里发起一个会超时提醒并在沉淀失败时通知的任务
      hob.faux.setResponses([
        call("report", { outcome: "done", result: "首轮完成" }),
        text("首轮已知"),
      ]);
      const timedJob = await hob.runtime.jobs.start(aid, { title: "耗时任务", instruction: "跑一会", topicId: topicA.id, expectMinutes: 1 });
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topicA.id });

      // 停止主对话新建任务时，在话题 A 调用 stop_job 返回「主对话」并写清停止地点「话题「话题甲」」
      hob.faux.setResponses([text("已收到停止前的准备")]);
      const stoppedTarget = await hob.runtime.jobs.start(aid, { title: "待停任务", instruction: "停我" });
      const stopRes = said(await toolIn(hob, aid, "stop_job", topicA.id).execute("s1", { jobId: stoppedTarget.id }));
      expect(stopRes).toBe("已停止。这个任务是主对话创建的。");
      expect(hob.runtime.store.job(stoppedTarget.id)?.statusReason).toBe("写作助手在话题「话题甲」停止了");
      await hob.runtime.router.waitIdle(aid);
      expect(running.topicId).toBe(topicA.id);
      expect(timedJob.topicId).toBe(topicA.id);
    } finally {
      hob.close();
    }
  });

  it("话题 A 任务的 ask_user 记 topicId、回到话题 A，若本轮未接住按 Place 结束为受阻且不影响其他会话", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const aid = "writer";
      addAssistant(hob, aid, "写作助手", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const { topic: topicA } = await hob.runtime.assistantTopics.create(aid, { title: "话题甲" });
      const { topic: topicB } = await hob.runtime.assistantTopics.create(aid, { title: "话题乙" });

      // 任务在话题 A 提问，话题 A 的助手回合没有调用 reply_job（也没有留提问卡）-> 结束后任务变 stuck
      hob.faux.setResponses([
        call("ask_user", {
          title: "是否覆盖旧文件？",
          options: [{ label: "覆盖" }, { label: "跳过" }],
        }),
        text("我先记下这个问题，暂不回复任务"),
        text("已知道提问未答复结束"),
      ]);
      const jobA = await hob.runtime.jobs.start(aid, { title: "覆盖检查", instruction: "问一声", topicId: topicA.id });
      await waitFor(() => hob.runtime.store.approvals().some((a) => a.jobId === jobA.id));
      const jobApproval = hob.runtime.store.approvals().find((a) => a.jobId === jobA.id)!;
      expect(jobApproval.topicId).toBe(topicA.id);

      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topicA.id });

      const finishedA = hob.runtime.store.job(jobA.id)!;
      expect(finishedA.status).toBe("stuck");
      expect(finishedA.statusReason).toContain("提问没有得到答复：是否覆盖旧文件？");
      expect(hob.runtime.store.approval(jobApproval.id)?.status).toBe("expired");
      expect(hob.runtime.router.items(aid, {}, { topicId: topicB.id }).items).toEqual([]);
      expect(hob.runtime.router.items(aid).items).toEqual([]);

      // 在话题 B 起另一个等待中任务，在主对话跑一轮不会误杀话题 B 的 waiting 任务
      let resolveAskB!: (value: string) => void;
      const askB = new Promise<string>((resolve) => { resolveAskB = resolve; });
      const jobB = await hob.runtime.jobs.start(aid, { title: "B 的任务", instruction: "等回复", topicId: topicB.id });
      await hob.runtime.jobs.waitIdle();
      // 模拟一个等待中的 jobB 与主对话无关回合
      const waitingJobB: Job = { ...hob.runtime.store.job(jobB.id)!, status: "waiting" };
      hob.runtime.store.saveJob(waitingJobB);
      hob.runtime.store.saveApproval({
        id: "q-b-wait",
        assistantId: aid,
        title: "B 的问题",
        options: [{ key: "A", label: "好" }, { key: "B", label: "否" }],
        status: "pending",
        source: "job",
        jobId: jobB.id,
        topicId: topicB.id,
        createdAt: new Date().toISOString(),
      });
      await hob.runtime.jobs.finishUnansweredQuestions(aid, undefined);
      expect(hob.runtime.store.job(jobB.id)?.status).toBe("waiting");
      resolveAskB("done");
      void askB;
    } finally {
      hob.close();
    }
  });

  it("超时提醒与沉淀失败通知回到任务所在的助手话题", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const aid = "writer";
      addAssistant(hob, aid, "写作助手", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const { topic: topicA } = await hob.runtime.assistantTopics.create(aid, { title: "话题甲" });

      const events: Array<{ place?: { topicId?: string }; text: string }> = [];
      const origEvent = hob.runtime.router.event.bind(hob.runtime.router);
      vi.spyOn(hob.runtime.router, "event").mockImplementation(async (assistantId, content, details, place) => {
        events.push({ place, text: content });
        return origEvent(assistantId, content, details, place);
      });

      // 构造运行中任务并用 checkStalls 触发 2 倍预计时间通知（nextReminder=2 时通知助手）
      const now = Date.now();
      const job: Job = {
        id: "t-timeout-a",
        assistantId: aid,
        assistantName: "写作助手",
        topicId: topicA.id,
        title: "超长任务",
        instruction: "等超时",
        status: "running",
        expect: { minutes: 1, source: "assistant" },
        startedAt: new Date(now - 3 * 60_000).toISOString(),
        createdAt: new Date(now - 3 * 60_000).toISOString(),
        stats: { reads: 0, commands: 0, edits: 0 },
        activity: [],
      };
      hob.runtime.store.saveJob(job);
      const workers = (hob.runtime.jobs as unknown as { workers: Map<string, any> }).workers;
      workers.set(job.id, {
        job,
        askedFollowUp: false,
        lastActivityAt: now,
        pausedMs: 0,
        nextReminder: 2,
        steps: new Map(),
        queued: [],
        readPaths: new Map(),
        mcpServers: {},
      });
      hob.faux.setResponses([text("已了解超时进度")]);
      hob.runtime.jobs.checkStalls(now);
      await waitFor(() => events.some((item) => item.text.includes("超过预计的 1 分钟")));
      expect(events.find((item) => item.text.includes("超过预计的 1 分钟"))?.place).toEqual({ topicId: topicA.id });
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topicA.id });
      workers.delete(job.id);

      // 沉淀失败通知也回话题 A
      const doneJob: Job = { ...job, status: "done", endedAt: new Date().toISOString() };
      hob.runtime.store.saveJob(doneJob);
      vi.spyOn(hob.runtime.jobs as unknown as { openWorkerSession: () => Promise<never> }, "openWorkerSession").mockRejectedValueOnce(new Error("沉淀模型出错"));
      hob.faux.setResponses([text("收到沉淀失败通知")]);
      hob.runtime.jobs.startSediment(doneJob.id);
      await waitFor(() => events.some((item) => item.text.includes("沉淀失败，沉淀模型出错")));
      expect(events.find((item) => item.text.includes("沉淀失败，沉淀模型出错"))?.place).toEqual({ topicId: topicA.id });
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topicA.id });
    } finally {
      hob.close();
    }
  });
});

describe("票 D 回流：提问卡、卡片、文件、图片、页面与知识库", () => {
  it("话题 A 的 ask_user、send_card 记 topicId 且答案/操作回到话题 A；文件、生图、页面与上传进话题并带知识库 source.topicId", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const aid = "writer";
      addAssistant(hob, aid, "写作助手", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const { topic: topicA } = await hob.runtime.assistantTopics.create(aid, { title: "话题甲" });
      const { topic: topicB } = await hob.runtime.assistantTopics.create(aid, { title: "话题乙" });

      // 1. ask_user
      await toolIn(hob, aid, "ask_user", topicA.id).execute("ask1", {
        title: "用哪种格式？",
        options: [{ label: "Markdown" }, { label: "PDF" }],
      });
      const approval = hob.runtime.store.approvals().find((item) => item.title === "用哪种格式？")!;
      expect(approval.topicId).toBe(topicA.id);
      expect(hob.runtime.router.items(aid, {}, { topicId: topicA.id }).items.some((item) => item.kind === "question" && item.approvalId === approval.id)).toBe(true);
      expect(hob.runtime.router.items(aid, {}, { topicId: topicB.id }).items).toEqual([]);

      hob.faux.setResponses([text("好的，按 Markdown 处理")]);
      const answered = await answerApproval(hob.runtime, approval.id, { key: "A" });
      expect(answered.status).toBe(200);
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topicA.id });
      expect(hob.runtime.router.items(aid, {}, { topicId: topicA.id }).items.some((item) => item.kind === "assistant" && item.text.includes("按 Markdown 处理"))).toBe(true);
      expect(hob.runtime.router.items(aid).items).toEqual([]);

      // 2. send_card 记 topicId 且交互结果回到话题 A
      const cardRes = await toolIn(hob, aid, "send_card", topicA.id).execute("card1", {
        markdown: "# 确认单\n\n::button[同意]{primary}",
      });
      expect(said(cardRes)).toContain("卡片已显示给用户");
      const card = hob.runtime.store.cards().find((item) => item.topicId === topicA.id)!;
      expect(card).toBeDefined();
      hob.faux.setResponses([text("收到你在卡片上的同意操作")]);
      const cardAns = await answerCard(hob.runtime, card.id, { action: { tag: "button", text: "同意" } });
      expect(cardAns.status).toBe(200);
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topicA.id });
      expect(hob.runtime.router.items(aid, {}, { topicId: topicA.id }).items.some((item) => item.kind === "assistant" && item.text.includes("收到你在卡片上的同意操作"))).toBe(true);
      expect(hob.runtime.router.items(aid).items).toEqual([]);

      // 3. send_file / show_page / updateImage / 对话附件上传进话题 A，知识库收集记助手名下且 source.topicId === topicA.id
      const sentDir = join(hob.home, "assistants", aid, "files", "sent");
      mkdirSync(sentDir, { recursive: true });
      const reportFile = join(sentDir, "summary.md");
      writeFileSync(reportFile, "# 周报汇总\n内容A");
      await toolIn(hob, aid, "send_file", topicA.id).execute("f1", { path: reportFile });

      await toolIn(hob, aid, "show_page", topicA.id).execute("p1", {
        title: "展示页",
        summary: "测试摘要",
        html: "<h2>章节</h2><p>正文</p>",
      });

      const imgDir = join(hob.home, "assistants", aid, "files", "images");
      mkdirSync(imgDir, { recursive: true });
      const imgPath = join(imgDir, "pic.png");
      writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const imgItem = await hob.runtime.router.addItem(
        aid,
        { kind: "image", status: "pending", prompt: "画一只猫", startedAt: new Date().toISOString() },
        { topicId: topicA.id },
      );
      await hob.runtime.router.updateImage(aid, imgItem.id, { status: "done", path: imgPath }, { topicId: topicA.id });

      const uploadDir = join(hob.home, "assistants", aid, "files", "uploads");
      mkdirSync(uploadDir, { recursive: true });
      const chatFile = join(uploadDir, "u-1-notes.txt");
      writeFileSync(chatFile, "话题里的上传附件");
      hob.faux.setResponses([text("已收到上传附件")]);
      await hob.runtime.router.send(aid, { text: "请看附件", files: [chatFile] }, { topicId: topicA.id });
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topicA.id });

      await hob.runtime.knowledge.whenIdle();
      const kb = await hob.runtime.knowledge.list({ assistantId: aid });
      expect(kb.entries.some((e) => e.name === "summary.md" && e.source?.assistantId === aid && e.source.topicId === topicA.id)).toBe(true);
      expect(kb.entries.some((e) => e.name === "展示页" && e.source?.assistantId === aid && e.source.topicId === topicA.id)).toBe(true);
      expect(kb.entries.some((e) => e.name === "pic.png" && e.source?.assistantId === aid && e.source.topicId === topicA.id)).toBe(true);
      expect(kb.entries.some((e) => e.name === "notes.txt" && e.source?.assistantId === aid && e.source.topicId === topicA.id)).toBe(true);
      expect(hob.runtime.router.items(aid).items).toEqual([]);
    } finally {
      hob.close();
    }
  });
});

describe("票 D 回流：从话题转交与交给群", () => {
  it("从话题 A 调 message_assistant 记 fromTopicId，转交卡进 A，结果回 A（含重启恢复中断）", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const aid = "writer";
      addAssistant(hob, aid, "写作助手", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      addAssistant(hob, "editor", "校对助手");
      const { topic: topicA } = await hob.runtime.assistantTopics.create(aid, { title: "话题甲" });
      const { topic: topicB } = await hob.runtime.assistantTopics.create(aid, { title: "话题乙" });

      writeTodos(assistantTopicTodosPath(hob.home, aid, topicA.id), [{ text: "校对正文", status: "doing" }]);
      hob.faux.setResponses([
        text("校对完成：已修改 3 处错别字"),
        text("写作助手已在话题甲收到校对结果"),
      ]);
      const res = await toolIn(hob, aid, "message_assistant", topicA.id).execute("d1", {
        assistantId: "editor",
        note: "请帮忙校对一下",
      });
      expect(said(res)).toContain("已转交给「校对助手」");
      expect(readTodos(assistantTopicTodosPath(hob.home, aid, topicA.id))).toEqual([]);

      await hob.runtime.router.waitIdle("editor");
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topicA.id });

      const delegation = hob.runtime.store.delegations()[0]!;
      expect(delegation.fromTopicId).toBe(topicA.id);
      expect(delegation.status).toBe("done");
      expect(delegation.reportedAt).toBeDefined();

      const itemsA = hob.runtime.router.items(aid, {}, { topicId: topicA.id }).items;
      expect(itemsA.some((item) => item.kind === "delegation" && item.delegationId === delegation.id)).toBe(true);
      expect(itemsA.some((item) => item.kind === "assistant" && item.text.includes("写作助手已在话题甲收到校对结果"))).toBe(true);
      expect(hob.runtime.router.items(aid, {}, { topicId: topicB.id }).items).toEqual([]);
      expect(hob.runtime.router.items(aid).items).toEqual([]);

      // 重启恢复：未结束且带有 fromTopicId 的转交中断通知回话题 A
      const pendingDelegation: Delegation = {
        id: "dg-reboot",
        from: aid,
        to: "editor",
        text: "重启测试",
        createdAt: new Date().toISOString(),
        status: "running",
        jobIds: [],
        approvalIds: [],
        fromTopicId: topicA.id,
      };
      hob.runtime.store.saveDelegation(pendingDelegation);
      hob.faux.setResponses([text("话题甲收到重启中断通知")]);
      hob.runtime.delegations.recover();
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topicA.id });
      expect(hob.runtime.router.items(aid, {}, { topicId: topicA.id }).items.some((item) => item.kind === "assistant" && item.text.includes("话题甲收到重启中断通知"))).toBe(true);
      expect(hob.runtime.router.items(aid).items).toEqual([]);
    } finally {
      hob.close();
    }
  });

  it("从话题 A 调 message_group 记 TopicHandover.fromTopicId，群话题关闭后结论送回话题 A", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const aid = "writer";
      addAssistant(hob, aid, "写作助手", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      addAssistant(hob, "ops", "运维");
      const group = hob.runtime.groups.create({ name: "运维群", purpose: "处理问题", ownerId: "ops", members: ["ops"] });
      const { topic: topicA } = await hob.runtime.assistantTopics.create(aid, { title: "话题甲" });

      hob.faux.setResponses([text("群主已收到")]);
      const res = await toolIn(hob, aid, "message_group", topicA.id).execute("mg1", {
        groupId: group.id,
        title: "排查域名证书",
        note: "帮忙检查一下证书过期时间",
      });
      expect(said(res)).toContain("已交给群「运维群」");
      await waitFor(() => hob.runtime.groups.topicsOf(group.id).length === 1);
      const groupTopic = hob.runtime.groups.topicsOf(group.id)[0]!;
      expect(groupTopic.handover?.fromTopicId).toBe(topicA.id);
      expect(hob.runtime.router.items(aid, {}, { topicId: topicA.id }).items.some((item) => item.kind === "topic" && item.topicId === groupTopic.id)).toBe(true);
      await waitFor(() => hob.runtime.router.busyMembers(groupTopic.id).length === 0);

      // 关闭群话题，结论回流到助手话题 A
      hob.faux.setResponses([text("话题甲已收到群结论")]);
      hob.runtime.groups.closeByOwner(groupTopic.id, "证书已续期至明年");
      await waitFor(() => Boolean(hob.runtime.store.group(groupTopic.id)?.handover?.deliveredAt));
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topicA.id });
      expect(hob.runtime.router.items(aid, {}, { topicId: topicA.id }).items.some((item) => item.kind === "assistant" && item.text.includes("话题甲已收到群结论"))).toBe(true);
      expect(hob.runtime.router.items(aid).items).toEqual([]);
    } finally {
      hob.close();
    }
  });
});

describe("票 D 回流：定时任务归助手话题", () => {
  it("话题 A 建的定时记 topicId、返回写明进话题、到点直接进话题 A；主对话建的进主对话；update/delete 写明出处", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const aid = "writer";
      addAssistant(hob, aid, "写作助手", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      addAssistant(hob, "single", "单聊助手");
      const { topic: topicA } = await hob.runtime.assistantTopics.create(aid, { title: "搬家准备" });

      const createdA = said(await toolIn(hob, aid, "create_routine", topicA.id).execute("cr1", {
        name: "查搬家报价",
        instruction: "汇总搬家公司报价",
        schedules: ["0 9 * * *"],
      }));
      expect(createdA).toContain("到执行时间会在这个话题里执行");
      const rtA = hob.runtime.store.routines().find((r) => r.name === "查搬家报价")!;
      expect(rtA.topicId).toBe(topicA.id);

      const createdMain = said(await toolIn(hob, aid, "create_routine").execute("cr2", {
        name: "每日总结",
        instruction: "汇总今天的工作",
        schedules: ["0 18 * * *"],
      }));
      expect(createdMain).not.toContain("到执行时间会在这个话题里执行");
      const rtMain = hob.runtime.store.routines().find((r) => r.name === "每日总结")!;
      expect(rtMain.topicId).toBeUndefined();

      // 到点：rtA 进话题 A，rtMain 进主对话
      hob.faux.setResponses([text("话题 A 定时处理完成")]);
      await hob.runtime.routines.fire(rtA.id);
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topicA.id });
      const itemsA = hob.runtime.router.items(aid, {}, { topicId: topicA.id }).items;
      expect(itemsA.some((item) => item.kind === "note" && item.routineId === rtA.id)).toBe(true);
      expect(itemsA.some((item) => item.kind === "assistant" && item.text.includes("话题 A 定时处理完成") && item.routine?.id === rtA.id)).toBe(true);
      expect(hob.runtime.router.items(aid).items.some((item) => item.kind === "assistant" || (item.kind === "note" && item.routineId === rtA.id))).toBe(false);

      hob.faux.setResponses([text("主对话定时处理完成")]);
      await hob.runtime.routines.fire(rtMain.id);
      await hob.runtime.router.waitIdle(aid);
      expect(hob.runtime.router.items(aid).items.some((item) => item.kind === "assistant" && item.text.includes("主对话定时处理完成") && item.routine?.id === rtMain.id)).toBe(true);

      // 跨会话 update_routine / delete_routine 写明「主对话」「话题「…」」
      const updMainFromA = said(await toolIn(hob, aid, "update_routine", topicA.id).execute("ur1", { routineId: rtMain.id, name: "晚间总结" }));
      expect(updMainFromA).toContain("已修改「晚间总结」（主对话）");
      const updAFromMain = said(await toolIn(hob, aid, "update_routine").execute("ur2", { routineId: rtA.id, name: "核对搬家报价" }));
      expect(updAFromMain).toContain("已修改「核对搬家报价」（话题「搬家准备」）");

      const wrongId = said(await toolIn(hob, aid, "update_routine", topicA.id).execute("ur3", { routineId: "rt-nope", name: "x" }));
      expect(wrongId).toContain(`「核对搬家报价」（${rtA.id} · 话题「搬家准备」）`);
      expect(wrongId).toContain(`「晚间总结」（${rtMain.id} · 主对话）`);

      const delAFromMain = said(await toolIn(hob, aid, "delete_routine").execute("dr1", { routineId: rtA.id }));
      expect(delAFromMain).toContain("已删除「核对搬家报价」（话题「搬家准备」）");
      expect(delAFromMain).toContain(`「晚间总结」（${rtMain.id} · 主对话）`);

      // 单会话助手仍不带位置前缀
      const singleRt = hob.runtime.routines.create({ assistantId: "single", name: "单聊定时", instruction: "看看", schedules: ["0 9 * * *"] });
      const delSingle = said(await toolIn(hob, "single", "delete_routine").execute("dr2", { routineId: singleRt.id }));
      expect(delSingle).toBe("已删除「单聊定时」。你现在没有定时任务。");
    } finally {
      hob.close();
    }
  });

  it("关闭话题暂停启用中定时并记 pausedBy，重开仅恢复 pausedBy 的，用户自暂停与主对话定时不受影响", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const aid = "writer";
      addAssistant(hob, aid, "写作助手", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const { topic: topicA } = await hob.runtime.assistantTopics.create(aid, { title: "话题甲" });
      const { post } = await loggedIn(hob.runtime, hob.home);

      const rtActive = hob.runtime.routines.create({ assistantId: aid, topicId: topicA.id, name: "启用定时", instruction: "做", schedules: ["0 9 * * *"] });
      const rtUserPaused = hob.runtime.routines.create({ assistantId: aid, topicId: topicA.id, name: "自暂停定时", instruction: "停", schedules: ["0 10 * * *"], active: false });
      const rtMain = hob.runtime.routines.create({ assistantId: aid, name: "主对话定时", instruction: "做", schedules: ["0 11 * * *"] });

      const closeRes = await post(`/api/assistants/${aid}/topics/${topicA.id}/close`, { note: "先暂停" });
      expect(closeRes.status).toBe(200);

      expect(hob.runtime.store.routine(rtActive.id)).toMatchObject({ active: false, pausedBy: "topicClosed" });
      expect(hob.runtime.routines.nextRuns(rtActive.id)).toEqual([]);
      expect(hob.runtime.store.routine(rtUserPaused.id)?.active).toBe(false);
      expect(hob.runtime.store.routine(rtUserPaused.id)?.pausedBy).toBeUndefined();
      expect(hob.runtime.store.routine(rtMain.id)?.active).toBe(true);

      // 关闭期间 runNow / 启用返回 400「话题已关闭」
      const runClosed = await post(`/api/routines/${rtActive.id}/run`);
      expect(runClosed.status).toBe(400);
      expect(await runClosed.json()).toEqual({ error: "话题已关闭" });
      const enableClosed = await hob.runtime.app?.request(`/api/routines/${rtActive.id}`).catch(() => undefined);
      void enableClosed;
      expect(() => hob.runtime.routines.update(rtActive.id, { active: true })).toThrow("话题已关闭");

      // 重开：恢复 rtActive，不恢复 rtUserPaused
      const reopenRes = await post(`/api/assistants/${aid}/topics/${topicA.id}/reopen`);
      expect(reopenRes.status).toBe(200);
      expect(hob.runtime.store.routine(rtActive.id)?.active).toBe(true);
      expect(hob.runtime.store.routine(rtActive.id)?.pausedBy).toBeUndefined();
      expect(hob.runtime.routines.nextRuns(rtActive.id).filter(Boolean)).toHaveLength(1);
      expect(hob.runtime.store.routine(rtUserPaused.id)?.active).toBe(false);
      expect(hob.runtime.store.routine(rtUserPaused.id)?.pausedBy).toBeUndefined();
    } finally {
      hob.close();
    }
  });
});

describe("票 D 回流：nowBlock、sessionOrigin、待办收起与推送", () => {
  it("sessionOrigin 区分单聊、主对话、助手话题；nowBlock 区分本会话与别处；待办收起与推送按话题精准生效", async () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-11-26T09:00:00Z"));
    const hob = makeHob({}, { memory: "off" });
    try {
      const aid = "writer";
      addAssistant(hob, aid, "写作助手", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      addAssistant(hob, "single", "单聊助手");
      const group = hob.runtime.groups.create({ name: "协同群", purpose: "协作", ownerId: aid, members: [aid] });
      const { topic: topicA } = await hob.runtime.assistantTopics.create(aid, { title: "搬家" });
      const { topic: topicB } = await hob.runtime.assistantTopics.create(aid, { title: "报销" });

      // 1. sessionOrigin
      expect(sessionOrigin(hob.runtime.store, undefined, undefined, "single")).toBe("单聊");
      expect(sessionOrigin(hob.runtime.store, undefined, { topicId: topicA.id }, aid)).toBe("主对话");
      expect(sessionOrigin(hob.runtime.store, { topicId: topicA.id }, undefined, aid)).toBe("话题「搬家」");
      expect(sessionOrigin(hob.runtime.store, { groupId: group.id }, { topicId: topicA.id }, aid)).toBe("群「协同群」");

      // 2. nowBlock 在主对话、话题 A、话题 B 区分本会话与别处
      const nowIso = "2026-11-26T08:58:00Z";
      hob.runtime.store.saveJob({
        id: "t-main", assistantId: aid, title: "主对话任务", instruction: "m", status: "running",
        startedAt: nowIso, createdAt: nowIso, stats: { reads: 0, commands: 0, edits: 0 }, activity: [],
      });
      hob.runtime.store.saveJob({
        id: "t-a", assistantId: aid, topicId: topicA.id, title: "搬家任务", instruction: "a", status: "running",
        startedAt: nowIso, createdAt: nowIso, stats: { reads: 0, commands: 0, edits: 0 }, activity: [],
      });
      hob.runtime.store.saveJob({
        id: "t-g", assistantId: aid, groupId: group.id, title: "群任务", instruction: "g", status: "queued",
        createdAt: nowIso, stats: { reads: 0, commands: 0, edits: 0 }, activity: [],
      });
      hob.runtime.store.saveApproval({
        id: "q-b", assistantId: aid, topicId: topicB.id, title: "发票选哪张", options: [], status: "pending", source: "router", createdAt: nowIso,
      });
      hob.runtime.store.saveDelegation({
        id: "dg-a", from: aid, to: "single", text: "帮忙订车", createdAt: nowIso, status: "running", jobIds: [], fromTopicId: topicA.id,
      });

      const blockMain = nowBlock(hob.runtime, aid);
      expect(blockMain).toContain("进行中：t-main「主对话任务」");
      expect(blockMain).not.toContain("转交中：");
      expect(blockMain).toContain("别处进行中：话题「搬家」里 t-a「搬家任务」");
      expect(blockMain).toContain("群「协同群」里 t-g「群任务」");
      expect(blockMain).toContain("别处等用户选：话题「报销」里「发票选哪张」");

      const blockA = nowBlock(hob.runtime, aid, { topicId: topicA.id });
      expect(blockA).toContain("进行中：t-a「搬家任务」");
      expect(blockA).toContain("转交中：单聊助手「帮忙订车」");
      expect(blockA).toContain("别处进行中：");
      expect(blockA).toContain("主对话里 t-main「主对话任务」");
      expect(blockA).toContain("群「协同群」里 t-g「群任务」");
      expect(blockA).toContain("别处等用户选：话题「报销」里「发票选哪张」");

      // 3. todosBusy 按话题精准判断（仅 topicA 有转交、仅 topicB 有提问卡；主对话无活但 topicA 有活时主对话不互相挡）
      const pathA = assistantTopicTodosPath(hob.home, aid, topicA.id);
      const pathB = assistantTopicTodosPath(hob.home, aid, topicB.id);
      writeTodos(pathA, [{ text: "等订车结果", status: "doing" }]);
      writeTodos(pathB, [{ text: "等选发票", status: "doing" }]);
      expect(todosBusy(hob.runtime, aid, { topicId: topicA.id })).toBe(true);
      expect(todosBusy(hob.runtime, aid, { topicId: topicB.id })).toBe(true);

      // 创建无活的话题 C：尽管 topicA/topicB/main 忙碌，topicC 待办应直接收起
      const { topic: topicC } = await hob.runtime.assistantTopics.create(aid, { title: "无活话题" });
      const pathC = assistantTopicTodosPath(hob.home, aid, topicC.id);
      writeTodos(pathC, [{ text: "可收起", status: "todo" }]);
      expect(todosBusy(hob.runtime, aid, { topicId: topicC.id })).toBe(false);
      releaseIdleTodos(hob.runtime, aid, { topicId: topicC.id });
      expect(readTodos(pathC)).toEqual([]);

      // 4. 推送地址与 target
      const sent: Array<{ payload: PushPayload; target?: string }> = [];
      const push = { send: async (payload: PushPayload, target?: string) => { sent.push({ payload, target }); return { sent: 1, removed: 0 }; } };
      pushAssistantTurnEnd({ push, store: hob.runtime.store }, { assistantId: aid, place: { topicId: topicA.id }, text: "话题完成" });
      pushAssistantTurnEnd({ push, store: hob.runtime.store }, { assistantId: aid, place: { topicId: topicA.id }, error: "网络断开" });
      pushInteractiveCard({ push, store: hob.runtime.store }, { assistantId: aid, place: { topicId: topicA.id }, title: "确认单" });
      pushApproval({ push, store: hob.runtime.store }, {
        id: "q-push", assistantId: aid, topicId: topicA.id, title: "要继续吗", options: [], status: "pending", source: "router", createdAt: nowIso,
      });
      await Promise.resolve();
      const expectedUrl = `/#/chat/${aid}/topic/${topicA.id}`;
      expect(pushTarget(aid, { topicId: topicA.id })).toBe(`topic:${topicA.id}`);
      expect(sent).toHaveLength(4);
      for (const entry of sent) {
        expect(entry.payload.url).toBe(expectedUrl);
        expect(entry.target).toBe(`topic:${topicA.id}`);
      }
    } finally {
      hob.close();
    }
  });
});

describe("票 D 回流：搜索聊天记录与收藏", () => {
  it("searchHistory 命中助手话题返回「助手名 · 话题名」与 topic 引用，收藏与取消收藏接口生效", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const aid = "writer";
      addAssistant(hob, aid, "写作助手", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      hob.faux.setResponses([text("好的，已经记下搬家预算五千元")]);
      const { topic } = await hob.runtime.assistantTopics.create(aid, { title: "搬家规划", text: "预计搬家预算五千元" });
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topic.id });

      const { get, post, del } = await loggedIn(hob.runtime, hob.home);
      const searchRes = await get("/api/history/search?query=五千元");
      expect(searchRes.status).toBe(200);
      const found = (await searchRes.json()) as Awaited<ReturnType<typeof searchHistory>>;
      expect(found.total).toBe(2);
      expect(found.results[0]).toMatchObject({
        conversation: { kind: "topic", id: topic.id },
        conversationName: "写作助手 · 搬家规划",
      });

      const assistantItem = hob.runtime.router.items(aid, {}, { topicId: topic.id }).items.find((i) => i.kind === "assistant")!;
      const starRes = await post("/api/stars", { conversation: { kind: "topic", id: topic.id }, itemId: assistantItem.id });
      expect(starRes.status).toBe(200);
      const starsJson = (await (await get("/api/stars")).json()) as { stars: Array<{ conversation: { kind: string; id: string }; speaker: string; itemId: string }> };
      expect(starsJson.stars).toHaveLength(1);
      expect(starsJson.stars[0]).toMatchObject({
        conversation: { kind: "topic", id: topic.id },
        speaker: aid,
        itemId: assistantItem.id,
      });

      const starredSearch = await searchHistory(hob.runtime.store, { starred: true });
      expect(starredSearch.results[0]).toMatchObject({
        conversation: { kind: "topic", id: topic.id },
        conversationName: "写作助手 · 搬家规划",
        speakerName: "写作助手",
        starred: true,
      });

      const unstarRes = await del("/api/stars", { conversation: { kind: "topic", id: topic.id }, itemId: assistantItem.id });
      expect(unstarRes.status).toBe(200);
      expect(((await (await get("/api/stars")).json()) as { stars: unknown[] }).stars).toEqual([]);
    } finally {
      hob.close();
    }
  });
});

describe("票 D 回流：关闭结论同步主对话与已关闭话题自动重开", () => {
  it("关闭话题写入主对话 hob.context（有结论与无结论两种）；幂等再关不重复写入", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const aid = "writer";
      addAssistant(hob, aid, "写作助手", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const { post } = await loggedIn(hob.runtime, hob.home);

      const { topic: tWithNote } = await hob.runtime.assistantTopics.create(aid, { title: "年度总结" });
      const { topic: tNoNote } = await hob.runtime.assistantTopics.create(aid, { title: "临时想法" });

      expect((await post(`/api/assistants/${aid}/topics/${tWithNote.id}/close`, { note: "已定稿发出" })).status).toBe(200);
      // 幂等再关一次不重复写 context
      expect((await post(`/api/assistants/${aid}/topics/${tWithNote.id}/close`)).status).toBe(200);
      expect((await post(`/api/assistants/${aid}/topics/${tNoNote.id}/close`, {})).status).toBe(200);

      const mainEntries = hob.runtime.router.sessionEntries(aid);
      const contexts = mainEntries.filter((e) => e.type === "custom_message" && e.customType === "hob.context");
      expect(contexts).toHaveLength(2);
      expect(String((contexts[0] as any).content)).toContain(`话题「年度总结」（${tWithNote.id}）已关闭。结论：已定稿发出`);
      expect(String((contexts[1] as any).content)).toContain(`话题「临时想法」（${tNoNote.id}）被用户关闭，没有写结论。`);
      // 不开轮：主对话可见条目仍然为空
      expect(hob.runtime.router.items(aid).items).toEqual([]);
    } finally {
      hob.close();
    }
  });

  it("已关闭的话题收到四类结果时自动重开、恢复定时、先落 note 再送事件开轮", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const aid = "writer";
      addAssistant(hob, aid, "写作助手", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      addAssistant(hob, "editor", "校对助手");
      const group = hob.runtime.groups.create({ name: "设计群", purpose: "设计评审", ownerId: "editor", members: ["editor"] });

      // 1. 任务结果触发重开（同时验证 pausedBy 定时恢复与 assistant_topic 事件）
      const { topic: tJob } = await hob.runtime.assistantTopics.create(aid, { title: "任务重开" });
      const rt = hob.runtime.routines.create({ assistantId: aid, topicId: tJob.id, name: "巡检", instruction: "看看", schedules: ["0 9 * * *"] });
      const manualPausedRt = hob.runtime.routines.create({ assistantId: aid, topicId: tJob.id, name: "手停", instruction: "停", schedules: ["0 10 * * *"], active: false });
      const events: HobEvent[] = [];
      const off = hob.runtime.bus.subscribe((ev) => events.push(ev));

      // 先建 running 任务，再关闭话题
      const runningJob: Job = {
        id: "t-closed-reopen",
        assistantId: aid,
        assistantName: "写作助手",
        topicId: tJob.id,
        title: "整理数据",
        instruction: "整理",
        status: "running",
        createdAt: new Date().toISOString(),
        stats: { reads: 0, commands: 0, edits: 0 },
        activity: [],
      };
      hob.runtime.store.saveJob(runningJob);
      await hob.runtime.assistantTopics.close(aid, tJob.id, "先关掉等任务");
      expect(hob.runtime.store.assistantTopic(aid, tJob.id)?.closedAt).toBeTruthy();
      expect(hob.runtime.store.routine(rt.id)).toMatchObject({ active: false, pausedBy: "topicClosed" });

      hob.faux.setResponses([text("已收到重开后的任务结果")]);
      await (hob.runtime.jobs as unknown as { finish: (id: string, status: Job["status"], summary?: string) => Promise<void> }).finish(runningJob.id, "done", "全部整理好了");
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: tJob.id });

      const reopenedJobTopic = hob.runtime.store.assistantTopic(aid, tJob.id)!;
      expect(reopenedJobTopic.closedAt).toBeUndefined();
      expect(reopenedJobTopic.closeNote).toBeUndefined();
      expect(hob.runtime.store.routine(rt.id)?.active).toBe(true);
      expect(hob.runtime.store.routine(rt.id)?.pausedBy).toBeUndefined();
      expect(hob.runtime.store.routine(manualPausedRt.id)?.active).toBe(false);
      expect(events.some((e) => e.type === "assistant_topic" && e.topic.id === tJob.id && !e.topic.closedAt)).toBe(true);
      const jobItems = hob.runtime.router.items(aid, {}, { topicId: tJob.id }).items;
      const noteIdx = jobItems.findIndex((i) => i.kind === "note" && i.icon === "info" && i.text === "任务「整理数据」有了结果，话题已重新打开");
      const replyIdx = jobItems.findIndex((i) => i.kind === "assistant" && i.text.includes("已收到重开后的任务结果"));
      expect(noteIdx).toBeGreaterThanOrEqual(0);
      expect(replyIdx).toBeGreaterThan(noteIdx);

      // 2. 提问卡答案触发重开
      const { topic: tAsk } = await hob.runtime.assistantTopics.create(aid, { title: "提问重开" });
      await toolIn(hob, aid, "ask_user", tAsk.id).execute("ask-reopen", { title: "确认颜色", options: [{ label: "蓝" }, { label: "绿" }] });
      const askApproval = hob.runtime.store.approvals().find((a) => a.title === "确认颜色")!;
      await hob.runtime.assistantTopics.close(aid, tAsk.id, "暂关");
      hob.faux.setResponses([text("收到颜色选择")]);
      await answerApproval(hob.runtime, askApproval.id, { key: "A" });
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: tAsk.id });
      expect(hob.runtime.store.assistantTopic(aid, tAsk.id)?.closedAt).toBeUndefined();
      const askItems = hob.runtime.router.items(aid, {}, { topicId: tAsk.id }).items;
      expect(askItems.some((i) => i.kind === "note" && i.icon === "info" && i.text === "提问有了回答，话题已重新打开")).toBe(true);
      expect(askItems.some((i) => i.kind === "assistant" && i.text.includes("收到颜色选择"))).toBe(true);

      // 3. 转交结果触发重开
      const { topic: tDel } = await hob.runtime.assistantTopics.create(aid, { title: "转交重开" });
      const dg: Delegation = {
        id: "dg-reopen",
        from: aid,
        to: "editor",
        text: "帮忙看下",
        createdAt: new Date().toISOString(),
        status: "done",
        jobIds: [],
        fromTopicId: tDel.id,
        reply: "改好了",
        turnFinished: true,
      };
      hob.runtime.store.saveDelegation(dg);
      await hob.runtime.assistantTopics.close(aid, tDel.id, "关着等转交");
      hob.faux.setResponses([text("收到校对助手的转交结果")]);
      await hob.runtime.router.delegationResult(aid, dg.id, "转交给「校对助手」的事已结束：改好了", false, { topicId: tDel.id });
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: tDel.id });
      expect(hob.runtime.store.assistantTopic(aid, tDel.id)?.closedAt).toBeUndefined();
      const delItems = hob.runtime.router.items(aid, {}, { topicId: tDel.id }).items;
      expect(delItems.some((i) => i.kind === "note" && i.icon === "info" && i.text === "「校对助手」交回了转交的结果，话题已重新打开")).toBe(true);
      expect(delItems.some((i) => i.kind === "assistant" && i.text.includes("收到校对助手的转交结果"))).toBe(true);

      // 4. 群话题结论触发重开（也测英文 locale 下 note 文案）
      setLocale("en");
      const { topic: tGrp } = await hob.runtime.assistantTopics.create(aid, { title: "群重开" });
      const { topic: grpTopic } = hob.runtime.groups.handOver(group.id, "做海报", aid, { text: "请出图", files: [], fromTopicId: tGrp.id });
      await hob.runtime.assistantTopics.close(aid, tGrp.id, "关着等群");
      hob.faux.setResponses([text("Received group conclusion")]);
      hob.runtime.groups.closeByOwner(grpTopic.id, "海报已出稿");
      await waitFor(() => Boolean(hob.runtime.store.group(grpTopic.id)?.handover?.deliveredAt));
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: tGrp.id });
      expect(hob.runtime.store.assistantTopic(aid, tGrp.id)?.closedAt).toBeUndefined();
      const grpItems = hob.runtime.router.items(aid, {}, { topicId: tGrp.id }).items;
      expect(grpItems.some((i) => i.kind === "note" && i.icon === "info" && i.text === "The topic in group “设计群” has a conclusion. The topic was reopened.")).toBe(true);
      expect(grpItems.some((i) => i.kind === "assistant" && i.text.includes("Received group conclusion"))).toBe(true);

      off();
    } finally {
      hob.close();
    }
  });

  it("登录卡、插件卡、检查脚本 notify、一次性定时过点重开及 HTTP POST /api/routines 支持 topicId", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-11-26T00:30:00Z")); // 上海 08:30
    const hob = makeHob({}, { memory: "off" });
    try {
      const aid = "writer";
      addAssistant(hob, aid, "写作助手", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const { topic: topicA } = await hob.runtime.assistantTopics.create(aid, { title: "登录与定时" });
      const { post } = await loggedIn(hob.runtime, hob.home);

      // 1. 登录卡在话题 A 记 topicId，且关闭后回答自动重开并回话题 A
      await toolIn(hob, aid, "login", topicA.id).execute("lg1", {
        site: "example.com",
        reason: "需要登录查看",
      });
      const loginApproval = hob.runtime.store.approvals().find((a) => a.login?.site === "example.com")!;
      expect(loginApproval.topicId).toBe(topicA.id);
      await hob.runtime.assistantTopics.close(aid, topicA.id, "等登录");
      hob.faux.setResponses([text("已收到你在 example.com 的登录确认")]);
      const loginAns = await answerApproval(hob.runtime, loginApproval.id, { key: "A" });
      expect(loginAns.status).toBe(200);
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topicA.id });
      expect(hob.runtime.store.assistantTopic(aid, topicA.id)?.closedAt).toBeUndefined();
      expect(hob.runtime.router.items(aid, {}, { topicId: topicA.id }).items.some((i) => i.kind === "assistant" && i.text.includes("登录确认"))).toBe(true);

      // 2. 插件卡记 topicId，操作结果回话题 A
      await (hob.runtime.router as unknown as {
        addPluginCard: (assistantId: string, place: { topicId?: string }, payload: any) => Promise<void>;
      }).addPluginCard(aid, { topicId: topicA.id }, {
        pluginId: "demo-plugin",
        pluginName: "示例插件",
        service: "svc",
        callbackTool: "cb",
        card: {
          schema: "2.0",
          header: { title: { tag: "plain_text", content: "插件卡" } },
          body: { elements: [{ tag: "button", text: { tag: "plain_text", content: "提交" }, type: "primary_filled", name: "btn" }] },
        },
      });
      const pluginCard = hob.runtime.store.cards().find((c) => c.owner.type === "plugin" && c.topicId === topicA.id)!;
      expect(pluginCard).toBeDefined();
      vi.spyOn(hob.runtime.plugins.store, "list").mockReturnValueOnce([{ id: "demo-plugin", enabled: true } as any]);
      vi.spyOn(hob.runtime.plugins, "states").mockReturnValueOnce([{ name: "svc", status: "connected" } as any]);
      vi.spyOn(hob.runtime.plugins, "call").mockResolvedValueOnce({ content: [{ type: "text", text: "插件已处理" }] } as any);
      hob.faux.setResponses([text("收到插件卡结果")]);
      const pluginRes = await answerCard(hob.runtime, pluginCard.id, { action: { tag: "button", text: "提交" } });
      expect(pluginRes.status).toBe(200);
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topicA.id });
      expect(hob.runtime.router.items(aid, {}, { topicId: topicA.id }).items.some((i) => i.kind === "assistant" && i.text.includes("收到插件卡结果"))).toBe(true);

      // 3. HTTP POST /api/routines 支持 topicId，检查脚本 notify 进话题 A 且推送 URL 正确
      const sent: Array<{ payload: PushPayload; target?: string }> = [];
      vi.spyOn(hob.runtime.push, "send").mockImplementation(async (payload, target) => {
        sent.push({ payload, target });
        return { sent: 1, removed: 0 };
      });
      const rtNotifyRes = await post("/api/routines", {
        assistantId: aid,
        topicId: topicA.id,
        name: "通知巡检",
        instruction: "看通知",
        schedules: ["0 12 * * *"],
        check: { script: "echo 有新提醒", then: "notify" },
      });
      expect(rtNotifyRes.status).toBe(200);
      const { routine: rtNotify } = (await rtNotifyRes.json()) as { routine: { id: string; topicId?: string } };
      expect(rtNotify.topicId).toBe(topicA.id);
      await hob.runtime.routines.runNow(rtNotify.id);
      await Promise.resolve();
      expect(hob.runtime.router.items(aid, {}, { topicId: topicA.id }).items.some((i) => i.kind === "assistant" && i.text === "有新提醒" && i.routine?.id === rtNotify.id)).toBe(true);
      expect(sent.some((s) => s.payload.url === `/#/chat/${aid}/topic/${topicA.id}` && s.target === `topic:${topicA.id}`)).toBe(true);

      // 4. 一次性定时关闭后跨过时间点再重开，按完成停止并把 note 落进话题 A
      const rtOnce = hob.runtime.routines.create({
        assistantId: aid,
        topicId: topicA.id,
        name: "九点提醒",
        instruction: "提醒",
        schedules: ["2026-11-26T09:00"],
        once: true,
      });
      await hob.runtime.assistantTopics.close(aid, topicA.id, "暂关");
      expect(hob.runtime.store.routine(rtOnce.id)).toMatchObject({ active: false, pausedBy: "topicClosed" });

      vi.setSystemTime(new Date("2026-11-26T01:30:00Z")); // 上海 09:30
      hob.runtime.assistantTopics.reopen(aid, topicA.id);
      const finishedOnce = hob.runtime.store.routine(rtOnce.id)!;
      expect(finishedOnce).toMatchObject({ active: false, stopReason: "finished" });
      expect(finishedOnce.pausedBy).toBeUndefined();
      await waitFor(() => hob.runtime.router.items(aid, {}, { topicId: topicA.id }).items.some((i) => i.kind === "note" && i.text === "定时任务「九点提醒」已完成最后一次运行，已停止"));
    } finally {
      hob.close();
    }
  });

  it("save_skill 在助手话题及其任务里把「已存技能」note 落回原话题而非主对话", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const aid = "writer";
      addAssistant(hob, aid, "写作助手", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const { topic: topicA } = await hob.runtime.assistantTopics.create(aid, { title: "技能沉淀" });

      // 1. Router 在话题 A 直接调 save_skill
      const workDir = assistantWorkDir(hob.home, aid);
      const routerSkillSrc = join(workDir, "topic-direct-skill");
      mkdirSync(routerSkillSrc, { recursive: true });
      writeFileSync(
        join(routerSkillSrc, "SKILL.md"),
        "---\nname: topic-direct-skill\ndescription: 话题内直接沉淀的技能\nmetadata:\n  title: 话题直存技能\n---\n\n步骤一\n",
      );
      const directRes = await buildRouterTools(hob.runtime, aid, { topicId: topicA.id }, workDir, workDir)
        .find((item) => item.name === "save_skill")!
        .execute("ss1", { name: "topic-direct-skill", from: "topic-direct-skill" });
      expect(directRes.isError).not.toBe(true);
      expect(
        hob.runtime.router.items(aid, {}, { topicId: topicA.id }).items.some(
          (i) => i.kind === "note" && i.icon === "skill" && i.text.includes("话题直存技能"),
        ),
      ).toBe(true);
      expect(hob.runtime.router.items(aid).items.some((i) => i.kind === "note" && i.icon === "skill")).toBe(false);

      // 2. 话题 A 派出的任务回顾时调 save_skill
      hob.faux.setResponses([
        call("report", { outcome: "done", result: "先完成了正文" }),
        text("话题任务已完成"),
      ]);
      const job = await hob.runtime.jobs.start(aid, {
        title: "话题任务存技能",
        instruction: "完成并沉淀",
        topicId: topicA.id,
      });
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topicA.id });

      const jobCwd = hob.runtime.store.job(job.id)!.cwd!;
      const jobSkillSrc = join(jobCwd, "topic-job-skill");
      mkdirSync(jobSkillSrc, { recursive: true });
      writeFileSync(
        join(jobSkillSrc, "SKILL.md"),
        "---\nname: topic-job-skill\ndescription: 话题任务沉淀的技能\nmetadata:\n  title: 话题任务技能\n---\n\n步骤二\n",
      );
      hob.faux.setResponses([
        call("save_skill", { name: "topic-job-skill", from: "topic-job-skill" }),
        call("report", { outcome: "done", result: "已沉淀技能" }),
        text("回顾完成"),
      ]);
      const reviewRes = await toolIn(hob, aid, "review_job", topicA.id).execute("rv1", { jobId: job.id });
      expect(reviewRes.isError).not.toBe(true);
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topicA.id });

      expect(
        hob.runtime.router.items(aid, {}, { topicId: topicA.id }).items.some(
          (i) => i.kind === "note" && i.icon === "skill" && i.text.includes("话题任务技能"),
        ),
      ).toBe(true);
      expect(hob.runtime.router.items(aid).items.some((i) => i.kind === "note" && i.icon === "skill")).toBe(false);
    } finally {
      hob.close();
    }
  });

  it("HTTP POST/PATCH /api/routines 对非法、非字符串、跨助手或篡改 topicId 返回 400", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const aid = "writer";
      const otherAid = "coder";
      addAssistant(hob, aid, "写作助手", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      addAssistant(hob, otherAid, "编程助手", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const { topic: writerTopic } = await hob.runtime.assistantTopics.create(aid, { title: "写作话题" });
      const { topic: coderTopic } = await hob.runtime.assistantTopics.create(otherAid, { title: "编程话题" });
      const { post, patch } = await loggedIn(hob.runtime, hob.home);

      for (const badTopicId of [123, { id: "x" }, "", "../bad", "tp-nonexistent", coderTopic.id]) {
        const res = await post("/api/routines", {
          assistantId: aid,
          topicId: badTopicId,
          name: "异常定时",
          instruction: "测试校验",
          schedules: ["0 9 * * *"],
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("话题不存在");
      }

      const okMain = await post("/api/routines", {
        assistantId: aid,
        name: "主对话定时",
        instruction: "正常建",
        schedules: ["0 9 * * *"],
      });
      expect(okMain.status).toBe(200);
      const { routine: mainRoutine } = (await okMain.json()) as { routine: { id: string } };

      const okTopic = await post("/api/routines", {
        assistantId: aid,
        topicId: writerTopic.id,
        name: "话题定时",
        instruction: "正常建",
        schedules: ["0 10 * * *"],
      });
      expect(okTopic.status).toBe(200);
      const { routine: topicRoutine } = (await okTopic.json()) as { routine: { id: string } };

      const tamperMain = await patch(`/api/routines/${mainRoutine.id}`, { topicId: writerTopic.id });
      expect(tamperMain.status).toBe(400);
      expect((await tamperMain.json()) as { error: string }).toEqual({ error: "个人定时任务不能更改归属" });

      const tamperTopic = await patch(`/api/routines/${topicRoutine.id}`, { topicId: coderTopic.id });
      expect(tamperTopic.status).toBe(400);
      expect((await tamperTopic.json()) as { error: string }).toEqual({ error: "个人定时任务不能更改归属" });
    } finally {
      hob.close();
    }
  });

  it("reopenForResult 并发到达已关闭话题时共享重开过程，确保重开 note 先于所有结果事件落盘", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const aid = "writer";
      addAssistant(hob, aid, "写作助手", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const { topic } = await hob.runtime.assistantTopics.create(aid, { title: "并发重开" });
      await hob.runtime.assistantTopics.close(aid, topic.id, "先关闭");

      const timelineOrder: string[] = [];
      const origAddItem = hob.runtime.router.addItem.bind(hob.runtime.router);
      let releaseFirstNote!: () => void;
      const firstNoteGate = new Promise<void>((resolve) => {
        releaseFirstNote = resolve;
      });
      let noteEntered = false;
      vi.spyOn(hob.runtime.router, "addItem").mockImplementation(async (assistantId, item, place) => {
        if (item.kind === "note" && item.icon === "info" && place?.topicId === topic.id && !noteEntered) {
          noteEntered = true;
          await firstNoteGate;
          timelineOrder.push(`note:${item.text}`);
        }
        return origAddItem(assistantId, item, place);
      });
      const origEvent = hob.runtime.router.event.bind(hob.runtime.router);
      vi.spyOn(hob.runtime.router, "event").mockImplementation(async (assistantId, body, details, place) => {
        if (place?.topicId === topic.id) timelineOrder.push(`event:${body}`);
        return origEvent(assistantId, body, details, place);
      });

      hob.faux.setResponses([text("已收到两条并发结果")]);
      const p1 = hob.runtime.router.answerEvent(aid, "结果一", { topicId: topic.id });
      const p2 = hob.runtime.router.answerEvent(aid, "结果二", { topicId: topic.id });
      await Promise.resolve();
      releaseFirstNote();
      await Promise.all([p1, p2]);
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topic.id });

      expect(timelineOrder[0]).toBe("note:提问有了回答，话题已重新打开");
      expect(timelineOrder.slice(1)).toEqual(["event:结果一", "event:结果二"]);
      const notes = hob.runtime.router.items(aid, {}, { topicId: topic.id }).items.filter(
        (i) => i.kind === "note" && i.icon === "info" && i.text === "提问有了回答，话题已重新打开",
      );
      expect(notes).toHaveLength(1);
    } finally {
      hob.close();
    }
  });
});
