import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../shared/i18n.ts";
import type { Assistant, AssistantTopic, Rule, TopicConfigView } from "../../shared/types.ts";
import { answerApproval, updateAssistant } from "../src/actions.ts";
import { assistantTopicFile, assistantTopicRuleOverridesPath } from "../src/config.ts";
import { createApp } from "../src/http.ts";
import { assistantTopicModelPick } from "../src/models.ts";
import { buildSystemPrompt, buildWorkerPrompt } from "../src/prompt.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import type { HobRuntime } from "../src/runtime.ts";
import { deleteTopicRule, resetTopicRule, setTopicRule } from "../src/topic-config.ts";
import { call, makeHob, text, waitFor, type TestHob } from "./helpers.ts";

const extraDirs: string[] = [];

afterEach(() => {
  setLocale("zh-CN");
  vi.restoreAllMocks();
  for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "hob-topic-cfg-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  extraDirs.push(dir);
  return dir;
}

function addAssistant(hob: TestHob, id = "dev", extra: Partial<Assistant> = {}): Assistant {
  const base = hob.runtime.store.assistant("hob")!;
  const assistant: Assistant = {
    ...base,
    id,
    name: "开发助手",
    duty: "写代码与排查问题",
    primary: false,
    pinned: false,
    sprite: "page",
    topics: { enabledAt: "2026-11-26T00:00:00.000Z" },
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
  const req = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    get: (path: string) => req("GET", path),
    post: (path: string, body?: unknown) => req("POST", path, body),
    put: (path: string, body?: unknown) => req("PUT", path, body),
    patch: (path: string, body?: unknown) => req("PATCH", path, body),
    del: (path: string) => req("DELETE", path),
  };
}

describe("助手话题规则覆盖层与存储", () => {
  it("规则合成顺序、own/changed/hidden、上级删规则后的孤儿清理与 reset 恢复跟随", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const aid = "dev";
      addAssistant(hob, aid);
      const store = hob.runtime.store;
      const parentRules: Rule[] = [
        { id: "r-1", text: "发版前确认", mode: "ask", changedAt: "2026-11-26T00:00:00Z" },
        { id: "r-2", text: "删除前确认", mode: "ask", changedAt: "2026-11-26T00:00:00Z" },
        { id: "r-3", text: "先跑单测", mode: "allow", changedAt: "2026-11-26T00:00:00Z" },
      ];
      store.saveRules(aid, parentRules);
      const { topic } = await hob.runtime.assistantTopics.create(aid, { title: "修登录超时" });

      const host = store.assistantTopicConfigHost(aid, topic.id);
      const edited = setTopicRule(host, { id: "r-1", mode: "allow" });
      expect(edited).toMatchObject({ id: "r-1", text: "发版前确认", mode: "allow", from: "parent", changed: true });
      deleteTopicRule(host, "r-2");
      const own = setTopicRule(host, { text: "只在话题确认迁移", mode: "ask" });
      expect(own.from).toBe("topic");

      // 上级修改 r-1 文案并删掉 r-2：topicRules 保持顺序、未改字段跟随上级、孤儿条目被忽略
      store.saveRules(aid, [
        { id: "r-1", text: "上线前确认", mode: "ask", changedAt: "2026-11-26T01:00:00Z" },
        { id: "r-3", text: "先跑单测", mode: "allow", changedAt: "2026-11-26T00:00:00Z" },
      ]);
      expect(
        store.topicRules(aid, topic.id).map((r) => ({ id: r.id, text: r.text, mode: r.mode, from: r.from, changed: r.changed })),
      ).toEqual([
        { id: "r-1", text: "上线前确认", mode: "allow", from: "parent", changed: true },
        { id: "r-3", text: "先跑单测", mode: "allow", from: "parent", changed: undefined },
        { id: own.id, text: "只在话题确认迁移", mode: "ask", from: "topic", changed: undefined },
      ]);
      // 上级 rules(aid) 不被话题覆盖污染
      expect(store.rules(aid).map((r) => r.id)).toEqual(["r-1", "r-3"]);

      // 下次写入顺手清掉孤儿 r-2
      setTopicRule(host, { text: "再加一条话题规则", mode: "allow" });
      expect(store.assistantTopicRuleOverrides(aid, topic.id).hidden["r-2"]).toBeUndefined();

      // reset 恢复跟随上级；own 规则和不存在规则不能 reset
      resetTopicRule(host, "r-1");
      expect(store.topicRules(aid, topic.id)[0]).toMatchObject({
        id: "r-1",
        text: "上线前确认",
        mode: "ask",
        from: "parent",
      });
      expect(store.topicRules(aid, topic.id)[0]!.changed).toBeUndefined();
      expect(() => resetTopicRule(host, own.id)).toThrow("本话题新增的规则");
      expect(() => resetTopicRule(host, "r-missing")).toThrow("规则不存在");

      // 损坏的 rule-overrides.json 抛错而不静默当空
      writeFileSync(assistantTopicRuleOverridesPath(hob.home, aid, topic.id), "[]");
      expect(() => store.assistantTopicRuleOverrides(aid, topic.id)).toThrow("话题规则覆盖文件格式无效");
      writeFileSync(assistantTopicRuleOverridesPath(hob.home, aid, topic.id), "{bad json");
      expect(() => store.assistantTopicRuleOverrides(aid, topic.id)).toThrow();
    } finally {
      hob.close();
    }
  });
});

