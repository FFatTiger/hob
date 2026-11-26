import { describe, expect, it, vi } from "vitest";
import { placeFields, placeOf, samePlace, sessionKey } from "../src/place.ts";
import { sessionOrigin } from "../src/origin.ts";
import { nowBlock } from "../src/now.ts";
import { todosBusy } from "../src/todos.ts";
import { makeHob } from "./helpers.ts";

describe("place helpers", () => {
  it("placeOf extracts normalized Place from records", () => {
    expect(placeOf(undefined)).toEqual({});
    expect(placeOf(null)).toEqual({});
    expect(placeOf({})).toEqual({});
    expect(placeOf({ groupId: "g-1" })).toEqual({ groupId: "g-1" });
    expect(placeOf({ topicId: "tp-1" })).toEqual({ topicId: "tp-1" });
    expect(placeOf({ groupId: undefined, topicId: undefined })).toEqual({});
  });

  it("samePlace distinguishes main, group, and different topicIds", () => {
    expect(samePlace(undefined, undefined)).toBe(true);
    expect(samePlace(undefined, {})).toBe(true);
    expect(samePlace({}, { groupId: undefined, topicId: undefined })).toBe(true);
    expect(samePlace({ groupId: "g-1" }, { groupId: "g-1" })).toBe(true);
    expect(samePlace({ topicId: "tp-1" }, { topicId: "tp-1" })).toBe(true);

    expect(samePlace({ groupId: "g-1" }, { groupId: "g-2" })).toBe(false);
    expect(samePlace({ groupId: "g-1" }, {})).toBe(false);
    expect(samePlace({ topicId: "tp-1" }, {})).toBe(false);
    expect(samePlace({}, { topicId: "tp-1" })).toBe(false);
    expect(samePlace({ topicId: "tp-1" }, { topicId: "tp-2" })).toBe(false);
    expect(samePlace({ groupId: "g-1" }, { topicId: "tp-1" })).toBe(false);
  });

  it("sessionKey builds stable per-session keys", () => {
    expect(sessionKey("hob")).toBe("hob");
    expect(sessionKey("hob", {})).toBe("hob");
    expect(sessionKey("hob", { groupId: "g-1" })).toBe("hob@g-1");
    expect(sessionKey("hob", { topicId: "tp-1" })).toBe("hob@tp-1");
  });

  it("placeFields spreads only present fields", () => {
    expect(placeFields(undefined)).toEqual({});
    expect(placeFields({})).toEqual({});
    expect(placeFields({ groupId: undefined, topicId: undefined })).toEqual({});
    expect(placeFields({ groupId: "g-1" })).toEqual({ groupId: "g-1" });
    expect(placeFields({ topicId: "tp-1" })).toEqual({ topicId: "tp-1" });
    expect({ id: "x", ...placeFields({}) }).not.toHaveProperty("groupId");
    expect({ id: "x", ...placeFields({}) }).not.toHaveProperty("topicId");
  });
});

