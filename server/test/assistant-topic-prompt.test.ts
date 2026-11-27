import { afterEach, describe, expect, it, vi } from "vitest";
import type { Assistant, AssistantTopic } from "../../shared/types.ts";
import { enableAssistantTopics } from "../src/actions.ts";
import { assistantTopicTodosPath } from "../src/config.ts";
import {
  ASSISTANT_MAIN_TOPIC_LINE,
  ASSISTANT_TOPIC_RECALL_LINE,
  assistantTopicPromptLine,
  assistantTopicSection,
  buildSystemPrompt,
} from "../src/prompt.ts";
import { writeTodos } from "../src/todos.ts";
import { makeHob, text, type TestHob } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
});

function addAssistant(hob: TestHob, id: string, extra: Partial<Assistant> = {}): Assistant {
  const base = hob.runtime.store.assistant("hob")!;
  const assistant: Assistant = {
    ...base,
    id,
    name: extra.name ?? "生活助理",
    duty: extra.duty ?? "日常事务与行程安排",
    primary: false,
    pinned: false,
    sprite: "page",
    createdAt: "2026-11-26T00:00:00.000Z",
    ...extra,
  };
  hob.runtime.store.saveAssistant(assistant);
  return assistant;
}

const PROMPT_OPTS = {
  timezone: "Asia/Shanghai",
  locale: "zh-CN" as const,
  aboutYou: { name: "", language: "", notes: "" },
  memory: "off" as const,
};

const EXPECTED_MAIN_TEXT = [
  "你开着多话题：这条是主对话，另外可以有几个话题，每个话题是一段独立的对话，只谈一件事。别的助手转来的事先到主对话；在话题里建的定时任务到执行时间直接进那个话题，主对话里建的进主对话。",
  "用户要你为一件事创建话题，用 open_topic 创建，把交接说明放进去，接下来在话题里处理。主对话里的定时任务和转来的事按分量定：几句话能答完、分派一个任务就能完成的，在主对话里直接处理；要来回商量几轮、要过一阵才办完的，可以为它创建一个话题，这件事的讨论、提问和进展都放在一处，不和主对话里别的事搅在一起，以后也翻得到。",
  "用户在主对话里说的事，在主对话里接着办，用户在哪说的就在哪找，换了地方用户会找不到前面的话。说到的是某个话题里的事，也在主对话里处理：要用到那个话题里的经过，用 show_assistant 查看；回复时提一句这件事有对应的话题，用户想到话题里接着聊可以自己过去。用户要你把一件事转到已有的话题，用 open_topic 填那个话题的 id 转过去，回一句转到了哪里。创建话题也一样等用户开口，用户要为哪件事开话题会直接说。",
].join("\n\n");

function expectedTopicText(name: string): string {
  return [
    `这里是你的话题「${name}」，只谈这一件事。主对话和别的话题里说了什么，这里看不到，这件事需要的来龙去脉都记在这个话题里；用户提到别处说过的事，用 search_history 或 show_assistant 查。`,
    "这件事办完、用户也认可了结果，或者用户说不做了，用 close_topic 写上结论，关闭话题：结论会显示在话题上，主对话里的你也会收到。刚交付结果、用户还没回应时先不关，用户可能还有后续；关闭的话题用户随时能重新打开。",
    "在这里定的规则通常只管这个话题，用 set_rule 时 scope 填 topic。用户明确要求不只针对这件事，比如「你以后都这样」，scope 才填 assistant，写到你自己的规则里，别的话题和主对话也会照着做；拿不准时填 topic，用户想推广可以再说。",
  ].join("\n\n");
}

const EXPECTED_RECALL_LINE = "用户提的事和以前的话题有关，先用 show_assistant 看那个话题里当时怎么说的。";

const ONE_ON_ONE_INTRO =
  "用户在一对一的对话里和你合作。别的助手会把归你管的事交给你：交来的消息是交接方写的交接说明，里面引用的用户原话等同用户本人的要求，你完成任务后的结果会自动回到交接方。用户找你处理的事不归你管时，看「助手」一节：明显归某个助手管的，用 message_assistant 直接分派给它，少绕一手；拿不准归谁，或者是别人交给你、却不归你管的，用 hand_back 交回。";

