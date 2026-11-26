import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/http.ts";
import { makeHob } from "./helpers.ts";

describe("群话题精确筛选（exact=1）", () => {
  it("GET /api/jobs 与 GET /api/knowledge 支持 exact=1 只返回当前会话的任务和文件", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const group = hob.runtime.groups.create({ name: "研发群", purpose: "协作", ownerId: "hob", members: ["hob"] });
      const topicA = hob.runtime.groups.createTopic(group.id, "话题甲", "user");
      const topicB = hob.runtime.groups.createTopic(group.id, "话题乙", "user");

      const saveJob = (id: string, groupId: string, title: string) => {
        hob.runtime.store.saveJob({
          id,
          assistantId: "hob",
          groupId,
          title,
          instruction: title,
          status: "done",
          createdAt: "2026-01-01T00:00:00Z",
          endedAt: "2026-01-01T00:01:00Z",
          stats: { reads: 0, commands: 0, edits: 0 },
          activity: [],
        });
      };
      saveJob("j-group", group.id, "综合任务");
      saveJob("j-a", topicA.id, "话题甲任务");
      saveJob("j-b", topicB.id, "话题乙任务");

      const fileG = join(hob.home, "group-out.md");
      const fileA = join(hob.home, "a-out.md");
      const fileB = join(hob.home, "b-out.md");
      writeFileSync(fileG, "综合产物");
      writeFileSync(fileA, "话题甲产物");
      writeFileSync(fileB, "话题乙产物");

      await hob.runtime.knowledge.collect({ origin: "output", path: fileG, name: "group-out.md", assistantId: "hob", jobId: "j-group" });
      await hob.runtime.knowledge.collect({ origin: "output", path: fileA, name: "a-out.md", assistantId: "hob", jobId: "j-a" });
      await hob.runtime.knowledge.collect({ origin: "output", path: fileB, name: "b-out.md", assistantId: "hob", jobId: "j-b" });
      await hob.runtime.knowledge.whenIdle();

      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "test" }),
      });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const getJson = async (url: string) => (await app.request(url, { headers: { cookie } })).json();

      // 不带 exact：全群汇总
      const allGroupJobs = await getJson(`/api/jobs?groupId=${group.id}`);
      expect(allGroupJobs.jobs.map((j: { id: string }) => j.id).sort()).toEqual(["j-a", "j-b", "j-group"]);

      const allFromTopicJobs = await getJson(`/api/jobs?groupId=${topicA.id}`);
      expect(allFromTopicJobs.jobs.map((j: { id: string }) => j.id).sort()).toEqual(["j-a", "j-b", "j-group"]);

      // exact=1：只返回对应会话
      const exactTopicAJobs = await getJson(`/api/jobs?groupId=${topicA.id}&exact=1`);
      expect(exactTopicAJobs.jobs.map((j: { id: string }) => j.id)).toEqual(["j-a"]);

      const exactGroupJobs = await getJson(`/api/jobs?groupId=${group.id}&exact=1`);
      expect(exactGroupJobs.jobs.map((j: { id: string }) => j.id)).toEqual(["j-group"]);

      // 知识库文件同理
      const allFiles = await getJson(`/api/knowledge?origin=output&groupId=${group.id}`);
      expect(allFiles.entries.map((e: { name: string }) => e.name).sort()).toEqual(["a-out.md", "b-out.md", "group-out.md"]);

      const exactTopicAFiles = await getJson(`/api/knowledge?origin=output&groupId=${topicA.id}&exact=1`);
      expect(exactTopicAFiles.entries.map((e: { name: string }) => e.name)).toEqual(["a-out.md"]);

      // 多话题助手：按 topicId 精确筛选单话题的任务与产出文件
      hob.runtime.store.saveAssistant({
        id: "planner",
        name: "日程统筹",
        duty: "日程与事务",
        sprite: "page",
        primary: false,
        pinned: false,
        hidden: false,
        notify: true,
        topics: { enabledAt: "2026-01-01T00:00:00Z" },
        createdAt: "2026-01-01T00:00:00Z",
      });
      const saveAssistantJob = (id: string, title: string, topicId?: string) => {
        hob.runtime.store.saveJob({
          id,
          assistantId: "planner",
          ...(topicId ? { topicId } : {}),
          title,
          instruction: title,
          status: "done",
          createdAt: "2026-01-01T00:00:00Z",
          endedAt: "2026-01-01T00:01:00Z",
          stats: { reads: 0, commands: 0, edits: 0 },
          activity: [],
        });
      };
      saveAssistantJob("j-p-main", "主对话任务");
      saveAssistantJob("j-p-t1", "话题一任务", "tp-1");
      saveAssistantJob("j-p-t2", "话题二任务", "tp-2");

      const fileMain = join(hob.home, "p-main.md");
      const fileT1 = join(hob.home, "p-t1.md");
      const fileT2 = join(hob.home, "p-t2.md");
      writeFileSync(fileMain, "主对话产物");
      writeFileSync(fileT1, "话题一产物");
      writeFileSync(fileT2, "话题二产物");
      await hob.runtime.knowledge.collect({ origin: "output", path: fileMain, name: "p-main.md", assistantId: "planner", jobId: "j-p-main" });
      await hob.runtime.knowledge.collect({ origin: "output", path: fileT1, name: "p-t1.md", assistantId: "planner", jobId: "j-p-t1", topicId: "tp-1" });
      await hob.runtime.knowledge.collect({ origin: "output", path: fileT2, name: "p-t2.md", assistantId: "planner", jobId: "j-p-t2", topicId: "tp-2" });
      await hob.runtime.knowledge.whenIdle();

      const allPlannerJobs = await getJson("/api/jobs?assistantId=planner&groupId=none");
      expect(allPlannerJobs.jobs.map((j: { id: string }) => j.id).sort()).toEqual(["j-p-main", "j-p-t1", "j-p-t2"]);
      const t1Jobs = await getJson("/api/jobs?assistantId=planner&groupId=none&topicId=tp-1");
      expect(t1Jobs.jobs.map((j: { id: string }) => j.id)).toEqual(["j-p-t1"]);

      const allPlannerFiles = await getJson("/api/knowledge?origin=output&assistantId=planner&groupId=none");
      expect(allPlannerFiles.entries.map((e: { name: string }) => e.name).sort()).toEqual(["p-main.md", "p-t1.md", "p-t2.md"]);
      const t1Files = await getJson("/api/knowledge?origin=output&assistantId=planner&groupId=none&topicId=tp-1");
      expect(t1Files.entries.map((e: { name: string }) => e.name)).toEqual(["p-t1.md"]);
    } finally {
      await hob.runtime.knowledge.whenIdle();
      hob.close();
    }
  });
});
