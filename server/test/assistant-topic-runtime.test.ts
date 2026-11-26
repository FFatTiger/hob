import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../shared/i18n.ts";
import type {
  Approval,
  Assistant,
  AssistantSummary,
  AssistantTopicSummary,
  Bootstrap,
  Delegation,
  HobEvent,
  ItemsPage,
  Job,
} from "../../shared/types.ts";
import { archiveAssistant, enableAssistantTopics } from "../src/actions.ts";
import {
  archiveAssistantsDir,
  assistantTopicDir,
  assistantTopicFile,
  assistantTopicRouterPath,
  assistantTopicStatePath,
  assistantTopicTodosPath,
  assistantTodosPath,
} from "../src/config.ts";
import { TOPIC_CLOSED } from "../src/groups.ts";
import { createApp } from "../src/http.ts";
import type { HobRuntime } from "../src/runtime.ts";
import { releaseIdleTodosAtStartup, writeTodos } from "../src/todos.ts";
import { allowedWorkspaceDirs, resolveWorkspaceCwd, topicCwdLockedByAssistant } from "../src/workspace.ts";
import { call, makeHob, text, waitFor, type TestHob } from "./helpers.ts";

const extraDirs: string[] = [];

afterEach(() => {
  setLocale("zh-CN");
  vi.restoreAllMocks();
  for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "hob-topic-cwd-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  extraDirs.push(dir);
  return dir;
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function addAssistant(hob: TestHob, id = "writer", extra: Partial<Assistant> = {}): Assistant {
  const base = hob.runtime.store.assistant("hob")!;
  const assistant: Assistant = {
    ...base,
    id,
    name: "写作助手",
    duty: "周报和文档",
    primary: false,
    pinned: false,
    sprite: "page",
    createdAt: "2026-11-26T00:00:00.000Z",
    ...extra,
  };
  hob.runtime.store.saveAssistant(assistant);
  return assistant;
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
  const patch = (path: string, body: unknown) =>
    app.request(path, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { app, cookie, get, post, patch };
}

describe("助手多话题：会话隔离、SSE 与 bootstrap", () => {
  it("主对话、话题 A、话题 B 会话文件/state/items/SSE 完全隔离，且不污染 AssistantSummary", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const aid = "writer";
      addAssistant(hob, aid, { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const { get, post } = await loggedIn(hob.runtime, hob.home);

      const events: HobEvent[] = [];
      const off = hob.runtime.bus.subscribe((ev) => events.push(ev));

      // 主对话先发一条消息，记下文件与 state 校验和
      hob.faux.setResponses([text("主对话回复")]);
      const mainSend = await post(`/api/assistants/${aid}/messages`, { text: "主对话消息" });
      expect(mainSend.status).toBe(202);
      await hob.runtime.router.waitIdle(aid);

      const mainRouterFile = hob.runtime.store.routerFile(aid);
      const mainStateFile = join(hob.home, "assistants", aid, "state.json");
      const mainRouterHashBefore = sha256(mainRouterFile);
      const mainStateHashBefore = sha256(mainStateFile);
      const mainSummaryBefore = hob.runtime.router.summary(hob.runtime.store.assistant(aid)!);

      const openSpy = vi.spyOn(hob.runtime.pi, "open");
      // 创建话题 A 与话题 B 并分别发消息
      hob.faux.setResponses([text("话题 A 回复")]);
      const resA = await post(`/api/assistants/${aid}/topics`, { title: "话题甲", text: "给话题 A 发消息" });
      expect(resA.status).toBe(201);
      const bodyA = (await resA.json()) as { topic: AssistantTopicSummary; item: { id: string; text: string } };
      expect(bodyA.topic.id).toMatch(/^tp-[a-z0-9]{6}$/);
      expect(bodyA.item.text).toBe("给话题 A 发消息");
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: bodyA.topic.id });

      hob.faux.setResponses([text("话题 B 回复")]);
      const resB = await post(`/api/assistants/${aid}/topics`, { title: "话题乙", text: "给话题 B 发消息" });
      expect(resB.status).toBe(201);
      const bodyB = (await resB.json()) as { topic: AssistantTopicSummary; item: { id: string; text: string } };
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: bodyB.topic.id });

      off();

      // 主对话的 router.jsonl 与 state.json 字节未动，主对话摘要也未被话题消息改动
      expect(sha256(mainRouterFile)).toBe(mainRouterHashBefore);
      expect(sha256(mainStateFile)).toBe(mainStateHashBefore);
      const mainSummaryAfter = hob.runtime.router.summary(hob.runtime.store.assistant(aid)!);
      expect(mainSummaryAfter.last).toEqual(mainSummaryBefore.last);
      expect(mainSummaryAfter.unread).toBe(mainSummaryBefore.unread);

      // 话题 A、B 各自有独立 router.jsonl 与 state.json
      const fileA = assistantTopicRouterPath(hob.home, aid, bodyA.topic.id);
      const fileB = assistantTopicRouterPath(hob.home, aid, bodyB.topic.id);
      expect(existsSync(fileA)).toBe(true);
      expect(existsSync(fileB)).toBe(true);
      expect(existsSync(assistantTopicStatePath(hob.home, aid, bodyA.topic.id))).toBe(true);
      expect(existsSync(assistantTopicStatePath(hob.home, aid, bodyB.topic.id))).toBe(true);

      // GET /items 互不串
      const mainItems = (await (await get(`/api/assistants/${aid}/items`)).json()) as ItemsPage;
      const itemsA = (await (await get(`/api/assistants/${aid}/topics/${bodyA.topic.id}/items`)).json()) as ItemsPage;
      const itemsB = (await (await get(`/api/assistants/${aid}/topics/${bodyB.topic.id}/items`)).json()) as ItemsPage;
      expect(mainItems.items.map((item) => item.text)).toEqual(["主对话消息", "主对话回复"]);
      expect(itemsA.items.map((item) => item.text)).toEqual(["给话题 A 发消息", "话题 A 回复"]);
      expect(itemsB.items.map((item) => item.text)).toEqual(["给话题 B 发消息", "话题 B 回复"]);

      // 话题会话的 spillDir 在 topics/<tid>/spill
      const stateA = await hob.runtime.router.ensure(aid, { topicId: bodyA.topic.id });
      expect(stateA.manager!.getSessionDir()).toBe(assistantTopicDir(hob.home, aid, bodyA.topic.id));
      expect(openSpy.mock.calls.find((c) => c[0].file === fileA)?.[0].spillDir).toBe(
        join(assistantTopicDir(hob.home, aid, bodyA.topic.id), "spill"),
      );

      // SSE 事件：话题的 item / delta / router-activity 都带 topicId，且推 assistant_topic
      const topicAEvents = events.filter(
        (ev): ev is Extract<HobEvent, { type: "item" | "delta" | "router-activity" }> =>
          (ev.type === "item" || ev.type === "delta" || ev.type === "router-activity") && ev.topicId === bodyA.topic.id,
      );
      expect(topicAEvents.some((ev) => ev.type === "item" && ev.item.kind === "assistant" && ev.item.text === "话题 A 回复")).toBe(true);
      expect(topicAEvents.some((ev) => ev.type === "delta")).toBe(true);
      expect(topicAEvents.some((ev) => ev.type === "router-activity")).toBe(true);
      expect(events.some((ev) => ev.type === "assistant_topic" && ev.topic.id === bodyA.topic.id)).toBe(true);
      // 话题回合不发不带 topicId 的主对话 assistant/item 事件
      const mainEventsAfterMain = events.slice(
        events.findIndex((ev) => ev.type === "assistant_topic" && ev.topic.id === bodyA.topic.id),
      );
      expect(
        mainEventsAfterMain.some(
          (ev) => ev.type === "assistant" && ev.assistant.id === aid,
        ),
      ).toBe(false);
      expect(
        mainEventsAfterMain.some(
          (ev) => (ev.type === "item" || ev.type === "delta" || ev.type === "router-activity") && ev.assistantId === aid && !ev.topicId,
        ),
      ).toBe(false);

      // bootstrap 与 GET /topics 都返回话题列表
      const boot = (await (await get("/api/bootstrap")).json()) as Bootstrap;
      expect(boot.assistantTopics.map((t) => t.id).sort()).toEqual([bodyA.topic.id, bodyB.topic.id].sort());
      const listed = (await (await get(`/api/assistants/${aid}/topics`)).json()) as AssistantTopicSummary[];
      expect(listed.map((t) => t.id).sort()).toEqual([bodyA.topic.id, bodyB.topic.id].sort());
    } finally {
      hob.close();
    }
  });

  it("todos、reactions、提问卡过期与 delegations.takeOver 按会话严格隔离", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const aid = "writer";
      addAssistant(hob, aid, { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const { topic: topicA } = await hob.runtime.assistantTopics.create(aid, { title: "甲" });
      const { topic: topicB } = await hob.runtime.assistantTopics.create(aid, { title: "乙" });

      // 1. todos 隔离与启动闲置清理
      hob.faux.setResponses([call("update_todos", { items: [{ text: "话题A待办", status: "todo" }] }), text("好")]);
      await hob.runtime.router.send(aid, { text: "记待办" }, { topicId: topicA.id });
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topicA.id });
      // 主对话和话题 B 的 todos.json 没受影响；上面一轮结束没活了所以 releaseIdleTodos 已清，手动写入未完成的待办测启动清理和隔离
      writeTodos(assistantTopicTodosPath(hob.home, aid, topicA.id), [{ text: "A 任务", status: "doing" }]);
      writeTodos(assistantTodosPath(hob.home, aid), [{ text: "主待办", status: "todo" }]);
      expect(hob.runtime.assistantTopics.summary(aid, topicA.id).todos).toEqual([{ text: "A 任务", status: "doing" }]);
      expect(hob.runtime.assistantTopics.summary(aid, topicB.id).todos).toEqual([]);
      releaseIdleTodosAtStartup(hob.runtime);
      expect(hob.runtime.assistantTopics.summary(aid, topicA.id).todos).toEqual([]);
      expect(hob.runtime.router.summary(hob.runtime.store.assistant(aid)!).todos).toEqual([]);

      // 2. react 在话题内只写话题 state.json，不写主对话 state.json
      hob.faux.setResponses([call("react", { emoji: "👍" }), text("收到")]);
      await hob.runtime.router.send(aid, { text: "点个赞" }, { topicId: topicA.id });
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topicA.id });
      expect(hob.runtime.store.state(aid).reactions).toBeUndefined();
      expect(hob.runtime.store.assistantTopicState(aid, topicA.id).reactions).toBeTruthy();

      // 3. send 只过期同一会话的 pending router 提问卡
      const mainApproval: Approval = {
        id: "q-main",
        assistantId: aid,
        title: "主对话确认",
        options: [{ key: "A", label: "确认" }],
        status: "pending",
        source: "router",
        createdAt: "2026-11-26T01:00:00.000Z",
      };
      const topicAApproval: Approval = {
        id: "q-topic-a",
        assistantId: aid,
        topicId: topicA.id,
        title: "话题 A 确认",
        options: [{ key: "A", label: "确认" }],
        status: "pending",
        source: "router",
        createdAt: "2026-11-26T01:00:00.000Z",
      };
      const topicBApproval: Approval = {
        id: "q-topic-b",
        assistantId: aid,
        topicId: topicB.id,
        title: "话题 B 确认",
        options: [{ key: "A", label: "确认" }],
        status: "pending",
        source: "router",
        createdAt: "2026-11-26T01:00:00.000Z",
      };
      hob.runtime.store.saveApproval(mainApproval);
      hob.runtime.store.saveApproval(topicAApproval);
      hob.runtime.store.saveApproval(topicBApproval);

      hob.faux.setResponses([text("已收到")]);
      await hob.runtime.router.send(aid, { text: "新消息" }, { topicId: topicA.id });
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topicA.id });
      expect(hob.runtime.store.approval("q-topic-a")?.status).toBe("expired");
      expect(hob.runtime.store.approval("q-main")?.status).toBe("pending");
      expect(hob.runtime.store.approval("q-topic-b")?.status).toBe("pending");

      // 4. delegations.takeOver 只接管落在当前会话的转交
      const mainDelegation: Delegation = {
        id: "dg-main",
        from: "hob",
        to: aid,
        text: "主对话转交",
        createdAt: "2026-11-26T01:00:00.000Z",
        status: "running",
        jobIds: [],
      };
      const topicADelegation: Delegation = {
        id: "dg-topic-a",
        from: "hob",
        to: aid,
        toTopicId: topicA.id,
        text: "话题 A 转交",
        createdAt: "2026-11-26T01:00:00.000Z",
        status: "running",
        jobIds: [],
      };
      hob.runtime.store.saveDelegation(mainDelegation);
      hob.runtime.store.saveDelegation(topicADelegation);

      // 主对话说话只接管 mainDelegation
      hob.faux.setResponses([text("主对话接手")]);
      await hob.runtime.router.send(aid, { text: "我来接手主对话" });
      await hob.runtime.router.waitIdle(aid);
      expect(hob.runtime.store.delegation("dg-main")?.status).toBe("takenOver");
      expect(hob.runtime.store.delegation("dg-topic-a")?.status).toBe("running");

      // 话题 B 说话不接管话题 A 的转交
      hob.faux.setResponses([text("话题 B")]);
      await hob.runtime.router.send(aid, { text: "话题 B 消息" }, { topicId: topicB.id });
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topicB.id });
      expect(hob.runtime.store.delegation("dg-topic-a")?.status).toBe("running");

      // 话题 A 说话接管话题 A 的转交
      hob.faux.setResponses([text("话题 A 接手")]);
      await hob.runtime.router.send(aid, { text: "我来接手话题 A" }, { topicId: topicA.id });
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topicA.id });
      expect(hob.runtime.store.delegation("dg-topic-a")?.status).toBe("takenOver");
    } finally {
      hob.close();
    }
  });

  it("未配置模型时发话题消息仍写入话题 router.jsonl 并推带 topicId 的条目", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const aid = "writer";
      addAssistant(hob, aid, { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const { post, get } = await loggedIn(hob.runtime, hob.home);
      const { topic } = await hob.runtime.assistantTopics.create(aid, { title: "无模型话题" });

      // 清空模型配置
      const rev = hob.runtime.settings.get().revision;
      hob.runtime.settings.patch(rev, {
        models: { roster: [], conversation: { ref: "", thinking: "off" }, work: { ref: "", thinking: "off" }, suggest: null },
      });

      const events: HobEvent[] = [];
      const off = hob.runtime.bus.subscribe((ev) => events.push(ev));
      const res = await post(`/api/assistants/${aid}/topics/${topic.id}/messages`, { text: "你好" });
      expect(res.status).toBe(202);
      off();

      const items = (await (await get(`/api/assistants/${aid}/topics/${topic.id}/items`)).json()) as ItemsPage;
      expect(items.items.map((item) => item.kind)).toEqual(["user", "note"]);
      expect(existsSync(hob.runtime.store.routerFile(aid))).toBe(false);
      expect(events.filter((ev) => ev.type === "item" && ev.topicId === topic.id)).toHaveLength(2);
    } finally {
      hob.close();
    }
  });
});

