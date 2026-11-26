import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Approval, Assistant, Delegation, HobEvent, Item, Job } from "../../shared/types.ts";
import { answerApproval } from "../src/actions.ts";
import { buildRouterTools, HANDOFF_NOTE_DESCRIPTION } from "../src/router-tools.ts";
import { createRuntime } from "../src/runtime.ts";
import { CWD_IMMUTABLE, topicCwdLockedByAssistant } from "../src/workspace.ts";
import { call, makeHob, text, waitFor, type TestHob } from "./helpers.ts";

const extraDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "hob-topic-tools-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  extraDirs.push(dir);
  return dir;
}

function addAssistant(hob: TestHob, id = "writer", extra: Partial<Assistant> = {}): Assistant {
  const base = hob.runtime.store.assistant("hob")!;
  const assistant: Assistant = {
    ...base,
    id,
    name: extra.name ?? "写作助手",
    duty: extra.duty ?? "周报与文案",
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

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((part) => part.text ?? "").join("");
}

function toolParams(tool: NonNullable<ReturnType<typeof findTool>>): Record<string, { description?: string }> {
  return ((tool.parameters as unknown as { properties?: Record<string, { description?: string }> }).properties) ?? {};
}

describe("助手多话题：工具名单门控与 schema", () => {
  it("单会话助手和主助手无话题工具；多话题主对话有 open/close/rename，话题内无 open_topic", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const workDir = tempDir("hob-bound-");
      addAssistant(hob, "single", { name: "单聊助手" });
      addAssistant(hob, "multi", { name: "多话题自由", topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      addAssistant(hob, "bound", {
        name: "多话题绑目录",
        cwd: workDir,
        topics: { enabledAt: "2026-11-26T00:00:00.000Z" },
      });
      const topic = hob.runtime.store.saveAssistantTopic.bind(hob.runtime.store);
      topic({
        id: "tp-gate01",
        assistantId: "multi",
        name: "既有话题",
        createdAt: "2026-11-26T01:00:00.000Z",
        createdBy: "user",
      });

      const hobNames = buildRouterTools(hob.runtime, "hob").map((t) => t.name);
      const singleNames = buildRouterTools(hob.runtime, "single").map((t) => t.name);
      const multiMainNames = buildRouterTools(hob.runtime, "multi").map((t) => t.name);
      const multiTopicNames = buildRouterTools(hob.runtime, "multi", { topicId: "tp-gate01" }).map((t) => t.name);

      for (const name of ["open_topic", "close_topic", "rename_topic"]) {
        expect(hobNames).not.toContain(name);
        expect(singleNames).not.toContain(name);
        expect(multiMainNames).toContain(name);
      }
      expect(multiTopicNames).toContain("close_topic");
      expect(multiTopicNames).toContain("rename_topic");
      expect(multiTopicNames).not.toContain("open_topic");

      // 助手未绑 cwd 时 open_topic 暴露 cwd；已绑 cwd 时隐藏 cwd
      const openFree = findTool(hob, "multi", "open_topic")!;
      const openBound = findTool(hob, "bound", "open_topic")!;
      expect(openFree.description).toBe(
        "创建一个话题，把你的交接说明放进去，接下来在话题里处理。topic 填已有话题的 id，就转到那个话题（已关闭的会重新打开）。话题是一段独立的对话，主对话里说过什么话题里看不到，要用到的都写进 note。",
      );
      expect(toolParams(openFree).title.description).toBe("新话题的名字，写这件事，如「下月搬家」。转到已有话题时不填。");
      expect(toolParams(openFree).topic.description).toBe("已有话题的 id。创建新话题时不填。");
      expect(toolParams(openFree).note.description).toBe(HANDOFF_NOTE_DESCRIPTION);
      expect(toolParams(openFree).files).toMatchObject({ items: { description: "要交给话题的文件路径" } });
      expect(toolParams(openFree).cwd.description).toBe("仅创建新话题时可选，话题的工作目录（绝对路径，创建后不可修改）。");
      expect("cwd" in toolParams(openBound)).toBe(false);

      const closeTool = findTool(hob, "multi", "close_topic")!;
      expect(closeTool.description).toBe("关闭话题：这件事办完了，或者用户不做了。");
      expect(toolParams(closeTool).topic.description).toBe("话题 id。在话题里关这个话题时不填。");
      expect(toolParams(closeTool).note.description).toBe("这件事的结论，或者为什么不做了。会显示在话题上，主对话里的你也会收到。");

      const renameTool = findTool(hob, "multi", "rename_topic")!;
      expect(renameTool.description).toBe("修改话题名。");
      expect(toolParams(renameTool).topic.description).toBe("话题 id。在话题里改这个话题时不填。");
      expect(toolParams(renameTool).title.description).toBe("新名字，最多 40 字。");

      // 所有助手的 show_assistant 都带有 topic 参数
      for (const aid of ["hob", "single", "multi"]) {
        const showTool = findTool(hob, aid, "show_assistant")!;
        expect("topic" in toolParams(showTool)).toBe(true);
      }
    } finally {
      hob.close();
    }
  });
});

describe("open_topic：创建话题、转到已有话题与参数校验", () => {
  it("创建新话题：写卡片、forwardedFrom、附件事件、工作目录与禁自动起名", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const topicCwd = tempDir("hob-topic-cwd-");
      addAssistant(hob, "multi", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const attachPath = join(hob.home, "assistants", "multi", "work", "清单.txt");
      mkdirSync(join(hob.home, "assistants", "multi", "work"), { recursive: true });
      writeFileSync(attachPath, "打包箱子");

      const events: HobEvent[] = [];
      const off = hob.runtime.bus.subscribe((ev) => events.push(ev));
      const eventSpy = vi.spyOn(hob.runtime.router, "event").mockResolvedValue(true);
      const openTool = findTool(hob, "multi", "open_topic")!;
      // verify open_topic rollback when addTopicHandoff fails (no ghost assistant_topic SSE)
      vi.spyOn(hob.runtime.router, "addTopicHandoff").mockRejectedValueOnce(new Error("写入交接条目失败"));
      const rolledBack = await openTool.execute("rb1", { title: "应回滚话题", note: "说明" });
      expect(rolledBack.isError).toBe(true);
      expect(hob.runtime.assistantTopics.list("multi")).toHaveLength(0);
      expect(events.some((ev) => ev.type === "assistant_topic")).toBe(false);

      // verify open_topic rollback when addItem fails (no ghost assistant_topic SSE, disk & session cleaned)
      vi.spyOn(hob.runtime.router, "addItem").mockRejectedValueOnce(new Error("主对话落卡失败"));
      const rolledBackItem = await openTool.execute("rb2", { title: "落卡失败回滚", note: "说明" });
      expect(rolledBackItem.isError).toBe(true);
      expect(hob.runtime.assistantTopics.list("multi")).toHaveLength(0);
      expect(events.some((ev) => ev.type === "assistant_topic")).toBe(false);

      const res = (await openTool.execute("c1", {
        title: "下月搬家",
        note: "整理下个月搬家的步骤和箱子数量。",
        files: [attachPath, "   ", ""],
        cwd: topicCwd,
      })) as { terminate?: boolean; content: { type: string; text: string }[]; isError?: boolean };
      off();

      expect(res.isError).not.toBe(true);
      expect(res.terminate).toBe(true);
      const created = hob.runtime.assistantTopics.list("multi")[0]!;
      expect(created.name).toBe("下月搬家");
      expect(created.nameAuto).toBeUndefined();
      expect(created.createdBy).toBe("assistant");
      expect(created.cwd).toBe(topicCwd);
      expect(textOf(res)).toBe(`话题「下月搬家」（${created.id}）已创建，交接说明已转过去，接下来在话题里处理。`);
      const publishedTopic = events.find((ev) => ev.type === "assistant_topic" && ev.topic.id === created.id);
      expect(publishedTopic && publishedTopic.type === "assistant_topic" ? publishedTopic.topic.last?.text : undefined).toContain(
        "整理下个月搬家的步骤和箱子数量。",
      );

      // 主对话落话题卡
      const mainItems = hob.runtime.router.items("multi").items;
      expect(mainItems).toContainEqual(expect.objectContaining({ kind: "topic", topicId: created.id }));

      // 目标话题落 forwardedFrom 条目并收到开轮事件
      const topicItems = hob.runtime.router.items("multi", {}, { topicId: created.id }).items;
      expect(topicItems).toContainEqual(
        expect.objectContaining({
          kind: "user",
          text: "整理下个月搬家的步骤和箱子数量。",
          files: [attachPath],
          forwardedFrom: { assistantId: "multi" },
        }),
      );
      expect(eventSpy).toHaveBeenCalledWith(
        "multi",
        `这个话题是你从主对话创建的。交接说明：整理下个月搬家的步骤和箱子数量。（附件：${attachPath}）`,
        expect.objectContaining({ workDone: true }),
        { topicId: created.id },
      );

      // 话题内 start_job 默认落在该话题绑定的 cwd
      hob.faux.setResponses([call("report", { outcome: "done", result: "已整理" }), text("完成")]);
      const startTool = findTool(hob, "multi", "start_job", { topicId: created.id })!;
      const jobRes = await startTool.execute("j1", { title: "整理物品", note: "列出打包清单" });
      expect(jobRes.isError).not.toBe(true);
      const job = hob.runtime.store.jobs().find((item) => item.title === "整理物品")!;
      expect(job.topicId).toBe(created.id);
      expect(job.cwd).toBe(topicCwd);
      await hob.runtime.jobs.waitIdle();
    } finally {
      hob.close();
    }
  });

  it("转到已有话题（含已关闭话题自动重开）：主对话落转交提示，话题收到事件", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "multi", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const { topic: existing } = await hob.runtime.assistantTopics.create("multi", { title: "装修预算" });
      hob.runtime.assistantTopics.close("multi", existing.id, "初版已定");
      expect(hob.runtime.store.assistantTopic("multi", existing.id)?.closedAt).toBeDefined();

      hob.faux.setResponses([text("已收到补充预算，继续处理。")]);
      const openTool = findTool(hob, "multi", "open_topic")!;
      const res = (await openTool.execute("c2", {
        topic: existing.id,
        note: "用户要求追加厨房电器预算。",
      })) as { terminate?: boolean; content: { type: string; text: string }[]; isError?: boolean };

      expect(res.isError).not.toBe(true);
      expect(res.terminate).toBe(true);
      expect(textOf(res)).toBe(`已转到话题「装修预算」（${existing.id}），接下来在话题里处理。`);

      const reopened = hob.runtime.store.assistantTopic("multi", existing.id)!;
      expect(reopened.closedAt).toBeUndefined();
      expect(reopened.closeNote).toBeUndefined();

      const mainNotes = hob.runtime.router.items("multi").items.filter((item) => item.kind === "note");
      expect(mainNotes).toContainEqual(expect.objectContaining({ text: "转到了话题「装修预算」" }));

      await hob.runtime.router.waitIdle("multi", 10_000, { topicId: existing.id });
      const topicItems = hob.runtime.router.items("multi", {}, { topicId: existing.id }).items;
      expect(topicItems).toContainEqual(
        expect.objectContaining({
          kind: "user",
          text: "用户要求追加厨房电器预算。",
          forwardedFrom: { assistantId: "multi" },
        }),
      );
      expect(topicItems).toContainEqual(expect.objectContaining({ kind: "assistant", text: "已收到补充预算，继续处理。" }));

      // 验证送进会话文件的开轮事件正文
      const topicEntries = hob.runtime.router.sessionEntries("multi", { topicId: existing.id });
      const eventEntry = topicEntries.find((e) => e.type === "custom_message" && e.customType === "hob.event") as
        | { content?: string }
        | undefined;
      expect(eventEntry?.content).toContain("[hob-event] 你从主对话把一件事转到了这个话题。交接说明：用户要求追加厨房电器预算。");
    } finally {
      hob.close();
    }
  });

  it("open_topic 参数校验：title/topic 二选一、40 字上限、空 note、无效 topic 列进行中话题、cwd 限制", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const boundDir = tempDir("hob-bound-");
      const otherDir = tempDir("hob-other-");
      addAssistant(hob, "multi", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      addAssistant(hob, "other", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      addAssistant(hob, "bound", { cwd: boundDir, topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });

      const { topic: activeTopic } = await hob.runtime.assistantTopics.create("multi", { title: "进行中甲" });
      const { topic: closedTopic } = await hob.runtime.assistantTopics.create("multi", { title: "已关闭乙" });
      hob.runtime.assistantTopics.close("multi", closedTopic.id, "完了");
      const { topic: foreignTopic } = await hob.runtime.assistantTopics.create("other", { title: "别人话题" });

      const openTool = findTool(hob, "multi", "open_topic")!;

      const bothEmpty = await openTool.execute("e1", { note: "说明" });
      expect(bothEmpty.isError).toBe(true);
      expect(textOf(bothEmpty)).toContain("title 和 topic 要填一个");

      const bothSet = await openTool.execute("e2", { title: "新", topic: activeTopic.id, note: "说明" });
      expect(bothSet.isError).toBe(true);
      expect(textOf(bothSet)).toContain("title 和 topic 只能填一个");

      const tooLongTitle = "超".repeat(41);
      const overLimit = await openTool.execute("e3", { title: tooLongTitle, note: "说明" });
      expect(overLimit.isError).toBe(true);
      expect(textOf(overLimit)).toContain("最多 40 字");
      expect(textOf(overLimit)).toContain("41");

      const emptyNote = await openTool.execute("e4", { title: "有效名字", note: "   " });
      expect(emptyNote.isError).toBe(true);
      expect(textOf(emptyNote)).toContain("note 不能为空");

      const badTopic = await openTool.execute("e5", { topic: foreignTopic.id, note: "说明" });
      expect(badTopic.isError).toBe(true);
      expect(textOf(badTopic)).toContain(`进行中的话题：进行中甲（${activeTopic.id}）`);
      expect(textOf(badTopic)).not.toContain(closedTopic.id);

      const cwdWithExisting = await openTool.execute("e6", { topic: activeTopic.id, note: "说明", cwd: otherDir });
      expect(cwdWithExisting.isError).toBe(true);
      expect(textOf(cwdWithExisting)).toContain(CWD_IMMUTABLE);

      const missingCwd = await openTool.execute("e7", { title: "目录不存在", note: "说明", cwd: join(otherDir, "missing") });
      expect(missingCwd.isError).toBe(true);
      expect(textOf(missingCwd)).toContain("工作目录不存在");

      const boundOpen = findTool(hob, "bound", "open_topic")!;
      const forcedCwd = await boundOpen.execute("e8", { title: "强传目录", note: "说明", cwd: otherDir });
      expect(forcedCwd.isError).toBe(true);
      expect(textOf(forcedCwd)).toBe(topicCwdLockedByAssistant(boundDir));
      expect(hob.runtime.assistantTopics.list("bound")).toHaveLength(0);
    } finally {
      hob.close();
    }
  });
});

