import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { answerApproval } from "../src/actions.ts";
import { groupDir } from "../src/config.ts";
import { createApp } from "../src/http.ts";
import { groupModelPick } from "../src/models.ts";
import { buildSystemPrompt, buildWorkerPrompt, GROUP_TOPIC_RULE_LINE } from "../src/prompt.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import {
  deleteTopicRule,
  effectiveRules,
  hiddenRules,
  layerOverrides,
  patchOverrides,
  resetTopicRule,
  setTopicRule,
  type TopicConfigHost,
} from "../src/topic-config.ts";
import type { Group, Rule, RuleOverrides, TopicOverrides } from "../../shared/types.ts";
import { makeHob } from "./helpers.ts";

function makeMemoryHost(initialParent: Rule[]): {
  host: TopicConfigHost;
  parent: Rule[];
  getOverrides: () => TopicOverrides;
  getRuleOverrides: () => RuleOverrides;
} {
  let parent = initialParent.map((r) => ({ ...r }));
  let overrides: TopicOverrides = {};
  let ruleOverrides: RuleOverrides = { own: [], changed: {}, hidden: {} };
  return {
    parent,
    getOverrides: () => overrides,
    getRuleOverrides: () => ruleOverrides,
    host: {
      parentRules: () => parent,
      readOverrides: () => overrides,
      writeOverrides: (next) => {
        overrides = next;
      },
      readRuleOverrides: () => ruleOverrides,
      writeRuleOverrides: (next) => {
        ruleOverrides = next;
      },
    },
  };
}

describe("话题配置覆盖层纯函数（topic-config）", () => {
  it("规则合成：顺序、hidden、changed 覆盖文字、孤儿改动清理", () => {
    const parent: Rule[] = [
      { id: "r-1", text: "发版前确认", changedAt: "2026-01-01T00:00:00Z" },
      { id: "r-2", text: "删除前确认", changedAt: "2026-01-01T00:00:00Z" },
      { id: "r-3", text: "先跑测试", changedAt: "2026-01-01T00:00:00Z" },
    ];
    const box = makeMemoryHost(parent);

    // 改 r-1 的文字，停用 r-2，新增 own 规则
    const edited = setTopicRule(box.host, { id: "r-1", text: "发版前直接合并" });
    expect(edited).toMatchObject({ id: "r-1", text: "发版前直接合并", from: "parent", changed: true });
    deleteTopicRule(box.host, "r-2");
    const own = setTopicRule(box.host, { text: "只在话题确认" });
    expect(own.from).toBe("topic");

    // 上级把 r-1 的文字改了：话题里覆盖过 r-1，仍保留话题的文字
    box.parent[0] = { id: "r-1", text: "上线前确认", changedAt: "2026-01-02T00:00:00Z" };
    // 上级把 r-2 删掉：r-2 在 hidden 里变成孤儿，读时忽略
    box.parent.splice(1, 1);

    const list = effectiveRules(box.parent, box.getRuleOverrides());
    expect(list.map((r) => ({ id: r.id, text: r.text, from: r.from, changed: r.changed }))).toEqual([
      { id: "r-1", text: "发版前直接合并", from: "parent", changed: true },
      { id: "r-3", text: "先跑测试", from: "parent", changed: undefined },
      { id: own.id, text: "只在话题确认", from: "topic", changed: undefined },
    ]);
    expect(hiddenRules(box.parent, box.getRuleOverrides())).toEqual([]);

    // 下次写入顺手清掉孤儿 r-2
    setTopicRule(box.host, { text: "再来一条" });
    expect(box.getRuleOverrides().hidden["r-2"]).toBeUndefined();

    // reset r-1 恢复跟随上级；own 规则不能 reset
    resetTopicRule(box.host, "r-1");
    expect(effectiveRules(box.parent, box.getRuleOverrides())[0]).toMatchObject({
      id: "r-1",
      text: "上线前确认",
      from: "parent",
    });
    expect(effectiveRules(box.parent, box.getRuleOverrides())[0]!.changed).toBeUndefined();
    expect(() => resetTopicRule(box.host, own.id)).toThrow("本话题新增的规则");
    expect(() => resetTopicRule(box.host, "r-missing")).toThrow("规则不存在");
  });

  it("layerOverrides 和 patchOverrides：逐项叠、null 恢复跟随、忽略老数据 memberModels.conversation", () => {
    const p1 = { ref: "p/conv", thinking: "low" as const };
    const p2 = { ref: "p/work", thinking: "high" as const };
    const t1 = { ref: "t/conv", thinking: "medium" as const };
    const m1 = { ref: "m/work", thinking: "off" as const };
    const tm1 = { ref: "tm/work", thinking: "high" as const };

    const parent = {
      models: { conversation: p1, work: p2 },
      memberModels: { a: { work: m1 }, b: { conversation: p1 } as unknown as { work?: typeof m1 } },
      replyMode: "owner" as const,
    };
    const box = makeMemoryHost([]);
    patchOverrides(box.host, {
      models: { conversation: t1 },
      memberModels: { a: { work: tm1 } },
      replyMode: "all",
    });
    const layered = layerOverrides(parent, box.getOverrides());
    expect(layered.models).toEqual({ conversation: t1, work: p2 });
    expect(layered.memberModels).toEqual({ a: { work: tm1 } });
    expect(layered.replyMode).toBe("all");

    // 传入 null 恢复跟随
    const after = patchOverrides(box.host, {
      models: { conversation: null },
      memberModels: { a: { work: null } },
      replyMode: null,
    });
    expect(after).toEqual({});
    const reverted = layerOverrides(parent, after);
    expect(reverted.models).toEqual({ conversation: p1, work: p2 });
    expect(reverted.memberModels).toEqual({ a: { work: m1 } });
    expect(reverted.replyMode).toBe("owner");
  });
});

