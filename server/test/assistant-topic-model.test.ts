import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../../shared/i18n.ts";
import type { Assistant, AssistantSummary, AssistantTopic, Draft, HobEvent } from "../../shared/types.ts";
import {
  assistantTopicDir,
  assistantTopicFile,
  assistantTopicRouterPath,
  assistantTopicRuleOverridesPath,
  assistantTopicsDir,
  assistantTopicStatePath,
  assistantTopicTodosPath,
  assistantTodosPath,
  LAYOUT_VERSION,
} from "../src/config.ts";
import { createApp } from "../src/http.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import type { HobRuntime } from "../src/runtime.ts";
import { Store } from "../src/store.ts";
import { makeHob, text, waitFor, type TestHob } from "./helpers.ts";

afterEach(() => setLocale("zh-CN"));

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
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

async function appWithCookie(runtime: HobRuntime, home: string) {
  const app = createApp(runtime, { home });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test" }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  return { app, cookie };
}

describe("助手多话题：存储路径与 Store helper", () => {
  it("路径 helper、读写 AssistantTopic、空目录、坏文件抛错、state 局部更新与老数据兼容", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const store = hob.runtime.store;
      const aid = "writer";
      addAssistant(hob, aid);

      expect(LAYOUT_VERSION).toBe(2);
      expect(assistantTopicsDir(hob.home, aid)).toBe(join(hob.home, "assistants", aid, "topics"));
      expect(assistantTopicDir(hob.home, aid, "tp-1")).toBe(join(hob.home, "assistants", aid, "topics", "tp-1"));
      expect(assistantTopicTodosPath(hob.home, aid, "tp-1")).toBe(join(hob.home, "assistants", aid, "topics", "tp-1", "todos.json"));
      expect(assistantTopicFile(hob.home, aid, "tp-1")).toBe(join(hob.home, "assistants", aid, "topics", "tp-1", "topic.json"));
      expect(assistantTopicStatePath(hob.home, aid, "tp-1")).toBe(join(hob.home, "assistants", aid, "topics", "tp-1", "state.json"));
      expect(assistantTopicRuleOverridesPath(hob.home, aid, "tp-1")).toBe(join(hob.home, "assistants", aid, "topics", "tp-1", "rule-overrides.json"));
      expect(assistantTopicRouterPath(hob.home, aid, "tp-1")).toBe(join(hob.home, "assistants", aid, "topics", "tp-1", "router.jsonl"));
      expect(store.assistantTopicRouterFile(aid, "tp-1")).toBe(assistantTopicRouterPath(hob.home, aid, "tp-1"));

      // 老数据：没有 topics 字段读出就是单会话，没有 topics/ 目录返回 []
      expect(store.assistant(aid)?.topics).toBeUndefined();
      expect(store.assistantTopics(aid)).toEqual([]);
      expect(store.assistantTopic(aid, "tp-missing")).toBeUndefined();

      const t2: AssistantTopic = {
        id: "tp-second",
        assistantId: aid,
        name: "第二个话题",
        nameAuto: true,
        cwd: "/tmp/work",
        overrides: { models: { work: { ref: "hob-faux/faux-1", thinking: "low" } } },
        createdAt: "2026-11-26T02:00:00.000Z",
        createdBy: aid,
        closedAt: "2026-11-26T03:00:00.000Z",
        closeNote: "已完成",
      };
      const t1: AssistantTopic = {
        id: "tp-first",
        assistantId: aid,
        name: "第一个话题",
        createdAt: "2026-11-26T01:00:00.000Z",
        createdBy: "user",
      };
      store.saveAssistantTopic(t2);
      store.saveAssistantTopic(t1);

      // topics/ 下的非目录文件忽略，按 createdAt 排序
      writeFileSync(join(assistantTopicsDir(hob.home, aid), ".DS_Store"), "junk");
      const reopened = new Store(hob.home);
      expect(reopened.assistantTopic(aid, "tp-first")).toEqual(t1);
      expect(reopened.assistantTopic(aid, "tp-second")).toEqual(t2);
      expect(reopened.assistantTopics(aid)).toEqual([t1, t2]);

      // state 读写支持局部合并
      expect(reopened.assistantTopicState(aid, "tp-first")).toEqual({});
      reopened.saveAssistantTopicState(aid, "tp-first", { readAt: "2026-11-26T01:05:00.000Z" });
      reopened.saveAssistantTopicState(aid, "tp-first", { reactions: { m1: { user: "👍" } } });
      expect(reopened.assistantTopicState(aid, "tp-first")).toEqual({
        readAt: "2026-11-26T01:05:00.000Z",
        reactions: { m1: { user: "👍" } },
      });

      // topic.json 读坏必须抛错（不能悄悄吞掉）
      const badDir = assistantTopicDir(hob.home, aid, "tp-bad");
      mkdirSync(badDir, { recursive: true });
      writeFileSync(join(badDir, "topic.json"), "{坏掉的 JSON");
      expect(() => reopened.assistantTopic(aid, "tp-bad")).toThrow(join(badDir, "topic.json"));
      expect(() => reopened.assistantTopics(aid)).toThrow(join(badDir, "topic.json"));
      expect(() => reopened.validate()).toThrow(join(badDir, "topic.json"));

      // 非法结构也抛错
      writeFileSync(join(badDir, "topic.json"), "[]");
      expect(() => reopened.assistantTopic(aid, "tp-bad")).toThrow(join(badDir, "topic.json"));
    } finally {
      hob.close();
    }
  });
});