describe("close_topic 与 rename_topic", () => {
  it("主对话需填 topic 并列进行中话题，话题内不填 topic 操作自身且 close_topic 结束本轮", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "multi", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      addAssistant(hob, "other", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });

      // 创建无标题自动起名的话题（用于验证 rename 去掉 nameAuto）
      const { topic: t1 } = await hob.runtime.assistantTopics.create("multi", {});
      const { topic: t2 } = await hob.runtime.assistantTopics.create("multi", { title: "进行中二" });
      const { topic: foreign } = await hob.runtime.assistantTopics.create("other", { title: "别家" });
      expect(t1.nameAuto).toBe(true);

      const mainClose = findTool(hob, "multi", "close_topic")!;
      const mainRename = findTool(hob, "multi", "rename_topic")!;

      // 主对话未填 topic 报错并列进行中话题
      const closeNoTopic = await mainClose.execute("c1", { note: "好了" });
      expect(closeNoTopic.isError).toBe(true);
      expect(textOf(closeNoTopic)).toContain(t1.id);
      expect(textOf(closeNoTopic)).toContain(t2.id);

      const renameNoTopic = await mainRename.execute("r1", { title: "新名字" });
      expect(renameNoTopic.isError).toBe(true);
      expect(textOf(renameNoTopic)).toContain(t1.id);

      // 不属于本助手的 topic 报错
      const closeForeign = await mainClose.execute("c2", { topic: foreign.id, note: "好了" });
      expect(closeForeign.isError).toBe(true);
      expect(textOf(closeForeign)).toContain(`「${foreign.id}」不是你的话题`);

      // 空 note 或超长 title 报错
      const emptyNote = await mainClose.execute("c3", { topic: t1.id, note: "  " });
      expect(emptyNote.isError).toBe(true);
      expect(textOf(emptyNote)).toContain("note 不能为空");

      const longTitle = await mainRename.execute("r2", { topic: t1.id, title: "名".repeat(41) });
      expect(longTitle.isError).toBe(true);
      expect(textOf(longTitle)).toContain("40");

      // 在话题 t1 内不填 topic 改名：去掉 nameAuto
      const topicRename = findTool(hob, "multi", "rename_topic", { topicId: t1.id })!;
      const renamed = await topicRename.execute("r3", { title: "明确名称" });
      expect(renamed.isError).not.toBe(true);
      const afterRename = hob.runtime.store.assistantTopic("multi", t1.id)!;
      expect(afterRename.name).toBe("明确名称");
      expect(afterRename.nameAuto).toBeUndefined();

      // 在主对话关闭 t2：不结束本轮（无 terminate）
      const closedFromMain = (await mainClose.execute("c4", { topic: t2.id, note: "主对话关闭结论" })) as {
        terminate?: boolean;
        isError?: boolean;
      };
      expect(closedFromMain.isError).not.toBe(true);
      expect(closedFromMain.terminate).not.toBe(true);
      expect(hob.runtime.store.assistantTopic("multi", t2.id)).toMatchObject({
        closeNote: "主对话关闭结论",
      });
      expect(hob.runtime.store.assistantTopic("multi", t2.id)?.closedAt).toBeDefined();

      // 在话题 t1 内不填 topic 关自己：结束本轮（terminate: true）
      const topicClose = findTool(hob, "multi", "close_topic", { topicId: t1.id })!;
      const closedSelf = (await topicClose.execute("c5", { note: "这件事办完了" })) as {
        terminate?: boolean;
        isError?: boolean;
        content: { type: string; text: string }[];
      };
      expect(closedSelf.isError).not.toBe(true);
      expect(closedSelf.terminate).toBe(true);
      expect(textOf(closedSelf)).toBe("话题「明确名称」已关闭。");
      expect(hob.runtime.store.assistantTopic("multi", t1.id)?.closeNote).toBe("这件事办完了");
    } finally {
      hob.close();
    }
  });
});

