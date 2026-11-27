import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Assistant, Group, GroupItem } from "../../shared/types.ts";
import { archiveAssistant } from "../src/actions.ts";
import { createApp } from "../src/http.ts";
import { GroupManager, MAX_WAVE_TURNS, RELAY_NOTE, RESTART_NOTE } from "../src/groups.ts";
import { buildSystemPrompt, GROUP_OWNER_LINE, groupPromptLine } from "../src/prompt.ts";
import { lookupFile } from "../src/files.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { call, makeHob, text, waitFor, type TestHob } from "./helpers.ts";

/** 会话文件里的用户消息正文（群会话的输入就是它）。 */
function userTexts(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
        if (entry.type !== "message" || entry.message?.role !== "user") return [];
        const content = entry.message.content;
        if (typeof content === "string") return [content];
        if (!Array.isArray(content)) return [];
        return [content.filter((block) => block?.type === "text").map((block) => block.text).join("")];
      } catch {
        return [];
      }
    });
}

function addAssistant(hob: TestHob, id: string, name: string, duty: string): Assistant {
  const base = hob.runtime.store.assistant("hob")!;
  const assistant: Assistant = { ...base, id, name, duty, primary: false, pinned: false, sprite: "page" };
  hob.runtime.store.saveAssistant(assistant);
  return assistant;
}

/** 一个三人群：Hob（群主）、服务器、写作 搭档（名字里带空格）。 */
function setup(tokensPerSecond?: number): { hob: TestHob; group: Group } {
  const hob = makeHob({}, { memory: "off", ...(tokensPerSecond ? { tokensPerSecond } : {}) });
  addAssistant(hob, "ops", "服务器", "机器");
  addAssistant(hob, "write", "写作 搭档", "周报");
  const group = hob.runtime.groups.create({ name: "家里机器", purpose: "机器上的事", ownerId: "hob", members: ["hob", "ops", "write"] });
  return { hob, group };
}

const memberFile = (hob: TestHob, gid: string, assistantId: string) => hob.runtime.store.groupMemberFile(gid, assistantId);
const assistantItems = (hob: TestHob, gid: string) => hob.runtime.groups.items(gid).items.filter((item) => item.kind === "assistant");

/** 等到群里出现这么多条助手回复，并且没有人在说话。 */
async function settled(hob: TestHob, gid: string, replies: number): Promise<void> {
  await waitFor(() => assistantItems(hob, gid).length >= replies);
  await waitFor(() => hob.runtime.groups.summary(gid).busy.length === 0);
}