describe("群话题模型顺序、老数据与 saveGroup 不固化", () => {
  it("任务模型 6 层顺序、对话模型 4 层顺序、老数据 memberModels.conversation 忽略并在保存时清掉", async () => {
    const ids = ["global", "asst", "group", "topic", "member", "topicMember"];
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
      const assistant = hob.runtime.store.assistant("hob")!;
      const pick = (id: string) => ({ ref: `hob-faux/${id}`, thinking: "off" as const });
      hob.runtime.store.saveAssistant({ ...assistant, models: { conversation: pick("asst"), work: pick("asst") } });

      const group = hob.runtime.groups.create({ name: "研发群", purpose: "测试", ownerId: "hob", members: ["hob"] });
      // 在磁盘直接写入包含遗留 memberModels.hob.conversation 的老格式群文件
      const groupJsonPath = join(groupDir(hob.home, group.id), "group.json");
      const rawGroup = JSON.parse(readFileSync(groupJsonPath, "utf8")) as Record<string, unknown>;
      rawGroup.models = { conversation: pick("group"), work: pick("group") };
      rawGroup.memberModels = {
        hob: { conversation: pick("member"), work: pick("member") },
        legacyOnly: { conversation: pick("member") },
      };
      writeFileSync(groupJsonPath, JSON.stringify(rawGroup, null, 2));

      const topic = hob.runtime.groups.createTopic(group.id, "具体功能", "user");
      await hob.runtime.groups.updateModels(topic.id, { conversation: pick("topic"), work: pick("topic") });
      await hob.runtime.groups.updateMemberModels(topic.id, "hob", { work: pick("topicMember") });
      await hob.runtime.models.get();

      const parent = hob.runtime.store.group(group.id)!;
      const stackedTopic = hob.runtime.store.group(topic.id)!;
      const settings = hob.runtime.settings.settings.models;
      const currentHob = hob.runtime.store.assistant("hob")!;

      // 对话模型：跳过 member，topic > group > assistant > global
      expect(groupModelPick(currentHob, parent, hob.runtime.models, settings, "conversation")).toMatchObject({
        source: "group",
        pick: pick("group"),
      });
      expect(groupModelPick(currentHob, parent, hob.runtime.models, settings, "conversation", stackedTopic.overrides)).toMatchObject({
        source: "topic",
        pick: pick("topic"),
      });
      await hob.runtime.groups.updateModels(topic.id, { conversation: null });
      expect(groupModelPick(currentHob, parent, hob.runtime.models, settings, "conversation", hob.runtime.store.group(topic.id)!.overrides)).toMatchObject({
        source: "group",
        pick: pick("group"),
      });

      // 任务模型 6 层顺序：topicMember > member > topic > group > assistant > global
      const step = (ov?: TopicOverrides, g: Group = parent, a = currentHob) =>
        groupModelPick(a, g, hob.runtime.models, settings, "work", ov);

      expect(step(hob.runtime.store.group(topic.id)!.overrides)).toEqual({
        source: "topicMember",
        pick: pick("topicMember"),
        inherited: { source: "member", pick: pick("member") },
      });
      await hob.runtime.groups.updateMemberModels(topic.id, "hob", { work: null });
      expect(step(hob.runtime.store.group(topic.id)!.overrides)).toEqual({
        source: "member",
        pick: pick("member"),
        inherited: { source: "member", pick: pick("member") },
      });

      // 去掉 group 里的 member 覆盖，应该先用 topic 默认，再是 group 默认、assistant、global
      const withoutMember: Group = { ...parent, memberModels: undefined };
      expect(step(hob.runtime.store.group(topic.id)!.overrides, withoutMember)).toEqual({
        source: "topic",
        pick: pick("topic"),
        inherited: { source: "topic", pick: pick("topic") },
      });
      await hob.runtime.groups.updateModels(topic.id, { work: null });
      expect(step(hob.runtime.store.group(topic.id)!.overrides, withoutMember)).toEqual({
        source: "group",
        pick: pick("group"),
        inherited: { source: "group", pick: pick("group") },
      });
      const withoutGroupModels: Group = { ...withoutMember, models: undefined };
      expect(step(hob.runtime.store.group(topic.id)!.overrides, withoutGroupModels)).toEqual({
        source: "assistant",
        pick: pick("asst"),
        inherited: { source: "assistant", pick: pick("asst") },
      });
      expect(step(hob.runtime.store.group(topic.id)!.overrides, withoutGroupModels, { ...currentHob, models: undefined })).toEqual({
        source: "global",
        pick: pick("global"),
        inherited: { source: "global", pick: pick("global") },
      });

      // saveGroup 写群文件时清掉 memberModels 中残留的 conversation，只剩空的整项删掉、work 保留
      hob.runtime.store.saveGroup(parent);
      const savedRaw = JSON.parse(readFileSync(groupJsonPath, "utf8")) as Record<string, any>;
      expect(savedRaw.memberModels).toEqual({ hob: { work: pick("member") } });
    } finally {
      hob.close();
    }
  });

  it("上级改了以后没覆盖的话题跟着变，已覆盖的保持不变", async () => {
    const ids = ["fast", "smart", "eyes"];
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
      const group = hob.runtime.groups.create({ name: "评审群", purpose: "测试", ownerId: "hob", members: ["hob"], replyMode: "owner" });
      const follow = hob.runtime.groups.createTopic(group.id, "跟随的话题", "user");
      const pinned = hob.runtime.groups.createTopic(group.id, "覆盖的话题", "user");

      await hob.runtime.groups.updateModels(pinned.id, { conversation: pick("eyes"), work: pick("eyes") });
      hob.runtime.groups.update(pinned.id, { replyMode: "all" });

      // 上级修改 replyMode、models、memberModels
      hob.runtime.groups.update(group.id, { replyMode: "all" });
      await hob.runtime.groups.updateModels(group.id, { conversation: pick("smart"), work: pick("smart") });
      await hob.runtime.groups.updateMemberModels(group.id, "hob", { work: pick("fast") });

      const followView = hob.runtime.store.group(follow.id)!;
      expect(followView.replyMode).toBe("all");
      expect(followView.models).toEqual({ conversation: pick("smart"), work: pick("smart") });
      expect(followView.memberModels).toEqual({ hob: { work: pick("fast") } });
      expect(followView.overrides).toEqual({});

      const pinnedView = hob.runtime.store.group(pinned.id)!;
      expect(pinnedView.replyMode).toBe("all");
      expect(pinnedView.models).toEqual({ conversation: pick("eyes"), work: pick("eyes") });
      // memberModels 没在 pinned 单独改过，所以依然跟随群的 memberModels
      expect(pinnedView.memberModels).toEqual({ hob: { work: pick("fast") } });

      // 群改回 owner，pinned 因为显式设过 replyMode=all 所以不变，follow 跟着变
      hob.runtime.groups.update(group.id, { replyMode: "owner" });
      expect(hob.runtime.store.group(follow.id)!.replyMode).toBe("owner");
      expect(hob.runtime.store.group(pinned.id)!.replyMode).toBe("all");
    } finally {
      hob.close();
    }
  });

  it("改话题名、关闭、重开不会把继承来的回应方式和模型存成覆盖", async () => {
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
      const pick = { ref: "hob-faux/smart", thinking: "off" as const };
      const group = hob.runtime.groups.create({ name: "群", purpose: "测试", ownerId: "hob", members: ["hob"], replyMode: "all" });
      await hob.runtime.groups.updateModels(group.id, { conversation: pick, work: pick });
      await hob.runtime.groups.updateMemberModels(group.id, "hob", { work: pick });

      const topic = hob.runtime.groups.createTopic(group.id, "原名", "user");
      // 视图上已经叠好了继承值
      expect(topic.replyMode).toBe("all");
      expect(topic.models?.conversation).toEqual(pick);

      // 改话题名、关闭、重开
      hob.runtime.groups.update(topic.id, { name: "改后的名字" });
      hob.runtime.groups.closeByUser(topic.id, "先暂停");
      hob.runtime.groups.reopen(topic.id);

      // 磁盘 JSON 不应把 replyMode/models/memberModels 写进去，overrides 仍为空
      const raw = JSON.parse(readFileSync(join(groupDir(hob.home, topic.id), "group.json"), "utf8")) as Record<string, unknown>;
      expect(raw.name).toBe("改后的名字");
      expect(raw.replyMode).toBeUndefined();
      expect(raw.models).toBeUndefined();
      expect(raw.memberModels).toBeUndefined();
      expect(raw.overrides).toEqual({});

      // 群后来改回 owner，话题依然跟着变
      hob.runtime.groups.update(group.id, { replyMode: "owner" });
      expect(hob.runtime.store.group(topic.id)!.replyMode).toBe("owner");
    } finally {
      hob.close();
    }
  });

  it("老数据补 overrides 的三种情况和重复启动不改，损坏的 rule-overrides.json 报错", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const store = hob.runtime.store;
      const groupAll = hob.runtime.groups.create({ name: "全员群", purpose: "测试", ownerId: "hob", members: ["hob"], replyMode: "all" });
      const groupOwner = hob.runtime.groups.create({ name: "群主群", purpose: "测试", ownerId: "hob", members: ["hob"] });

      const writeRawTopic = (id: string, parentId: string, extra: Record<string, unknown>) => {
        const dir = groupDir(hob.home, id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "group.json"), JSON.stringify({ id, parentId, name: id, createdAt: "2026-01-01T00:00:00Z", ...extra }, null, 2));
      };

      // 1. 和群相同（all == all；owner == 群缺省 owner）
      writeRawTopic("g-same1", groupAll.id, { replyMode: "all" });
      writeRawTopic("g-same2", groupOwner.id, { replyMode: "owner" });
      // 2. 和群不同
      writeRawTopic("g-diff1", groupAll.id, { replyMode: "owner" });
      writeRawTopic("g-diff2", groupOwner.id, { replyMode: "all" });
      // 3. 没有 replyMode
      writeRawTopic("g-none", groupAll.id, {});

      store.migrateTopicOverrides();

      const raw = (id: string) => JSON.parse(readFileSync(join(groupDir(hob.home, id), "group.json"), "utf8")) as Record<string, unknown>;
      expect(raw("g-same1")).toMatchObject({ overrides: {} });
      expect(raw("g-same1").replyMode).toBeUndefined();
      expect(raw("g-same2")).toMatchObject({ overrides: {} });
      expect(raw("g-same2").replyMode).toBeUndefined();
      expect(raw("g-diff1")).toMatchObject({ overrides: { replyMode: "owner" } });
      expect(raw("g-diff1").replyMode).toBeUndefined();
      expect(raw("g-diff2")).toMatchObject({ overrides: { replyMode: "all" } });
      expect(raw("g-none")).toMatchObject({ overrides: {} });

      // 后来用户特意在 g-same1 覆盖成和群相同的 all；再次启动不能把它删掉
      hob.runtime.groups.update("g-same1", { replyMode: "all" });
      expect(raw("g-same1").overrides).toEqual({ replyMode: "all" });
      store.migrateTopicOverrides();
      expect(raw("g-same1").overrides).toEqual({ replyMode: "all" });

      // 损坏的 rule-overrides.json 报错不静默当空
      writeFileSync(join(groupDir(hob.home, "g-same1"), "rule-overrides.json"), "{broken");
      expect(() => store.groupRuleOverrides("g-same1")).toThrow(/读取 .*rule-overrides\.json 失败/);
      expect(() => store.validate()).toThrow(/读取 .*rule-overrides\.json 失败/);
    } finally {
      hob.close();
    }
  });
});

