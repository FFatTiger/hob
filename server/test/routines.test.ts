import { afterEach, describe, expect, it, vi } from "vitest";
import { makeHob } from "./helpers.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { createApp } from "../src/http.ts";

function setNow(iso: string): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

afterEach(() => vi.useRealTimers());

describe("群定时", () => {
  it("启动时把旧群定时迁到群主名下", () => {
    const hob = makeHob();
    try {
      const base = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...base, id: "ops", primary: false });
      const group = hob.runtime.groups.create({ name: "团队", purpose: "协作", ownerId: "hob", members: ["hob", "ops"] });
      const routine = hob.runtime.routines.create({ assistantId: "hob", groupId: group.id, name: "检查", instruction: "检查", schedules: ["0 9 * * *"] });
      hob.runtime.store.saveRoutine({ ...routine, assistantId: "ops" });
      hob.runtime.routines.start();
      expect(hob.runtime.store.routine(routine.id)?.assistantId).toBe("hob");
    } finally { hob.close(); }
  });

  it("接口建群定时自动使用群主，修改负责人返回 400", async () => {
    const hob = makeHob();
    try {
      const group = hob.runtime.groups.create({ name: "团队", purpose: "协作", ownerId: "hob", members: ["hob"] });
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const headers = { cookie, "content-type": "application/json" };
      const created = await app.request("/api/routines", { method: "POST", headers, body: JSON.stringify({ groupId: group.id, name: "检查", instruction: "检查", schedules: ["0 9 * * *"] }) });
      expect(created.status).toBe(200);
      const body = await created.json() as { routine: { id: string; assistantId: string } };
      expect(body.routine.assistantId).toBe("hob");
      const patch = await app.request(`/api/routines/${body.routine.id}`, { method: "PATCH", headers, body: JSON.stringify({ assistantId: "hob" }) });
      expect(patch.status).toBe(400);
      expect(await patch.json()).toEqual({ error: "群的定时由群主处理" });
    } finally { hob.close(); }
  });
  it("群主接收定时，换群主时同步；不绑定技能", async () => {
    const hob = makeHob();
    try {
      const main = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...main, id: "ops", name: "服务器", primary: false });
      const group = hob.runtime.groups.create({ name: "团队", purpose: "协作", ownerId: "hob", members: ["hob", "ops"] });
      const topic = hob.runtime.groups.createTopic(group.id, "话题", "user");
      const tool = buildRouterTools(hob.runtime, "ops", topic.id).find((item) => item.name === "create_routine")!;
      expect(tool.parameters.properties).not.toHaveProperty("by");
      const result = await tool.execute("routine", { name: "检查", instruction: "检查", schedules: ["0 9 * * *"], skill: "ignored" });
      expect(result.isError).not.toBe(true);
      const routine = hob.runtime.store.routines()[0]!;
      expect(routine).toMatchObject({ assistantId: "hob", groupId: topic.id });
      expect(routine).not.toHaveProperty("skill");
      expect(() => hob.runtime.routines.update(routine.id, { assistantId: "ops" })).toThrow("群的定时由群主处理");
      const delivered: { gid: string; aid: string; event: string; trigger?: string }[] = [];
      hob.runtime.groups.deliverEvent = async (gid, aid, event, trigger) => { delivered.push({ gid, aid, event, trigger }); };
      expect(await hob.runtime.routines.runNow(routine.id)).toEqual({ outcome: "handed" });
      const note = hob.runtime.groups.items(topic.id).items.find((item) => item.kind === "note" && item.text.includes("已到执行时间"))!;
      expect(delivered[0]).toMatchObject({ gid: topic.id, aid: "hob", trigger: note.id, event: expect.stringContaining("服务器 填写的任务内容：检查") });
      expect(hob.runtime.store.jobs()).toHaveLength(0);
      expect(hob.runtime.store.routine(routine.id)?.runs[0]).toMatchObject({ status: "handed" });
      hob.runtime.groups.update(group.id, { ownerId: "ops" });
      expect(hob.runtime.store.routine(routine.id)).toMatchObject({ assistantId: "ops", groupId: topic.id });
      expect(hob.runtime.store.routine(routine.id)).not.toHaveProperty("skill");
    } finally { hob.close(); }
  });
});