describe("助手多话题：POST /api/assistants/:id/topic-mode 与单向约束", () => {
  it("校验 404 与主助手 400（含英文翻译），正常开启、幂等与 PATCH 忽略 topics", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "writer");
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const events: HobEvent[] = [];
      const off = hob.runtime.bus.subscribe((ev) => events.push(ev));

      // 不存在 404
      const notFound = await app.request("/api/assistants/nope/topic-mode", {
        method: "POST",
        headers: { cookie },
      });
      expect(notFound.status).toBe(404);

      // 主助手 400
      const primaryDenied = await app.request("/api/assistants/hob/topic-mode", {
        method: "POST",
        headers: { cookie },
      });
      expect(primaryDenied.status).toBe(400);
      expect(await primaryDenied.json()).toEqual({ error: "主助手暂不支持多话题" });

      // PATCH 传 topics 到单会话助手时被忽略
      const ignoredSingle = await app.request("/api/assistants/writer", {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ topics: { enabledAt: "2020-01-01T00:00:00.000Z" } }),
      });
      expect(ignoredSingle.status).toBe(200);
      expect(hob.runtime.store.assistant("writer")?.topics).toBeUndefined();

      // 首次开启多话题
      const enabled = await app.request("/api/assistants/writer/topic-mode", {
        method: "POST",
        headers: { cookie },
      });
      expect(enabled.status).toBe(200);
      const summary1 = (await enabled.json()) as AssistantSummary;
      expect(summary1.topics?.enabledAt).toBeTruthy();
      expect(hob.runtime.store.assistant("writer")?.topics).toEqual(summary1.topics);
      expect(events.some((ev) => ev.type === "item" && ev.assistantId === "writer" && ev.item.kind === "note" && ev.item.text === "已开启多话题，这里是主对话")).toBe(true);
      expect(events.some((ev) => ev.type === "assistant" && ev.assistant.id === "writer" && ev.assistant.topics?.enabledAt === summary1.topics?.enabledAt)).toBe(true);

      // 幂等重复调用：不改 enabledAt，不重复写分隔 note，router.jsonl 字节完全不变
      const routerFile = hob.runtime.store.routerFile("writer");
      const beforeRepeat = readFileSync(routerFile);
      const again = await app.request("/api/assistants/writer/topic-mode", {
        method: "POST",
        headers: { cookie },
      });
      expect(again.status).toBe(200);
      const summary2 = (await again.json()) as AssistantSummary;
      expect(summary2.topics).toEqual(summary1.topics);
      expect(sha256(readFileSync(routerFile))).toBe(sha256(beforeRepeat));

      // 单向约束：PATCH 传 topics: null 或新日期时保留原值
      for (const payload of [{ topics: null }, { topics: false }, { topics: { enabledAt: "2020-01-01T00:00:00.000Z" } }]) {
        const res = await app.request("/api/assistants/writer", {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { assistant: AssistantSummary };
        expect(body.assistant.topics).toEqual(summary1.topics);
        expect(hob.runtime.store.assistant("writer")?.topics).toEqual(summary1.topics);
      }
      off();
    } finally {
      hob.close();
    }
  });

  it("英文界面语言下主助手报错与分隔 note 均翻译", async () => {
    const hob = makeHob({}, { settings: { general: { locale: "en" } }, memory: "off" });
    try {
      addAssistant(hob, "writer");
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);

      const primaryDenied = await app.request("/api/assistants/hob/topic-mode", {
        method: "POST",
        headers: { cookie },
      });
      expect(primaryDenied.status).toBe(400);
      expect(await primaryDenied.json()).toEqual({ error: "The main assistant doesn't support topics yet." });

      const okRes = await app.request("/api/assistants/writer/topic-mode", {
        method: "POST",
        headers: { cookie },
      });
      expect(okRes.status).toBe(200);
      const notes = hob.runtime.router.items("writer").items.filter((item) => item.kind === "note");
      expect(notes.at(-1)).toMatchObject({ kind: "note", icon: "info", text: "Topics are on. This is the main conversation." });
    } finally {
      hob.close();
    }
  });

  it("无损转换：router.jsonl 前缀字节与模型上下文完全不变、末尾仅追加 1 条 hob.item note、state/todos/approvals/job 不变", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "writer");
      hob.faux.setResponses([text("第一轮回复"), text("第二轮回复")]);
      await hob.runtime.router.send("writer", { text: "帮我记一件事" });
      await hob.runtime.router.waitIdle("writer");

      // 准备 state.json / todos.json / approvals.json / job.json
      hob.runtime.store.saveState("writer", { readAt: "2026-11-26T00:10:00.000Z" });
      const todosPath = assistantTodosPath(hob.home, "writer");
      writeFileSync(todosPath, JSON.stringify([{ text: "整理大纲", done: false }]));
      hob.runtime.store.saveApproval({
        id: "q-1",
        assistantId: "writer",
        title: "要继续吗？",
        options: [{ key: "A", label: "继续" }],
        status: "pending",
        source: "router",
        createdAt: "2026-11-26T00:11:00.000Z",
      });
      hob.runtime.store.saveJob({
        id: "t-1",
        assistantId: "writer",
        title: "写作任务",
        instruction: "写初稿",
        status: "done",
        createdAt: "2026-11-26T00:12:00.000Z",
        stats: { reads: 0, commands: 0, edits: 0 },
        activity: [],
      });

      const routerFile = hob.runtime.store.routerFile("writer");
      const stateFile = join(hob.home, "assistants", "writer", "state.json");
      const approvalsFile = join(hob.home, "assistants", "writer", "approvals.json");
      const jobFile = join(hob.home, "assistants", "writer", "jobs", "t-1", "job.json");

      const beforeRouter = readFileSync(routerFile);
      const beforeRouterHash = sha256(beforeRouter);
      const beforeStateHash = sha256(readFileSync(stateFile));
      const beforeTodosHash = sha256(readFileSync(todosPath));
      const beforeApprovalsHash = sha256(readFileSync(approvalsFile));
      const beforeJobHash = sha256(readFileSync(jobFile));
      const beforeContext = SessionManager.open(routerFile, dirname(routerFile), hob.home).buildSessionContext().messages;

      // 当前空闲会话处于打开状态：开启多话题后应立刻释放
      expect((hob.runtime.router as any).routers.get("writer")?.session).toBeDefined();

      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const res = await app.request("/api/assistants/writer/topic-mode", {
        method: "POST",
        headers: { cookie },
      });
      expect(res.status).toBe(200);

      // 空闲会话句柄已释放
      expect((hob.runtime.router as any).routers.get("writer")?.session).toBeUndefined();

      // router.jsonl 前缀字节一字未改，末尾仅多 1 行 hob.item note
      const afterRouter = readFileSync(routerFile);
      expect(afterRouter.length).toBeGreaterThan(beforeRouter.length);
      expect(sha256(afterRouter.subarray(0, beforeRouter.length))).toBe(beforeRouterHash);
      const tailText = afterRouter.subarray(beforeRouter.length).toString("utf8");
      const tailLines = tailText.split("\n").filter((line) => line.trim().length > 0);
      expect(tailLines).toHaveLength(1);
      expect(JSON.parse(tailLines[0])).toMatchObject({
        type: "custom",
        customType: "hob.item",
        data: { kind: "note", icon: "info", text: "已开启多话题，这里是主对话" },
      });

      // 重新打开后模型上下文完全一致（note 不进模型上下文）
      const afterContext = SessionManager.open(routerFile, dirname(routerFile), hob.home).buildSessionContext().messages;
      expect(afterContext).toEqual(beforeContext);

      // state.json / todos.json / approvals.json / job.json 字节完全不变
      expect(sha256(readFileSync(stateFile))).toBe(beforeStateHash);
      expect(sha256(readFileSync(todosPath))).toBe(beforeTodosHash);
      expect(sha256(readFileSync(approvalsFile))).toBe(beforeApprovalsHash);
      expect(sha256(readFileSync(jobFile))).toBe(beforeJobHash);

      // 下一轮重新打开会话且能正常接着聊
      await hob.runtime.router.send("writer", { text: "继续刚才的话题" });
      await hob.runtime.router.waitIdle("writer");
      const items = hob.runtime.router.items("writer").items;
      expect(items.some((item) => item.kind === "note" && item.text === "已开启多话题，这里是主对话")).toBe(true);
      expect(items.some((item) => item.kind === "assistant" && item.text === "第二轮回复")).toBe(true);
    } finally {
      hob.close();
    }
  });

  it("未配置模型时开启多话题也成功并落分隔 note（新助手空对话与已有历史均适用）", async () => {
    const hob = makeHob({ }, {
      memory: "off",
      settings: {
        models: {
          roster: [],
          conversation: { ref: "", thinking: "off" },
          work: { ref: "", thinking: "off" },
          suggest: null,
        },
      },
    });
    try {
      addAssistant(hob, "fresh");
      addAssistant(hob, "existing");
      // 给 existing 先发一条消息（走无模型路径写进 router.jsonl）
      await hob.runtime.router.send("existing", { text: "没配模型前的话" });
      const beforeExisting = readFileSync(hob.runtime.store.routerFile("existing"));

      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);

      const resFresh = await app.request("/api/assistants/fresh/topic-mode", { method: "POST", headers: { cookie } });
      expect(resFresh.status).toBe(200);
      expect(hob.runtime.store.assistant("fresh")?.topics?.enabledAt).toBeTruthy();
      expect(hob.runtime.router.items("fresh").items).toMatchObject([
        { kind: "note", icon: "info", text: "已开启多话题，这里是主对话" },
      ]);

      const resExisting = await app.request("/api/assistants/existing/topic-mode", { method: "POST", headers: { cookie } });
      expect(resExisting.status).toBe(200);
      const afterExisting = readFileSync(hob.runtime.store.routerFile("existing"));
      expect(sha256(afterExisting.subarray(0, beforeExisting.length))).toBe(sha256(beforeExisting));
      expect(hob.runtime.router.items("existing").items.at(-1)).toMatchObject({
        kind: "note",
        icon: "info",
        text: "已开启多话题，这里是主对话",
      });
    } finally {
      hob.close();
    }
  });

  it("正在回复时开启多话题不打断本轮，等这一轮结束后释放会话并在下一轮重开", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "writer");
      let resolveTurn!: () => void;
      const turnGate = new Promise<void>((resolve) => { resolveTurn = resolve; });
      const started = new Promise<void>((resolve) => {
        hob.faux.setResponses([
          async () => {
            resolve();
            await turnGate;
            return text("忙碌轮结束");
          },
          text("新会话恢复回复"),
        ]);
      });

      const sendPromise = hob.runtime.router.send("writer", { text: "开始长回复" });
      await started;
      await sendPromise;

      const stateWhileBusy = (hob.runtime.router as any).routers.get("writer");
      expect(stateWhileBusy?.session).toBeDefined();
      expect(stateWhileBusy?.running).toBeGreaterThan(0);

      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const res = await app.request("/api/assistants/writer/topic-mode", { method: "POST", headers: { cookie } });
      expect(res.status).toBe(200);

      // 这一轮还在跑：不立刻释放，已标 releaseAfterTurn
      expect((hob.runtime.router as any).routers.get("writer")?.session).toBe(stateWhileBusy.session);
      expect((hob.runtime.router as any).routers.get("writer")?.releaseAfterTurn).toBe(true);

      // 放行这一轮结束：立即自动释放会话句柄
      resolveTurn();
      await hob.runtime.router.waitIdle("writer");
      await waitFor(() => !(hob.runtime.router as any).routers.get("writer")?.session);
      expect((hob.runtime.router as any).routers.get("writer")?.releaseAfterTurn).toBe(false);

      // 下一轮打开全新会话句柄并带原历史和分隔 note
      await hob.runtime.router.send("writer", { text: "下一轮" });
      await hob.runtime.router.waitIdle("writer");
      const items = hob.runtime.router.items("writer").items;
      expect(items.some((item) => item.kind === "assistant" && item.text === "忙碌轮结束")).toBe(true);
      expect(items.some((item) => item.kind === "note" && item.text === "已开启多话题，这里是主对话")).toBe(true);
      expect(items.some((item) => item.kind === "assistant" && item.text === "新会话恢复回复")).toBe(true);
    } finally {
      hob.close();
    }
  });
});