describe("群话题配置 HTTP 接口、工具与提示词", () => {
  it("GET/PATCH/DELETE/reset 话题配置接口，且不互相污染其他话题", async () => {
    const ids = ["fast", "smart", "eyes"];
    const hob = makeHob(
      {},
      {
        memory: "off",
        models: ids.map((id) => ({ id, input: ["text"] })),
        settings: { models: { roster: ids.map((id) => ({ ref: `hob-faux/${id}`, note: "" })) } },
      },
    );
    try {
      const group = hob.runtime.groups.create({ name: "设计群", purpose: "测试", ownerId: "hob", members: ["hob"], replyMode: "owner" });
      const topic = hob.runtime.groups.createTopic(group.id, "配色", "user");
      const sibling = hob.runtime.groups.createTopic(group.id, "排版", "user");

      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const req = (path: string, method = "GET", body?: unknown) =>
        app.request(path, {
          method,
          headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });

      // 群新增一条规则 r-parent
      const addParent = await req(`/api/groups/${group.id}`, "PATCH", { rule: { text: "上线前问我" } });
      expect(addParent.status).toBe(200);
      const parentRuleId = ((await addParent.json()) as { rule: Rule }).rule.id;

      // 话题修改父规则、再加一条自己的规则
      const editInTopic = await req(`/api/groups/${topic.id}`, "PATCH", { rule: { id: parentRuleId, text: "本话题上线直接发布" } });
      expect(editInTopic.status).toBe(200);
      const addInTopic = await req(`/api/groups/${topic.id}`, "PATCH", { rule: { text: "只在这个话题直接发图" } });
      expect(addInTopic.status).toBe(200);
      const ownRuleId = ((await addInTopic.json()) as { rule: Rule }).rule.id;

      // 话题覆盖 models 和 replyMode
      const smart = { ref: "hob-faux/smart", thinking: "off" };
      expect((await req(`/api/groups/${topic.id}`, "PATCH", { models: { conversation: smart }, replyMode: "all" })).status).toBe(200);

      const profileRes = await req(`/api/groups/${topic.id}/profile`);
      expect(profileRes.status).toBe(200);
      const profile = (await profileRes.json()) as import("../../shared/types.ts").GroupProfile;
      expect(profile.replyMode).toEqual({ value: "all", source: "topic" });
      expect(profile.models?.conversation).toMatchObject({ source: "topic", pick: smart });
      expect(profile.rules).toMatchObject([
        { id: parentRuleId, text: "本话题上线直接发布", from: "parent", changed: true },
        { id: ownRuleId, text: "只在这个话题直接发图", from: "topic" },
      ]);
      expect(profile.hiddenRules).toEqual([]);

      // 兄弟话题不受影响
      const siblingProfile = (await (await req(`/api/groups/${sibling.id}/profile`)).json()) as import("../../shared/types.ts").GroupProfile;
      expect(siblingProfile.replyMode).toEqual({ value: "owner", source: "group" });
      expect(siblingProfile.rules).toMatchObject([{ id: parentRuleId, text: "上线前问我", from: "parent" }]);

      // 在话题里停用上级规则 → 进入 hiddenRules；再 reset → 恢复跟随
      expect((await req(`/api/groups/${topic.id}/rules/${parentRuleId}`, "DELETE")).status).toBe(200);
      const afterDel = (await (await req(`/api/groups/${topic.id}/profile`)).json()) as import("../../shared/types.ts").GroupProfile;
      expect(afterDel.rules.map((r) => r.id)).toEqual([ownRuleId]);
      expect(afterDel.hiddenRules?.map((r) => r.id)).toEqual([parentRuleId]);

      // own 规则不能 reset，不存在的规则 reset 返回 404
      expect((await req(`/api/groups/${topic.id}/rules/${ownRuleId}/reset`, "POST")).status).toBe(400);
      expect((await req(`/api/groups/${topic.id}/rules/r-missing/reset`, "POST")).status).toBe(404);

      expect((await req(`/api/groups/${topic.id}/rules/${parentRuleId}/reset`, "POST")).status).toBe(200);
      const afterReset = (await (await req(`/api/groups/${topic.id}/profile`)).json()) as import("../../shared/types.ts").GroupProfile;
      expect(afterReset.rules[0]).toMatchObject({ id: parentRuleId, text: "上线前问我", from: "parent" });
      expect(afterReset.rules[0]!.changed).toBeUndefined();
      expect(afterReset.hiddenRules).toEqual([]);

      // models 与 replyMode 传 null 恢复跟随
      expect((await req(`/api/groups/${topic.id}`, "PATCH", { models: { conversation: null }, replyMode: null })).status).toBe(200);
      const reverted = (await (await req(`/api/groups/${topic.id}/profile`)).json()) as import("../../shared/types.ts").GroupProfile;
      expect(reverted.replyMode).toEqual({ value: "owner", source: "group" });
      expect(reverted.models?.conversation.source).toBe("global");
    } finally {
      hob.close();
    }
  });

  it("set_rule / remove_rule 在话题有 scope 参数、综合和单聊没有；always 与提示词照定稿", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const base = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...base, id: "dev", name: "开发", duty: "写代码", primary: false, pinned: false, sprite: "page" });
      const group = hob.runtime.groups.create({ name: "开发群", purpose: "研发", ownerId: "hob", members: ["hob", "dev"] });
      const topic = hob.runtime.groups.createTopic(group.id, "修 bug", "user");

      const directTools = buildRouterTools(hob.runtime, "dev");
      const primaryTools = buildRouterTools(hob.runtime, "hob");
      const overviewTools = buildRouterTools(hob.runtime, "hob", { groupId: group.id });
      const topicTools = buildRouterTools(hob.runtime, "hob", { groupId: topic.id });

      // 综合、单聊、主助手里 set_rule / remove_rule 没有 scope 参数
      for (const list of [directTools, primaryTools, overviewTools]) {
        expect((list.find((t) => t.name === "set_rule")!.parameters as any).properties.scope).toBeUndefined();
        expect((list.find((t) => t.name === "remove_rule")!.parameters as any).properties.scope).toBeUndefined();
      }
      // 话题里有必填 scope: "topic" | "group"
      for (const toolName of ["set_rule", "remove_rule"] as const) {
        const params = topicTools.find((t) => t.name === toolName)!.parameters as any;
        expect(params.required).toContain("scope");
        expect(params.properties.scope.anyOf.map((v: any) => v.const)).toEqual(["topic", "group"]);
      }

      const topicSet = topicTools.find((t) => t.name === "set_rule")!;
      const topicRemove = topicTools.find((t) => t.name === "remove_rule")!;

      // 缺省或非法 scope 均拒绝并提示两个可选值
      for (const invalid of [undefined, "", "assistant"]) {
        const badSet = await topicSet.execute("0a", { text: "x", ...(invalid !== undefined ? { scope: invalid } : {}) }, undefined, undefined, undefined as never);
        expect(badSet.isError).toBe(true);
        expect((badSet.content[0] as { text: string }).text).toContain("topic");
        expect((badSet.content[0] as { text: string }).text).toContain("group");

        const badRm = await topicRemove.execute("0b", { ruleId: "r-any", ...(invalid !== undefined ? { scope: invalid } : {}) }, undefined, undefined, undefined as never);
        expect(badRm.isError).toBe(true);
        expect((badRm.content[0] as { text: string }).text).toContain("topic");
        expect((badRm.content[0] as { text: string }).text).toContain("group");
      }

      const resTopic = await topicSet.execute("1", { text: "临时直接改", scope: "topic" }, undefined, undefined, undefined as never);
      expect((resTopic.content[0] as { text: string }).text).toBe("已加到这个话题的规则，只在这个话题生效。");
      expect(hob.runtime.store.groupParentRules(group.id)).toEqual([]);

      const resGroup = await topicSet.execute("2", { text: "全群发布先确认", scope: "group" }, undefined, undefined, undefined as never);
      expect((resGroup.content[0] as { text: string }).text).toBe("已加到本群的规则，没有单独改过这一条的话题都会用。");
      const parentRuleId = hob.runtime.store.groupParentRules(group.id)[0]!.id;

      // 在话题里带 scope: "topic" 删除上级规则 → 停用，只影响本话题，群里还在
      await topicRemove.execute("3", { ruleId: parentRuleId, scope: "topic" }, undefined, undefined, undefined as never);
      expect(hob.runtime.store.groupRules(topic.id).some((r) => r.id === parentRuleId)).toBe(false);
      expect(hob.runtime.store.groupParentRules(group.id).some((r) => r.id === parentRuleId)).toBe(true);

      // 在话题里带 scope: "group" 删除上级规则 → 从本群规则删除
      const resGroup2 = await topicSet.execute("4", { text: "仅群级测试规则", scope: "group" }, undefined, undefined, undefined as never);
      expect((resGroup2.content[0] as { text: string }).text).toBe("已加到本群的规则，没有单独改过这一条的话题都会用。");
      const toDeleteGroupRuleId = hob.runtime.store.groupParentRules(group.id).find((r) => r.text === "仅群级测试规则")!.id;
      const rmGroup = await topicRemove.execute("5", { ruleId: toDeleteGroupRuleId, scope: "group" }, undefined, undefined, undefined as never);
      expect((rmGroup.content[0] as { text: string }).text).toBe("已从本群的规则里删除。");
      expect(hob.runtime.store.groupParentRules(group.id).some((r) => r.id === toDeleteGroupRuleId)).toBe(false);

      // 提示词：群话题逐字包含第十节文字；综合、单聊、主助手不含话题规则段
      const opts = { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const };
      const topicPrompt = buildSystemPrompt(hob.runtime.store, "hob", { ...opts, group: hob.runtime.store.group(topic.id)! });
      expect(topicPrompt).toContain(
        "在这个话题里定的规则通常只管这个话题，用 set_rule 时 scope 填 topic。用户明确要求整个群以后都要这样，scope 才填 group，写到本群的规则里，综合和别的话题也会照着做；拿不准时填 topic。",
      );
      expect(GROUP_TOPIC_RULE_LINE).toBe(
        "在这个话题里定的规则通常只管这个话题，用 set_rule 时 scope 填 topic。用户明确要求整个群以后都要这样，scope 才填 group，写到本群的规则里，综合和别的话题也会照着做；拿不准时填 topic。",
      );

      for (const prompt of [
        buildSystemPrompt(hob.runtime.store, "hob", opts),
        buildSystemPrompt(hob.runtime.store, "dev", opts),
        buildSystemPrompt(hob.runtime.store, "hob", { ...opts, group: hob.runtime.store.group(group.id)! }),
      ]) {
        expect(prompt).not.toContain(GROUP_TOPIC_RULE_LINE);
        expect(prompt).not.toContain("这个话题的规则：");
      }

      // 话题内提问卡 always 写进话题层，并且话题内任务拿到合成后的规则
      hob.runtime.store.saveApproval({
        id: "a-1",
        assistantId: "dev",
        groupId: topic.id,
        title: "继续？",
        options: [{ key: "A", label: "以后直接修", always: true }],
        status: "pending",
        source: "router",
        createdAt: new Date().toISOString(),
      });
      await answerApproval(hob.runtime, "a-1", { key: "A" });
      expect(hob.runtime.store.groupRules(topic.id).some((r) => r.text === "直接执行：以后直接修" && r.from === "topic")).toBe(true);
      expect(hob.runtime.store.groupParentRules(group.id).some((r) => r.text.includes("以后直接修"))).toBe(false);

      hob.runtime.store.saveJob({
        id: "t-topic-rules",
        assistantId: "dev",
        title: "任务规则",
        instruction: "测试",
        groupId: topic.id,
        status: "done",
        createdAt: new Date().toISOString(),
        stats: { reads: 0, commands: 0, edits: 0 },
        activity: [],
      });
      const workerPrompt = buildWorkerPrompt(hob.runtime.store, "t-topic-rules", opts);
      expect(workerPrompt).toContain("以后直接修");
      // 被本话题停用的上级规则不进本话题任务提示词
      expect(workerPrompt).not.toContain("全群发布先确认");
      expect(existsSync(join(groupDir(hob.home, topic.id), "rule-overrides.json"))).toBe(true);
    } finally {
      hob.close();
    }
  });

  it("saveGroup 在未迁移话题没有 overrides 时保留老的 replyMode，且置顶与回应方式覆盖互不覆盖", () => {
    const hob = makeHob();
    try {
      const group = hob.runtime.groups.create({
        name: "协同群",
        purpose: "测试",
        ownerId: "hob",
        members: ["hob", "dev"],
        replyMode: "owner",
      });
      const topic = hob.runtime.groups.createTopic(group.id, "未迁移测试");
      const topicFile = join(groupDir(hob.home, topic.id), "group.json");

      // 构造磁盘上还没有 overrides 键但有老 replyMode 的话题文件，直接调用 saveGroup 改名
      const legacyOnDisk = JSON.parse(readFileSync(topicFile, "utf8")) as Record<string, unknown>;
      delete legacyOnDisk.overrides;
      legacyOnDisk.replyMode = "all";
      writeFileSync(topicFile, JSON.stringify(legacyOnDisk, null, 2));

      const view = hob.runtime.store.group(topic.id)!;
      expect(view.overrides).toBeUndefined();
      hob.runtime.store.saveGroup({ ...view, name: "已保存名字" });
      const savedRaw = JSON.parse(readFileSync(topicFile, "utf8")) as Record<string, unknown>;
      expect(savedRaw.overrides).toEqual({ replyMode: "all" });
      expect(savedRaw.replyMode).toBeUndefined();

      // 若磁盘上既无 overrides 也无 replyMode，即使群是 all，saveGroup 也不应把群的 replyMode 固化进 overrides
      hob.runtime.groups.update(group.id, { replyMode: "all" });
      delete legacyOnDisk.replyMode;
      writeFileSync(topicFile, JSON.stringify(legacyOnDisk, null, 2));
      const viewNoOwn = hob.runtime.store.group(topic.id)!;
      expect(viewNoOwn.replyMode).toBe("all");
      hob.runtime.store.saveGroup({ ...viewNoOwn, name: "不固化群值" });
      const savedNoOwn = JSON.parse(readFileSync(topicFile, "utf8")) as Record<string, unknown>;
      expect(savedNoOwn.overrides).toEqual({});

      // 置顶 + 回应方式覆盖 + 改名共同作用，关闭与重开清置顶同时保留 overrides
      hob.runtime.groups.update(topic.id, { replyMode: "owner", pinned: true, name: "置顶话题" });
      const pinned = hob.runtime.store.group(topic.id)!;
      expect(pinned.pinnedAt).toBeTruthy();
      expect(pinned.overrides).toEqual({ replyMode: "owner" });
      hob.runtime.groups.update(topic.id, { replyMode: null, pinned: false });
      const unpinned = hob.runtime.store.group(topic.id)!;
      expect(unpinned.pinnedAt).toBeUndefined();
      expect(unpinned.overrides).toEqual({});
      expect(unpinned.replyMode).toBe("all");
    } finally {
      hob.close();
    }
  });
});