describe("助手话题模型逐键叠加、会话释放与不固化", () => {
  it("topic → assistant → global 逐键叠加、allowed 拦截与 null 恢复跟随", async () => {
    const ids = ["global", "asst", "topicConv", "topicWork", "disallowed"];
    const hob = makeHob(
      {},
      {
        memory: "off",
        models: ids.map((id) => ({ id, input: ["text"] })),
        settings: {
          models: {
            conversation: { ref: "hob-faux/global", thinking: "off" },
            work: { ref: "hob-faux/global", thinking: "off" },
            roster: ids.map((id) => ({ ref: `hob-faux/${id}`, note: "" })),
          },
        },
      },
    );
    try {
      const pick = (id: string) => ({ ref: `hob-faux/${id}`, thinking: "off" as const });
      const aid = "dev";
      addAssistant(hob, aid, {
        models: {
          conversation: pick("asst"),
          work: pick("asst"),
          allowed: ["hob-faux/global", "hob-faux/asst", "hob-faux/topicConv", "hob-faux/topicWork"],
        },
      });
      const { topic } = await hob.runtime.assistantTopics.create(aid, { title: "模型测试" });
      await hob.runtime.models.get();
      const settings = hob.runtime.settings.settings.models;
      const assistant = hob.runtime.store.assistant(aid)!;

      // 未覆盖时跟随助手
      expect(assistantTopicModelPick(assistant, topic, hob.runtime.models, settings, "conversation")).toEqual({
        source: "assistant",
        pick: pick("asst"),
        inherited: { source: "assistant", pick: pick("asst") },
      });
      expect(assistantTopicModelPick(assistant, topic, hob.runtime.models, settings, "work")).toEqual({
        source: "assistant",
        pick: pick("asst"),
        inherited: { source: "assistant", pick: pick("asst") },
      });

      const { get, patch } = await loggedIn(hob.runtime, hob.home);

      // disallowed 不在 allowed 名单里，话题 work 拦截 400
      const badWork = await patch(`/api/assistants/${aid}/topics/${topic.id}/config`, {
        models: { work: pick("disallowed") },
      });
      expect(badWork.status).toBe(400);

      // 只覆盖 conversation，work 依然跟随 assistant
      const p1 = await patch(`/api/assistants/${aid}/topics/${topic.id}/config`, {
        models: { conversation: pick("topicConv") },
      });
      expect(p1.status).toBe(200);
      const view1 = (await p1.json()) as TopicConfigView;
      expect(view1.models.conversation).toEqual({
        source: "topic",
        pick: pick("topicConv"),
        inherited: { source: "assistant", pick: pick("asst") },
      });
      expect(view1.models.work).toEqual({
        source: "assistant",
        pick: pick("asst"),
        inherited: { source: "assistant", pick: pick("asst") },
      });

      // 再覆盖 work
      const p2 = await patch(`/api/assistants/${aid}/topics/${topic.id}/config`, {
        models: { work: pick("topicWork") },
      });
      expect(p2.status).toBe(200);
      const view2 = (await p2.json()) as TopicConfigView;
      expect(view2.models.work).toEqual({
        source: "topic",
        pick: pick("topicWork"),
        inherited: { source: "assistant", pick: pick("asst") },
      });

      // 若后来助手收窄 allowed 名单把 topicWork 踢出去，读取时回退到 assistant/global
      hob.runtime.store.saveAssistant({
        ...hob.runtime.store.assistant(aid)!,
        models: { conversation: pick("asst"), work: pick("asst"), allowed: ["hob-faux/asst"] },
      });
      const narrowed = (await (await get(`/api/assistants/${aid}/topics/${topic.id}/config`)).json()) as TopicConfigView;
      expect(narrowed.models.work).toEqual({
        source: "assistant",
        pick: pick("asst"),
        inherited: { source: "assistant", pick: pick("asst") },
      });

      // 恢复其中一项跟随（work: null），conversation 覆盖保持不变
      const pPartialReset = await patch(`/api/assistants/${aid}/topics/${topic.id}/config`, {
        models: { work: null },
      });
      expect(pPartialReset.status).toBe(200);
      const viewPartialReset = (await pPartialReset.json()) as TopicConfigView;
      expect(viewPartialReset.models.conversation.source).toBe("topic");
      expect(viewPartialReset.models.work.source).toBe("assistant");

      // 恢复全部跟随（null 删除覆盖键）
      const p3 = await patch(`/api/assistants/${aid}/topics/${topic.id}/config`, {
        models: { conversation: null, work: null },
      });
      expect(p3.status).toBe(200);
      const view3 = (await p3.json()) as TopicConfigView;
      expect(view3.models.conversation.source).toBe("assistant");
      expect(view3.models.work.source).toBe("assistant");
      const rawTopic = JSON.parse(readFileSync(assistantTopicFile(hob.home, aid, topic.id), "utf8")) as AssistantTopic;
      expect(rawTopic.overrides).toBeUndefined();

      // 去掉助手级模型，回退到 global
      hob.runtime.store.saveAssistant({ ...hob.runtime.store.assistant(aid)!, models: undefined });
      const viewGlobal = (await (await get(`/api/assistants/${aid}/topics/${topic.id}/config`)).json()) as TopicConfigView;
      expect(viewGlobal.models.conversation).toEqual({
        source: "global",
        pick: pick("global"),
        inherited: { source: "global", pick: pick("global") },
      });
      expect(viewGlobal.models.work).toEqual({
        source: "global",
        pick: pick("global"),
        inherited: { source: "global", pick: pick("global") },
      });
    } finally {
      hob.close();
    }
  });

  it("改话题模型仅释放本话题会话；改助手模型后未覆盖话题跟着变、已覆盖话题不变", async () => {
    const ids = ["global", "asst1", "asst2", "topicConv", "topicWork"];
    const hob = makeHob(
      {},
      {
        memory: "off",
        models: ids.map((id) => ({ id, input: ["text"] })),
        settings: {
          models: {
            conversation: { ref: "hob-faux/global", thinking: "off" },
            work: { ref: "hob-faux/global", thinking: "off" },
            roster: ids.map((id) => ({ ref: `hob-faux/${id}`, note: "" })),
          },
        },
      },
    );
    try {
      const pick = (id: string) => ({ ref: `hob-faux/${id}`, thinking: "off" as const });
      const aid = "dev";
      addAssistant(hob, aid, { models: { conversation: pick("asst1"), work: pick("asst1") } });
      const { topic: follow } = await hob.runtime.assistantTopics.create(aid, { title: "跟随话题" });
      const { topic: custom } = await hob.runtime.assistantTopics.create(aid, { title: "覆盖话题" });

      const mainBefore = await hob.runtime.router.ensure(aid);
      const followBefore = await hob.runtime.router.ensure(aid, { topicId: follow.id });
      await hob.runtime.router.ensure(aid, { topicId: custom.id });
      expect(mainBefore.session?.model?.id).toBe("asst1");
      expect(followBefore.session?.model?.id).toBe("asst1");

      const { patch } = await loggedIn(hob.runtime, hob.home);
      const releaseSpy = vi.spyOn(hob.runtime.router, "releaseSession");

      // 改 custom 话题模型：只释放 custom 会话，主对话与 follow 话题会话保持原实例
      const res = await patch(`/api/assistants/${aid}/topics/${custom.id}/config`, {
        models: { conversation: pick("topicConv"), work: pick("topicWork") },
      });
      expect(res.status).toBe(200);
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      expect(releaseSpy).toHaveBeenCalledWith(aid, { topicId: custom.id });

      expect((await hob.runtime.router.ensure(aid)).session).toBe(mainBefore.session);
      expect((await hob.runtime.router.ensure(aid, { topicId: follow.id })).session).toBe(followBefore.session);

      const customAfter = await hob.runtime.router.ensure(aid, { topicId: custom.id });
      expect(customAfter.session?.model?.id).toBe("topicConv");
      // 话题会话内 start_job 参数说明把 topicWork 标为默认
      const startJobTool = customAfter.session!.agent.state.tools.find((t) => t.name === "start_job")!;
      expect((startJobTool.parameters as any).properties.model.description).toContain("hob-faux/topicWork（默认）");

      // 话题内派出的任务默认用话题叠加后的 work 模型
      hob.faux.setResponses([
        call("start_job", { title: "话题任务", note: "执行检查" }),
        text("已派任务。"),
        call("report", { outcome: "done", result: "完成" }),
        text("知道了"),
      ]);
      await hob.runtime.router.send(aid, { text: "派一个任务" }, { topicId: custom.id });
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: custom.id });
      const customJob = hob.runtime.store.jobs().find((j) => j.topicId === custom.id)!;
      expect(customJob.model).toBe("hob-faux/topicWork");

      // 改助手级模型：未覆盖话题跟着变，已覆盖话题不变
      const up = await updateAssistant(hob.runtime, aid, {
        models: { conversation: pick("asst2"), work: pick("asst2") },
      });
      expect(up.status).toBe(200);
      expect((await hob.runtime.router.ensure(aid)).session?.model?.id).toBe("asst2");
      expect((await hob.runtime.router.ensure(aid, { topicId: follow.id })).session?.model?.id).toBe("asst2");
      expect((await hob.runtime.router.ensure(aid, { topicId: custom.id })).session?.model?.id).toBe("topicConv");

      // follow 话题里派任务用新的助手模型 asst2，custom 依然用 topicWork
      const jobFollow = await hob.runtime.jobs.start(aid, {
        title: "跟随任务",
        instruction: "测试",
        topicId: follow.id,
      });
      const jobCustom2 = await hob.runtime.jobs.start(aid, {
        title: "覆盖任务",
        instruction: "测试",
        topicId: custom.id,
      });
      expect(jobFollow.model).toBe("hob-faux/asst2");
      expect(jobCustom2.model).toBe("hob-faux/topicWork");
    } finally {
      hob.close();
    }
  });

  it("话题空闲时改模型立即释放；忙碌时改模型不打断当前轮次，本轮安全结束后才释放", async () => {
    const ids = ["m1", "m2", "m3"];
    const hob = makeHob(
      {},
      {
        memory: "off",
        models: ids.map((id) => ({ id, input: ["text"] })),
        settings: {
          models: {
            conversation: { ref: "hob-faux/m1", thinking: "off" },
            work: { ref: "hob-faux/m1", thinking: "off" },
            roster: ids.map((id) => ({ ref: `hob-faux/${id}`, note: "" })),
          },
        },
      },
    );
    try {
      const pick = (id: string) => ({ ref: `hob-faux/${id}`, thinking: "off" as const });
      const aid = "dev";
      addAssistant(hob, aid);
      const { topic } = await hob.runtime.assistantTopics.create(aid, { title: "优雅释放验证" });
      const { patch } = await loggedIn(hob.runtime, hob.home);
      const topicKey = `${aid}@${topic.id}`;

      // 1. 空闲时改模型：立即释放旧会话句柄
      const idleBefore = await hob.runtime.router.ensure(aid, { topicId: topic.id });
      expect(idleBefore.session?.model?.id).toBe("m1");
      const rIdle = await patch(`/api/assistants/${aid}/topics/${topic.id}/config`, {
        models: { conversation: pick("m2") },
      });
      expect(rIdle.status).toBe(200);
      expect((hob.runtime.router as any).routers.get(topicKey)?.session).toBeUndefined();
      expect((hob.runtime.router as any).routers.get(topicKey)?.releaseAfterTurn).toBe(false);

      // 2. 忙碌时改模型：不打断当前轮次，仅标 releaseAfterTurn，本轮结束后才释放
      let resolveTurn!: () => void;
      const turnGate = new Promise<void>((resolve) => {
        resolveTurn = resolve;
      });
      const started = new Promise<void>((resolve) => {
        hob.faux.setResponses([
          async () => {
            resolve();
            await turnGate;
            return text("忙碌轮完整回复");
          },
          text("新模型下的新一轮"),
        ]);
      });

      const sendPromise = hob.runtime.router.send(aid, { text: "开始长回复" }, { topicId: topic.id });
      await started;
      await sendPromise;

      const stateBusy = (hob.runtime.router as any).routers.get(topicKey);
      const busySession = stateBusy?.session;
      expect(busySession).toBeDefined();
      expect(busySession.model?.id).toBe("m2");
      expect(stateBusy.running).toBeGreaterThan(0);

      const rBusy = await patch(`/api/assistants/${aid}/topics/${topic.id}/config`, {
        models: { conversation: pick("m3") },
      });
      expect(rBusy.status).toBe(200);
      // 还在跑：会话句柄未销毁，且已标记 releaseAfterTurn
      expect((hob.runtime.router as any).routers.get(topicKey)?.session).toBe(busySession);
      expect((hob.runtime.router as any).routers.get(topicKey)?.releaseAfterTurn).toBe(true);

      // 放行本轮结束：安全收尾后再释放句柄
      resolveTurn();
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topic.id });
      await waitFor(() => !(hob.runtime.router as any).routers.get(topicKey)?.session);
      expect((hob.runtime.router as any).routers.get(topicKey)?.releaseAfterTurn).toBe(false);

      // 下一轮重新打开会话并切到 m3，且上一轮回复完整保留
      await hob.runtime.router.send(aid, { text: "下一轮" }, { topicId: topic.id });
      await hob.runtime.router.waitIdle(aid, 10_000, { topicId: topic.id });
      expect((hob.runtime.router as any).routers.get(topicKey)?.session?.model?.id).toBe("m3");
      const items = hob.runtime.router.items(aid, {}, { topicId: topic.id }).items;
      expect(items.some((item) => item.kind === "assistant" && item.text === "忙碌轮完整回复")).toBe(true);
      expect(items.some((item) => item.kind === "assistant" && item.text === "新模型下的新一轮")).toBe(true);
    } finally {
      hob.close();
    }
  });

  it("存回不固化：改名、关闭、重开不把继承来的模型写入 topic.json 的 overrides", async () => {
    const ids = ["fast", "smart"];
    const hob = makeHob(
      {},
      {
        memory: "off",
        models: ids.map((id) => ({ id, input: ["text"] })),
        settings: { models: { roster: ids.map((id) => ({ ref: `hob-faux/${id}`, note: "" })) } },
      },
    );
    try {
      const pick = (id: string) => ({ ref: `hob-faux/${id}`, thinking: "off" as const });
      const aid = "dev";
      addAssistant(hob, aid, { models: { conversation: pick("smart"), work: pick("smart") } });
      const { topic: pureFollow } = await hob.runtime.assistantTopics.create(aid, { title: "纯跟随" });
      const { topic: partial } = await hob.runtime.assistantTopics.create(aid, { title: "仅改对话" });

      const { get, patch } = await loggedIn(hob.runtime, hob.home);
      await patch(`/api/assistants/${aid}/topics/${partial.id}/config`, {
        models: { conversation: pick("fast") },
      });

      // 读视图不会污染磁盘
      const view = (await (await get(`/api/assistants/${aid}/topics/${pureFollow.id}/config`)).json()) as TopicConfigView;
      expect(view.models.conversation.pick).toEqual(pick("smart"));

      // 改名、关闭、重开
      hob.runtime.assistantTopics.rename(aid, pureFollow.id, "改名后");
      hob.runtime.assistantTopics.close(aid, pureFollow.id, "暂存");
      hob.runtime.assistantTopics.reopen(aid, pureFollow.id);

      hob.runtime.assistantTopics.rename(aid, partial.id, "部分覆盖改名");
      hob.runtime.assistantTopics.close(aid, partial.id, "关闭");
      hob.runtime.assistantTopics.reopen(aid, partial.id);

      const rawFollow = JSON.parse(readFileSync(assistantTopicFile(hob.home, aid, pureFollow.id), "utf8")) as AssistantTopic;
      expect(rawFollow.overrides).toBeUndefined();

      const rawPartial = JSON.parse(readFileSync(assistantTopicFile(hob.home, aid, partial.id), "utf8")) as AssistantTopic;
      expect(rawPartial.overrides).toEqual({ models: { conversation: pick("fast") } });
    } finally {
      hob.close();
    }
  });
});