describe("定时", () => {
  it("创建、改时间即时生效、立即运行交给助手并记 runs", async () => {
    const hob = makeHob();
    try {
      const routine = hob.runtime.routines.create({
        assistantId: "hob",
        name: "每日简报",
        instruction: "看看今天的新闻",
        schedules: ["0 9 * * *"],
      });
      expect(hob.runtime.routines.nextRuns(routine.id)).toHaveLength(1);

      const updated = hob.runtime.routines.update(routine.id, { schedules: ["0 9 * * *", "0 21 * * *"] });
      expect(updated.schedules).toEqual(["0 9 * * *", "0 21 * * *"]);
      expect(hob.runtime.routines.nextRuns(routine.id)).toHaveLength(2);

      // 关掉就不排了
      hob.runtime.routines.update(routine.id, { active: false });
      expect(hob.runtime.routines.nextRuns(routine.id)).toHaveLength(0);
      hob.runtime.routines.update(routine.id, { active: true });

      const event = vi.spyOn(hob.runtime.router, "event").mockResolvedValue(true);
      const tick = await hob.runtime.routines.runNow(routine.id);
      expect(tick).toEqual({ outcome: "handed" });
      expect(event).toHaveBeenCalledWith("hob", expect.stringContaining("看看今天的新闻"), expect.anything());
      expect(hob.runtime.store.routine(routine.id)?.runs[0]).toMatchObject({ status: "handed" });
    } finally {
      hob.close();
    }
  });

  it("非法 cron 报错，不建定时", () => {
    const hob = makeHob();
    try {
      expect(() =>
        hob.runtime.routines.create({
          assistantId: "hob",
          name: "坏定时",
          instruction: "x",
          schedules: ["不是 cron"],
        }),
      ).toThrow(/cron/);
      expect(hob.runtime.store.routines()).toHaveLength(0);
    } finally {
      hob.close();
    }
  });

  it("删掉定时后不再排", () => {
    const hob = makeHob();
    try {
      const routine = hob.runtime.routines.create({
        assistantId: "hob",
        name: "临时",
        instruction: "x",
        schedules: ["0 9 * * *"],
      });
      hob.runtime.routines.remove(routine.id);
      expect(hob.runtime.store.routine(routine.id)).toBeUndefined();
      expect(hob.runtime.routines.nextRuns(routine.id)).toEqual([]);
    } finally {
      hob.close();
    }
  });
});

describe("检查脚本试跑", () => {
  it("建定时时试跑一次，脚本写错当场告诉模型，写对就记下现状", async () => {
    const hob = makeHob();
    try {
      const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "create_routine")!;
      const said = (result: { content: unknown[] }) => (result.content as { text?: string }[]).map((part) => part.text ?? "").join("");
      const bad = said((await tool.execute("bad", { name: "坏脚本", instruction: "看看", schedules: ["0 9 * * *"], check: { script: "import json\nprint(json.dumps(1))", then: "job" } })));
      expect(bad).toContain("检查脚本试跑失败");
      expect(hob.runtime.store.routines().some((routine) => routine.name === "坏脚本")).toBe(true);
      const good = said((await tool.execute("good", { name: "好脚本", instruction: "看看", schedules: ["0 9 * * *"], check: { script: "test -f seen || touch seen", then: "job" } })));
      expect(good).toContain("检查脚本试跑通过");
      const routine = hob.runtime.store.routines().find((item) => item.name === "好脚本")!;
      expect(routine.checks?.total ?? 0).toBe(0);
    } finally { hob.close(); }
  });
});

