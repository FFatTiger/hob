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

describe("批准的提示词原文", () => {
  it("主助手、其他助手和 Worker 逐字相等，固定部分符合上限", () => {
    const primary = { id: "hob", name: "Hob", primary: true, duty: "主助手", instructions: "主说明" };
    const other = { id: "ops", name: "运维", primary: false, duty: "服务器", dutyLong: "维护机器", instructions: "副说明" };
    const store = {
      assistant: (id: string) => id === "hob" ? primary : other,
      assistants: () => [primary, other],
      rules: (id: string) => id === "hob" ? [{ mode: "ask", text: "重启" }, { mode: "allow", text: "查看" }] : [{ mode: "ask", text: "发布" }],
      routines: () => [{ assistantId: "hob", name: "日报", schedules: ["0 9 * * *"], active: true, instruction: "写日报" }],
      job: () => ({ assistantId: "hob", cwd: "/work" }),
    } as never;
    const settings = { timezone: "Asia/Shanghai", aboutYou: { name: "小林", language: "中文", notes: "简洁" }, memory: "lore" as const, skills: [{ name: "搜索", description: "不显示" }] };
    const common = ["用简洁、规范的书面中文回复，先给结论。", "", "## 你手里有什么", "你能直接看：文件和图片、任务的结果和产出、网页、记忆。", "跑命令、改文件、操作设备这些动手的事在后台任务手里：任务在自己的会话和目录里做，做完把完整结果发回给你。", "任务结束后还能接着做。一件事交给任务或其他助手后由它负责到底，跟进也交给它。", "任务能用的技能：搜索", "", "## 用户", "- 称呼：小林", "- 语言：中文", "- 其他：简洁"];
    const memory = ["", "## 记忆", "长期记忆在 Lore：过去的偏好、决定和约定先查 Lore；值得长期记住的新事实记进 Lore。读到的记忆和你刚核实的事实对不上（过时或有错），当场改对；整条已经不成立或没用了，就删掉。"];
    expect(buildSystemPrompt(store, "hob", settings)).toBe(["你是「Hob」，用户的主助手。", "你和用户在一对一的对话里合作，用户的每条消息都是对你说的。", ...common, "", "## 用户定的规则", "- 执行前确认：重启", "- 直接执行：查看", "", "## 补充说明", "主说明", ...memory, "", "## 定时", "- 日报 · 每天 09:00：写日报", "", "## 其他助手", "- 运维（ops）：服务器。维护机器"].join("\n"));
    expect(buildSystemPrompt(store, "ops", settings)).toBe(["你是「运维」，用户的助手，负责服务器。", "详细职责：维护机器", "你和用户在一对一的对话里合作。主助手 Hob 会把归你管的事转给你：转来的消息带着用户的原话，等同用户本人的要求，结果会自动回到 Hob。", ...common, "", "## 用户定的规则", "- 执行前确认：发布", "", "## 补充说明", "副说明", ...memory].join("\n"));
    expect(buildWorkerPrompt(store, "t", { ...settings, abilities: { exec: false, write: true, image: false } })).toBe(["你是「Hob」助手派出的后台任务，在自己的会话里把交给你的事做完。", "工作目录：/work。产出放在这里；读取不限目录。", "交给你的消息里有用户的原话、最近的对话、附件和「Hob」的备注。", "做完调用 report：result 写完整结果，包括结论、数据、链接和文件路径。它会交给「Hob」，由它告诉用户。", "之后用户可能还会找你补充、纠正或追问，这些都会发到这个会话里；接着做完，再调用 report。", "不能做：执行命令（bash）、生图（generate_image）。", "", "## 用户", "- 称呼：小林", "- 语言：中文", "- 其他：简洁", "", "## 这些事执行前用 ask_user 问用户", "- 重启", "", "## 补充说明", "主说明", ...memory].join("\n"));
    const emptyStore = { ...store as object, assistant: () => ({ ...primary, instructions: "" }), assistants: () => [primary], rules: () => [], routines: () => [] } as never;
    const empty = { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const };
    expect(buildSystemPrompt(emptyStore, "hob", empty).length).toBeLessThanOrEqual(800);
    expect(buildWorkerPrompt(emptyStore, "t", empty).length).toBeLessThanOrEqual(600);
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
      expect(promptOf(hob)).toContain("服务器（ops）：机器。维护服务器");
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
      const expected = "任务结束后还能接着做。一件事交给任务或其他助手后由它负责到底，跟进也交给它。";
      for (const id of ["hob", "other"]) {
        expect(buildSystemPrompt(hob.runtime.store, id, { timezone, aboutYou, memory: "local" })).toContain(expected);
      }
    } finally {
      hob.close();
    }
  });

  it("Router 提示词里没有现在时间", () => {
    const hob = makeHob();
    try {
      const prompt = promptOf(hob);
      expect(prompt).not.toContain("现在时间：");
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
      expect(prompt).not.toContain("现在时间：");
    } finally {
      hob.close();
    }
  });

  it("讲清楚卡片工具先说话再调、always 选项、头像对照表", () => {
    const hob = makeHob();
    try {
      const prompt = promptOf(hob);
      expect(prompt).not.toContain("先在同一条消息里写一句话");
      expect(prompt).not.toContain("以后同类操作直接执行，无需确认");
      expect(prompt).not.toContain("用 set_rule 记入规则");
      expect(prompt).not.toContain("remember");
      expect(prompt).not.toContain("page 写作/文档");
      expect(prompt).not.toContain("hob 那个火苗是主助手专用的");
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
      expect(prompt).toContain("任务在自己的会话和目录里做");
    } finally {
      hob.close();
    }
  });

  it("「关于你」：填了哪行出哪行，全空就整节不出", () => {
    const hob = makeHob();
    try {
      expect(promptOf(hob)).not.toContain("## 用户");

      hob.runtime.settings.patch(hob.runtime.settings.get().revision, {
        general: { aboutYou: { name: "小林", language: "中文", notes: "" } },
      });
      const prompt = promptOf(hob);
      expect(prompt).toContain("## 用户");
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