describe("群", () => {
  it("群读取失败直接报错，不伪装成回退成功", () => {
    const source = readFileSync(join(process.cwd(), "server/src/groups.ts"), "utf8");
    expect(source).not.toMatch(/this\.group\([^\n]+\)\s*\?\?/);
  });
  it("群提示通过统一条目入口写入并只发送一次", () => {
    const { hob, group } = setup();
    try {
      const append = vi.spyOn(hob.runtime.groups, "appendItem");
      const events: unknown[] = [];
      const unsubscribe = hob.runtime.bus.subscribe((event) => { if (event.type === "group-item") events.push(event); });
      const item = hob.runtime.groups.note(group.id, "hob", "提示");
      expect(append).toHaveBeenCalledWith(group.id, "hob", { kind: "note", icon: "info", text: "提示" });
      expect(events).toHaveLength(1);
      expect(hob.runtime.store.groupItems(group.id)).toContainEqual(item);
      unsubscribe();
    } finally { hob.close(); }
  });
  it("群提示词按共享的同群判断筛选定时", () => {
    const { hob, group } = setup();
    try {
      hob.runtime.routines.create({ assistantId: "hob", groupId: group.id, name: "检查", instruction: "检查", schedules: ["0 9 * * *"] });
      const matches = vi.spyOn(hob.runtime.store, "groupMatches");
      const { timezone, aboutYou } = hob.runtime.settings.settings.general;
      buildSystemPrompt(hob.runtime.store, "hob", { timezone, aboutYou, memory: "off", group });
      expect(matches).toHaveBeenCalledWith(group.id, group.id);
    } finally { hob.close(); }
  });
  it("群消息中的图片交给支持图片的成员模型", async () => {
    const hob = makeHob({}, { memory: "off", models: [{ id: "vision", input: ["text", "image"] }] });
    try {
      const group = hob.runtime.groups.create({ name: "群", purpose: "测试", ownerId: "hob", members: ["hob"] });
      const path = join(hob.home, "image.png");
      writeFileSync(path, readFileSync(join(process.cwd(), "docs/design/v2/s1.png")));
      hob.faux.setResponses([text("看到了")]);
      await hob.runtime.groups.send(group.id, { text: "看图", files: [path] });
      await settled(hob, group.id, 1);
      const session = await hob.runtime.router.ensure("hob", group.id);
      const user = session.session!.messages.find((message) => message.role === "user");
      expect(user?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image", mimeType: expect.stringMatching(/^image\//) })]));
    } finally { hob.close(); }
  });

  it("成员发文件后点名同事复核，对方能读到交付路径和已生成的图片", async () => {
    const hob = makeHob({}, { memory: "off", models: [{ id: "vision", input: ["text", "image"] }] });
    try {
      addAssistant(hob, "review", "复核", "核对文件");
      const group = hob.runtime.groups.create({ name: "核账", purpose: "交叉核对", ownerId: "hob", members: ["hob", "review"] });
      const invoice = join(hob.runtime.store.assistantDir("hob"), "files", "明细.csv");
      const chart = join(hob.home, "小计.png");
      mkdirSync(dirname(invoice), { recursive: true });
      writeFileSync(invoice, "金额\n128\n");
      writeFileSync(chart, readFileSync(new URL("../../web/public/icons/favicon-32.png", import.meta.url)));
      hob.runtime.groups.appendItem(group.id, "hob", { kind: "image", prompt: "画小计", status: "done", path: chart });
      hob.runtime.groups.appendItem(group.id, "hob", { kind: "image", prompt: "画全图", status: "failed", error: "生成超时" });
      let received: unknown;
      hob.faux.setResponses([call("send_file", { path: invoice }), text("@复核 请按明细和小计图核对"), (context) => {
        received = context.messages.findLast((message) => message.role === "user")?.content;
        return text("已核对");
      }]);
      await hob.runtime.groups.send(group.id, { text: "把明细发给同事复核" });
      await settled(hob, group.id, 2);
      const content = JSON.stringify(received);
      expect(content).toContain(invoice);
      expect(content).toContain(chart);
      expect(content).toContain("生成超时");
      expect(received).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image", mimeType: "image/png" })]));
    } finally { hob.close(); }
  });
  it("会话启动预检成功但消息未接收时不推进游标", async () => {
    const { hob, group } = setup();
    try {
      const state = await hob.runtime.router.ensure("hob", group.id);
      vi.spyOn(state.session!, "prompt").mockImplementation(async (_text, options) => {
        options?.preflightResult?.("started");
        throw new Error("提交前出错");
      });
      const item = hob.runtime.groups.appendItem(group.id, "user", { kind: "user", text: "未接收" });
      await hob.runtime.groups.deliverEvent(group.id, "hob", "事件");
      expect(hob.runtime.store.groupState(group.id).seen?.hob).not.toBe(item.id);
    } finally { hob.close(); }
  });

  it("打开成员会话失败时保留游标并在群中显示原因", async () => {
    const { hob, group } = setup();
    try {
      const item = hob.runtime.groups.appendItem(group.id, "user", { kind: "user", text: "尚未送达" });
      vi.spyOn(hob.runtime.router, "ensure").mockRejectedValueOnce(new Error("模型不可用"));
      await hob.runtime.groups.deliverEvent(group.id, "hob", "事件");
      expect(hob.runtime.store.groupState(group.id).seen?.hob).not.toBe(item.id);
      expect(hob.runtime.groups.items(group.id).items.some((entry) => entry.kind === "note" && entry.text.includes("回复失败") && entry.text.includes("模型不可用"))).toBe(true);
    } finally { hob.close(); }
  });

  it("成员会话中途出错时已接收的消息不重放", async () => {
    const { hob, group } = setup();
    try {
      hob.faux.setResponses([fauxAssistantMessage([fauxText("API Error: interrupted")], { stopReason: "aborted", errorMessage: "interrupted" })]);
      const item = hob.runtime.groups.appendItem(group.id, "user", { kind: "user", text: "处理一次" });
      await hob.runtime.groups.deliverEvent(group.id, "hob", "事件");
      expect(hob.runtime.store.groupState(group.id).seen?.hob).toBe(item.id);
      expect(userTexts(memberFile(hob, group.id, "hob")).filter((text) => text.includes("处理一次"))).toHaveLength(1);
    } finally { hob.close(); }
  });
  it("群成员断流时显示未能回复", async () => {
    const { hob, group } = setup();
    try {
      hob.faux.setResponses([fauxAssistantMessage([fauxText("API Error: stream interrupted")], { stopReason: "aborted", errorMessage: "API Error: stream interrupted" })]);
      await hob.runtime.groups.send(group.id, { text: "继续" });
      await waitFor(() => hob.runtime.groups.items(group.id).items.some((item) => item.kind === "note" && item.text.includes("未能回复")));
      expect(assistantItems(hob, group.id)).toEqual([]);
      const note = hob.runtime.groups.items(group.id).items.find((item) => item.kind === "note" && item.text.includes("未能回复"));
      expect(note?.text).toMatch(/^未能回复：模型调用失败（.+）。可重新发送。$/);
      expect(note).toMatchObject({ speaker: "hob" });
    } finally { hob.close(); }
  });

  it("建群、改群、归档群；参数不对说清哪里不对", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "ops", "服务器", "机器");
      addAssistant(hob, "write", "写作", "周报");
      const groups = hob.runtime.groups;

      expect(() => groups.create({ name: "", purpose: "机器", ownerId: "ops", members: ["ops", "write"] })).toThrow("群名不能为空");
      expect(() => groups.create({ name: "家里", purpose: " ", ownerId: "ops", members: ["ops", "write"] })).toThrow("职责不能为空");
      expect(() => groups.create({ name: "家里", purpose: "机器", ownerId: "ops", members: [] })).toThrow("群里至少要有一个助手");
      expect(() => groups.create({ name: "家里", purpose: "机器", ownerId: "ops", members: ["ops", "nobody"] })).toThrow("助手不存在或已归档：nobody");
      expect(() => groups.create({ name: "家里", purpose: "机器", ownerId: "write", members: ["ops", "hob"] })).toThrow("群主必须是成员之一");

      const group = groups.create({ name: "家里", purpose: "机器上的事", ownerId: "ops", members: ["ops", "write"] });
      expect(groups.summary(group.id)).toMatchObject({ name: "家里", purpose: "机器上的事", ownerId: "ops", members: ["ops", "write"], unread: 0, busy: [] });

      expect(() => groups.update(group.id, { ownerId: "hob" })).toThrow("群主必须是成员之一");
      expect(() => groups.update(group.id, { name: "" })).toThrow("群名不能为空");
      const renamed = groups.update(group.id, { name: "家里的机器", purpose: "只管家里的机器", members: ["ops", "write", "hob"], ownerId: "hob" });
      expect(renamed).toMatchObject({ name: "家里的机器", ownerId: "hob", members: ["ops", "write", "hob"] });

      await groups.archive(group.id);
      expect(hob.runtime.store.group(group.id)).toBeUndefined();
      expect(groups.list().map((item) => item.id)).not.toContain(group.id);
      expect(() => groups.items(group.id)).toThrow("群不存在");
    } finally {
      hob.close();
    }
  });

  it("一个助手也能建群：它就是群主，不点名的消息也由它接", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "write", "写作", "周报");
      const groups = hob.runtime.groups;

      const group = groups.create({ name: "周报", purpose: "每周写一份周报", ownerId: "write", members: ["write"] });
      expect(groups.summary(group.id)).toMatchObject({ ownerId: "write", members: ["write"], busy: [] });

      hob.faux.setResponses([text("这周的两件事")]);
      await groups.send(group.id, { text: "这周开始写吧" });
      await settled(hob, group.id, 1);
      expect(assistantItems(hob, group.id).map((item) => item.speaker)).toEqual(["write"]);

      // 改群照旧：成员可以在 1 个以上增减，空了才报错
      expect(() => groups.update(group.id, { members: [] })).toThrow("群里至少要留一个成员");
      expect(groups.update(group.id, { members: ["write", "hob"], ownerId: "write" }).members).toEqual(["write", "hob"]);
    } finally {
      hob.close();
    }
  });

  it("不点名轮到群主；@ 谁轮到谁；带空格的名字能认", async () => {
    const { hob, group } = setup();
    try {
      hob.faux.setResponses([text("收到"), text("我看下"), text("我来写")]);
      await hob.runtime.groups.send(group.id, { text: "有人吗" });
      await settled(hob, group.id, 1);
      expect(assistantItems(hob, group.id).map((item) => item.speaker)).toEqual(["hob"]);
      expect(existsSync(memberFile(hob, group.id, "ops"))).toBe(false);

      await hob.runtime.groups.send(group.id, { text: "@服务器 看一下磁盘" });
      await settled(hob, group.id, 2);
      expect(assistantItems(hob, group.id).map((item) => item.speaker)).toEqual(["hob", "ops"]);

      await hob.runtime.groups.send(group.id, { text: "@写作 搭档 写一句" });
      await settled(hob, group.id, 3);
      expect(assistantItems(hob, group.id).map((item) => item.speaker)).toEqual(["hob", "ops", "write"]);
      // 带空格的名字整段匹配，「写作 搭档」不会被拆成「写作」
      expect(userTexts(memberFile(hob, group.id, "write")).at(-1)).toContain("用户：@写作 搭档 写一句");
    } finally {
      hob.close();
    }
  });

  it("引用谁的消息就轮到谁", async () => {
    const { hob, group } = setup();
    try {
      hob.faux.setResponses([text("磁盘还有 40G")]);
      await hob.runtime.groups.send(group.id, { text: "@服务器 剩多少磁盘" });
      await settled(hob, group.id, 1);
      const reply = assistantItems(hob, group.id)[0]!;

      hob.faux.setResponses([text("清理计划我列一下")]);
      await hob.runtime.groups.send(group.id, { text: "接着说", quote: { itemId: reply.id, text: reply.text } });
      await settled(hob, group.id, 2);
      expect(assistantItems(hob, group.id).map((item) => item.speaker)).toEqual(["ops", "ops"]);
      expect(userTexts(memberFile(hob, group.id, "hob"))).toEqual([]);
    } finally {
      hob.close();
    }
  });

  it("同时 @ 两个：第一个说完了第二个才开始，并能看到第一位的回复", async () => {
    const { hob, group } = setup();
    try {
      let secondInput = "";
      let firstFinished = false;
      const off = hob.runtime.bus.subscribe((event) => {
        if (event.type === "group-item" && event.item.kind === "assistant" && event.item.text === "我先说") firstFinished = true;
      });
      let firstFinishedAtSecondStart = false;
      hob.faux.setResponses([text("我先说"), (ctx) => {
        firstFinishedAtSecondStart = firstFinished;
        secondInput = JSON.stringify(ctx.messages);
        return text("我也说");
      }]);
      await hob.runtime.groups.send(group.id, { text: "@服务器 @写作 搭档 一起看" });
      await settled(hob, group.id, 2);
      off();
      const items = assistantItems(hob, group.id);
      expect(items.map((item) => item.speaker)).toEqual(["ops", "write"]);
      expect(items.map((item) => item.text)).toEqual(["我先说", "我也说"]);
      expect(firstFinishedAtSecondStart).toBe(true);
      expect(secondInput).toContain("服务器：我先说");
    } finally {
      hob.close();
    }
  });

  it("按三次点名的顺序发言，每一位都能读到之前的回复", async () => {
    const { hob, group } = setup();
    try {
      hob.faux.setResponses([text("写作先说"), text("群主再说"), text("服务器最后说")]);
      await hob.runtime.groups.send(group.id, { text: "@写作 搭档 @Hob @服务器 @写作 搭档 核对一下" });
      await settled(hob, group.id, 3);
      expect(assistantItems(hob, group.id).map((item) => item.speaker)).toEqual(["write", "hob", "ops"]);
      expect(userTexts(memberFile(hob, group.id, "hob")).at(-1)).toContain("写作 搭档：写作先说");
      expect(userTexts(memberFile(hob, group.id, "ops")).at(-1)).toContain("写作 搭档：写作先说\nHob：群主再说");
    } finally {
      hob.close();
    }
  });

  it("回复里新点名的成员先接力，已在等的成员按原顺序只跑一次", async () => {
    const { hob, group } = setup();
    try {
      addAssistant(hob, "review", "评审", "评审");
      addAssistant(hob, "qa", "测试", "验证");
      hob.runtime.groups.update(group.id, { members: [...group.members, "review", "qa"] });
      hob.faux.setResponses([text("请 @评审 @测试 @写作 搭档 都看看"), text("评审意见"), text("测试意见"), text("写作意见"), text("群主意见")]);
      await hob.runtime.groups.send(group.id, { text: "@服务器 @写作 搭档 @Hob 核对一下" });
      await settled(hob, group.id, 5);
      expect(assistantItems(hob, group.id).map((item) => item.speaker)).toEqual(["ops", "review", "qa", "write", "hob"]);
      expect(userTexts(memberFile(hob, group.id, "write")).at(-1)).toContain("评审：评审意见\n测试：测试意见");
      expect(hob.faux.state.callCount).toBe(5);
    } finally {
      hob.close();
    }
  });

  it("群主只调用 call_members 也能点名，去重后按顺序流式回复并交回群主", async () => {
    const { hob, group } = setup();
    try {
      const streaming: string[] = [];
      const off = hob.runtime.bus.subscribe((event) => {
        if (event.type === "group-item" && event.item.kind === "assistant" && event.item.streaming) streaming.push(event.item.speaker);
      });
      hob.faux.setResponses([
        () => {
          // 第一位已经读过现有时间线，群主这一轮也只调工具，仍要按交代开一轮。
          const store = hob.runtime.store;
          const last = hob.runtime.groups.timeline(group.id).at(-1)!;
          store.saveGroupState(group.id, { seen: { ...store.groupState(group.id).seen, write: last.id } });
          return fauxAssistantMessage([fauxToolCall("call_members", { members: ["write", "ops", "write"], note: "先列最关键的风险", return_to_owner: true })], { stopReason: "toolUse" });
        },
        text("文案容易被误读"), text("磁盘空间不足"), text("群主汇总"),
      ]);
      await hob.runtime.groups.send(group.id, { text: "请安排风险评审" });
      await settled(hob, group.id, 3);
      off();
      expect(assistantItems(hob, group.id).map((item) => item.speaker)).toEqual(["write", "ops", "hob"]);
      expect(streaming).toEqual(["write", "ops", "hob"]);
      expect(userTexts(memberFile(hob, group.id, "write")).at(-1)).toContain("第 1/2 位）。交代：先列最关键的风险");
      const ops = userTexts(memberFile(hob, group.id, "ops")).at(-1);
      expect(ops).toContain("第 2/2 位）。交代：先列最关键的风险");
      expect(ops).toContain("写作 搭档：文案容易被误读");
      const owner = userTexts(memberFile(hob, group.id, "hob")).at(-1);
      expect(owner).toContain("写作 搭档：文案容易被误读\n服务器：磁盘空间不足");
      expect(owner).toContain("请结合他们的回复进行总结收口");
      expect(hob.faux.state.callCount).toBe(4);
    } finally {
      hob.close();
    }
  });

  it("call_members 优先于原本排队和正文重复点名，没填 note 也会给到交代", async () => {
    const { hob, group } = setup();
    try {
      hob.faux.setResponses([
        fauxAssistantMessage([fauxText("请 @服务器 @写作 搭档 回复"), fauxToolCall("call_members", { members: ["write", "ops"] })], { stopReason: "toolUse" }),
        text("写作的回复"), text("服务器的回复"),
      ]);
      await hob.runtime.groups.send(group.id, { text: "@Hob @服务器 核对一下" });
      await settled(hob, group.id, 3);
      expect(assistantItems(hob, group.id).map((item) => item.speaker)).toEqual(["hob", "write", "ops"]);
      expect(userTexts(memberFile(hob, group.id, "ops")).at(-1)).toContain("请结合上方群聊内容发言");
      expect(hob.faux.state.callCount).toBe(3);
    } finally {
      hob.close();
    }
  });

  it("call_members 只给群和话题的群主，非法成员会返回当前名单", async () => {
    const { hob, group } = setup();
    try {
      const toolFor = (id: string, gid?: string) => buildRouterTools(hob.runtime, id, gid).find((tool) => tool.name === "call_members");
      const tool = toolFor("hob", group.id)!;
      expect(toolFor("ops", group.id)).toBeUndefined();
      expect(toolFor("hob")).toBeUndefined();
      const topic = hob.runtime.groups.createTopic(group.id, "测试话题", "hob");
      expect(toolFor("hob", topic.id)).toBeDefined();
      for (const members of [[], ["hob"], ["not-in-group", "ops"]]) {
        const result = await tool.execute("test", { members });
        expect(result).toMatchObject({ isError: true });
        expect(JSON.stringify(result.content)).toContain("服务器（ops）");
        expect(JSON.stringify(result.content)).toContain("写作 搭档（write）");
      }
      hob.runtime.groups.update(group.id, { ownerId: "ops" });
      const result = await tool.execute("test", { members: ["write"] });
      expect(JSON.stringify(result.content)).toContain("只有群主能按序点名成员");
    } finally {
      hob.close();
    }
  });

  it.each(["mentions", "all"])("暂停会中断正在说的成员，继续从下一位开始（%s）", async (mode) => {
    const { hob, group } = setup(35);
    try {
      const groups = hob.runtime.groups;
      if (mode === "all") groups.update(group.id, { replyMode: "all" });
      hob.faux.setResponses([text("第一位的回复很长，应该在这段话全部说完之前中断发言"), text("下一位"), text("最后一位")]);
      const streaming = new Promise<void>((resolve) => {
        const off = hob.runtime.bus.subscribe((event) => {
          if (event.type === "group-delta" && event.groupId === group.id) { off(); resolve(); }
        });
      });
      await groups.send(group.id, { text: mode === "all" ? "大家怎么看" : "@Hob @服务器 @写作 搭档 大家怎么看" });
      await streaming;
      const abort = vi.spyOn(hob.runtime.router, "stop");
      const paused = await groups.send(group.id, { text: "先暂停一下！" });
      expect(paused.kind).toBe("user");
      expect(abort).toHaveBeenCalledWith("hob", group.id);
      expect(hob.faux.state.callCount).toBe(1);
      expect(groups.summary(group.id).busy).toEqual([]);
      expect(groups.timeline(group.id)).toContainEqual(expect.objectContaining({ kind: "note", speaker: "system", text: "已暂停，回复「继续」从下一位接着走" }));
      expect(assistantItems(hob, group.id).some((item) => item.text.includes("中断发言"))).toBe(false);

      await groups.send(group.id, { text: "继续吧" });
      await waitFor(() => assistantItems(hob, group.id).some((item) => item.text === "最后一位"));
      expect(assistantItems(hob, group.id).filter((item) => item.speaker !== "hob").map(({ speaker, text }) => [speaker, text])).toEqual([["ops", "下一位"], ["write", "最后一位"]]);
      expect(hob.faux.state.callCount).toBe(3);
    } finally {
      hob.close();
    }
  });

  it("两条群消息各有成员在发言时，重复暂停仍保留两边未轮到的成员", async () => {
    const { hob, group } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      const groups = hob.runtime.groups;
      addAssistant(hob, "review", "评审", "评审");
      groups.update(group.id, { members: [...group.members, "review"] });
      const speaking = async () => { await gate; return text("当前发言"); };
      hob.faux.setResponses([speaking, speaking, text("接着说"), text("接着说")]);
      await groups.send(group.id, { text: "@服务器 @写作 搭档 第一件事" });
      await waitFor(() => hob.faux.state.callCount === 1);
      await groups.send(group.id, { text: "@Hob @评审 第二件事" });
      await waitFor(() => hob.faux.state.callCount === 2);
      expect(groups.summary(group.id).queue?.pending).toEqual(["write", "review"]);

      const stopping = groups.send(group.id, { text: "暂停" });
      release();
      await stopping;
      await groups.send(group.id, { text: "暂停" });
      expect(groups.summary(group.id).queue).toEqual({ pending: ["write", "review"], paused: true });
      await groups.send(group.id, { text: "继续" });
      await waitFor(() => assistantItems(hob, group.id).filter((item) => item.text === "接着说").length === 2);
      const speakers = assistantItems(hob, group.id).filter((item) => item.text === "接着说").map((item) => item.speaker);
      expect(speakers.sort()).toEqual(["review", "write"]);
      expect(hob.faux.state.callCount).toBe(4);
    } finally { release(); hob.close(); }
  });

  it("summary.queue 反映串行接力与暂停状态，支持 resumeQueue、discardQueue 和 POST /api/groups/:id/queue", async () => {
    const { hob, group } = setup(35);
    try {
      const groups = hob.runtime.groups;
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const headers = { "content-type": "application/json", cookie: login.headers.get("set-cookie")!.split(";")[0]! };
      const postQueue = (id: string, body: unknown) => app.request(`/api/groups/${id}/queue`, { method: "POST", headers, body: JSON.stringify(body) });

      expect((await postQueue("g-missing", { action: "resume" })).status).toBe(404);
      expect((await postQueue(group.id, { action: "invalid" })).status).toBe(400);
      expect((await postQueue(group.id, null)).status).toBe(400);
      expect(await (await postQueue(group.id, { action: "resume" })).json()).toEqual({ ok: true, applied: false });
      expect(await (await postQueue(group.id, { action: "discard" })).json()).toEqual({ ok: true, applied: false });

      hob.faux.setResponses([text("第一位的回复很长，用来确保流式进行中可以观察排队并暂停"), text("第二位回复"), text("第三位回复")]);
      const streaming = new Promise<void>((resolve) => {
        const off = hob.runtime.bus.subscribe((event) => {
          if (event.type === "group-delta" && event.groupId === group.id) { off(); resolve(); }
        });
      });
      await groups.send(group.id, { text: "@Hob @服务器 @写作 搭档 依次说说" });
      await streaming;
      expect(groups.summary(group.id).queue).toEqual({ pending: ["ops", "write"] });

      await groups.send(group.id, { text: "暂停" });
      expect(groups.summary(group.id).queue).toEqual({ pending: ["ops", "write"], paused: true });

      const resumed = await postQueue(group.id, { action: "resume" });
      expect(resumed.status).toBe(200);
      expect(await resumed.json()).toEqual({ ok: true, applied: true });
      await waitFor(() => assistantItems(hob, group.id).some((item) => item.text === "第三位回复"));
      await waitFor(() => groups.summary(group.id).busy.length === 0);
      expect(groups.summary(group.id).queue).toBeUndefined();

      // 再次暂停并用 discard 放弃排队
      hob.faux.setResponses([text("另一段很长的流式输出，确保暂停前还没说完"), text("不会被说出来")]);
      const streaming2 = new Promise<void>((resolve) => {
        const off = hob.runtime.bus.subscribe((event) => {
          if (event.type === "group-delta" && event.groupId === group.id) { off(); resolve(); }
        });
      });
      await groups.send(group.id, { text: "@Hob @服务器 再来一轮" });
      await streaming2;
      await groups.send(group.id, { text: "暂停" });
      expect(groups.summary(group.id).queue).toEqual({ pending: ["ops"], paused: true });

      const discarded = await postQueue(group.id, { action: "discard" });
      expect(discarded.status).toBe(200);
      expect(await discarded.json()).toEqual({ ok: true, applied: true });
      expect(groups.summary(group.id).queue).toBeUndefined();

      // 已关闭话题不允许 resumeQueue
      const topic = groups.createTopic(group.id, "已关话题", "user");
      groups.closeByUser(topic.id, "结束");
      const closedRes = await postQueue(topic.id, { action: "resume" });
      expect(closedRes.status).toBe(400);
    } finally {
      hob.close();
    }
  });

  it("同一个成员被叫两次：第一次说完以后又来一条，另开一轮，输入只有这一条新条目", async () => {
    const { hob, group } = setup();
    try {
      hob.faux.setResponses([text("第一句收到"), text("第二句收到")]);
      void hob.runtime.groups.send(group.id, { text: "@服务器 第一句" });
      await settled(hob, group.id, 1);
      await hob.runtime.groups.send(group.id, { text: "@服务器 第二句" });
      await settled(hob, group.id, 2);
      expect(assistantItems(hob, group.id).map((item) => item.text)).toEqual(["第一句收到", "第二句收到"]);
      const inputs = userTexts(memberFile(hob, group.id, "ops"));
      expect(inputs).toHaveLength(2);
      // 第二次的输入：它上一条说完之后的新条目
      expect(inputs[1]!.slice(inputs[1]!.indexOf("\n\n") + 2)).toBe("用户：@服务器 第二句");
    } finally {
      hob.close();
    }
  });

  it("成员一轮还在跑时用户再发一条：用 steer 插进同一轮，不多跑一轮", async () => {
    // 一个字一个字地吐，才有「正在流式」的窗口发第二条
    const { hob, group } = setup(20);
    try {
      hob.faux.setResponses([text("第一句我先看着，慢慢说"), text("第二句也收到了")]);
      const deliver = vi.spyOn(hob.runtime.router, "deliverMember");
      const streaming = new Promise<void>((resolve) => {
        const off = hob.runtime.bus.subscribe((event) => {
          if (event.type !== "group-delta" || event.groupId !== group.id) return;
          off();
          resolve();
        });
      });
      await hob.runtime.groups.send(group.id, { text: "@服务器 第一句" });
      await streaming;
      await hob.runtime.groups.send(group.id, { text: "@服务器 第二句" });
      await settled(hob, group.id, 2);

      // 只有一轮：第二条没另排一轮
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(assistantItems(hob, group.id).map((item) => item.text)).toEqual(["第一句我先看着，慢慢说", "第二句也收到了"]);
      // 模型收到的 steer 文字里有这条消息（同一会话的第二条用户消息）
      const inputs = userTexts(memberFile(hob, group.id, "ops"));
      expect(inputs).toHaveLength(2);
      expect(inputs[0]).toContain("用户：@服务器 第一句");
      expect(inputs[1]!.slice(inputs[1]!.indexOf("\n\n") + 2)).toBe("用户：@服务器 第二句");
    } finally {
      hob.close();
    }
  });

  it("正在发言的成员接收了新的多点名消息，新提到的接力成员先跑", async () => {
    const { hob, group } = setup(30);
    try {
      hob.faux.setResponses([text("我先慢慢记录这个问题"), text("先请 @Hob 看一下"), text("群主补充"), text("写作接上")]);
      const streaming = new Promise<void>((resolve) => {
        const off = hob.runtime.bus.subscribe((event) => {
          if (event.type === "group-delta" && event.groupId === group.id) { off(); resolve(); }
        });
      });
      await hob.runtime.groups.send(group.id, { text: "@服务器 帮我看看" });
      await streaming;
      await hob.runtime.groups.send(group.id, { text: "@服务器 @写作 搭档 一起核对" });
      await settled(hob, group.id, 4);
      expect(assistantItems(hob, group.id).map((item) => item.speaker)).toEqual(["ops", "ops", "hob", "write"]);
      expect(userTexts(memberFile(hob, group.id, "write")).at(-1)).toContain("Hob：群主补充");
    } finally {
      hob.close();
    }
  });

  it("排到时已经没有新条目的一轮不跑，不调模型", async () => {
    const { hob, group } = setup();
    try {
      hob.faux.setResponses([text("两句都看到了"), text("不该跑到这句")]);
      const deliver = vi.spyOn(hob.runtime.router, "deliverMember");
      // 两句话几乎同时发出：第一轮把两句都带上了，后面排的那一轮没有新东西
      void hob.runtime.groups.send(group.id, { text: "@服务器 第一句" });
      await hob.runtime.groups.send(group.id, { text: "@服务器 第二句" });
      await settled(hob, group.id, 1);

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(assistantItems(hob, group.id).map((item) => item.text)).toEqual(["两句都看到了"]);
      const inputs = userTexts(memberFile(hob, group.id, "ops"));
      expect(inputs).toHaveLength(1);
      expect(inputs[0]!.slice(inputs[0]!.indexOf("\n\n") + 2).split("\n")).toEqual([
        "系统：已创建群「家里机器」",
        "用户：@服务器 第一句",
        "用户：@服务器 第二句",
      ]);
      expect(hob.faux.getPendingResponseCount()).toBe(1);
    } finally {
      hob.close();
    }
  });

  it("事件那一轮先列群里还没见过的新条目，再写事件；那条用户消息不再单独跑一轮", async () => {
    const { hob, group } = setup();
    try {
      hob.faux.setResponses([text("事件和你说的话我都看到了"), text("不该跑到这句")]);
      const deliver = vi.spyOn(hob.runtime.router, "deliverMember");
      // 事件先排上，用户在这期间说的话也进了群
      void hob.runtime.groups.deliverEvent(group.id, "ops", "任务「查磁盘」完成了。");
      await hob.runtime.groups.send(group.id, { text: "@服务器 先别急，等我看下" });
      await settled(hob, group.id, 1);

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(assistantItems(hob, group.id).map((item) => item.text)).toEqual(["事件和你说的话我都看到了"]);
      const inputs = userTexts(memberFile(hob, group.id, "ops"));
      expect(inputs).toHaveLength(1);
      const body = inputs[0]!.slice(inputs[0]!.indexOf("\n\n") + 2);
      expect(body.split("\n\n")).toEqual([
        "系统：已创建群「家里机器」\n用户：@服务器 先别急，等我看下",
        "[hob-event] 任务「查磁盘」完成了。",
      ]);
      expect(hob.faux.getPendingResponseCount()).toBe(1);
    } finally {
      hob.close();
    }
  });

  it("成员回复里 @ 了别人，接着轮到那个人", async () => {
    const { hob, group } = setup();
    try {
      hob.faux.setResponses([text("@写作 搭档 你去查一下磁盘"), text("好，我查")]);
      await hob.runtime.groups.send(group.id, { text: "@服务器 磁盘的事你看下" });
      await settled(hob, group.id, 2);
      expect(assistantItems(hob, group.id).map((item) => item.speaker)).toEqual(["ops", "write"]);
      expect(userTexts(memberFile(hob, group.id, "write")).at(-1)).toContain("服务器：@写作 搭档 你去查一下磁盘");
    } finally {
      hob.close();
    }
  });

  it("一条消息引出超过 20 个回合就停：留 note、给群主发事件", async () => {
    const { hob, group } = setup();
    try {
      const relay = () => text("@Hob 接着说 @服务器 接着说");
      // 群主收尾那一轮也 @ 了人：不再接着转，最后那条回复不该被用到
      hob.faux.setResponses([...Array.from({ length: MAX_WAVE_TURNS + 1 }, relay), text("不该出现")]);
      await hob.runtime.groups.send(group.id, { text: "你们俩接着聊" });
      await waitFor(() => hob.runtime.groups.items(group.id).items.some((item) => item.kind === "note" && item.text === RELAY_NOTE));
      await settled(hob, group.id, MAX_WAVE_TURNS);
      expect(assistantItems(hob, group.id).length).toBeGreaterThanOrEqual(MAX_WAVE_TURNS);
      expect(hob.runtime.groups.items(group.id).items.filter((item) => item.kind === "note" && item.text === RELAY_NOTE)).toHaveLength(1);

      await waitFor(() => userTexts(memberFile(hob, group.id, "hob")).some((value) => value.includes(`[hob-event] ${RELAY_NOTE}`)));
      await settled(hob, group.id, MAX_WAVE_TURNS + 1);
      expect(existsSync(hob.runtime.store.routerFile("hob")) ? readFileSync(hob.runtime.store.routerFile("hob"), "utf8") : "").not.toContain(RELAY_NOTE);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(assistantItems(hob, group.id)).toHaveLength(MAX_WAVE_TURNS + 1);
      expect(assistantItems(hob, group.id).some((item) => item.text === "不该出现")).toBe(false);
    } finally {
      hob.close();
    }
  });

  it("成员收到的输入是它上次说完以后的条目，按「名字：内容」一行行列出，最后是叫到它的那条", async () => {
    const { hob, group } = setup();
    try {
      hob.faux.setResponses([text("第一件事收到")]);
      await hob.runtime.groups.send(group.id, { text: "第一件事" });
      await settled(hob, group.id, 1);

      hob.faux.setResponses([text("第二件事收到")]);
      await hob.runtime.groups.send(group.id, { text: "第二件事 @服务器 你看" });
      await settled(hob, group.id, 2);
      const input = userTexts(memberFile(hob, group.id, "ops")).at(-1)!;
      const body = input.slice(input.indexOf("\n\n") + 2);
      expect(body.split("\n")).toEqual(["系统：已创建群「家里机器」", "用户：第一件事", "Hob：第一件事收到", "用户：第二件事 @服务器 你看"]);
      expect(body.endsWith("用户：第二件事 @服务器 你看")).toBe(true);

      // 它上次说完以后：再叫它一次，输入从它的上一条回复之后开始
      hob.faux.setResponses([text("第三件事收到")]);
      await hob.runtime.groups.send(group.id, { text: "@服务器 还有第三件事" });
      await settled(hob, group.id, 3);
      const next = userTexts(memberFile(hob, group.id, "ops")).at(-1)!;
      expect(next.slice(next.indexOf("\n\n") + 2).split("\n")).toEqual(["用户：@服务器 还有第三件事"]);
    } finally {
      hob.close();
    }
  });

  it("只调了工具没说话的回合：下次叫它（重启后也一样）不重复给已经给过的条目，只流出空白的条目收掉", async () => {
    const { hob, group } = setup();
    try {
      hob.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("read", { path: hob.runtime.store.groupTimelineFile(group.id) })], { stopReason: "toolUse" }),
        text("\n\n"),
      ]);
      await hob.runtime.groups.send(group.id, { text: "@服务器 先看一眼" });
      await waitFor(() => userTexts(memberFile(hob, group.id, "ops")).length === 1);
      await waitFor(() => hob.runtime.groups.summary(group.id).busy.length === 0);

      // 重启：内存里的东西都没了，给到哪一条要从 state.json 读
      hob.runtime.groups = new GroupManager(hob.runtime);
      hob.faux.setResponses([text("看过了")]);
      await hob.runtime.groups.send(group.id, { text: "@服务器 看完说一声" });
      await settled(hob, group.id, 1);
      const next = userTexts(memberFile(hob, group.id, "ops")).at(-1)!;
      expect(next.slice(next.indexOf("\n\n") + 2).split("\n")).toEqual(["用户：@服务器 看完说一声"]);
      expect(hob.runtime.store.groupItems(group.id).some((item) => item.kind === "assistant" && item.streaming)).toBe(false);
    } finally {
      hob.close();
    }
  });

  it("一轮里调了工具：工具前后两段文字各成一条，不会丢也不会重复", async () => {
    const { hob, group } = setup();
    try {
      hob.faux.setResponses([
        fauxAssistantMessage([fauxText("我先看看时间线"), fauxToolCall("read", { path: hob.runtime.store.groupTimelineFile(group.id) })], { stopReason: "toolUse" }),
        text("看完了：只有一句问候。"),
      ]);
      await hob.runtime.groups.send(group.id, { text: "@服务器 看下群里的记录" });
      await settled(hob, group.id, 2);
      expect(assistantItems(hob, group.id).map((item) => item.text)).toEqual(["我先看看时间线", "看完了：只有一句问候。"]);
    } finally {
      hob.close();
    }
  });

  it("群里又发了话：成员在这个群里出的、还没答的问题卡过期，别的群和单聊的不动", async () => {
    const { hob, group } = setup();
    try {
      const base = { assistantId: "hob", title: "现在发布吗", options: [{ key: "A" as const, label: "发布" }], status: "pending" as const, source: "router" as const, createdAt: new Date().toISOString() };
      hob.runtime.store.saveApproval({ ...base, id: "q-here", groupId: group.id });
      hob.runtime.store.saveApproval({ ...base, id: "q-elsewhere", groupId: "g-other" });
      hob.runtime.store.saveApproval({ ...base, id: "q-single" });
      hob.faux.setResponses([text("好")]);
      await hob.runtime.groups.send(group.id, { text: "先不管那个，看看这个" });
      await settled(hob, group.id, 1);
      expect(hob.runtime.store.approval("q-here")?.status).toBe("expired");
      expect(hob.runtime.store.approval("q-elsewhere")?.status).toBe("pending");
      expect(hob.runtime.store.approval("q-single")?.status).toBe("pending");
    } finally {
      hob.close();
    }
  });

  it.each(["mention", "quote", "owner", "all"])("群消息只结束本次收件人的问题卡（%s）", async (mode) => {
    const { hob, group } = setup();
    try {
      if (mode === "all") hob.runtime.groups.update(group.id, { replyMode: "all" });
      const quote = hob.runtime.groups.appendItem(group.id, "ops", { kind: "assistant", text: "我来核对" });
      const base = { title: "是否继续", options: [], status: "pending" as const, source: "router" as const, groupId: group.id, createdAt: new Date().toISOString() };
      for (const id of group.members) hob.runtime.store.saveApproval({ ...base, id: `q-${id}`, assistantId: id });
      hob.faux.setResponses(group.members.map(() => text("收到")));
      await hob.runtime.groups.send(group.id, {
        text: mode === "mention" ? "@服务器 查一下进展" : "查一下进展",
        ...(mode === "quote" ? { quote: { itemId: quote.id, text: "我来核对" } } : {}),
      });
      await settled(hob, group.id, mode === "all" ? 4 : 2);
      const recipients = mode === "all" ? group.members : [mode === "owner" ? "hob" : "ops"];
      for (const id of group.members) expect(hob.runtime.store.approval(`q-${id}`)?.status).toBe(recipients.includes(id) ? "expired" : "pending");
    } finally { hob.close(); }
  });

  it("群会话和单聊互不影响：群里说话不让单聊的提问过期，单聊里也看不到群消息", async () => {
    const { hob, group } = setup();
    try {
      const approval = {
        id: "q-group",
        assistantId: "hob",
        title: "现在发布吗",
        options: [{ key: "A" as const, label: "发布" }, { key: "B" as const, label: "不发布" }],
        status: "pending" as const,
        source: "router" as const,
        createdAt: new Date().toISOString(),
      };
      hob.runtime.store.saveApproval(approval);

      hob.faux.setResponses([text("群里说的"), text("单聊说的")]);
      await hob.runtime.groups.send(group.id, { text: "群里的一句话" });
      await settled(hob, group.id, 1);
      // 群里说话不让单聊里挂着的提问过期
      expect(hob.runtime.store.approval("q-group")?.status).toBe("pending");
      await hob.runtime.router.send("hob", { text: "单聊的一句话" });
      await hob.runtime.router.waitIdle("hob");

      // 单聊照旧：发消息时把挂着的问题过掉，且看不到群里的消息
      expect(hob.runtime.store.approval("q-group")?.status).toBe("expired");
      const single = hob.runtime.router.items("hob").items;
      expect(JSON.stringify(single)).toContain("单聊的一句话");
      expect(JSON.stringify(single)).not.toContain("群里的一句话");
      expect(JSON.stringify(hob.runtime.groups.items(group.id))).not.toContain("单聊的一句话");
      // 单聊的条目照旧，群里的回复不会出现在单聊里
      expect(single.filter((item) => item.kind === "assistant").map((item) => item.text)).toEqual(["单聊说的"]);
    } finally {
      hob.close();
    }
  });

  it("条目 id 按群递增不重复，时间线同 id 后写的覆盖前面的", async () => {
    const { hob, group } = setup();
    try {
      hob.faux.setResponses([text("收到"), text("也说一句")]);
      await hob.runtime.groups.send(group.id, { text: "第一句 @服务器" });
      await settled(hob, group.id, 1);
      await hob.runtime.groups.send(group.id, { text: "第二句 @写作 搭档" });
      await settled(hob, group.id, 2);
      const ids = hob.runtime.groups.items(group.id).items.map((item) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
      // 建群 note + 两句用户消息 + 两条回复
      expect(ids).toEqual(["g-1", "g-2", "g-3", "g-4", "g-5"]);

      const item = hob.runtime.groups.items(group.id).items[0]!;
      hob.runtime.store.appendGroupItem(group.id, { ...item, text: "改过的" } as GroupItem);
      const after = hob.runtime.groups.items(group.id).items;
      expect(after).toHaveLength(5);
      expect(after[0]).toMatchObject({ id: item.id, text: "改过的" });
    } finally {
      hob.close();
    }
  });

  it("归档群主后群主换成剩下的第一个成员；群里没人了把群一起归档", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "ops", "服务器", "机器");
      addAssistant(hob, "write", "写作", "周报");
      const gid = hob.runtime.groups.create({ name: "机器", purpose: "机器上的事", ownerId: "ops", members: ["ops", "write"] }).id;

      expect((await archiveAssistant(hob.runtime, "ops")).status).toBe(200);
      const after = hob.runtime.store.group(gid)!;
      expect(after.members).toEqual(["write"]);
      expect(after.ownerId).toBe("write");

      expect((await archiveAssistant(hob.runtime, "write")).status).toBe(200);
      expect(hob.runtime.store.group(gid)).toBeUndefined();
      expect(hob.runtime.groups.list().map((item) => item.id)).not.toContain(gid);
    } finally {
      hob.close();
    }
  });

  it("重启：被中断的流式条目不续，收尾并留一条说明", () => {
    const { hob, group } = setup();
    try {
      const item: GroupItem = { kind: "assistant", speaker: "ops", id: "g-9", at: new Date().toISOString(), text: "说到一半", streaming: true };
      hob.runtime.store.appendGroupItem(group.id, item);
      new GroupManager(hob.runtime);
      const items = hob.runtime.groups.items(group.id).items;
      expect(items.find((entry) => entry.id === "g-9")).toMatchObject({ streaming: false, text: "说到一半" });
      expect(items.at(-1)).toMatchObject({ kind: "note", text: RESTART_NOTE });
    } finally {
      hob.close();
    }
  });

  // 定稿只在开发仓库里（.scratch 不公开），没有就跳过逐字对照
  it.skipIf(!existsSync(".scratch/v2/design-groups.md"))("提示词：群会话换成「你在群…」那段，群主多一段；单聊不变", () => {
    const { hob, group } = setup();
    try {
      const design = readFileSync(".scratch/v2/design-groups.md", "utf8");
      const [memberSource, ownerSource] = [...design.matchAll(/^> (.+)$/gm)].map((match) => match[1]!);
      const members = "Hob（hob，主助手，群主）、服务器（ops，机器）、写作 搭档（write，周报）";
      const expected = memberSource!
        .replace("{群名}", group.name)
        .replace("{名字（id，职责）列表，群主标「群主」}", members)
        .replace("{purpose}", group.purpose);
      expect(ownerSource).toBe(GROUP_OWNER_LINE);

      const options = { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const };
      const ownerPrompt = buildSystemPrompt(hob.runtime.store, "hob", { ...options, group });
      expect(ownerPrompt).toContain(expected);
      expect(ownerPrompt).toContain(GROUP_OWNER_LINE);
      expect(ownerPrompt).not.toContain("用户在一对一的对话里和你合作");
      expect(ownerPrompt).not.toContain("message_assistant");

      const memberPrompt = buildSystemPrompt(hob.runtime.store, "ops", { ...options, group });
      expect(memberPrompt).toContain(expected);
      expect(memberPrompt).not.toContain(GROUP_OWNER_LINE);
      expect(memberPrompt).not.toContain("用户在一对一的对话里和你合作");

      const single = buildSystemPrompt(hob.runtime.store, "hob", options);
      expect(single).toContain("用户在一对一的对话里和你合作，每条消息都是对你说的。");
      expect(single).not.toContain("你在群「");
    } finally {
      hob.close();
    }
  });

  it("消耗统计把群会话算在对应助手名下；/api/files 能读 groups/", async () => {
    const { hob, group } = setup();
    try {
      const dir = join(hob.home, "groups", group.id, "members");
      const line = `${JSON.stringify({
        type: "message",
        id: "m-1",
        timestamp: "2026-11-06T01:00:00.000Z",
        message: { role: "assistant", provider: "hob-faux", model: "faux-1", timestamp: Date.parse("2026-11-06T01:00:00.000Z"), content: [], usage: { type: "usage", input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } },
      })}\n`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(memberFile(hob, group.id, "ops"), `${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-11-06T00:00:00.000Z", cwd: hob.home })}\n${line}`);

      const view = await hob.runtime.usage.view();
      expect(view.rows.find((row) => row.assistantId === "ops" && row.source === "chat")).toMatchObject({ requests: 1, input: 10, output: 5 });
      expect(view.assistants.find((item) => item.id === "ops")?.name).toBe("服务器");

      const uploads = join(hob.home, "groups", group.id, "files", "uploads");
      mkdirSync(uploads, { recursive: true });
      writeFileSync(join(uploads, "a.txt"), "内容");
      expect(lookupFile(hob.home, join(uploads, "a.txt"))).toMatchObject({ ok: true, info: { name: "a.txt" } });
      expect(lookupFile(hob.home, hob.runtime.store.groupTimelineFile(group.id)).ok).toBe(true);
    } finally {
      hob.close();
    }
  });

  it("HTTP：列表、条目、发消息、已读、上传、停止、归档", async () => {
    const { hob, group } = setup();
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

      const list = await app.request("/api/groups", { headers: { cookie } });
      expect(list.status).toBe(200);
      const listed = (await list.json()) as Group[];
      expect(listed.find((item) => item.id === group.id)).toMatchObject({ name: "家里机器", members: ["hob", "ops", "write"] });

      const bad = await app.request("/api/groups", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "x", purpose: "y", ownerId: "hob", members: [] }) });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: "群里至少要有一个助手" });

      hob.faux.setResponses([text("收到")]);
      const sent = await app.request(`/api/groups/${group.id}/messages`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "你好" }) });
      expect(sent.status).toBe(202);
      await settled(hob, group.id, 1);

      const empty = await app.request(`/api/groups/${group.id}/messages`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "  " }) });
      expect(empty.status).toBe(400);

      const read = await app.request(`/api/groups/${group.id}/read`, { method: "POST", headers: { cookie } });
      expect(read.status).toBe(200);
      expect(hob.runtime.groups.summary(group.id).unread).toBe(0);

      const items = await app.request(`/api/groups/${group.id}/items`, { headers: { cookie } });
      expect(items.status).toBe(200);
      expect((await items.json() as { items: GroupItem[] }).items.map((item) => item.kind)).toEqual(["note", "user", "assistant"]);

      const form = new FormData();
      form.append("file", new File([new Uint8Array([1, 2, 3])], "日志.txt"));
      const upload = await app.request(`/api/uploads?groupId=${group.id}`, { method: "POST", headers: { cookie }, body: form });
      expect(upload.status).toBe(200);
      const uploaded = (await upload.json() as { files: string[] }).files[0]!;
      expect(uploaded.startsWith(join(hob.home, "groups", group.id, "files", "uploads"))).toBe(true);
      expect(existsSync(uploaded)).toBe(true);

      const stop = await app.request(`/api/groups/${group.id}/stop`, { method: "POST", headers: { cookie } });
      expect(stop.status).toBe(200);

      expect((await app.request(`/api/groups/g-nope/items`, { headers: { cookie } })).status).toBe(404);
      expect((await app.request(`/api/groups/${group.id}/archive`, { method: "POST", headers: { cookie } })).status).toBe(200);
      expect(hob.runtime.store.group(group.id)).toBeUndefined();
    } finally {
      hob.close();
    }
  });
});