describe("show_assistant：多话题资料与按话题分页查看", () => {
  it("多话题资料列进行中与最近关闭的 5 个话题（不改未读），支持 topic 分页查看和话题内回看主对话", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "single", { name: "单聊" });
      addAssistant(hob, "multi", { name: "管家", topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });

      // 主对话发消息
      hob.faux.setResponses([text("主对话收到")]);
      await hob.runtime.router.send("multi", { text: "主对话问题" });
      await hob.runtime.router.waitIdle("multi");

      // 建 1 个进行中话题与 6 个已关闭话题（带各自闭环时间）
      const openTopic = (await hob.runtime.assistantTopics.create("multi", { title: "进行中的家务" })).topic;
      const closedTopics: string[] = [];
      for (let i = 1; i <= 6; i += 1) {
        const created = (await hob.runtime.assistantTopics.create("multi", { title: `已关话题${i}` })).topic;
        hob.runtime.store.saveAssistantTopic({
          ...hob.runtime.store.assistantTopic("multi", created.id)!,
          closedAt: `2026-11-26T0${i}:00:00.000Z`,
          closeNote: `结论${i}`,
        });
        closedTopics.push(created.id);
      }

      // 在进行中话题里制造 12 轮（24 条）消息以测分页，并留一条未读助手消息验证 show_assistant 不碰 readAt
      hob.faux.setResponses(Array.from({ length: 12 }, (_, idx) => text(`话题答复 ${idx}`)));
      for (let idx = 0; idx < 12; idx += 1) {
        await hob.runtime.router.send("multi", { text: `话题提问 ${idx}` }, { topicId: openTopic.id });
        await hob.runtime.router.waitIdle("multi", 10_000, { topicId: openTopic.id });
      }
      const unreadBefore = hob.runtime.router.unread("multi", { topicId: openTopic.id });
      expect(unreadBefore).toBeGreaterThan(0);

      const hobShow = findTool(hob, "hob", "show_assistant")!;
      // 1. 查看多话题助手资料：列进行中的话题 + 最近关闭的 5 个话题（第 1 个最早关闭的不在其中）
      const profile = textOf(await hobShow.execute("s1", { assistantId: "multi" }));
      expect(profile).toContain("进行中的话题：");
      expect(profile).toContain(`- 进行中的家务（${openTopic.id}）`);
      expect(profile).toContain("最近关闭的话题：");
      for (let i = 2; i <= 6; i += 1) {
        expect(profile).toContain(`已关话题${i}（${closedTopics[i - 1]}） · 结论：结论${i}`);
      }
      expect(profile).not.toContain(`已关话题1（${closedTopics[0]}）`);
      expect(profile).toContain("主对话：");
      expect(profile).toContain("主对话问题");
      expect(profile).toContain("主对话收到");
      expect(hob.runtime.router.unread("multi", { topicId: openTopic.id })).toBe(unreadBefore);

      // 2. 带 topic 查看该话题消息并分页
      const page1 = textOf(await hobShow.execute("s2", { assistantId: "multi", topic: openTopic.id }));
      expect(page1).toContain(`管家（multi） · 话题「进行中的家务」（${openTopic.id}）`);
      expect(page1).toContain("话题提问 11");
      expect(page1).toContain("话题答复 11");
      expect(page1).not.toContain("话题提问 0");
      expect(page1).toContain("第 1/2 页，共 24 条；查看下一页填 page=2");

      const page2 = textOf(await hobShow.execute("s3", { assistantId: "multi", topic: openTopic.id, page: 2 }));
      expect(page2).toContain("话题提问 0");
      expect(page2).toContain("话题答复 0");
      expect(page2).not.toContain("话题提问 11");
      expect(page2).toContain("共 24 条");

      // 3. 话题内的助手用 show_assistant 不填 topic 回看主对话
      const selfShow = findTool(hob, "multi", "show_assistant", { topicId: openTopic.id })!;
      const backToMain = textOf(await selfShow.execute("s4", { assistantId: "multi" }));
      expect(backToMain).toContain("主对话问题");
      expect(backToMain).toContain("主对话收到");

      // 4. 报错情况：未填 assistantId 只填 topic；目标不是多话题；话题不存在/不属于该助手
      const missingAid = await hobShow.execute("e1", { topic: openTopic.id });
      expect(missingAid.isError).toBe(true);

      const nonMulti = await hobShow.execute("e2", { assistantId: "single", topic: openTopic.id });
      expect(nonMulti.isError).toBe(true);
      expect(textOf(nonMulti)).toContain("不是多话题助手");

      const missingTopic = await hobShow.execute("e3", { assistantId: "multi", topic: "tp-notfound" });
      expect(missingTopic.isError).toBe(true);
      expect(textOf(missingTopic)).toContain("没有这个话题");
      expect(textOf(missingTopic)).toContain(openTopic.id);
    } finally {
      hob.close();
    }
  });
});