describe("助手多话题：生命周期、校验、已读与停止", () => {
  it("校验单会话助手、主助手、标题超 40 字、跨助手/不存在 404 及语言翻译", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "solo");
      addAssistant(hob, "multi", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      addAssistant(hob, "other", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const { get, post, patch } = await loggedIn(hob.runtime, hob.home);

      // 单会话助手与主助手建话题均回 400
      const soloRes = await post("/api/assistants/solo/topics", { title: "测试" });
      expect(soloRes.status).toBe(400);
      expect(await soloRes.json()).toEqual({ error: "这个助手是单会话模式，先在助手设置里改成多话题" });

      const hobRes = await post("/api/assistants/hob/topics", { title: "测试" });
      expect(hobRes.status).toBe(400);

      // 英文模式错误翻译
      setLocale("en");
      const soloEn = await post("/api/assistants/solo/topics", { title: "Test" });
      expect(soloEn.status).toBe(400);
      expect(await soloEn.json()).toEqual({ error: "This assistant uses a single conversation. Switch it to topics in its settings first." });
      setLocale("zh-CN");

      // 标题超 40 字报 400 并给出字数
      const longTitle = "一".repeat(41);
      const longRes = await post("/api/assistants/multi/topics", { title: longTitle });
      expect(longRes.status).toBe(400);
      const longBody = (await longRes.json()) as { error: string };
      expect(longBody.error).toContain("40");
      expect(longBody.error).toContain("41");

      // 创建多话题助手的话题
      const created = (await (await post("/api/assistants/multi/topics", { title: "正常标题" })).json()) as { topic: AssistantTopicSummary };
      const tid = created.topic.id;

      // 话题不属于该助手 / 助手不存在 / 话题不存在 → 所有 :tid 接口 404
      for (const [method, path, body] of [
        ["GET", `/api/assistants/other/topics/${tid}/items`],
        ["GET", `/api/assistants/missing/topics/${tid}/items`],
        ["GET", `/api/assistants/multi/topics/tp-missing/items`],
        ["PATCH", `/api/assistants/other/topics/${tid}`, { title: "改名" }],
        ["POST", `/api/assistants/other/topics/${tid}/close`, { note: "关" }],
        ["POST", `/api/assistants/other/topics/${tid}/reopen`],
        ["POST", `/api/assistants/other/topics/${tid}/messages`, { text: "hi" }],
        ["POST", `/api/assistants/other/topics/${tid}/read`],
        ["POST", `/api/assistants/other/topics/${tid}/stop`],
      ] as const) {
        const res = method === "GET" ? await get(path) : method === "PATCH" ? await patch(path, body) : await post(path, body);
        expect(res.status, `${method} ${path}`).toBe(404);
      }

      // 空改名与超长改名 400；传 cwd 400
      expect((await patch(`/api/assistants/multi/topics/${tid}`, { title: "  " })).status).toBe(400);
      expect((await patch(`/api/assistants/multi/topics/${tid}`, { title: "字".repeat(41) })).status).toBe(400);
      expect((await patch(`/api/assistants/multi/topics/${tid}`, { cwd: "/tmp" })).status).toBe(400);
    } finally {
      hob.close();
    }
  });

  it("关闭、幂等、重开、未完成待办清理、关闭后发消息 400、已读/未读与停止隔离", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const aid = "writer";
      addAssistant(hob, aid, { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const { get, post, patch } = await loggedIn(hob.runtime, hob.home);

      hob.faux.setResponses([text("第一句回复")]);
      const resA = await post(`/api/assistants/${aid}/topics`, { title: "话题甲", text: "开始" });
      const topicA = ((await resA.json()) as { topic: AssistantTopicSummary }).topic;
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topicA.id });

      const resB = await post(`/api/assistants/${aid}/topics`, { title: "话题乙" });
      const topicB = ((await resB.json()) as { topic: AssistantTopicSummary }).topic;

      // 话题 A 有 1 条未读，读后归零并推 assistant_topic
      expect(hob.runtime.assistantTopics.summary(aid, topicA.id).unread).toBe(1);
      const events: HobEvent[] = [];
      const off = hob.runtime.bus.subscribe((ev) => events.push(ev));
      const readRes = await post(`/api/assistants/${aid}/topics/${topicA.id}/read`);
      expect(readRes.status).toBe(200);
      expect(hob.runtime.assistantTopics.summary(aid, topicA.id).unread).toBe(0);
      expect(events.some((ev) => ev.type === "assistant_topic" && ev.topic.id === topicA.id && ev.topic.unread === 0)).toBe(true);

      // 写入未完成待办，关闭时清空；关闭不中止正在跑的回合或任务
      writeTodos(assistantTopicTodosPath(hob.home, aid, topicA.id), [{ text: "未完成待办", status: "doing" }]);
      const runningJob: Job = {
        id: "t-topic-run",
        assistantId: aid,
        topicId: topicA.id,
        title: "跑着的活",
        instruction: "继续",
        status: "running",
        createdAt: "2026-11-26T01:00:00.000Z",
        stats: { reads: 0, commands: 0, edits: 0 },
        activity: [],
      };
      hob.runtime.store.saveJob(runningJob);

      const closeRes = await post(`/api/assistants/${aid}/topics/${topicA.id}/close`, { note: "先告一段落" });
      expect(closeRes.status).toBe(200);
      const closed = (await closeRes.json()) as AssistantTopicSummary;
      expect(closed.closedAt).toBeTruthy();
      expect(closed.closeNote).toBe("先告一段落");
      expect(closed.todos).toEqual([]);
      expect(hob.runtime.store.job("t-topic-run")?.status).toBe("running");

      // 幂等再关一次保留原 closedAt 与 closeNote
      const closeAgain = (await (await post(`/api/assistants/${aid}/topics/${topicA.id}/close`)).json()) as AssistantTopicSummary;
      expect(closeAgain.closedAt).toBe(closed.closedAt);
      expect(closeAgain.closeNote).toBe("先告一段落");

      // 已关闭话题发消息回 400 TOPIC_CLOSED
      const closedSend = await post(`/api/assistants/${aid}/topics/${topicA.id}/messages`, { text: "还能发吗" });
      expect(closedSend.status).toBe(400);
      expect(await closedSend.json()).toEqual({ error: TOPIC_CLOSED });

      // 重开后清掉 closedAt/closeNote，可继续发消息
      const reopenRes = await post(`/api/assistants/${aid}/topics/${topicA.id}/reopen`);
      expect(reopenRes.status).toBe(200);
      const reopened = (await reopenRes.json()) as AssistantTopicSummary;
      expect(reopened.closedAt).toBeUndefined();
      expect(reopened.closeNote).toBeUndefined();

      hob.faux.setResponses([text("重开后的回复")]);
      const reopenedSend = await post(`/api/assistants/${aid}/topics/${topicA.id}/messages`, { text: "继续聊" });
      expect(reopenedSend.status).toBe(202);
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topicA.id });
      const itemsAfter = (await (await get(`/api/assistants/${aid}/topics/${topicA.id}/items`)).json()) as ItemsPage;
      expect(itemsAfter.items.at(-1)).toMatchObject({ kind: "assistant", text: "重开后的回复" });

      // 停止话题 A 不影响话题 B 或主对话
      const stateA = await hob.runtime.router.ensure(aid, { topicId: topicA.id });
      const stateB = await hob.runtime.router.ensure(aid, { topicId: topicB.id });
      const abortA = vi.spyOn(stateA.session!, "abort");
      const abortB = vi.spyOn(stateB.session!, "abort");
      const stopRes = await post(`/api/assistants/${aid}/topics/${topicA.id}/stop`);
      expect(stopRes.status).toBe(200);
      expect(abortA).toHaveBeenCalledOnce();
      expect(abortB).not.toHaveBeenCalled();

      // 手动改名更新 name 并去掉 nameAuto
      const autoCreated = (await (await post(`/api/assistants/${aid}/topics`, { text: "先用自动标题" })).json()) as { topic: AssistantTopicSummary };
      expect(autoCreated.topic.nameAuto).toBe(true);
      const renamed = (await (await patch(`/api/assistants/${aid}/topics/${autoCreated.topic.id}`, { title: "手动标题" })).json()) as AssistantTopicSummary;
      expect(renamed.name).toBe("手动标题");
      expect(renamed.nameAuto).toBeUndefined();
      off();
    } finally {
      hob.close();
    }
  });
});