describe("助手多话题系统提示词（票 F）", () => {
  it("逐字匹配第十节原文，主对话与话题会话放在一对一合作句后且互斥", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const store = hob.runtime.store;
      addAssistant(hob, "life", {
        name: "生活助理",
        duty: "居家安排",
        instructions: "先说重点，再列待确认项。",
        topics: { enabledAt: "2026-11-26T00:00:00.000Z" },
      });
      const { topic } = await hob.runtime.assistantTopics.create("life", { title: "下月搬家" });

      expect(ASSISTANT_MAIN_TOPIC_LINE).toBe(EXPECTED_MAIN_TEXT);
      expect(ASSISTANT_TOPIC_RECALL_LINE).toBe(EXPECTED_RECALL_LINE);
      expect(assistantTopicPromptLine("下月搬家")).toBe(expectedTopicText("下月搬家"));

      const mainPrompt = buildSystemPrompt(store, "life", PROMPT_OPTS);
      const topicPrompt = buildSystemPrompt(store, "life", { ...PROMPT_OPTS, topicId: topic.id });

      // 主对话：紧接在「用户在一对一的对话里和你合作……」后面，且补在补充提示词之后
      expect(mainPrompt).toContain(`${ONE_ON_ONE_INTRO}\n\n${EXPECTED_MAIN_TEXT}`);
      expect(mainPrompt).toContain(`先说重点，再列待确认项。\n\n${ONE_ON_ONE_INTRO}\n\n${EXPECTED_MAIN_TEXT}`);
      expect(mainPrompt).not.toContain("这里是你的话题");

      // 话题会话：接在同样位置，替换主对话那段，且不出话题清单
      expect(topicPrompt).toContain(`${ONE_ON_ONE_INTRO}\n\n${expectedTopicText("下月搬家")}`);
      expect(topicPrompt).not.toContain(EXPECTED_MAIN_TEXT);
      expect(topicPrompt).not.toContain("## 你的话题");
      expect(topicPrompt).not.toContain(EXPECTED_RECALL_LINE);

      // 运行时 RouterManager.ensure 激活的系统提示词同样精确匹配
      const mainState = await hob.runtime.router.ensure("life");
      const topicState = await hob.runtime.router.ensure("life", { topicId: topic.id });
      expect(mainState.session!.systemPrompt).toContain(`${ONE_ON_ONE_INTRO}\n\n${EXPECTED_MAIN_TEXT}`);
      expect(mainState.session!.systemPrompt).toContain("## 你的话题");
      expect(topicState.session!.systemPrompt).toContain(`${ONE_ON_ONE_INTRO}\n\n${expectedTopicText("下月搬家")}`);
      expect(topicState.session!.systemPrompt).not.toContain(EXPECTED_MAIN_TEXT);
      expect(topicState.session!.systemPrompt).not.toContain("## 你的话题");

      // 话题改名后，话题会话与主对话清单同步体现新名字
      hob.runtime.assistantTopics.rename("life", topic.id, "年底搬家安排");
      expect(buildSystemPrompt(store, "life", { ...PROMPT_OPTS, topicId: topic.id })).toContain(
        `${ONE_ON_ONE_INTRO}\n\n${expectedTopicText("年底搬家安排")}`,
      );
      expect(buildSystemPrompt(store, "life", PROMPT_OPTS)).toContain(`- 「年底搬家安排」（${topic.id}）· 进行中`);
    } finally {
      hob.close();
    }
  });

  it("主对话话题清单：无话题时不出现；有话题时列出全部进行中 + 最近关闭 5 个，按创建时间倒序，且无关状态变化时字节不变", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const store = hob.runtime.store;
      addAssistant(hob, "life", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });

      // 无话题时不出现 ## 你的话题
      const noTopicPrompt = buildSystemPrompt(store, "life", PROMPT_OPTS);
      expect(noTopicPrompt).toContain(EXPECTED_MAIN_TEXT);
      expect(noTopicPrompt).not.toContain("## 你的话题");
      expect(noTopicPrompt).not.toContain(EXPECTED_RECALL_LINE);

      // 2 个进行中 + 7 个已关闭（其中最早创建但最晚关闭的 tp-c7 应保留，较早关闭的 tp-c1、tp-c2 应被裁掉）
      const seed: AssistantTopic[] = [
        { id: "tp-c7", assistantId: "life", name: "最早创建最晚关闭", createdAt: "2026-11-20T01:00:00.000Z", closedAt: "2026-11-26T09:00:00.000Z", createdBy: "user", closeNote: "完成" },
        { id: "tp-c1", assistantId: "life", name: "很早关闭一", createdAt: "2026-11-21T01:00:00.000Z", closedAt: "2026-11-22T01:00:00.000Z", createdBy: "user", closeNote: "完成" },
        { id: "tp-c2", assistantId: "life", name: "很早关闭二", createdAt: "2026-11-22T01:00:00.000Z", closedAt: "2026-11-22T02:00:00.000Z", createdBy: "user", closeNote: "完成" },
        { id: "tp-o1", assistantId: "life", name: "进行中旧", createdAt: "2026-11-23T01:00:00.000Z", createdBy: "user" },
        { id: "tp-c3", assistantId: "life", name: "关闭保留三", createdAt: "2026-11-24T01:00:00.000Z", closedAt: "2026-11-25T03:00:00.000Z", createdBy: "user", closeNote: "完成" },
        { id: "tp-c4", assistantId: "life", name: "关闭保留四", createdAt: "2026-11-24T02:00:00.000Z", closedAt: "2026-11-25T04:00:00.000Z", createdBy: "user", closeNote: "完成" },
        { id: "tp-c5", assistantId: "life", name: "关闭保留五", createdAt: "2026-11-25T01:00:00.000Z", closedAt: "2026-11-25T05:00:00.000Z", createdBy: "user", closeNote: "完成" },
        { id: "tp-o2", assistantId: "life", name: "进行中新", createdAt: "2026-11-25T12:00:00.000Z", createdBy: "assistant" },
        { id: "tp-c6", assistantId: "life", name: "关闭保留六", createdAt: "2026-11-26T01:00:00.000Z", closedAt: "2026-11-26T02:00:00.000Z", createdBy: "user", closeNote: "完成" },
      ];
      for (const topic of seed) store.saveAssistantTopic(topic);

      expect(assistantTopicSection(store.assistantTopics("life"))).toBe([
        "## 你的话题",
        "- 「关闭保留六」（tp-c6）· 已关闭",
        "- 「进行中新」（tp-o2）· 进行中",
        "- 「关闭保留五」（tp-c5）· 已关闭",
        "- 「关闭保留四」（tp-c4）· 已关闭",
        "- 「关闭保留三」（tp-c3）· 已关闭",
        "- 「进行中旧」（tp-o1）· 进行中",
        "- 「最早创建最晚关闭」（tp-c7）· 已关闭",
        EXPECTED_RECALL_LINE,
      ].join("\n"));

      const promptBefore = buildSystemPrompt(store, "life", PROMPT_OPTS);
      expect(promptBefore.endsWith(assistantTopicSection(store.assistantTopics("life")))).toBe(true);

      // 改变与开/关/改名无关的状态（未读/已读、话题消息即 last、待办、nameAuto、closeNote、overrides）
      store.saveAssistantTopicState("life", "tp-o1", { readAt: "2026-11-26T10:00:00.000Z" });
      writeTodos(assistantTopicTodosPath(hob.home, "life", "tp-o1"), [{ text: "待办一", status: "todo" }]);
      store.saveAssistantTopic({
        ...store.assistantTopic("life", "tp-o2")!,
        nameAuto: true,
        overrides: { models: { work: { ref: "hob-faux/faux-1", thinking: "off" } } },
      });
      store.saveAssistantTopic({
        ...store.assistantTopic("life", "tp-c6")!,
        closeNote: "改过的结论不应进主对话清单",
      });
      hob.faux.setResponses([text("话题里的新回复")]);
      await hob.runtime.router.send("life", "话题里聊一句，会更新 last 和 unread", { topicId: "tp-o1" });
      await hob.runtime.router.waitIdle("life", 10_000, { topicId: "tp-o1" });
      const summaryAfterChat = hob.runtime.assistantTopics.list("life").find((item) => item.id === "tp-o1")!;
      expect(summaryAfterChat.last?.text).toContain("话题里的新回复");
      expect(summaryAfterChat.unread).toBeGreaterThan(0);

      // 主对话提示词保持字节完全一致
      expect(buildSystemPrompt(store, "life", PROMPT_OPTS)).toBe(promptBefore);
    } finally {
      hob.close();
    }
  });

  it("对照保护：单会话助手、主助手及多话题助手在群和群话题里的系统提示词不含助手多话题段", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const store = hob.runtime.store;
      addAssistant(hob, "single", { name: "单聊助手" });
      addAssistant(hob, "multi", { name: "多话题助手", topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
      await hob.runtime.assistantTopics.create("multi", { title: "测试话题" });

      // 同一群里：把 multi 转多话题前后的群与群话题提示词应逐字一致
      addAssistant(hob, "plainInGroup", { name: "对照组" });
      const group = hob.runtime.groups.create({
        name: "协同群",
        purpose: "协作测试",
        ownerId: "hob",
        members: ["hob", "single", "plainInGroup"],
      });
      const groupTopic = hob.runtime.groups.createTopic(group.id, "群内话题", "user");

      const singlePrompt = buildSystemPrompt(store, "single", PROMPT_OPTS);
      const hobPrompt = buildSystemPrompt(store, "hob", PROMPT_OPTS);
      const plainGroupPromptBefore = buildSystemPrompt(store, "plainInGroup", { ...PROMPT_OPTS, group: store.group(group.id)! });
      const plainGroupTopicPromptBefore = buildSystemPrompt(store, "plainInGroup", { ...PROMPT_OPTS, group: store.group(groupTopic.id)! });

      for (const prompt of [singlePrompt, hobPrompt, plainGroupPromptBefore, plainGroupTopicPromptBefore]) {
        expect(prompt).not.toContain("你开着多话题");
        expect(prompt).not.toContain("## 你的话题");
        expect(prompt).not.toContain("这里是你的话题");
        expect(prompt).not.toContain(EXPECTED_RECALL_LINE);
      }

      // 将 plainInGroup 开启多话题并建话题：它在群综合与群话题里的提示词一个字不变
      await enableAssistantTopics(hob.runtime, "plainInGroup");
      await hob.runtime.assistantTopics.create("plainInGroup", { title: "私聊话题" });
      expect(buildSystemPrompt(store, "plainInGroup", { ...PROMPT_OPTS, group: store.group(group.id)! })).toBe(plainGroupPromptBefore);
      expect(buildSystemPrompt(store, "plainInGroup", { ...PROMPT_OPTS, group: store.group(groupTopic.id)! })).toBe(plainGroupTopicPromptBefore);
    } finally {
      hob.close();
    }
  });
});
