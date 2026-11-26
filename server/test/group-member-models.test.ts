import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { groupModelPick } from "../src/models.ts";
import { createApp } from "../src/http.ts";
import { makeHob } from "./helpers.ts";

describe("群成员模型", () => {
  it("没有可用模型时群资料显示全局设置", async () => {
    const hob = makeHob();
    try {
      const group = hob.runtime.groups.create({ name: "群", purpose: "测试", ownerId: "hob", members: ["hob"] });
      const pick = { ref: "missing/model", thinking: "off" as const };
      const modified = { ...group, models: { conversation: pick, work: pick } };
      vi.spyOn(hob.runtime.models, "find").mockReturnValue(undefined);
      const settings = hob.runtime.settings.settings.models;
      for (const key of ["conversation", "work"] as const) {
        expect(groupModelPick(hob.runtime.store.assistant("hob")!, modified, hob.runtime.models, settings, key)).toMatchObject({ source: "global", pick: settings[key] });
      }
    } finally { hob.close(); }
  });
  it("群和成员的模型覆盖复用字段解析", () => {
    const source = readFileSync(new URL("../src/groups.ts", import.meta.url), "utf8");
    expect(source.match(/checkAssistantModels\(\{ models:/g)).toHaveLength(1);
  });
  it("冷缓存下群资料和实际任务使用相同模型", async () => {
    const hob = makeHob({}, { memory: "off", models: [{ id: "base" }, { id: "group" }], settings: { models: { roster: ["base", "group"].map((id) => ({ ref: `hob-faux/${id}`, note: "" })) } } });
    try {
      const group = hob.runtime.groups.create({ name: "群", purpose: "测试", members: ["hob"], ownerId: "hob" });
      await hob.runtime.groups.updateModels(group.id, { work: { ref: "hob-faux/group", thinking: "off" } });
      hob.runtime.models.reset();
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const response = await app.request(`/api/groups/${group.id}/profile`, { headers: { cookie } });
      const profile = await response.json() as import("../../shared/types.ts").GroupProfile;
      const job = await hob.runtime.jobs.start("hob", { title: "测试", instruction: "测试", groupId: group.id });
      expect(profile.memberModels.hob!.work).toMatchObject({ source: "group", pick: { ref: job.model } });
    } finally { hob.close(); }
  });
  it("单聊、两个群及话题隔离会话和任务模型", async () => {
    const picks = ["fast", "smart", "eyes"];
    const hob = makeHob({}, { memory: "off", models: picks.map((id) => ({ id, input: ["text"] })), settings: { models: { roster: picks.map((id) => ({ ref: `hob-faux/${id}`, note: "" })) } } });
    try {
      const a = hob.runtime.groups.create({ name: "甲", purpose: "测试", members: ["hob"], ownerId: "hob" });
      const b = hob.runtime.groups.create({ name: "乙", purpose: "测试", members: ["hob"], ownerId: "hob" });
      const topic = hob.runtime.groups.createTopic(a.id, "话题", "user");
      const pick = (ref: string) => ({ ref: `hob-faux/${ref}`, thinking: "off" });
      await hob.runtime.groups.updateModels(a.id, { conversation: pick("smart") });
      await hob.runtime.groups.updateMemberModels(a.id, "hob", { work: pick("smart") });
      await hob.runtime.groups.updateModels(b.id, { conversation: pick("eyes") });
      await hob.runtime.groups.updateMemberModels(b.id, "hob", { work: pick("eyes") });
      const direct = await hob.runtime.router.ensure("hob");
      const first = await hob.runtime.router.ensure("hob", { groupId: a.id });
      const second = await hob.runtime.router.ensure("hob", { groupId: b.id });
      const topicState = await hob.runtime.router.ensure("hob", { groupId: topic.id });
      expect([direct, first, second, topicState].map((state) => state.session?.model?.id)).toEqual(["fast", "smart", "eyes", "smart"]);
      const jobA = await hob.runtime.jobs.start("hob", { title: "甲任务", instruction: "测试", groupId: a.id });
      const jobB = await hob.runtime.jobs.start("hob", { title: "乙任务", instruction: "测试", groupId: b.id });
      expect([jobA.model, jobB.model]).toEqual(["hob-faux/smart", "hob-faux/eyes"]);
      const directSession = direct.session;
      const secondSession = second.session;
      await hob.runtime.groups.updateModels(a.id, { conversation: pick("eyes") });
      await hob.runtime.groups.updateMemberModels(a.id, "hob", { work: pick("eyes") });
      expect((await hob.runtime.router.ensure("hob")).session).toBe(directSession);
      expect((await hob.runtime.router.ensure("hob", { groupId: b.id })).session).toBe(secondSession);
      expect((await hob.runtime.router.ensure("hob", { groupId: a.id })).session?.model?.id).toBe("eyes");
      expect(hob.runtime.store.job(jobA.id)?.model).toBe("hob-faux/smart");
      const other = { ...hob.runtime.store.assistant("hob")!, id: "other", name: "其他", primary: false };
      hob.runtime.store.saveAssistant(other);
      hob.runtime.groups.update(a.id, { members: ["hob", "other"] });
      await hob.runtime.groups.updateMemberModels(a.id, "other", { work: pick("smart") });
      hob.runtime.groups.update(a.id, { members: ["hob"] });
      expect(hob.runtime.store.group(a.id)?.memberModels?.other).toBeUndefined();
    } finally { hob.close(); }
  });

  it("群模型按话题、群、助手、全局取值并只释放对应会话", async () => {
    const picks = ["fast", "smart", "eyes"];
    const hob = makeHob({}, { memory: "off", models: picks.map((id) => ({ id, input: ["text"] })), settings: { models: { roster: picks.map((id) => ({ ref: `hob-faux/${id}`, note: "" })) } } });
    try {
      const a = hob.runtime.groups.create({ name: "甲", purpose: "测试", members: ["hob"], ownerId: "hob" });
      const b = hob.runtime.groups.create({ name: "乙", purpose: "测试", members: ["hob"], ownerId: "hob" });
      const topic = hob.runtime.groups.createTopic(a.id, "话题", "user");
      const pick = (id: string) => ({ ref: `hob-faux/${id}`, thinking: "off" });
      const direct = await hob.runtime.router.ensure("hob");
      const groupSession = await hob.runtime.router.ensure("hob", { groupId: a.id });
      const other = await hob.runtime.router.ensure("hob", { groupId: b.id });
      await hob.runtime.router.ensure("hob", { groupId: topic.id });
      // 改话题模型只释放这个话题的会话，综合、单聊和其他群不受影响
      await hob.runtime.groups.updateModels(topic.id, { conversation: pick("smart"), work: pick("smart") });
      expect((await hob.runtime.router.ensure("hob", { groupId: topic.id })).session?.model?.id).toBe("smart");
      expect((await hob.runtime.router.ensure("hob")).session).toBe(direct.session);
      expect((await hob.runtime.router.ensure("hob", { groupId: a.id })).session).toBe(groupSession.session);
      expect((await hob.runtime.router.ensure("hob", { groupId: b.id })).session).toBe(other.session);
      // 改群对话模型，群和未覆盖的话题都跟着变
      await hob.runtime.groups.updateModels(a.id, { conversation: pick("eyes") });
      expect((await hob.runtime.router.ensure("hob", { groupId: a.id })).session?.model?.id).toBe("eyes");
      expect((await hob.runtime.router.ensure("hob", { groupId: topic.id })).session?.model?.id).toBe("smart");
      await hob.runtime.groups.updateModels(a.id, { conversation: null });
      const assistant = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...assistant, models: { conversation: pick("eyes") as any } });
      expect((await hob.runtime.router.ensure("hob", { groupId: a.id })).session?.model?.id).toBe("eyes");
      hob.runtime.store.saveAssistant({ ...assistant });
      await hob.runtime.groups.updateModels(a.id, { conversation: null });
      expect((await hob.runtime.router.ensure("hob", { groupId: a.id })).session?.model?.id).toBe("fast");
    } finally { hob.close(); }
  });

  it("群资料返回移除成员覆盖后的模型来源", async () => {
    const ids = ["fast", "smart", "eyes"];
    const hob = makeHob({}, { memory: "off", models: ids.map((id) => ({ id, input: ["text"] })), settings: { models: { roster: ids.map((id) => ({ ref: `hob-faux/${id}`, note: "" })) } } });
    try {
      const group = hob.runtime.groups.create({ name: "测试群", purpose: "测试", members: ["hob"], ownerId: "hob" });
      const topic = hob.runtime.groups.createTopic(group.id, "话题", "user");
      const pick = (id: string) => ({ ref: `hob-faux/${id}`, thinking: "off" as const });
      const assistant = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...assistant, models: { conversation: pick("fast"), work: pick("fast") } });
      await hob.runtime.groups.updateModels(group.id, { conversation: pick("smart"), work: pick("smart") });
      await hob.runtime.groups.updateMemberModels(group.id, "hob", { work: pick("eyes") });
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const profile = async (id = topic.id) => (await (await app.request(`/api/groups/${id}/profile`, { headers: { cookie } })).json() as import("../../shared/types.ts").GroupProfile).memberModels.hob!;
      expect((await profile()).conversation).toEqual({ source: "group", pick: pick("smart"), inherited: { source: "group", pick: pick("smart") } });
      expect((await profile()).work).toEqual({ source: "member", pick: pick("eyes"), inherited: { source: "member", pick: pick("eyes") } });
      expect((await profile(group.id)).work).toEqual({ source: "member", pick: pick("eyes"), inherited: { source: "group", pick: pick("smart") } });
      await hob.runtime.groups.updateModels(group.id, { conversation: null, work: null });
      expect((await profile(group.id)).work.inherited).toEqual({ source: "assistant", pick: pick("fast") });
      hob.runtime.store.saveAssistant({ ...assistant, models: undefined });
      expect((await profile(group.id)).work.inherited).toEqual({ source: "global", pick: hob.runtime.settings.settings.models.work });
      await hob.runtime.groups.updateMemberModels(group.id, "hob", { work: null });
      const following = await profile(group.id);
      expect(following.work.inherited).toEqual({ source: following.work.source, pick: following.work.pick });
    } finally { hob.close(); }
  });

  it("话题成员模型独立于所属群，只收 work，清除和非成员校验", async () => {
    const hob = makeHob({}, { models: [{ id: "fast", input: ["text"] }, { id: "smart", input: ["text"] }], settings: { models: { roster: [{ ref: "hob-faux/fast", note: "" }, { ref: "hob-faux/smart", note: "" }] } } });
    try {
      const group = hob.runtime.groups.create({ name: "测试群", purpose: "测试", members: ["hob"], ownerId: "hob" });
      const topic = hob.runtime.groups.createTopic(group.id, "话题", "user");
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const patch = (id: string, assistant: string, body: unknown) => app.request(`/api/groups/${id}/members/${assistant}/models`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
      const badConv = await patch(topic.id, "hob", { conversation: { ref: "hob-faux/smart", thinking: "off" } });
      expect(badConv.status).toBe(400);
      expect(await badConv.json()).toEqual({ error: "成员只能单设任务模型，对话模型在群设置里改" });
      expect((await patch(topic.id, "hob", { work: { ref: "hob-faux/smart", thinking: "off" } })).status).toBe(200);
      expect(hob.runtime.store.group(group.id)?.memberModels?.hob?.work).toBeUndefined();
      expect(hob.runtime.store.group(topic.id)?.memberModels?.hob?.work?.ref).toBe("hob-faux/smart");
      expect((await patch(group.id, "other", { work: null })).status).toBe(400);
      expect((await patch(topic.id, "hob", { work: null })).status).toBe(200);
      expect(hob.runtime.store.group(topic.id)?.memberModels?.hob).toBeUndefined();
    } finally { hob.close(); }
  });
});