describe("助手多话题：自动起名", () => {
  it("无模型时保留去 Markdown 截断名；空文本使用默认名并标 nameAuto", async () => {
    const hob = makeHob({}, { memory: "off" }); // suggest: null（无模型）
    try {
      const aid = "writer";
      addAssistant(hob, aid, { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const { post } = await loggedIn(hob.runtime, hob.home);

      hob.faux.setResponses([text("收到")]);
      const mdText = "# **请帮我整理下个月[搬家清单](https://example.com)的详细步骤**\n第二行忽略";
      const res = await post(`/api/assistants/${aid}/topics`, { text: mdText });
      expect(res.status).toBe(201);
      const { topic } = (await res.json()) as { topic: AssistantTopicSummary };
      expect(topic.name).toBe("请帮我整理下个月搬家清单的详细步骤");
      expect(topic.nameAuto).toBe(true);

      // 超过 20 字截断加「…」
      hob.faux.setResponses([text("收到")]);
      const longFirstLine = "这是一个超过二十个字符的Markdown标题测试内容用于验证截断";
      const resLong = await post(`/api/assistants/${aid}/topics`, { text: `**${longFirstLine}**` });
      const { topic: longTopic } = (await resLong.json()) as { topic: AssistantTopicSummary };
      expect(longTopic.name).toBe(`${[...longFirstLine].slice(0, 20).join("")}…`);
      expect(longTopic.nameAuto).toBe(true);

      // 没有传 text 时用默认名并标 nameAuto
      const resEmpty = await post(`/api/assistants/${aid}/topics`, {});
      const { topic: emptyTopic } = (await resEmpty.json()) as { topic: AssistantTopicSummary };
      expect(emptyTopic.name).toBe("新话题");
      expect(emptyTopic.nameAuto).toBe(true);

      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topic.id });
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: longTopic.id });
      expect(hob.runtime.store.assistantTopic(aid, longTopic.id)?.name).toBe(longTopic.name);
    } finally {
      hob.close();
    }
  });

  it("有模型时异步替换为不超过 12 字名字并推 SSE；手动改名在模型回来前生效则不覆盖", async () => {
    const hob = makeHob({}, {
      memory: "off",
      models: [{ id: "faux-1" }, { id: "faux-namer" }],
      settings: { models: { roster: [{ ref: "hob-faux/faux-1", note: "" }, { ref: "hob-faux/faux-namer", note: "" }], conversation: { ref: "hob-faux/faux-1", thinking: "off" }, work: { ref: "hob-faux/faux-1", thinking: "off" }, suggest: { ref: "hob-faux/faux-namer", thinking: "off" } } },
    });
    try {
      const aid = "writer";
      addAssistant(hob, aid, { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const { post, patch } = await loggedIn(hob.runtime, hob.home);

      const piRuntime = await hob.runtime.pi.runtime();
      let resolveFirstName!: (value: unknown) => void;
      let autoNameCalls = 0;
      vi.spyOn(piRuntime, "completeSimple").mockImplementation((async (_model, context) => {
        if (!context.systemPrompt?.includes("起一个简短的话题标题")) {
          return fauxAssistantMessage("[]");
        }
        autoNameCalls += 1;
        if (autoNameCalls === 1) {
          // 超过 12 字应被裁剪到 12 字
          return fauxAssistantMessage("「下个月初跨城搬家详细日程安排表」");
        }
        return await new Promise((resolve) => { resolveFirstName = resolve; });
      }) as typeof piRuntime.completeSimple);

      const events: HobEvent[] = [];
      const off = hob.runtime.bus.subscribe((ev) => events.push(ev));

      hob.faux.setResponses([text("已收到搬家消息")]);
      const res1 = await post(`/api/assistants/${aid}/topics`, {
        text: "帮我规划下个月跨城搬家的全部步骤和打包清单",
      });
      expect(res1.status).toBe(201);
      const t1 = ((await res1.json()) as { topic: AssistantTopicSummary }).topic;
      expect(t1.name).toBe("帮我规划下个月跨城搬家的全部步骤和打包清…");

      // 等待异步起名完成并推 assistant_topic SSE
      await waitFor(() => hob.runtime.store.assistantTopic(aid, t1.id)?.name !== t1.name);
      const updated1 = hob.runtime.store.assistantTopic(aid, t1.id)!;
      expect([...updated1.name].length).toBeLessThanOrEqual(12);
      expect(updated1.name).toBe("下个月初跨城搬家详细日程");
      expect(events.some((ev) => ev.type === "assistant_topic" && ev.topic.id === t1.id && ev.topic.name === "下个月初跨城搬家详细日程")).toBe(true);
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: t1.id });

      // 场景 2：模型回来前用户已手动改名，模型回来绝对不覆盖
      hob.faux.setResponses([text("已收到")]);
      const res2 = await post(`/api/assistants/${aid}/topics`, { text: "再帮我整理税务申报材料" });
      const t2 = ((await res2.json()) as { topic: AssistantTopicSummary }).topic;
      await waitFor(() => typeof resolveFirstName === "function");

      const manualRes = await patch(`/api/assistants/${aid}/topics/${t2.id}`, { title: "用户手动名字" });
      expect(manualRes.status).toBe(200);
      expect(hob.runtime.store.assistantTopic(aid, t2.id)?.nameAuto).toBeUndefined();

      resolveFirstName(fauxAssistantMessage("模型后起的名字"));
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(hob.runtime.store.assistantTopic(aid, t2.id)?.name).toBe("用户手动名字");
      expect(hob.runtime.store.assistantTopic(aid, t2.id)?.nameAuto).toBeUndefined();
      // 3. 场景 3：无 text（仅 files）时使用默认名、不调用自动起名；模型报错时保留截断名
      const callsBeforeFiles = autoNameCalls;
      const uploadDir = join(hob.home, "assistants", aid, "files", "uploads");
      mkdirSync(uploadDir, { recursive: true });
      const docPath = join(uploadDir, "doc.txt");
      writeFileSync(docPath, "test upload");
      hob.faux.setResponses([text("收到文件")]);
      const res3 = await post(`/api/assistants/${aid}/topics`, {
        files: [docPath],
      });
      expect(res3.status).toBe(201);
      const t3 = ((await res3.json()) as { topic: AssistantTopicSummary; item: { files?: string[] } });
      expect(t3.topic.name).toBe("新话题");
      expect(t3.topic.nameAuto).toBe(true);
      expect(t3.item.files).toHaveLength(1);
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: t3.topic.id });
      expect(autoNameCalls).toBe(callsBeforeFiles);

      // 验证 completeSimple 返回 error 时静默保留截断名
      let failCall = false;
      vi.restoreAllMocks();
      vi.spyOn(piRuntime, "completeSimple").mockImplementation((async (_model, context) => {
        if (!context.systemPrompt?.includes("起一个简短的话题标题")) {
          return fauxAssistantMessage("[]");
        }
        failCall = true;
        return { ...fauxAssistantMessage(""), stopReason: "error" as const, errorMessage: "boom" };
      }) as typeof piRuntime.completeSimple);
      hob.faux.setResponses([text("收到报错场景")]);
      const res4 = await post(`/api/assistants/${aid}/topics`, { text: "失败时保留这段截断的初始标题不变更" });
      const t4 = ((await res4.json()) as { topic: AssistantTopicSummary }).topic;
      await waitFor(() => failCall);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(hob.runtime.store.assistantTopic(aid, t4.id)?.name).toBe(t4.name);
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: t4.id });
      off();
    } finally {
      hob.close();
    }
  });
});