describe("工具写分层、提问卡 always 与提示词接入", () => {
  it("set_rule / remove_rule 在助手话题有 scope: assistant，主对话与单聊无 scope；always 按会话写分层", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const single = addAssistant(hob, "single", { topics: undefined });
      const multi = addAssistant(hob, "multi");
      const { topic } = await hob.runtime.assistantTopics.create(multi.id, { title: "话题甲" });

      const singleTools = buildRouterTools(hob.runtime, single.id);
      const mainTools = buildRouterTools(hob.runtime, multi.id);
      const primaryTools = buildRouterTools(hob.runtime, "hob");
      const topicTools = buildRouterTools(hob.runtime, multi.id, { topicId: topic.id });

      for (const list of [singleTools, mainTools, primaryTools]) {
        expect((list.find((t) => t.name === "set_rule")!.parameters as any).properties.scope).toBeUndefined();
        expect((list.find((t) => t.name === "remove_rule")!.parameters as any).properties.scope).toBeUndefined();
      }
      expect((topicTools.find((t) => t.name === "set_rule")!.parameters as any).properties.scope.const).toBe("assistant");
      expect((topicTools.find((t) => t.name === "remove_rule")!.parameters as any).properties.scope.const).toBe("assistant");
      expect((topicTools.find((t) => t.name === "set_rule")!.parameters as any).properties.scope.description).toBe(
        "可选。用户说这条规则不只是这件事、而是你以后都要这样时填，写到上级；不填只写这个话题。",
      );

      const topicSet = topicTools.find((t) => t.name === "set_rule")!;
      const topicRemove = topicTools.find((t) => t.name === "remove_rule")!;

      // 非法 scope 被拒绝
      const badScope = await topicSet.execute("0", { text: "x", mode: "ask", scope: "group" }, undefined, undefined, undefined as never);
      expect(badScope.isError).toBe(true);

      // 无 scope 写话题层
      const rTopic = await topicSet.execute("1", { text: "只在这个话题直接修", mode: "allow" }, undefined, undefined, undefined as never);
      expect((rTopic.content[0] as { text: string }).text).toBe("已加到这个话题的规则，只在这个话题生效。");
      expect(hob.runtime.store.rules(multi.id)).toEqual([]);
      expect(hob.runtime.store.topicRules(multi.id, topic.id)).toMatchObject([
        { text: "只在这个话题直接修", mode: "allow", from: "topic" },
      ]);

      // 带 scope: "assistant" 写助手层
      const rAsst = await topicSet.execute(
        "2",
        { text: "发版前先问", mode: "ask", scope: "assistant" },
        undefined,
        undefined,
        undefined as never,
      );
      expect((rAsst.content[0] as { text: string }).text).toBe("已加到你的规则，没有单独改过这一条的话题都会用。");
      expect(hob.runtime.store.rules(multi.id)).toMatchObject([{ text: "发版前先问", mode: "ask" }]);
      const parentRuleId = hob.runtime.store.rules(multi.id)[0]!.id;

      // 无 scope 删除上级规则 → 只隐藏在话题层，助手层还在
      const dTopic = await topicRemove.execute("3", { ruleId: parentRuleId }, undefined, undefined, undefined as never);
      expect((dTopic.content[0] as { text: string }).text).toBe("已从这个话题的规则里删除，只在这个话题生效。");
      expect(hob.runtime.store.topicRules(multi.id, topic.id).some((r) => r.id === parentRuleId)).toBe(false);
      expect(hob.runtime.store.rules(multi.id).some((r) => r.id === parentRuleId)).toBe(true);

      // 带 scope: "assistant" 删除上级规则 → 从助手层删掉
      const rAsst2 = await topicSet.execute(
        "4",
        { text: "推代码前先测", mode: "ask", scope: "assistant" },
        undefined,
        undefined,
        undefined as never,
      );
      expect((rAsst2.content[0] as { text: string }).text).toBe("已加到你的规则，没有单独改过这一条的话题都会用。");
      const toDeleteId = hob.runtime.store.rules(multi.id).find((r) => r.text === "推代码前先测")!.id;
      const dAsst = await topicRemove.execute(
        "5",
        { ruleId: toDeleteId, scope: "assistant" },
        undefined,
        undefined,
        undefined as never,
      );
      expect((dAsst.content[0] as { text: string }).text).toBe("已从你的规则里删除。");
      expect(hob.runtime.store.rules(multi.id).some((r) => r.id === toDeleteId)).toBe(false);

      // 提问卡 always：话题内写话题层（含覆盖已有上级 ask 规则），主对话写助手层
      hob.runtime.store.saveApproval({
        id: "q-topic",
        assistantId: multi.id,
        topicId: topic.id,
        title: "要继续吗？",
        options: [{ key: "A", label: "以后直接清缓存", always: true }],
        status: "pending",
        source: "router",
        createdAt: new Date().toISOString(),
      });
      await answerApproval(hob.runtime, "q-topic", { key: "A" });
      expect(hob.runtime.store.topicRules(multi.id, topic.id).some((r) => r.text === "以后直接清缓存" && r.mode === "allow" && r.from === "topic")).toBe(true);
      expect(hob.runtime.store.rules(multi.id).some((r) => r.text === "以后直接清缓存")).toBe(false);

      hob.runtime.store.saveApproval({
        id: "q-topic-override",
        assistantId: multi.id,
        topicId: topic.id,
        title: "发布吗？",
        ruleText: "发版前先问",
        options: [{ key: "A", label: "允许", always: true }],
        status: "pending",
        source: "router",
        createdAt: new Date().toISOString(),
      });
      await answerApproval(hob.runtime, "q-topic-override", { key: "A" });
      expect(hob.runtime.store.topicRules(multi.id, topic.id).find((r) => r.text === "发版前先问")).toMatchObject({
        mode: "allow",
        from: "parent",
        changed: true,
      });
      expect(hob.runtime.store.rules(multi.id).find((r) => r.text === "发版前先问")?.mode).toBe("ask");

      hob.runtime.store.saveApproval({
        id: "q-main",
        assistantId: multi.id,
        title: "主对话确认？",
        options: [{ key: "A", label: "以后主对话直接查日志", always: true }],
        status: "pending",
        source: "router",
        createdAt: new Date().toISOString(),
      });
      await answerApproval(hob.runtime, "q-main", { key: "A" });
      expect(hob.runtime.store.rules(multi.id).some((r) => r.text === "以后主对话直接查日志" && r.mode === "allow")).toBe(true);
    } finally {
      hob.close();
    }
  });

  it("助手话题系统提示词与话题任务提示词使用合成规则，主对话/单聊/主助手提示词不变", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const store = hob.runtime.store;
      store.saveGlobalRules([
        { id: "g-ask", text: "全局删库确认", mode: "ask", changedAt: "2026-11-26T00:00:00Z" },
        { id: "g-allow", text: "全局只读直接查", mode: "allow", changedAt: "2026-11-26T00:00:00Z" },
      ]);
      const single = addAssistant(hob, "single", { topics: undefined });
      const multi = addAssistant(hob, "multi");
      store.saveRules(multi.id, [
        { id: "a-hide", text: "助手默认先问再改", mode: "ask", changedAt: "2026-11-26T00:00:00Z" },
        { id: "a-flip", text: "助手默认确认重跑", mode: "ask", changedAt: "2026-11-26T00:00:00Z" },
      ]);
      const { topic } = await hob.runtime.assistantTopics.create(multi.id, { title: "独立话题" });

      const opts = {
        timezone: "Asia/Shanghai",
        locale: "zh-CN" as const,
        aboutYou: { name: "", language: "", notes: "" },
        memory: "off" as const,
      };
      const mainPromptBefore = buildSystemPrompt(store, multi.id, opts);
      const singlePromptBefore = buildSystemPrompt(store, single.id, opts);
      const primaryPromptBefore = buildSystemPrompt(store, "hob", opts);

      const host = store.assistantTopicConfigHost(multi.id, topic.id);
      deleteTopicRule(host, "a-hide");
      setTopicRule(host, { id: "a-flip", mode: "allow" });
      setTopicRule(host, { text: "话题新增确认发布", mode: "ask" });
      setTopicRule(host, { text: "话题新增直接构建", mode: "allow" });

      // 主对话、单会话、主助手提示词一个字不变
      expect(buildSystemPrompt(store, multi.id, opts)).toBe(mainPromptBefore);
      expect(buildSystemPrompt(store, single.id, opts)).toBe(singlePromptBefore);
      expect(buildSystemPrompt(store, "hob", opts)).toBe(primaryPromptBefore);

      // 话题会话系统提示词：## 用户定的规则 标题不变，列出合成后规则
      const topicPrompt = buildSystemPrompt(store, multi.id, { ...opts, topicId: topic.id });
      expect(topicPrompt).toContain("## 用户定的规则");
      expect(topicPrompt).toContain("- 执行前确认：全局删库确认");
      expect(topicPrompt).toContain("- 直接执行：助手默认确认重跑");
      expect(topicPrompt).toContain("- 执行前确认：话题新增确认发布");
      expect(topicPrompt).toContain("- 直接执行：话题新增直接构建");
      expect(topicPrompt).not.toContain("助手默认先问再改");

      // 运行中会话拿到的 systemPrompt 也是合成后的
      const topicState = await hob.runtime.router.ensure(multi.id, { topicId: topic.id });
      expect(topicState.session!.systemPrompt).toContain("话题新增确认发布");
      expect(topicState.session!.systemPrompt).not.toContain("助手默认先问再改");

      // 话题内派出的任务提示词用全局规则 + 话题合成规则
      const job = await hob.runtime.jobs.start(multi.id, {
        title: "话题后台任务",
        instruction: "测规则",
        topicId: topic.id,
      });
      const workerPrompt = buildWorkerPrompt(store, job.id, opts);
      expect(workerPrompt).toContain("全局只读直接查");
      expect(workerPrompt).toContain("全局删库确认");
      expect(workerPrompt).toContain("助手默认确认重跑");
      expect(workerPrompt).toContain("话题新增直接构建");
      expect(workerPrompt).toContain("话题新增确认发布");
      expect(workerPrompt).not.toContain("助手默认先问再改");
      expect(existsSync(assistantTopicRuleOverridesPath(hob.home, multi.id, topic.id))).toBe(true);
    } finally {
      hob.close();
    }
  });
});