describe("Place integration across origin, nowBlock, todosBusy, and finishUnansweredQuestions", () => {
  it("sessionOrigin formats direct, group, and topic places", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const group = hob.runtime.groups.create({ name: "研发群", purpose: "开发", ownerId: "hob", members: ["hob"] });
      const topic = hob.runtime.groups.createTopic(group.id, "修复测试", "user");
      const other = hob.runtime.groups.create({ name: "运维群", purpose: "运维", ownerId: "hob", members: ["hob"] });

      expect(sessionOrigin(hob.runtime.store, undefined, undefined)).toBe("单聊");
      expect(sessionOrigin(hob.runtime.store, {}, { groupId: group.id })).toBe("单聊");
      expect(sessionOrigin(hob.runtime.store, { groupId: "g-missing" }, {})).toBe("单聊");
      expect(sessionOrigin(hob.runtime.store, { groupId: group.id }, { groupId: group.id })).toBe("综合");
      expect(sessionOrigin(hob.runtime.store, { groupId: topic.id }, { groupId: group.id })).toBe("话题「修复测试」");
      expect(sessionOrigin(hob.runtime.store, { groupId: topic.id }, undefined)).toBe("群「研发群」的话题「修复测试」");
      expect(sessionOrigin(hob.runtime.store, { groupId: other.id }, { groupId: group.id })).toBe("群「运维群」");
    } finally {
      hob.close();
    }
  });

  it("todosBusy and finishUnansweredQuestions do not mix different topicId places with main chat", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const store = hob.runtime.store;
      // Save a waiting job with a topicId (future assistant topic shape)
      store.saveJob({
        id: "t-tp",
        assistantId: "hob",
        title: "话题任务",
        instruction: "测试",
        status: "waiting",
        createdAt: new Date().toISOString(),
        stats: { reads: 0, commands: 0, edits: 0 },
        activity: [],
        ...({ topicId: "tp-1" } as object),
      } as never);
      store.saveApproval({
        id: "q-tp",
        assistantId: "hob",
        title: "话题里的提问",
        options: [{ key: "A", label: "继续" }, { key: "B", label: "取消" }],
        status: "pending",
        source: "job",
        jobId: "t-tp",
        createdAt: new Date().toISOString(),
        ...({ topicId: "tp-1" } as object),
      } as never);
      hob.runtime.jobs.questionDelivered("t-tp");

      // Main chat should NOT see topicId: "tp-1" as busy in main place
      expect(todosBusy(hob.runtime, "hob", {})).toBe(false);
      expect(todosBusy(hob.runtime, "hob", { topicId: "tp-2" })).toBe(false);
      expect(todosBusy(hob.runtime, "hob", { topicId: "tp-1" })).toBe(true);

      // Finishing unanswered questions in main chat or tp-2 must NOT expire tp-1's job
      await hob.runtime.jobs.finishUnansweredQuestions("hob", {});
      await hob.runtime.jobs.finishUnansweredQuestions("hob", { topicId: "tp-2" });
      expect(store.job("t-tp")?.status).toBe("waiting");
      expect(store.approval("q-tp")?.status).toBe("pending");

      // Finishing in tp-1 DOES expire it
      const finishSpy = vi.spyOn(hob.runtime.jobs, "finish").mockResolvedValue();
      await hob.runtime.jobs.finishUnansweredQuestions("hob", { topicId: "tp-1" });
      expect(store.approval("q-tp")?.status).toBe("expired");
      expect(finishSpy).toHaveBeenCalledWith("t-tp", "stuck", undefined, "提问没有得到答复：话题里的提问");
    } finally {
      hob.close();
    }
  });

  it("nowBlock separates mine vs elsewhere by Place", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const store = hob.runtime.store;
      const group = hob.runtime.groups.create({ name: "团队", purpose: "协作", ownerId: "hob", members: ["hob"] });
      store.saveJob({
        id: "t-main",
        assistantId: "hob",
        title: "主对话任务",
        instruction: "测试",
        status: "running",
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        stats: { reads: 0, commands: 0, edits: 0 },
        activity: [],
      });
      store.saveJob({
        id: "t-grp",
        assistantId: "hob",
        title: "群里任务",
        instruction: "测试",
        status: "running",
        groupId: group.id,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        stats: { reads: 0, commands: 0, edits: 0 },
        activity: [],
      });
      const mainNow = nowBlock(hob.runtime, "hob");
      expect(mainNow).toContain("进行中：t-main「主对话任务」");
      expect(mainNow).toContain("别处进行中：群「团队」里 t-grp「群里任务」");
      const groupNow = nowBlock(hob.runtime, "hob", { groupId: group.id });
      expect(groupNow).toContain("进行中：t-grp「群里任务」");
      expect(groupNow).not.toContain("t-main");
    } finally {
      hob.close();
    }
  });
});