describe("群话题的定时归话题（P2）", () => {
  it("关闭话题暂停启用中定时并记 pausedBy，到点不跑也不改发综合；重开只恢复 pausedBy 的", async () => {
    const hob = makeHob();
    try {
      const group = hob.runtime.groups.create({ name: "研发群", purpose: "协作", ownerId: "hob", members: ["hob"] });
      const topic = hob.runtime.groups.createTopic(group.id, "上线检查", "user");

      const topicActive = hob.runtime.routines.create({
        assistantId: "hob",
        groupId: topic.id,
        name: "话题巡检",
        instruction: "看下上线指标",
        schedules: ["0 9 * * *"],
      });
      const topicUserPaused = hob.runtime.routines.create({
        assistantId: "hob",
        groupId: topic.id,
        name: "用户暂停的定时",
        instruction: "暂不用跑",
        schedules: ["0 10 * * *"],
        active: false,
      });
      const generalActive = hob.runtime.routines.create({
        assistantId: "hob",
        groupId: group.id,
        name: "综合早报",
        instruction: "汇总进展",
        schedules: ["0 8 * * *"],
      });

      const delivered: string[] = [];
      hob.runtime.groups.deliverEvent = async (gid) => { delivered.push(gid); };

      // 关闭话题：仅启用中的话题定时被暂停且记 pausedBy，cron 停止；用户手动暂停的与综合定时不受影响
      hob.runtime.groups.closeByUser(topic.id, "先告一段落");
      expect(hob.runtime.store.routine(topicActive.id)).toMatchObject({ active: false, pausedBy: "topicClosed" });
      expect(hob.runtime.routines.nextRuns(topicActive.id)).toEqual([]);
      expect(hob.runtime.store.routine(topicUserPaused.id)?.active).toBe(false);
      expect(hob.runtime.store.routine(topicUserPaused.id)?.pausedBy).toBeUndefined();
      expect(hob.runtime.store.routine(generalActive.id)).toMatchObject({ active: true });
      expect(hob.runtime.store.routine(generalActive.id)?.pausedBy).toBeUndefined();
      expect(hob.runtime.routines.nextRuns(generalActive.id)).toHaveLength(1);

      // 关闭后到点不跑，也不会改发到综合
      await hob.runtime.routines.fire(topicActive.id);
      expect(delivered).toEqual([]);
      expect(hob.runtime.store.routine(topicActive.id)?.runs).toEqual([]);
      expect(hob.runtime.groups.items(group.id).items.some((item) => item.kind === "note" && item.routineId === topicActive.id)).toBe(false);
      expect(hob.runtime.groups.items(topic.id).items.some((item) => item.kind === "note" && item.routineId === topicActive.id)).toBe(false);

      // 关闭期间拒绝手动启用或立即运行
      expect(() => hob.runtime.routines.update(topicActive.id, { active: true })).toThrow("话题已关闭");
      await expect(hob.runtime.routines.runNow(topicActive.id)).rejects.toThrow("话题已关闭");

      // 综合的定时照常在综合运行
      await hob.runtime.routines.fire(generalActive.id);
      expect(delivered).toEqual([group.id]);

      // 重新打开话题：只恢复 pausedBy 为 topicClosed 的定时，用户自己暂停的不被恢复
      hob.runtime.groups.reopen(topic.id);
      expect(hob.runtime.store.routine(topicActive.id)?.active).toBe(true);
      expect(hob.runtime.store.routine(topicActive.id)?.pausedBy).toBeUndefined();
      expect(hob.runtime.routines.nextRuns(topicActive.id)).toHaveLength(1);
      expect(hob.runtime.store.routine(topicUserPaused.id)?.active).toBe(false);
      expect(hob.runtime.store.routine(topicUserPaused.id)?.pausedBy).toBeUndefined();
      expect(hob.runtime.routines.nextRuns(topicUserPaused.id)).toEqual([]);

      // 重开后到点直接发到话题本身
      delivered.length = 0;
      await hob.runtime.routines.fire(topicActive.id);
      expect(delivered).toEqual([topic.id]);
    } finally { hob.close(); }
  });

  it("重启恢复：老数据里已关闭话题留着 active 的定时在 start 时暂停并记 pausedBy", async () => {
    const hob = makeHob();
    try {
      const group = hob.runtime.groups.create({ name: "研发群", purpose: "协作", ownerId: "hob", members: ["hob"] });
      const topic = hob.runtime.groups.createTopic(group.id, "历史话题", "user");
      const routine = hob.runtime.routines.create({
        assistantId: "hob",
        groupId: topic.id,
        name: "旧定时",
        instruction: "检查",
        schedules: ["0 9 * * *"],
      });
      // 模拟升级前的老数据：话题已关闭但定时还是 active
      hob.runtime.store.saveGroup({ ...hob.runtime.store.group(topic.id)!, closedAt: new Date().toISOString() });
      hob.runtime.routines.start();
      expect(hob.runtime.store.routine(routine.id)).toMatchObject({ active: false, pausedBy: "topicClosed" });
      expect(hob.runtime.routines.nextRuns(routine.id)).toEqual([]);
      hob.runtime.groups.reopen(topic.id);
      expect(hob.runtime.store.routine(routine.id)?.active).toBe(true);
      expect(hob.runtime.store.routine(routine.id)?.pausedBy).toBeUndefined();
    } finally { hob.close(); }
  });

  it("HTTP 接口：关闭话题后立即运行或启用定时返回 400", async () => {
    const hob = makeHob();
    try {
      const group = hob.runtime.groups.create({ name: "研发群", purpose: "协作", ownerId: "hob", members: ["hob"] });
      const topic = hob.runtime.groups.createTopic(group.id, "接口话题", "user");
      const routine = hob.runtime.routines.create({
        assistantId: "hob",
        groupId: topic.id,
        name: "巡检",
        instruction: "检查",
        schedules: ["0 9 * * *"],
      });
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const headers = { cookie, "content-type": "application/json" };

      expect((await app.request(`/api/groups/${topic.id}/close`, { method: "POST", headers, body: JSON.stringify({ note: "先停" }) })).status).toBe(200);
      const runRes = await app.request(`/api/routines/${routine.id}/run`, { method: "POST", headers });
      expect(runRes.status).toBe(400);
      expect(await runRes.json()).toEqual({ error: "话题已关闭" });
      const patchRes = await app.request(`/api/routines/${routine.id}`, { method: "PATCH", headers, body: JSON.stringify({ active: true }) });
      expect(patchRes.status).toBe(400);
      expect(await patchRes.json()).toEqual({ error: "话题已关闭" });

      expect((await app.request(`/api/groups/${topic.id}/reopen`, { method: "POST", headers })).status).toBe(200);
      expect(hob.runtime.store.routine(routine.id)?.active).toBe(true);
    } finally { hob.close(); }
  });

  it("工具返回：create_routine 说明进话题，update_routine 和 delete_routine 写明定时在哪", async () => {
    const hob = makeHob();
    try {
      const group = hob.runtime.groups.create({ name: "研发群", purpose: "协作", ownerId: "hob", members: ["hob"] });
      const topic = hob.runtime.groups.createTopic(group.id, "发布检查", "user");
      const said = (result: { content: unknown[] }) => (result.content as { text?: string }[]).map((part) => part.text ?? "").join("");
      const toolIn = (gid: string, name: string) => buildRouterTools(hob.runtime, "hob", gid).find((item) => item.name === name)!;

      const createdTopic = await toolIn(topic.id, "create_routine").execute("c1", { name: "发布巡检", instruction: "查日志", schedules: ["0 9 * * *"] });
      expect(said(createdTopic)).toContain("到执行时间会在这个话题里执行");
      const rtTopic = hob.runtime.store.routines().find((r) => r.name === "发布巡检")!;

      const createdGeneral = await toolIn(group.id, "create_routine").execute("c2", { name: "每日站会", instruction: "汇总", schedules: ["0 10 * * *"] });
      expect(said(createdGeneral)).not.toContain("到执行时间会在这个话题里执行");
      const rtGeneral = hob.runtime.store.routines().find((r) => r.name === "每日站会")!;

      // 在话题里修改综合的定时、在综合里修改话题的定时，都写明它实际在哪
      const updatedGeneral = await toolIn(topic.id, "update_routine").execute("u1", { routineId: rtGeneral.id, name: "早会汇总" });
      expect(said(updatedGeneral)).toContain("已修改「早会汇总」（综合）");
      const updatedTopic = await toolIn(group.id, "update_routine").execute("u2", { routineId: rtTopic.id, name: "发版巡检" });
      expect(said(updatedTopic)).toContain("已修改「发版巡检」（话题「发布检查」）");

      // id 填错时「现在有哪些」列出各定时的位置
      const missing = await toolIn(topic.id, "update_routine").execute("u3", { routineId: "rt-nope", name: "x" });
      expect(said(missing)).toContain(`「早会汇总」（${rtGeneral.id} · 综合）`);
      expect(said(missing)).toContain(`「发版巡检」（${rtTopic.id} · 话题「发布检查」）`);

      // 删除时写明删了哪里的、还剩哪些在哪里
      const deleted = await toolIn(group.id, "delete_routine").execute("d1", { routineId: rtTopic.id });
      expect(said(deleted)).toContain("已删除「发版巡检」（话题「发布检查」）");
      expect(said(deleted)).toContain(`「早会汇总」（${rtGeneral.id} · 综合）`);
    } finally { hob.close(); }
  });

  it("关闭期间显式停用会清掉 pausedBy，重开话题不再恢复", () => {
    const hob = makeHob();
    try {
      const group = hob.runtime.groups.create({ name: "研发群", purpose: "协作", ownerId: "hob", members: ["hob"] });
      const topic = hob.runtime.groups.createTopic(group.id, "上线检查", "user");
      const routine = hob.runtime.routines.create({
        assistantId: "hob",
        groupId: topic.id,
        name: "巡检",
        instruction: "看指标",
        schedules: ["0 9 * * *"],
      });

      hob.runtime.groups.closeByUser(topic.id, "先关");
      expect(hob.runtime.store.routine(routine.id)).toMatchObject({ active: false, pausedBy: "topicClosed" });

      const updated = hob.runtime.routines.update(routine.id, { active: false });
      expect(updated.active).toBe(false);
      expect(updated.pausedBy).toBeUndefined();
      expect(hob.runtime.store.routine(routine.id)?.pausedBy).toBeUndefined();

      hob.runtime.groups.reopen(topic.id);
      expect(hob.runtime.store.routine(routine.id)?.active).toBe(false);
      expect(hob.runtime.store.routine(routine.id)?.pausedBy).toBeUndefined();
      expect(hob.runtime.routines.nextRuns(routine.id)).toEqual([]);
    } finally { hob.close(); }
  });

  it("一次性定时因关闭暂停、过点后重开按完成停止", () => {
    setNow("2026-11-08T00:30:00Z"); // 上海 08:30
    const hob = makeHob();
    try {
      const group = hob.runtime.groups.create({ name: "研发群", purpose: "协作", ownerId: "hob", members: ["hob"] });
      const topic = hob.runtime.groups.createTopic(group.id, "发版窗口", "user");
      const expired = hob.runtime.routines.create({
        assistantId: "hob",
        groupId: topic.id,
        name: "九点发版提醒",
        instruction: "提醒发版",
        schedules: ["2026-11-08T09:00"],
        once: true,
      });
      const upcoming = hob.runtime.routines.create({
        assistantId: "hob",
        groupId: topic.id,
        name: "十点复核提醒",
        instruction: "提醒复核",
        schedules: ["2026-11-08T10:00"],
        once: true,
      });

      hob.runtime.groups.closeByUser(topic.id, "暂停");
      expect(hob.runtime.store.routine(expired.id)).toMatchObject({ active: false, pausedBy: "topicClosed" });
      expect(hob.runtime.store.routine(upcoming.id)).toMatchObject({ active: false, pausedBy: "topicClosed" });

      // 时间跨过 09:00 但未到 10:00 后重开
      setNow("2026-11-08T01:30:00Z"); // 上海 09:30
      hob.runtime.groups.reopen(topic.id);

      const savedExpired = hob.runtime.store.routine(expired.id)!;
      expect(savedExpired).toMatchObject({ active: false, stopReason: "finished" });
      expect(savedExpired.pausedBy).toBeUndefined();
      expect(savedExpired.stoppedAt).toBeDefined();
      expect(hob.runtime.routines.nextRuns(expired.id)).toEqual([]);
      expect(hob.runtime.groups.items(topic.id).items.some((item) => item.kind === "note" && item.text === "定时任务「九点发版提醒」已完成最后一次运行，已停止")).toBe(true);

      const savedUpcoming = hob.runtime.store.routine(upcoming.id)!;
      expect(savedUpcoming.active).toBe(true);
      expect(savedUpcoming.pausedBy).toBeUndefined();
      expect(hob.runtime.routines.nextRuns(upcoming.id).filter(Boolean)).toHaveLength(1);
    } finally { hob.close(); }
  });
});