describe("助手话题配置与规则 HTTP 接口", () => {
  it("GET/PATCH config、POST/PUT/DELETE/reset rules 的正常、400、404（含跨助手和非法 tid）", async () => {
    const ids = ["fast", "smart", "other"];
    const hob = makeHob(
      {},
      {
        memory: "off",
        models: ids.map((id) => ({ id, input: ["text"] })),
        settings: {
          models: {
            conversation: { ref: "hob-faux/fast", thinking: "off" },
            work: { ref: "hob-faux/fast", thinking: "off" },
            roster: ids.map((id) => ({ ref: `hob-faux/${id}`, note: "" })),
          },
        },
      },
    );
    try {
      const cwd = tempDir();
      const assistantCwd = tempDir("hob-asst-cwd-");
      const a1 = addAssistant(hob, "a1", {
        models: { allowed: ["hob-faux/fast", "hob-faux/smart"] },
      });
      const a2 = addAssistant(hob, "a2", { cwd: assistantCwd });
      hob.runtime.store.saveRules(a1.id, [
        { id: "p-1", text: "上级规则一", mode: "ask", changedAt: "2026-11-26T00:00:00Z" },
      ]);
      const { topic } = await hob.runtime.assistantTopics.create(a1.id, { title: "配置接口", cwd });
      const { topic: topicNoCwd } = await hob.runtime.assistantTopics.create(a1.id, { title: "无目录" });
      const { topic: topicOfA2 } = await hob.runtime.assistantTopics.create(a2.id, { title: "别人的话题" });

      const { get, post, put, patch, del } = await loggedIn(hob.runtime, hob.home);

      // 助手绑定 cwd 时 config.cwd source 为 assistant；都没绑时无 cwd 字段；话题绑定的任务默认落在话题 cwd
      const a2Cfg = (await (await get(`/api/assistants/${a2.id}/topics/${topicOfA2.id}/config`)).json()) as TopicConfigView;
      expect(a2Cfg.cwd).toEqual({ path: assistantCwd, source: "assistant" });
      const noCwdCfg = (await (await get(`/api/assistants/${a1.id}/topics/${topicNoCwd.id}/config`)).json()) as TopicConfigView;
      expect(noCwdCfg.cwd).toBeUndefined();
      const jobWithTopicCwd = await hob.runtime.jobs.start(a1.id, { title: "带目录", instruction: "查", topicId: topic.id });
      expect(jobWithTopicCwd.cwd).toBe(cwd);

      // 404 用例：助手不存在、话题不存在、非法 tid、跨助手 tid
      for (const path of [
        `/api/assistants/missing/topics/${topic.id}/config`,
        `/api/assistants/${a1.id}/topics/tp-missing/config`,
        `/api/assistants/${a1.id}/topics/${topicOfA2.id}/config`,
        `/api/assistants/${a1.id}/topics/..%2F..%2Fetc/config`,
      ]) {
        expect((await get(path)).status).toBe(404);
      }
      expect((await patch(`/api/assistants/${a1.id}/topics/${topicOfA2.id}/config`, { models: {} })).status).toBe(404);
      expect((await post(`/api/assistants/${a1.id}/topics/${topicOfA2.id}/rules`, { text: "x", mode: "ask" })).status).toBe(404);
      expect((await put(`/api/assistants/${a1.id}/topics/${topicOfA2.id}/rules/p-1`, { mode: "allow" })).status).toBe(404);
      expect((await del(`/api/assistants/${a1.id}/topics/${topicOfA2.id}/rules/p-1`)).status).toBe(404);
      expect((await post(`/api/assistants/${a1.id}/topics/${topicOfA2.id}/rules/p-1/reset`)).status).toBe(404);

      // GET /config 返回规则、hiddenRules、models 和 cwd
      const cfgRes = await get(`/api/assistants/${a1.id}/topics/${topic.id}/config`);
      expect(cfgRes.status).toBe(200);
      const cfg = (await cfgRes.json()) as TopicConfigView;
      expect(cfg.rules).toHaveLength(1);
      expect(cfg.rules[0]).toMatchObject({ id: "p-1", text: "上级规则一", mode: "ask", from: "parent" });
      expect(cfg.hiddenRules).toEqual([]);
      expect(cfg.cwd).toEqual({ path: cwd, source: "topic" });
      expect(cfg.models.conversation.source).toBe("global");
      expect(cfg.models.work.source).toBe("global");

      // PATCH /config 校验失败 400
      expect((await patch(`/api/assistants/${a1.id}/topics/${topic.id}/config`, null)).status).toBe(400);
      expect((await patch(`/api/assistants/${a1.id}/topics/${topic.id}/config`, { cwd: "/tmp" })).status).toBe(400);
      expect((await patch(`/api/assistants/${a1.id}/topics/${topic.id}/config`, { models: "bad" })).status).toBe(400);
      expect((await patch(`/api/assistants/${a1.id}/topics/${topic.id}/config`, { models: { unknown: {} } })).status).toBe(400);
      expect((await patch(`/api/assistants/${a1.id}/topics/${topic.id}/config`, { models: { conversation: { ref: "", thinking: "off" } } })).status).toBe(400);
      expect((await patch(`/api/assistants/${a1.id}/topics/${topic.id}/config`, { models: { work: { ref: "hob-faux/missing", thinking: "off" } } })).status).toBe(400);
      // 不在 allowed 名单里
      expect((await patch(`/api/assistants/${a1.id}/topics/${topic.id}/config`, { models: { work: { ref: "hob-faux/other", thinking: "off" } } })).status).toBe(400);

      // PATCH /config 正常更新并支持 null 恢复
      const okPatch = await patch(`/api/assistants/${a1.id}/topics/${topic.id}/config`, {
        models: {
          conversation: { ref: "hob-faux/smart", thinking: "off" },
          work: { ref: "hob-faux/smart", thinking: "off" },
        },
      });
      expect(okPatch.status).toBe(200);
      const patchedCfg = (await okPatch.json()) as TopicConfigView;
      expect(patchedCfg.models.conversation).toMatchObject({ source: "topic", pick: { ref: "hob-faux/smart" } });
      expect(patchedCfg.models.work).toMatchObject({ source: "topic", pick: { ref: "hob-faux/smart" } });

      // POST /rules：400 与 201
      expect((await post(`/api/assistants/${a1.id}/topics/${topic.id}/rules`, { text: "  ", mode: "ask" })).status).toBe(400);
      expect((await post(`/api/assistants/${a1.id}/topics/${topic.id}/rules`, { text: "a".repeat(1001), mode: "ask" })).status).toBe(400);
      expect((await post(`/api/assistants/${a1.id}/topics/${topic.id}/rules`, { text: "合法", mode: "bad" })).status).toBe(400);
      expect((await post(`/api/assistants/${a1.id}/topics/${topic.id}/rules`, { text: "上级规则一", mode: "allow" })).status).toBe(400);

      const postRule = await post(`/api/assistants/${a1.id}/topics/${topic.id}/rules`, { text: "本话题专属规则", mode: "ask" });
      expect(postRule.status).toBe(201);
      const createdRule = ((await postRule.json()) as { rule: { id: string; text: string; from: string } }).rule;
      expect(createdRule).toMatchObject({ text: "本话题专属规则", from: "topic" });

      // PUT /rules/:rid：400、404、改上级记 changed、改 own 直接改
      expect((await put(`/api/assistants/${a1.id}/topics/${topic.id}/rules/p-1`, {})).status).toBe(400);
      expect((await put(`/api/assistants/${a1.id}/topics/${topic.id}/rules/r-none`, { mode: "allow" })).status).toBe(404);
      expect((await put(`/api/assistants/${a1.id}/topics/${topic.id}/rules/p-1`, { text: "本话题专属规则" })).status).toBe(400);

      const putParent = await put(`/api/assistants/${a1.id}/topics/${topic.id}/rules/p-1`, { mode: "allow" });
      expect(putParent.status).toBe(200);
      expect(((await putParent.json()) as { rule: any }).rule).toMatchObject({
        id: "p-1",
        text: "上级规则一",
        mode: "allow",
        from: "parent",
        changed: true,
      });

      const putOwn = await put(`/api/assistants/${a1.id}/topics/${topic.id}/rules/${createdRule.id}`, {
        text: "改过的话题规则",
        mode: "allow",
      });
      expect(putOwn.status).toBe(200);
      expect(((await putOwn.json()) as { rule: any }).rule).toMatchObject({
        id: createdRule.id,
        text: "改过的话题规则",
        mode: "allow",
        from: "topic",
      });

      // reset own 规则回 400，reset parent 规则回 200
      expect((await post(`/api/assistants/${a1.id}/topics/${topic.id}/rules/${createdRule.id}/reset`)).status).toBe(400);
      expect((await post(`/api/assistants/${a1.id}/topics/${topic.id}/rules/r-none/reset`)).status).toBe(404);
      expect((await post(`/api/assistants/${a1.id}/topics/${topic.id}/rules/p-1/reset`)).status).toBe(200);

      // DELETE：删上级进 hiddenRules，删 own 直接移除，删不存在回 404
      expect((await del(`/api/assistants/${a1.id}/topics/${topic.id}/rules/p-1`)).status).toBe(200);
      expect((await del(`/api/assistants/${a1.id}/topics/${topic.id}/rules/p-1`)).status).toBe(404);
      const afterHide = (await (await get(`/api/assistants/${a1.id}/topics/${topic.id}/config`)).json()) as TopicConfigView;
      expect(afterHide.hiddenRules.map((r) => r.id)).toEqual(["p-1"]);
      expect(afterHide.rules.map((r) => r.id)).toEqual([createdRule.id]);

      // reset hidden 恢复跟随
      expect((await post(`/api/assistants/${a1.id}/topics/${topic.id}/rules/p-1/reset`)).status).toBe(200);
      expect((await del(`/api/assistants/${a1.id}/topics/${topic.id}/rules/${createdRule.id}`)).status).toBe(200);
      const finalCfg = (await (await get(`/api/assistants/${a1.id}/topics/${topic.id}/config`)).json()) as TopicConfigView;
      expect(finalCfg.hiddenRules).toEqual([]);
      expect(finalCfg.rules.map((r) => r.id)).toEqual(["p-1"]);

      // 英文界面错误翻译
      setLocale("en");
      const enBadWork = await patch(`/api/assistants/${a1.id}/topics/${topic.id}/config`, {
        models: { work: { ref: "hob-faux/other", thinking: "off" } },
      });
      expect(enBadWork.status).toBe(400);
      expect(await enBadWork.json()).toEqual({ error: "Model hob-faux/other isn't in this assistant's allowed models." });

      // rule-overrides.json 损坏时 DELETE /rules/:rid 和 POST .../reset 一样返回 400 而非误回 404
      writeFileSync(assistantTopicRuleOverridesPath(hob.home, a1.id, topic.id), "{broken-json");
      expect((await del(`/api/assistants/${a1.id}/topics/${topic.id}/rules/p-1`)).status).toBe(400);
      expect((await post(`/api/assistants/${a1.id}/topics/${topic.id}/rules/p-1/reset`)).status).toBe(400);
    } finally {
      hob.close();
    }
  });
});
