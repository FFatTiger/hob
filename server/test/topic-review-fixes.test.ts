import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Assistant } from "../../shared/types.ts";
import { assistantTopicDir, assistantTopicsDir } from "../src/config.ts";
import { createApp } from "../src/http.ts";
import { pushAssistantTurnEnd, pushInteractiveCard, type PushPayload } from "../src/push.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { deleteTopicRule, setTopicRule } from "../src/topic-config.ts";
import { makeHob, type TestHob } from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function addAssistant(hob: TestHob, id: string, extra: Partial<Assistant> = {}): Assistant {
  const base = hob.runtime.store.assistant("hob")!;
  const assistant: Assistant = {
    ...base,
    id,
    name: extra.name ?? id,
    duty: extra.duty ?? "协助处理事务",
    primary: false,
    pinned: false,
    sprite: "page",
    createdAt: "2026-11-26T00:00:00.000Z",
    ...extra,
  };
  hob.runtime.store.saveAssistant(assistant);
  return assistant;
}

function findTool(hob: TestHob, assistantId: string, name: string, place?: { groupId?: string; topicId?: string }) {
  return buildRouterTools(hob.runtime, assistantId, place).find((tool) => tool.name === name);
}

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((item) => item.text ?? "").join("");
}

describe("issue 269 step 2 server review fixes", () => {
  it("报告 11：assistantTopics 遇到损坏的 topic.json 记 console.error 并跳过，bootstrap 不崩，按 id 读仍报错", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const aid = "writer";
      addAssistant(hob, aid, { name: "写作助手", topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const { topic: good } = await hob.runtime.assistantTopics.create(aid, { title: "正常话题" });

      const badDir = join(assistantTopicsDir(hob.home, aid), "tp-broken");
      mkdirSync(badDir, { recursive: true });
      writeFileSync(join(badDir, "topic.json"), "{ invalid json");

      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const list = hob.runtime.store.assistantTopics(aid);
      expect(list.map((item) => item.id)).toEqual([good.id]);
      expect(errSpy).toHaveBeenCalled();

      const boot = hob.runtime.router.bootstrap();
      expect(boot.assistantTopics?.map((item) => item.id)).toEqual([good.id]);

      expect(() => hob.runtime.store.assistantTopic(aid, "tp-broken")).toThrow();
    } finally {
      hob.close();
    }
  });

  it("报告 12：从群里移除成员时，清理各话题 overrides.memberModels 中该成员的覆盖", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "ops", { name: "运维助手" });
      addAssistant(hob, "qa", { name: "测试助手" });
      const group = hob.runtime.groups.create({
        name: "交付群",
        purpose: "发版协作",
        ownerId: "hob",
        members: ["hob", "ops", "qa"],
      });
      const topic = hob.runtime.groups.createTopic(group.id, "灰度排查", "user");

      await hob.runtime.groups.updateMemberModels(topic.id, "ops", { work: { ref: "hob-faux/faux-1", thinking: "off" } });
      await hob.runtime.groups.updateMemberModels(topic.id, "qa", { work: { ref: "hob-faux/faux-1", thinking: "off" } });
      expect(hob.runtime.store.group(topic.id)?.overrides?.memberModels?.ops?.work?.ref).toBe("hob-faux/faux-1");
      expect(hob.runtime.store.group(topic.id)?.overrides?.memberModels?.qa?.work?.ref).toBe("hob-faux/faux-1");

      // 移除 ops
      hob.runtime.groups.update(group.id, { members: ["hob", "qa"] });
      expect(hob.runtime.store.group(topic.id)?.overrides?.memberModels?.ops).toBeUndefined();
      expect(hob.runtime.store.group(topic.id)?.overrides?.memberModels?.qa?.work?.ref).toBe("hob-faux/faux-1");

      // 重新加回 ops，旧覆盖不再出现
      hob.runtime.groups.update(group.id, { members: ["hob", "qa", "ops"] });
      expect(hob.runtime.store.group(topic.id)?.overrides?.memberModels?.ops).toBeUndefined();
      expect(hob.runtime.store.group(topic.id)?.memberModels?.ops).toBeUndefined();
    } finally {
      hob.close();
    }
  });

  it("报告 13：话题里 set_rule 写到上级时，若本话题改过或停用了同一条规则，返回如实说明不受影响", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      // 1. 群话题
      const group = hob.runtime.groups.create({ name: "发布群", purpose: "发版", ownerId: "hob", members: ["hob"] });
      hob.runtime.store.saveGroupRules(group.id, [
        { id: "r-chg", text: "推送标签", mode: "ask", changedAt: "2026-11-26T00:00:00.000Z" },
        { id: "r-hid", text: "清理日志", mode: "ask", changedAt: "2026-11-26T00:00:00.000Z" },
        { id: "r-plain", text: "同步文档", mode: "ask", changedAt: "2026-11-26T00:00:00.000Z" },
      ]);
      const gTopic = hob.runtime.groups.createTopic(group.id, "热修", "user");
      const gHost = hob.runtime.store.groupTopicConfigHost(gTopic.id);
      setTopicRule(gHost, { id: "r-chg", mode: "allow" });
      deleteTopicRule(gHost, "r-hid");

      const gSetRule = findTool(hob, "hob", "set_rule", { groupId: gTopic.id })!;
      const resChanged = toolText(await gSetRule.execute("c1", { text: "推送标签", mode: "allow", scope: "group" }));
      expect(resChanged).toContain("这个话题对这一条单独改过，这里不受影响");

      const resHidden = toolText(await gSetRule.execute("c2", { text: "清理日志", mode: "allow", scope: "group" }));
      expect(resHidden).toContain("这个话题停用了这一条，这里不受影响");

      const resPlain = toolText(await gSetRule.execute("c3", { text: "同步文档", mode: "allow", scope: "group" }));
      expect(resPlain).not.toContain("这里不受影响");

      // 2. 助手话题
      const aid = "writer";
      addAssistant(hob, aid, { name: "写作助手", topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      hob.runtime.store.saveRules(aid, [
        { id: "ar-1", text: "自动配图", mode: "ask", changedAt: "2026-11-26T00:00:00.000Z" },
        { id: "ar-2", text: "发送草稿", mode: "ask", changedAt: "2026-11-26T00:00:00.000Z" },
      ]);
      const { topic: aTopic } = await hob.runtime.assistantTopics.create(aid, { title: "专题稿" });
      const aHost = hob.runtime.store.assistantTopicConfigHost(aid, aTopic.id);
      setTopicRule(aHost, { id: "ar-1", mode: "allow" });
      deleteTopicRule(aHost, "ar-2");

      const aSetRule = findTool(hob, aid, "set_rule", { topicId: aTopic.id })!;
      expect(toolText(await aSetRule.execute("a1", { text: "自动配图", mode: "allow", scope: "assistant" }))).toContain("这个话题对这一条单独改过，这里不受影响");
      expect(toolText(await aSetRule.execute("a2", { text: "发送草稿", mode: "allow", scope: "assistant" }))).toContain("这个话题停用了这一条，这里不受影响");
    } finally {
      hob.close();
    }
  });

  it("报告 14：open_topic 转到已关闭的话题时，写交接失败不会把话题留在重开状态", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      // 1. 助手话题
      const aid = "writer";
      addAssistant(hob, aid, { name: "写作助手", topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const { topic } = await hob.runtime.assistantTopics.create(aid, { title: "旧专题" });
      const rt = hob.runtime.routines.create({ assistantId: aid, topicId: topic.id, name: "巡检", instruction: "查", schedules: ["0 9 * * *"] });
      await hob.runtime.assistantTopics.close(aid, topic.id, "阶段性完成");
      expect(hob.runtime.store.assistantTopic(aid, topic.id)?.closedAt).toBeTruthy();

      vi.spyOn(hob.runtime.router, "addTopicHandoff").mockRejectedValueOnce(new Error("磁盘写入失败"));
      const openTopic = findTool(hob, aid, "open_topic")!;
      const res = await openTopic.execute("ot1", { topic: topic.id, note: "补充新需求" });
      expect(res.isError).toBe(true);
      expect(toolText(res)).toContain("磁盘写入失败");
      // 话题仍保持关闭，定时任务也未恢复
      expect(hob.runtime.store.assistantTopic(aid, topic.id)?.closedAt).toBeTruthy();
      expect(hob.runtime.store.assistantTopic(aid, topic.id)?.closeNote).toBe("阶段性完成");
      expect(hob.runtime.store.routine(rt.id)).toMatchObject({ active: false, pausedBy: "topicClosed" });

      // 2. 群话题
      const group = hob.runtime.groups.create({ name: "运维群", purpose: "值守", ownerId: "hob", members: ["hob"] });
      const gTopic = hob.runtime.groups.createTopic(group.id, "告警排查", "user");
      hob.runtime.groups.closeByUser(gTopic.id, "已恢复");
      vi.spyOn(hob.runtime.groups, "appendItem").mockImplementationOnce(() => {
        throw new Error("时间线写入失败");
      });
      const gOpenTopic = findTool(hob, "hob", "open_topic", { groupId: group.id })!;
      const gRes = await gOpenTopic.execute("got1", { topic: gTopic.id, note: "再次触发" });
      expect(gRes.isError).toBe(true);
      expect(hob.runtime.store.group(gTopic.id)?.closedAt).toBeTruthy();
    } finally {
      hob.close();
    }
  });

  it("报告 16：show_assistant 说明包含 topic 用法，主助手漏填 assistantId 传 topic 时给出明确提示", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const showTool = findTool(hob, "hob", "show_assistant")!;
      expect(showTool.description).toContain("传 topic 可以看这个助手某个话题里的消息");

      const res = await showTool.execute("sa1", { topic: "tp-demo" });
      expect(res.isError).toBe(true);
      expect(toolText(res)).toContain("查别的助手的话题，要填 assistantId");
    } finally {
      hob.close();
    }
  });

  it("报告 20：assistantTopicDir 统一校验 tid，HTTP 话题接口非 TopicError 返回 500", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      for (const bad of ["", ".", "..", "../escape", "a/b", "a\\b"]) {
        expect(() => assistantTopicDir(hob.home, "writer", bad)).toThrow();
      }

      const aid = "writer";
      addAssistant(hob, aid, { name: "写作助手", topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const badDir = join(assistantTopicsDir(hob.home, aid), "tp-corrupt");
      mkdirSync(badDir, { recursive: true });
      writeFileSync(join(badDir, "topic.json"), "{ bad json");

      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "test" }),
      });
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

      const res = await app.request(`/api/assistants/${aid}/topics/tp-corrupt/config`, {
        headers: { cookie },
      });
      expect(res.status).toBe(500);
    } finally {
      hob.close();
    }
  });

  it("第 3 节：助手话题推送标题为「助手名 · 话题名」，群话题维持原样", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const aid = "writer";
      addAssistant(hob, aid, { name: "写作助手", notify: true, topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const { topic } = await hob.runtime.assistantTopics.create(aid, { title: "季度总结" });
      const group = hob.runtime.groups.create({ name: "产品群", purpose: "评审", ownerId: "hob", members: ["hob"] });
      const gTopic = hob.runtime.groups.createTopic(group.id, "需求对齐", "user");

      const sent: PushPayload[] = [];
      const push = {
        send: async (payload: PushPayload) => {
          sent.push(payload);
          return { sent: 1, removed: 0 };
        },
      };

      pushAssistantTurnEnd({ push, store: hob.runtime.store }, { assistantId: aid, place: { topicId: topic.id }, text: "初稿写好了" });
      pushAssistantTurnEnd({ push, store: hob.runtime.store }, { assistantId: aid, text: "主对话回复" });
      pushAssistantTurnEnd({ push, store: hob.runtime.store }, { assistantId: "hob", place: { groupId: gTopic.id }, text: "群话题回复" });
      pushInteractiveCard({ push, store: hob.runtime.store }, { assistantId: aid, place: { topicId: topic.id } });
      await new Promise((resolve) => setImmediate(resolve));

      expect(sent[0]?.title).toBe("写作助手 · 季度总结");
      expect(sent[1]?.title).toBe("写作助手");
      expect(sent[2]?.title).toBe("需求对齐");
      expect(sent[3]?.title).toBe("写作助手 · 季度总结");
    } finally {
      hob.close();
    }
  });
});