describe("转交挪进话题完整状态机", () => {
  it("转交落主对话后调用 open_topic 挪进话题：主对话不提前回传，话题结束后回传恰好一次", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "multi", { name: "写作", topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const resultSpy = vi.spyOn(hob.runtime.router, "delegationResult").mockResolvedValue(true);
      const events: HobEvent[] = [];
      const off = hob.runtime.bus.subscribe((ev) => events.push(ev));

      // 主对话转交回合调用 open_topic，随后话题会话处理并给出最终回复
      let topicTurnSeenPrompt = "";
      let openTopicToolResult = "";
      const originalExecute = buildRouterTools(hob.runtime, "multi").find((t) => t.name === "open_topic")!;
      expect(originalExecute).toBeDefined();
      const toolEndEvents: string[] = [];
      const multiState = await hob.runtime.router.ensure("multi");
      multiState.session!.subscribe((ev) => {
        if (ev.type === "tool_execution_end" && ev.toolName === "open_topic") {
          toolEndEvents.push((ev.result?.content?.[0] as { text?: string } | undefined)?.text ?? "");
        }
      });
      hob.faux.setResponses([
        call("open_topic", { title: "年度总结", note: "Hob 转来的要求：整理年度工作总结。" }),
        (ctx) => {
          topicTurnSeenPrompt = JSON.stringify(ctx.messages ?? []);
          return text("年度总结已整理完成。");
        },
      ]);

      const delegation = await hob.runtime.delegations.start("hob", "multi", "帮我整理年度工作总结。");
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.reportedAt));
      await hob.runtime.router.waitIdle("multi");
      const movedTopic = hob.runtime.assistantTopics.list("multi")[0]!;
      await hob.runtime.router.waitIdle("multi", 10_000, { topicId: movedTopic.id });
      off();

      openTopicToolResult = toolEndEvents[0] ?? "";
      expect(openTopicToolResult).toBe(
        `话题「年度总结」（${movedTopic.id}）已创建，交接说明已转过去，接下来在话题里处理。这件转交的事接下来在话题里处理，结果从话题回给「Hob」。`,
      );

      expect(movedTopic.name).toBe("年度总结");
      expect(topicTurnSeenPrompt).toContain("[hob-event] 这个话题是你从主对话创建的。交接说明：Hob 转来的要求：整理年度工作总结。");

      // Delegation 记录了 toTopicId 并推过包含 toTopicId 的 delegation SSE 事件
      const stored = hob.runtime.store.delegation(delegation.id)!;
      expect(stored.toTopicId).toBe(movedTopic.id);
      expect(stored.status).toBe("done");
      expect(events.some((ev) => ev.type === "delegation" && ev.delegation.id === delegation.id && ev.delegation.toTopicId === movedTopic.id)).toBe(true);

      // 发起方只收到恰好一次结果
      expect(resultSpy).toHaveBeenCalledTimes(1);
      expect(resultSpy).toHaveBeenCalledWith("hob", delegation.id, expect.stringContaining("年度总结已整理完成。"), false);
    } finally {
      hob.close();
    }
  });

  it("挪进已有话题后派任务挂到转交上：任务结果回话题而非主对话，全部完成后只回传发起方一次", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "multi", { name: "写作", topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const { topic: existing } = await hob.runtime.assistantTopics.create("multi", { title: "产品文档" });
      const resultSpy = vi.spyOn(hob.runtime.router, "delegationResult").mockResolvedValue(true);

      let workerDone = false;
      let workerReported = false;
      let releaseWorker!: () => void;
      const workerGate = new Promise<void>((resolve) => { releaseWorker = resolve; });
      const response = async (context: { messages?: unknown[] }) => {
        const system = JSON.stringify(context.messages?.[0] ?? "");
        const all = JSON.stringify(context.messages ?? []);
        if (system.includes("派出的后台任务")) {
          await workerGate;
          if (!workerReported) {
            workerReported = true;
            return call("report", { outcome: "done", result: "三章大纲已写好" });
          }
          return text("好，结果已报告。");
        }
        if (all.includes("[hob-event] 转自「Hob」")) {
          return call("open_topic", { topic: existing.id, note: "把文档大纲补齐。" });
        }
        if (all.includes("三章大纲已写好")) {
          workerDone = true;
          return text("文档大纲已按要求补齐。");
        }
        if (all.includes("[hob-event]")) {
          if (!hob.runtime.store.jobs().length) return call("start_job", { title: "写大纲", note: "写出三章大纲" });
          return text("已派任务写大纲。");
        }
        return text("收到。");
      };
      hob.faux.setResponses(Array.from({ length: 12 }, () => response));

      const delegation = await hob.runtime.delegations.start("hob", "multi", "补齐产品文档大纲");
      await waitFor(() => hob.runtime.store.jobs().length === 1);
      await hob.runtime.router.waitIdle("multi", 10_000, { topicId: existing.id });
      const beforeRelease = hob.runtime.store.delegation(delegation.id);
      const job0 = hob.runtime.store.jobs()[0];
      expect({ status: beforeRelease?.status, jobStatus: job0?.status, jobReason: job0?.statusReason }).toEqual({ status: "running", jobStatus: "running", jobReason: undefined });
      expect(resultSpy).not.toHaveBeenCalled();
      releaseWorker();
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.reportedAt), 10_000);
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("multi");
      await hob.runtime.router.waitIdle("multi", 10_000, { topicId: existing.id });

      expect(workerDone).toBe(true);
      const jobs = hob.runtime.store.jobs();
      expect(jobs).toHaveLength(1);
      const job = jobs[0]!;
      expect(job.delegationId).toBe(delegation.id);
      expect(job.topicId).toBe(existing.id);

      // 任务卡进话题，不进主对话
      expect(hob.runtime.router.items("multi", {}, { topicId: existing.id }).items).toContainEqual(
        expect.objectContaining({ kind: "job", jobId: job.id }),
      );
      expect(hob.runtime.router.items("multi").items.some((item) => item.kind === "job")).toBe(false);

      // 话题最终回传一次给 Hob
      const finalDelegation = hob.runtime.store.delegation(delegation.id)!;
      expect(finalDelegation.toTopicId).toBe(existing.id);
      expect(finalDelegation.jobIds).toEqual([job.id]);
      expect(finalDelegation.status).toBe("done");
      expect(finalDelegation.turnFailed).toBeUndefined();
      expect(resultSpy).toHaveBeenCalledTimes(1);
      expect(resultSpy).toHaveBeenCalledWith("hob", delegation.id, expect.stringContaining("文档大纲已按要求补齐。"), false);
    } finally {
      hob.close();
    }
  });

  it("话题内 hand_back 退回发起方一次；用户只在目标话题发言才会接管", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "multi", { name: "写作", topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const resultSpy = vi.spyOn(hob.runtime.router, "delegationResult").mockResolvedValue(true);

      // 场景 A：话题内 hand_back
      hob.faux.setResponses([
        call("open_topic", { title: "退回验证", note: "转到话题看是不是归我管" }),
        call("hand_back", { text: "需要运维处理", reason: "不属于写作范围" }),
      ]);
      const d1 = await hob.runtime.delegations.start("hob", "multi", "帮忙改服务器配置");
      await waitFor(() => Boolean(hob.runtime.store.delegation(d1.id)?.reportedAt));
      const t1 = hob.runtime.assistantTopics.list("multi")[0]!;
      await hob.runtime.router.waitIdle("multi", 10_000, { topicId: t1.id });
      expect(hob.runtime.store.delegation(d1.id)).toMatchObject({
        toTopicId: t1.id,
        status: "returned",
        reply: "退回：不属于写作范围",
      });
      expect(resultSpy).toHaveBeenCalledTimes(1);

      // 场景 B：挪进话题 tp-b 后，主对话与别的话题发消息不接管，只在目标话题发消息接管
      resultSpy.mockClear();
      const { topic: topicOther } = await hob.runtime.assistantTopics.create("multi", { title: "无关话题" });
      let releaseApproval!: () => void;
      const approvalGate = new Promise<void>((resolve) => { releaseApproval = resolve; });
      hob.faux.setResponses([
        call("open_topic", { title: "接管验证", note: "转到话题" }),
        call("ask_user", {
          title: "确认格式",
          options: [{ label: "Markdown" }, { label: "纯文本" }],
        }),
        text("主对话普通消息收到"),
        text("无关话题消息收到"),
        async () => {
          await approvalGate;
          return text("用户接管后的回复");
        },
      ]);

      const d2 = await hob.runtime.delegations.start("hob", "multi", "写一份说明");
      await waitFor(() => hob.runtime.store.delegation(d2.id)?.status === "waiting");
      const targetTopicId = hob.runtime.store.delegation(d2.id)!.toTopicId!;

      // 在主对话发消息、在无关话题发消息：都不接管 d2
      await hob.runtime.router.send("multi", { text: "在主对话插一句话" });
      await hob.runtime.router.waitIdle("multi");
      await hob.runtime.router.send("multi", { text: "在别的话题说一句" }, { topicId: topicOther.id });
      await hob.runtime.router.waitIdle("multi", 10_000, { topicId: topicOther.id });
      expect(hob.runtime.store.delegation(d2.id)?.status).toBe("waiting");
      expect(resultSpy).not.toHaveBeenCalled();

      // 在目标话题发消息：触发 takeOver 并通知发起方一次
      await hob.runtime.router.send("multi", { text: "我自己接着写" }, { topicId: targetTopicId });
      releaseApproval();
      await hob.runtime.router.waitIdle("multi", 10_000, { topicId: targetTopicId });
      await waitFor(() => Boolean(hob.runtime.store.delegation(d2.id)?.reportedAt));
      expect(hob.runtime.store.delegation(d2.id)?.status).toBe("takenOver");
      expect(resultSpy).toHaveBeenCalledTimes(1);
    } finally {
      hob.close();
    }
  });

  it("进程重启恢复：转交停留在话题中时正确中断或按 toTopicId 接续待答审批", async () => {
    const hob = makeHob({}, { memory: "off" });
    let hob2: ReturnType<typeof createRuntime> | undefined;
    try {
      addAssistant(hob, "multi", { name: "写作", topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const { topic: topicRun } = await hob.runtime.assistantTopics.create("multi", { title: "中断话题" });
      const { topic: topicAsk } = await hob.runtime.assistantTopics.create("multi", { title: "等待话题" });

      // 构造两条停留在话题中的转交：一条运行中，一条等待话题内 Router 审批
      const dRun: Delegation = {
        id: "dg-run-topic",
        from: "hob",
        to: "multi",
        toTopicId: topicRun.id,
        text: "整理报告",
        status: "running",
        createdAt: new Date().toISOString(),
        jobIds: [],
      };
      const approval: Approval = {
        id: "q-topic-wait",
        assistantId: "multi",
        topicId: topicAsk.id,
        title: "选择排版风格",
        options: [{ key: "A", label: "紧凑" }, { key: "B", label: "宽松" }],
        status: "pending",
        source: "router",
        createdAt: new Date().toISOString(),
      };
      const dAsk: Delegation = {
        id: "dg-ask-topic",
        from: "hob",
        to: "multi",
        toTopicId: topicAsk.id,
        text: "排版文件",
        status: "waiting",
        turnFinished: true,
        approvalIds: [approval.id],
        createdAt: new Date().toISOString(),
        jobIds: [],
      };
      hob.runtime.store.saveDelegation(dRun);
      hob.runtime.store.saveApproval(approval);
      hob.runtime.store.saveDelegation(dAsk);

      const home = hob.home;
      const config = hob.runtime.config;
      const pi = hob.runtime.pi;
      hob.runtime.router.disposeAll();
      hob.runtime.jobs.disposeAll();
      hob.runtime.routines.stop();
      hob.runtime.scriptTools.close();

      // 模拟重启后新建 Runtime 并恢复
      hob2 = createRuntime({
        home,
        config,
        pi,
      });
      const eventSpy = vi.spyOn(hob2.router, "event").mockResolvedValue(true);
      const resultSpy = vi.spyOn(hob2.router, "delegationResult").mockResolvedValue(true);

      hob2.delegations.recovering = true;
      hob2.jobs.recover();
      hob2.delegations.recover();

      // dRun 被中断并保留 toTopicId，通知发起方；dAsk 保持 waiting（等用户答复）
      expect(hob2.store.delegation(dRun.id)).toMatchObject({
        status: "interrupted",
        toTopicId: topicRun.id,
      });
      expect(hob2.store.delegation(dAsk.id)).toMatchObject({
        status: "waiting",
        toTopicId: topicAsk.id,
      });
      expect(eventSpy).toHaveBeenCalledTimes(1);
      expect(eventSpy).toHaveBeenCalledWith("hob", expect.stringContaining("因服务重启中断"), { urgent: true });

      // 重启后用户答复话题内的审批：答案必须送到 topicAsk（不误送主对话），并最终回传给 hob 一次
      hob.faux.setResponses([text("已按紧凑风格完成排版。")]);
      const answerRes = await answerApproval(hob2, approval.id, { key: "A" });
      expect(answerRes.status).toBe(200);
      await waitFor(() => Boolean(hob2!.store.delegation(dAsk.id)?.reportedAt));
      await hob2.router.waitIdle("multi", 10_000, { topicId: topicAsk.id });

      expect(hob2.store.delegation(dAsk.id)).toMatchObject({
        status: "done",
        toTopicId: topicAsk.id,
      });
      // 答案进了 topicAsk 会话，主对话未受污染
      expect(hob2.router.items("multi").items).toHaveLength(0);
      expect(hob2.router.sessionEntries("multi", { topicId: topicAsk.id }).some((e) => e.type === "custom_message" && JSON.stringify(e).includes("紧凑"))).toBe(true);
      expect(resultSpy).toHaveBeenCalledTimes(1);
      expect(resultSpy).toHaveBeenCalledWith("hob", dAsk.id, expect.stringContaining("已按紧凑风格完成排版。"), false);
    } finally {
      hob2?.router.disposeAll();
      hob2?.jobs.disposeAll();
      hob2?.routines.stop();
      hob2?.scriptTools.close();
      hob.close();
    }
  });

  it("转交已接管或有 pendingResult 时调 open_topic 不覆盖 toTopicId、不走 relay", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "multi", { name: "写作", topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      vi.spyOn(hob.runtime.router, "delegationResult").mockResolvedValue(true);
      const events: HobEvent[] = [];
      const off = hob.runtime.bus.subscribe((ev) => events.push(ev));
      const relaySpy = vi.spyOn(hob.runtime.router, "relay");
      const eventSpy = vi.spyOn(hob.runtime.router, "event");

      const toolEndEvents: string[] = [];
      const multiState = await hob.runtime.router.ensure("multi");
      multiState.session!.subscribe((ev) => {
        if (ev.type === "tool_execution_end" && ev.toolName === "open_topic") {
          toolEndEvents.push((ev.result?.content?.[0] as { text?: string } | undefined)?.text ?? "");
        }
      });

      hob.faux.setResponses([
        () => {
          // 模拟用户在窗口期内接管转交，随后模型才执行 open_topic
          hob.runtime.delegations.takeOver("multi");
          return call("open_topic", { title: "窗口期话题", note: "转过去继续" });
        },
        text("话题普通事件收到"),
      ]);

      const delegation = await hob.runtime.delegations.start("hob", "multi", "写一篇分析");
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.reportedAt));
      await hob.runtime.router.waitIdle("multi");
      const topic = hob.runtime.assistantTopics.list("multi")[0]!;
      await hob.runtime.router.waitIdle("multi", 10_000, { topicId: topic.id });
      off();

      const storedDelegation = hob.runtime.store.delegation(delegation.id);
      expect(storedDelegation?.status).toBe("takenOver");
      expect(storedDelegation?.toTopicId).toBeUndefined();
      // moveToTopic 守卫拒绝后，不发带 toTopicId 的 delegation SSE，也不走 topic relay
      expect(
        events.some((ev) => ev.type === "delegation" && ev.delegation.id === delegation.id && ev.delegation.toTopicId !== undefined),
      ).toBe(false);
      // relay 只在 delegations.start() 进主对话时调过一次
      expect(relaySpy).toHaveBeenCalledTimes(1);
      expect(eventSpy).toHaveBeenCalledWith(
        "multi",
        expect.stringContaining("这个话题是你从主对话创建的"),
        expect.objectContaining({ workDone: true }),
        { topicId: topic.id },
      );
      expect(toolEndEvents[0]).toBe(`话题「窗口期话题」（${topic.id}）已创建，交接说明已转过去，接下来在话题里处理。`);
    } finally {
      hob.close();
    }
  });

  it("目标话题 relay reject 时自动调用 delegations.turnEnded(..., true) 不卡死 running", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "multi", { name: "写作", topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const resultSpy = vi.spyOn(hob.runtime.router, "delegationResult").mockResolvedValue(true);
      const realRelay = hob.runtime.router.relay.bind(hob.runtime.router);
      let relayCount = 0;
      vi.spyOn(hob.runtime.router, "relay").mockImplementation(async (...args) => {
        relayCount += 1;
        if (relayCount === 2) throw new Error("目标话题会话启动失败");
        return realRelay(...args);
      });

      hob.faux.setResponses([call("open_topic", { title: "故障话题", note: "转过去处理" })]);

      const delegation = await hob.runtime.delegations.start("hob", "multi", "写一段说明");
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.reportedAt));
      await hob.runtime.router.waitIdle("multi");

      const finalDelegation = hob.runtime.store.delegation(delegation.id)!;
      expect(finalDelegation).toMatchObject({
        status: "stuck",
        turnFailed: true,
        turnFinished: true,
      });
      expect(finalDelegation.reply).toContain("目标话题会话启动失败");
      expect(resultSpy).toHaveBeenCalledTimes(1);
    } finally {
      hob.close();
    }
  });

  it("转交挪进话题后主对话以 success=false 收尾时，不误结已迁出的转交", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "multi", { name: "写作", topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      const resultSpy = vi.spyOn(hob.runtime.router, "delegationResult").mockResolvedValue(true);
      const routerAny = hob.runtime.router as unknown as {
        pushEvent: (...args: unknown[]) => Promise<boolean>;
      };
      const realPushEvent = routerAny.pushEvent.bind(hob.runtime.router);
      vi.spyOn(routerAny, "pushEvent").mockImplementation(async (...args: unknown[]) => {
        const res = await realPushEvent(...args);
        const placeArg = args[4] as { topicId?: string } | undefined;
        // 模拟主对话本轮虽已把转交迁出到话题，但主对话收尾返回 false
        if (!placeArg?.topicId) return false;
        return res;
      });

      hob.faux.setResponses([
        call("open_topic", { title: "迁出收尾验证", note: "在话题里写完" }),
        text("已在话题内完成。"),
      ]);

      const delegation = await hob.runtime.delegations.start("hob", "multi", "整理纪要");
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.reportedAt));
      await hob.runtime.router.waitIdle("multi");
      const topic = hob.runtime.assistantTopics.list("multi")[0]!;
      await hob.runtime.router.waitIdle("multi", 10_000, { topicId: topic.id });

      const finalDelegation = hob.runtime.store.delegation(delegation.id);
      expect(finalDelegation).toMatchObject({
        toTopicId: topic.id,
        status: "done",
      });
      expect(finalDelegation?.turnFailed).toBeUndefined();
      expect(resultSpy).toHaveBeenCalledTimes(1);
      expect(resultSpy).toHaveBeenCalledWith("hob", delegation.id, expect.stringContaining("已在话题内完成。"), false);
    } finally {
      hob.close();
    }
  });

  it("转交回合中主对话已有进行中任务或待答审批时，open_topic 被明确拦截且不建话题", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "multi", { name: "写作", topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      vi.spyOn(hob.runtime.router, "delegationResult").mockResolvedValue(true);

      // 场景 A：同转交回合主对话已有进行中任务时，调 open_topic 被拦截
      let releaseWorker!: () => void;
      const workerGate = new Promise<void>((resolve) => { releaseWorker = resolve; });
      const toolErrors: string[] = [];
      const multiState = await hob.runtime.router.ensure("multi");
      multiState.session!.subscribe((ev) => {
        if (ev.type === "tool_execution_end" && ev.toolName === "open_topic" && (ev.isError || (ev.result as { isError?: boolean } | undefined)?.isError)) {
          toolErrors.push((ev.result?.content?.[0] as { text?: string } | undefined)?.text ?? "");
        }
      });

      let workerReported = false;
      let triedOpenTopic = false;
      const response = async (ctx: { messages?: unknown[] }) => {
        const sys = JSON.stringify(ctx.messages?.[0] ?? "");
        const all = JSON.stringify(ctx.messages ?? []);
        if (sys.includes("派出的后台任务")) {
          await workerGate;
          if (!workerReported) {
            workerReported = true;
            return call("report", { outcome: "done", result: "任务做完了" });
          }
          return text("已报告。");
        }
        if (all.includes("任务做完了")) {
          return text("主对话任务也做完了。");
        }
        if (!hob.runtime.store.jobs().length) {
          return call("start_job", { title: "主对话任务", note: "先跑一个任务" });
        }
        if (!triedOpenTopic) {
          triedOpenTopic = true;
          return call("open_topic", { title: "不应创建", note: "尝试挪进话题" });
        }
        return text("好，我继续在主对话跟进。");
      };
      hob.faux.setResponses(Array.from({ length: 10 }, () => response));

      const dJob = await hob.runtime.delegations.start("hob", "multi", "主对话先派任务再试图建话题");
      await waitFor(() => toolErrors.length === 1);
      expect(toolErrors[0]).toContain("进行中的任务");
      expect(hob.runtime.assistantTopics.list("multi")).toHaveLength(0);
      expect(hob.runtime.store.delegation(dJob.id)?.toTopicId).toBeUndefined();
      releaseWorker();
      await waitFor(() => Boolean(hob.runtime.store.delegation(dJob.id)?.reportedAt));
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("multi");

      // 场景 B：主对话转交存在待答审批时，open_topic 被拦截
      const dWait: Delegation = {
        id: "dg-main-pending-approval",
        from: "hob",
        to: "multi",
        text: "等审批的转交",
        status: "waiting",
        approvalIds: ["q-main-pending"],
        createdAt: new Date().toISOString(),
        jobIds: [],
      };
      hob.runtime.store.saveDelegation(dWait);
      hob.runtime.store.saveApproval({
        id: "q-main-pending",
        assistantId: "multi",
        title: "主对话待答提问",
        options: [{ key: "A", label: "继续" }, { key: "B", label: "取消" }],
        status: "pending",
        source: "router",
        createdAt: new Date().toISOString(),
      });
      const stateB = await hob.runtime.router.ensure("multi");
      stateB.currentDelegationId = dWait.id;
      const openTool = findTool(hob, "multi", "open_topic")!;
      const blocked = await openTool.execute("blocked-approval", { title: "不应创建", note: "尝试挪进话题" });
      expect(blocked.isError).toBe(true);
      expect(textOf(blocked)).toContain("待答提问");
      expect(hob.runtime.assistantTopics.list("multi")).toHaveLength(0);
      expect(hob.runtime.store.delegation(dWait.id)?.toTopicId).toBeUndefined();
    } finally {
      hob.close();
    }
  });
});
