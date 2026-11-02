import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Assistant, Job } from "../../shared/types.ts";
import { mergeAssistant } from "../src/actions.ts";
import { makeHob, text, type TestHob } from "./helpers.ts";

function addAssistant(hob: TestHob, id: string, extra: Partial<Assistant> = {}): Assistant {
  const assistant: Assistant = {
    id,
    name: "写作",
    duty: "周报和文章",
    sprite: "page",
    primary: false,
    pinned: false,
    hidden: false,
    notify: true,
    instructions: "",
    createdAt: new Date().toISOString(),
    ...extra,
  };
  hob.runtime.store.saveAssistant(assistant);
  return assistant;
}

function addJob(hob: TestHob, id: string, assistantId: string, status: Job["status"]): Job {
  const job: Job = {
    id,
    assistantId,
    title: "写周报",
    instruction: "写这周的周报",
    status,
    createdAt: new Date().toISOString(),
    stats: { reads: 0, commands: 0, edits: 0 },
    activity: [],
  };
  hob.runtime.store.saveJob(job);
  return job;
}

describe("并回 Hob", () => {
  it("定时、规则、补充说明转给主助手，目录进归档，主助手对话里记一行", async () => {
    const hob = makeHob();
    try {
      const assistant = addAssistant(hob, "writer", { instructions: "先列要点，再展开" });
      const now = new Date().toISOString();
      hob.runtime.store.saveRules("writer", [
        { id: "r-w1", text: "发布公众号", mode: "ask", changedAt: now },
        { id: "r-w2", text: "查资料", mode: "allow", changedAt: now },
      ]);
      // 主助手已经有一条同文规则：保留它原来的模式，不重复追加
      hob.runtime.store.saveRules("hob", [{ id: "r-h1", text: "查资料", mode: "ask", changedAt: now }]);
      const routine = hob.runtime.routines.create({
        assistantId: "writer",
        name: "周报",
        instruction: "每周五写一份周报",
        schedules: ["0 17 * * 5"],
      });
      // 这个助手已经有一段对话：会话文件跟着进归档
      hob.faux.setResponses([text("好的，每周五写周报。")]);
      await hob.runtime.router.send("writer", { text: "以后每周五写周报" });
      await hob.runtime.router.waitIdle("writer");
      expect(existsSync(hob.runtime.store.routerFile("writer"))).toBe(true);
      const oldJob = addJob(hob, "t-old", "writer", "done");

      const result = await mergeAssistant(hob.runtime, "writer");
      expect(result.status).toBe(200);

      // 助手没了，定时转到主助手下面，调度也跟着换了
      expect(hob.runtime.store.assistant("writer")).toBeUndefined();
      expect(hob.runtime.store.routine(routine.id)!.assistantId).toBe("hob");
      expect(hob.runtime.routines.nextRuns(routine.id)).toHaveLength(1);
      expect(hob.runtime.router.profile("hob").routines.map((item) => item.id)).toEqual([routine.id]);

      // 规则：文字重复的只留主助手原来那条
      const rules = hob.runtime.store.rules("hob");
      expect(rules.map((rule) => rule.text).sort()).toEqual(["发布公众号", "查资料"]);
      expect(rules.find((rule) => rule.text === "查资料")!.mode).toBe("ask");
      expect(rules.find((rule) => rule.text === "发布公众号")!.mode).toBe("ask");

      // 补充说明：带一行来源接在主助手那段后面
      expect(hob.runtime.store.assistant("hob")!.instructions).toBe("来自「写作」：\n先列要点，再展开");

      // 归档：整个目录移进 archive/assistants/<id>-<时间>/，档案和对话都还在
      const root = join(hob.home, "archive", "assistants");
      const dirs = readdirSync(root);
      expect(dirs).toHaveLength(1);
      expect(dirs[0]!.startsWith("writer-")).toBe(true);
      const archived = join(root, dirs[0]!);
      expect(JSON.parse(readFileSync(join(archived, "profile.json"), "utf8")).name).toBe("写作");
      expect(readFileSync(join(archived, "router.jsonl"), "utf8")).toContain("以后每周五写周报");
      expect(existsSync(join(hob.home, "assistants", "writer"))).toBe(false);

      // 历史任务留在 jobs/，详情里照样有助手名
      expect(hob.runtime.store.job("t-old")!.assistantName).toBe(assistant.name);

      // 主助手对话里那行提示
      const notes = hob.runtime.router.items("hob").items.filter((item) => item.kind === "note");
      expect(notes.at(-1)).toMatchObject({
        kind: "note",
        icon: "split",
        text: "已并回「写作」：转来 1 个定时任务、1 条规则",
      });
    } finally {
      hob.close();
    }
  });

  it("主助手、不存在的助手都拒绝，并给出原因", async () => {
    const hob = makeHob();
    try {
      const primary = await mergeAssistant(hob.runtime, "hob");
      expect(primary.status).toBe(400);
      expect(primary.body).toMatchObject({ error: "主助手不能并回自己" });

      const missing = await mergeAssistant(hob.runtime, "nobody");
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({ error: "助手不存在" });
    } finally {
      hob.close();
    }
  });

  it("有进行中 / 排队 / 等待确认的任务时拒绝并回", async () => {
    const hob = makeHob();
    try {
      addAssistant(hob, "writer");
      for (const status of ["running", "queued", "waiting"] as const) {
        const job = addJob(hob, `t-${status}`, "writer", status);
        const result = await mergeAssistant(hob.runtime, "writer");
        expect(result.status).toBe(409);
        expect(result.body).toMatchObject({ error: "请等任务结束后再并回" });
        // 拒绝了就什么都没动
        expect(hob.runtime.store.assistant("writer")).toBeDefined();
        hob.runtime.store.saveJob({ ...job, status: "done" });
      }
      expect((await mergeAssistant(hob.runtime, "writer")).status).toBe(200);
    } finally {
      hob.close();
    }
  });

  it("没配好模型、写不了主助手对话时不动数据", async () => {
    const hob = makeHob();
    try {
      addAssistant(hob, "writer");
      hob.runtime.store.saveRules("writer", [
        { id: "r-w1", text: "发布公众号", mode: "ask", changedAt: new Date().toISOString() },
      ]);
      // 把对话模型清空：Hob 的对话开不了会话（和线上没配服务商时一样）
      hob.runtime.settings.patch(hob.runtime.settings.get().revision, {
        models: { roster: [], conversation: { ref: "", thinking: "off" }, work: { ref: "", thinking: "off" } },
      });

      const result = await mergeAssistant(hob.runtime, "writer");
      expect(result.status).toBe(409);
      expect(result.body).toMatchObject({ error: expect.stringContaining("无法写入 Hob 的对话") });
      expect(hob.runtime.store.assistant("writer")).toBeDefined();
      expect(hob.runtime.store.rules("hob")).toHaveLength(0);
    } finally {
      hob.close();
    }
  });
});
