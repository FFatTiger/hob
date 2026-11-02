import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSystemPrompt, buildWorkerPrompt } from "../src/prompt.ts";
import { nowText, checkTimezone, monthDayText, monthDayTimeText } from "../src/time.ts";
import { createFromDraft } from "../src/actions.ts";
import type { Draft } from "../../shared/types.ts";
import { makeHob, text } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("现在时间", () => {
  it("按 config.timezone 算，不带服务器系统时区", () => {
    expect(nowText("Asia/Shanghai", new Date("2026-11-01T01:10:00.000Z"))).toBe("2026-11-01 09:10 周日");
    expect(nowText("America/New_York", new Date("2026-11-01T01:10:00.000Z"))).toBe("2026-10-31 21:10 周六");
  });

  it("时区写错直接报错", () => {
    expect(() => checkTimezone("Asia/ShangHaii")).toThrow(/时区不合法/);
    expect(checkTimezone("Asia/Shanghai")).toBe("Asia/Shanghai");
  });

  it("月日按配置时区算：系统还是 10 月 31 日，上海已经 11 月 1 日", () => {
    const at = new Date("2026-10-31T16:30:00.000Z");
    expect(monthDayText("Asia/Shanghai", at)).toBe("11月1日");
    expect(monthDayText("America/New_York", at)).toBe("10月31日");
  });

  it("报告里的结束时间写成「11月1日 09:43」，按配置时区", () => {
    const at = new Date("2026-11-01T01:43:00.000Z");
    expect(monthDayTimeText("Asia/Shanghai", at)).toBe("11月1日 09:43");
    expect(monthDayTimeText("America/New_York", at)).toBe("10月31日 21:43");
  });

  it("分出助手的说明用 config 时区的日期", async () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      // 系统时区 2026-10-31 12:30，配置时区 Asia/Shanghai 已经是 11 月 1 日 00:30
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-31T16:30:00.000Z"));
      expect(new Date().getDate()).toBe(31);

      const hob = makeHob();
      try {
        const draft: Draft = {
          id: "d-1",
          assistantId: "hob",
          status: "pending",
          name: "写作",
          sprite: "page",
          duty: "周报和文章",
          dutyLong: "每周写周报。",
          routines: [],
          routinesText: "",
          askFirst: [],
          instructions: [],
          carry: { conversations: 2 },
          createdAt: new Date().toISOString(),
        };
        hob.runtime.store.saveDraft(draft);
        const result = await createFromDraft(hob.runtime, draft.id);
        expect(result.status).toBe(200);
        const id = (result.body as { assistant: { id: string } }).assistant.id;
        expect(hob.runtime.store.assistant(id)?.dutyLong).toBe("每周写周报。");
        const note = hob.runtime.router.items(id).items[0];
        expect(note.kind === "note" ? note.text : "").toBe("11月1日 由 Hob 创建 · 迁移 2 段对话");
      } finally {
        hob.close();
      }
    } finally {
      vi.useRealTimers();
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});

describe("系统提示词", () => {
  const promptOf = (hob: ReturnType<typeof makeHob>) => {
    const { timezone, aboutYou } = hob.runtime.settings.settings.general;
    return buildSystemPrompt(hob.runtime.store, "hob", { timezone, aboutYou, memory: "local" });
  };

  it("旧助手职责从创建草稿回填且不覆盖编辑，提示词列出职责和确认规则", () => {
    const hob = makeHob();
    try {
      const store = hob.runtime.store;
      const primary = store.assistant("hob")!;
      store.saveAssistant({ ...primary, id: "ops", name: "服务器", duty: "机器", primary: false });
      store.saveDraft({ id: "d", assistantId: "hob", status: "created", createdAssistantId: "ops", name: "服务器", sprite: "server", duty: "机器", dutyLong: "维护服务器", routines: [], routinesText: "", askFirst: [], instructions: [], carry: { conversations: 0 }, createdAt: primary.createdAt });
      store.migrateAssistantDuties();
      expect(store.assistant("ops")?.dutyLong).toBe("维护服务器");
      store.saveRules("ops", [{ id: "r", text: "重启服务", mode: "ask", changedAt: primary.createdAt }, { id: "r2", text: "查看日志", mode: "allow", changedAt: primary.createdAt }]);
      expect(promptOf(hob)).toContain("服务器（ops）：机器。详细职责：维护服务器。执行前要确认：重启服务");
      expect(promptOf(hob)).not.toContain("执行前要确认：查看日志");
      const { timezone, aboutYou } = hob.runtime.settings.settings.general;
      expect(buildSystemPrompt(store, "ops", { timezone, aboutYou, memory: "off" })).toContain("详细职责：维护服务器");
      store.saveAssistant({ ...store.assistant("ops")!, dutyLong: "" });
      store.migrateAssistantDuties();
      expect(store.assistant("ops")?.dutyLong).toBe("");
      expect(promptOf(hob)).not.toContain("详细职责：维护服务器");
      expect(buildSystemPrompt(store, "ops", { timezone, aboutYou, memory: "off" })).not.toContain("详细职责：");
    } finally { hob.close(); }
  });

  it("所有助手都要求在同一轮调用工具执行承诺的操作", () => {
    const hob = makeHob();
    try {
      const primary = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...primary, id: "other", primary: false, name: "其他助手" });
      const { timezone, aboutYou } = hob.runtime.settings.settings.general;
      const expected = "说要做的事，就在同一条消息里调用对应工具去做；不要只描述计划然后停下等用户催。只有规则要求确认或操作不可逆时才停下来问。";
      for (const id of ["hob", "other"]) {
        expect(buildSystemPrompt(hob.runtime.store, id, { timezone, aboutYou, memory: "local" })).toContain(expected);
      }
    } finally {
      hob.close();
    }
  });

  it("Router 提示词里有现在时间", () => {
    const hob = makeHob();
    try {
      const prompt = promptOf(hob);
      expect(prompt).toMatch(/^现在时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2} 周[日一二三四五六]$/m);
    } finally {
      hob.close();
    }
  });

  it("Worker 提示词里有现在时间", async () => {
    const hob = makeHob();
    try {
      const job = await hob.runtime.jobs.start("hob", { title: "查磁盘", instruction: "看看还剩多少" });
      await hob.runtime.jobs.waitIdle(10_000);
      const { timezone, aboutYou } = hob.runtime.settings.settings.general;
      const prompt = buildWorkerPrompt(hob.runtime.store, job.id, { timezone, aboutYou, memory: "local" });
      expect(prompt).toMatch(/^现在时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2} 周[日一二三四五六]$/m);
    } finally {
      hob.close();
    }
  });

  it("讲清楚卡片工具先说话再调、always 选项、头像对照表", () => {
    const hob = makeHob();
    try {
      const prompt = promptOf(hob);
      expect(prompt).toContain("先在同一条消息里写一句话");
      expect(prompt).toContain("以后同类操作直接执行，无需确认");
      expect(prompt).toContain("用 set_rule 记入规则");
      expect(prompt).not.toContain("remember");
      expect(prompt).toContain("page 写作/文档");
      expect(prompt).toContain("hob 那个火苗是主助手专用的");
    } finally {
      hob.close();
    }
  });

  it("提示词里没有外部工作台和具体产品名；写代码的活靠 cwd 指定目录", () => {
    const hob = makeHob();
    try {
      const prompt = promptOf(hob);
      expect(prompt).not.toContain("外部工作台");
      expect(prompt).not.toContain("via");
      expect(prompt).toContain("cwd");
    } finally {
      hob.close();
    }
  });

  it("「关于你」：填了哪行出哪行，全空就整节不出", () => {
    const hob = makeHob();
    try {
      expect(promptOf(hob)).not.toContain("## 关于用户");

      hob.runtime.settings.patch(hob.runtime.settings.get().revision, {
        general: { aboutYou: { name: "小林", language: "中文", notes: "" } },
      });
      const prompt = promptOf(hob);
      expect(prompt).toContain("## 关于用户");
      expect(prompt).toContain("- 称呼：小林");
      expect(prompt).toContain("- 语言：中文");
      expect(prompt).not.toContain("- 其他：");

      // Worker 的提示词也要有
      hob.faux.setResponses([text("收到")]);
      const job = {
        id: "t-about",
        assistantId: "hob",
        title: "看下",
        instruction: "看下",
        status: "queued" as const,
        createdAt: new Date().toISOString(),
        stats: { reads: 0, commands: 0, edits: 0 },
        activity: [],
      };
      hob.runtime.store.saveJob(job);
      const { timezone, aboutYou } = hob.runtime.settings.settings.general;
      expect(buildWorkerPrompt(hob.runtime.store, job.id, { timezone, aboutYou, memory: "off" })).toContain("- 称呼：小林");
    } finally {
      hob.close();
    }
  });
});