describe("助手多话题：create_assistant、Draft.topics 与 createFromDraft", () => {
  it("create_assistant 带 topics: true 创建多话题助手且不落分隔行，不传或 false 为单会话", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "create_assistant")!;
      expect((tool.parameters as { properties: Record<string, { description?: string }> }).properties.topics?.description).toContain("主助手不支持多话题");

      // topics: true
      const resMulti = await tool.execute("call-1", {
        name: "规划搭子",
        duty: "计划安排",
        dutyLong: "负责行程和日常规划。",
        sprite: "page",
        topics: true,
      });
      expect(resMulti.isError).toBeUndefined();
      const draftMulti = hob.runtime.store.drafts().find((d) => d.name === "规划搭子")!;
      expect(draftMulti.topics).toBe(true);
      expect(draftMulti.status).toBe("created");
      const multiId = draftMulti.createdAssistantId!;
      expect(hob.runtime.store.assistant(multiId)?.topics?.enabledAt).toBeTruthy();
      expect(hob.runtime.router.items(multiId).items.some((item) => item.kind === "note" && item.text === "已开启多话题，这里是主对话")).toBe(false);

      // 不传 topics -> 单会话
      await tool.execute("call-2", {
        name: "单聊搭子",
        duty: "日常记录",
        dutyLong: "负责记录琐事。",
        sprite: "notes",
      });
      const draftDefault = hob.runtime.store.drafts().find((d) => d.name === "单聊搭子")!;
      expect(draftDefault.topics).toBeUndefined();
      expect(hob.runtime.store.assistant(draftDefault.createdAssistantId!)?.topics).toBeUndefined();

      // topics: false -> 单会话
      await tool.execute("call-3", {
        name: "明确单聊",
        duty: "单聊记录",
        dutyLong: "明确选单会话。",
        sprite: "notes",
        topics: false,
      });
      const draftFalse = hob.runtime.store.drafts().find((d) => d.name === "明确单聊")!;
      expect(draftFalse.topics).toBe(false);
      expect(hob.runtime.store.assistant(draftFalse.createdAssistantId!)?.topics).toBeUndefined();
    } finally {
      hob.close();
    }
  });

  it("pending 草稿通过 POST /api/drafts/:id/create 创建时保留或覆写 Draft.topics", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const pendingFromDraft: Draft = {
        id: "d-topic-1",
        assistantId: "hob",
        status: "pending",
        name: "草稿多话题",
        duty: "专项协作",
        dutyLong: "从草稿创建的多话题助手。",
        sprite: "page",
        topics: true,
        routines: [],
        routinesText: "",
        askFirst: [],
        createdAt: "2026-11-26T00:00:00.000Z",
      };
      const pendingToggle: Draft = {
        ...pendingFromDraft,
        id: "d-topic-2",
        name: "草稿开关开启",
        topics: false,
      };
      hob.runtime.store.saveDraft(pendingFromDraft);
      hob.runtime.store.saveDraft(pendingToggle);

      const res1 = await app.request("/api/drafts/d-topic-1/create", { method: "POST", headers: { cookie } });
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as { assistant: AssistantSummary };
      expect(body1.assistant.topics?.enabledAt).toBeTruthy();
      expect(hob.runtime.store.assistant(body1.assistant.id)?.topics).toEqual(body1.assistant.topics);
      expect(hob.runtime.store.draft("d-topic-1")?.topics).toBe(true);

      const res2 = await app.request("/api/drafts/d-topic-2/create", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ topics: true }),
      });
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as { assistant: AssistantSummary };
      expect(body2.assistant.topics?.enabledAt).toBeTruthy();
      expect(hob.runtime.store.draft("d-topic-2")?.topics).toBe(true);
    } finally {
      hob.close();
    }
  });
});