describe("助手多话题：工作目录", () => {
  it("助手已绑目录时建话题传 cwd 报 400 且会话沿用助手目录；助手未绑时话题 cwd 校验并生效", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const boundDir = realpathSync(tempDir("hob-bound-"));
      const topicDir = realpathSync(tempDir("hob-topic-"));
      const otherDir = realpathSync(tempDir("hob-other-"));

      addAssistant(hob, "bound-a", { cwd: boundDir, topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      addAssistant(hob, "free-a", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const { post } = await loggedIn(hob.runtime, hob.home);

      // 1. 助手已绑目录时建话题传 cwd 报 400
      const lockedRes = await post("/api/assistants/bound-a/topics", { title: "测试", cwd: otherDir });
      expect(lockedRes.status).toBe(400);
      expect(await lockedRes.json()).toEqual({ error: topicCwdLockedByAssistant(boundDir) });

      // 不传 cwd 创建成功，resolveWorkspaceCwd 返回 source: "assistant"
      const boundTopicRes = await post("/api/assistants/bound-a/topics", { title: "跟随助手目录" });
      expect(boundTopicRes.status).toBe(201);
      const boundTopic = ((await boundTopicRes.json()) as { topic: AssistantTopicSummary }).topic;
      expect(resolveWorkspaceCwd(hob.runtime.store, hob.home, "bound-a", { topicId: boundTopic.id })).toEqual({
        bound: boundDir,
        source: "assistant",
        sessionCwd: boundDir,
      });

      // 2. 助手未绑目录：非法 cwd 报 400，合法 cwd 生效且 resolveWorkspaceCwd 返回 source: "topic"
      const badCwdRes = await post("/api/assistants/free-a/topics", { title: "坏目录", cwd: "relative/path" });
      expect(badCwdRes.status).toBe(400);
      const homeCwdRes = await post("/api/assistants/free-a/topics", { title: "数据目录", cwd: hob.home });
      expect(homeCwdRes.status).toBe(400);

      writeFileSync(join(topicDir, "AGENTS.md"), "# 话题规则\n仅在本话题目录生效\n");
      hob.faux.setResponses([text("已读取话题目录")]);
      const freeTopicRes = await post("/api/assistants/free-a/topics", {
        title: "话题目录",
        cwd: topicDir,
        text: "看看当前目录",
      });
      expect(freeTopicRes.status).toBe(201);
      const freeTopic = ((await freeTopicRes.json()) as { topic: AssistantTopicSummary }).topic;
      expect(freeTopic.cwd).toBe(topicDir);
      expect(resolveWorkspaceCwd(hob.runtime.store, hob.home, "free-a", { topicId: freeTopic.id })).toEqual({
        bound: topicDir,
        source: "topic",
        sessionCwd: topicDir,
      });
      expect(allowedWorkspaceDirs(hob.runtime.store)).toContain(topicDir);

      await hob.runtime.router.waitIdle("free-a", 10_000, { topicId: freeTopic.id });
      const state = await hob.runtime.router.ensure("free-a", { topicId: freeTopic.id });
      expect(state.session!.systemPrompt).toContain(`当前工作目录：${topicDir}（来源：本话题）`);
    } finally {
      hob.close();
    }
  });
});

describe("助手多话题：归档助手", () => {
  it("话题中有在跑任务时拒绝归档；可归档时 topics/ 随目录迁入归档、话题提问卡标 expired、话题会话句柄关闭", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const aid = "writer";
      addAssistant(hob, aid);
      await enableAssistantTopics(hob.runtime, aid);

      hob.faux.setResponses([text("话题里回复")]);
      const { topic } = await hob.runtime.assistantTopics.create(aid, { title: "归档测试话题", text: "记下来" });
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topic.id });
      writeTodos(assistantTopicTodosPath(hob.home, aid, topic.id), [{ text: "归档前待办", status: "todo" }]);

      // 话题内的待答提问卡
      const topicApproval: Approval = {
        id: "q-in-topic",
        assistantId: aid,
        topicId: topic.id,
        title: "是否继续",
        options: [{ key: "A", label: "继续" }],
        status: "pending",
        source: "router",
        createdAt: "2026-11-26T01:00:00.000Z",
      };
      hob.runtime.store.saveApproval(topicApproval);

      // 话题内有运行中任务时拒绝归档
      const liveJob: Job = {
        id: "t-live-topic",
        assistantId: aid,
        topicId: topic.id,
        title: "话题任务",
        instruction: "运行中",
        status: "running",
        createdAt: "2026-11-26T01:00:00.000Z",
        stats: { reads: 0, commands: 0, edits: 0 },
        activity: [],
      };
      hob.runtime.store.saveJob(liveJob);
      const blocked = await archiveAssistant(hob.runtime, aid);
      expect(blocked.status).toBe(409);

      // 任务结束后归档成功
      hob.runtime.store.saveJob({ ...liveJob, status: "done", endedAt: "2026-11-26T01:05:00.000Z" });
      const state = await hob.runtime.router.ensure(aid, { topicId: topic.id });
      const disposeSpy = vi.spyOn(state.session!, "dispose");

      const events: HobEvent[] = [];
      const off = hob.runtime.bus.subscribe((ev) => events.push(ev));
      const archived = await archiveAssistant(hob.runtime, aid);
      off();
      expect(archived.status).toBe(200);

      // 话题会话句柄已关闭释放
      expect(disposeSpy).toHaveBeenCalled();
      // 话题内未答提问卡标 expired
      expect(hob.runtime.store.approval("q-in-topic")?.status).toBe("expired");
      expect(events.some((ev) => ev.type === "approval" && ev.approval.id === "q-in-topic" && ev.approval.status === "expired")).toBe(true);
      expect(events.some((ev) => ev.type === "assistant_removed" && ev.id === aid)).toBe(true);

      // topics/ 完整迁入归档目录
      expect(existsSync(assistantTopicFile(hob.home, aid, topic.id))).toBe(false);
      const archiveRoot = archiveAssistantsDir(hob.home);
      const archivedDirName = (await import("node:fs")).readdirSync(archiveRoot).find((name) => name.startsWith(`${aid}-`));
      expect(archivedDirName).toBeTruthy();
      const archivedTopicDir = join(archiveRoot, archivedDirName!, "topics", topic.id);
      expect(existsSync(join(archivedTopicDir, "topic.json"))).toBe(true);
      expect(existsSync(join(archivedTopicDir, "router.jsonl"))).toBe(true);
      expect(existsSync(join(archivedTopicDir, "state.json"))).toBe(true);
      expect(existsSync(join(archivedTopicDir, "todos.json"))).toBe(true);
    } finally {
      hob.close();
    }
  });
});
