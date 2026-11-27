import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../shared/i18n.ts";
import { nowBlock } from "../src/now.ts";
import {
  ASSISTANT_TOPIC_REPORT_BACK_LINE,
  buildSystemPrompt,
  GROUP_TOPIC_REPORT_BACK_LINE,
  ONE_ON_ONE_REPORT_BACK_LINE,
  groupTopicHandoverReportBackLine,
} from "../src/prompt.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { todosBusy } from "../src/todos.ts";
import { makeHob, type TestHob } from "./helpers.ts";

const hobs: TestHob[] = [];
const tempDirs: string[] = [];
function createHob(): TestHob {
  const hob = makeHob({}, { memory: "off" });
  hobs.push(hob);
  return hob;
}
function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hob-ws-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  setLocale("zh-CN");
  while (hobs.length) hobs.pop()!.close();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function addAssistant(hob: TestHob, id: string, name: string, duty: string, extra: Record<string, unknown> = {}) {
  const base = hob.runtime.store.assistant("hob")!;
  hob.runtime.store.saveAssistant({
    ...base,
    id,
    name,
    duty,
    primary: false,
    pinned: false,
    ...extra,
  });
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => part.text ?? "").join("");
}

describe("report_back tool", () => {
  it("exposes report_back only to group topic owners and non-primary assistant sessions", async () => {
    const hob = createHob();
    addAssistant(hob, "owner", "策划助手", "统筹");
    addAssistant(hob, "member", "后勤助手", "执行");
    addAssistant(hob, "writer", "写作助手", "写作", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });

    const group = hob.runtime.groups.create({
      name: "活动群",
      purpose: "筹备活动",
      members: ["owner", "member"],
      ownerId: "owner",
    });
    const topic = hob.runtime.groups.createTopic(group.id, "场地布置", "owner");
    const { topic: handedTopic } = hob.runtime.groups.handOver(group.id, "备份迁移", "hob", { text: "迁移", files: [] });
    const { topic: assistantTopic } = await hob.runtime.assistantTopics.create("writer", { title: "第三章", createdBy: "user" });

    const has = (aid: string, place?: { groupId?: string; topicId?: string }) =>
      buildRouterTools(hob.runtime, aid, place).find((tool) => tool.name === "report_back");

    // 综合、群里普通成员、主助手单聊：没有
    expect(has("owner", { groupId: group.id })).toBeUndefined();
    expect(has("member", { groupId: group.id })).toBeUndefined();
    expect(has("member", { groupId: topic.id })).toBeUndefined();
    expect(has("member", { groupId: handedTopic.id })).toBeUndefined();
    expect(has("hob")).toBeUndefined();

    // 群话题群主（综合开 / 主助手交来）、非主助手主对话与话题：有，且说明按会话类型定
    expect(has("owner", { groupId: topic.id })?.description).toBe(
      "把这个话题的结果、进展，或者要综合来定的事交回综合。综合里的你会收到并接着安排；话题不关，这里还能接着办。",
    );
    expect(has("owner", { groupId: handedTopic.id })?.description).toBe(
      "把这个话题的结果、进展，或者要「Hob」来定的事交回给它。它会收到并接着处理；话题不关，这里还能接着办。",
    );
    expect(has("writer", { topicId: assistantTopic.id })?.description).toBe(
      "把这个话题的结果、进展，或者要主对话来定的事交回主对话。主对话里的你会收到并接着安排；话题不关，这里还能接着办。",
    );
    expect(has("writer")?.description).toBe(
      "把转来的事的新结果交回最近一次把事转给你的助手。它会收到并接着处理。",
    );
  });

  it("reports from a general-opened group topic back to general and wakes the owner", async () => {
    const hob = createHob();
    addAssistant(hob, "owner", "策划助手", "统筹");
    addAssistant(hob, "member", "后勤助手", "执行");
    const group = hob.runtime.groups.create({
      name: "活动群",
      purpose: "筹备活动",
      members: ["owner", "member"],
      ownerId: "owner",
    });
    const topic = hob.runtime.groups.createTopic(group.id, "场地布置", "owner");
    const deliverSpy = vi.spyOn(hob.runtime.groups, "deliverEvent").mockResolvedValue();

    const tool = buildRouterTools(hob.runtime, "owner", { groupId: topic.id }).find((item) => item.name === "report_back")!;
    const res = await tool.execute("c1", { text: "舞台搭建推迟一天，需与嘉宾接送协调" }, undefined, undefined, undefined as never);

    expect(resultText(res)).toBe("已交回综合。");
    expect((res as { terminate?: boolean }).terminate).toBeUndefined();
    expect(hob.runtime.store.group(topic.id)?.closedAt).toBeUndefined();

    const note = hob.runtime.store.groupItems(group.id).findLast((item) => item.kind === "note");
    expect(note).toMatchObject({
      kind: "note",
      icon: "info",
      text: "场地布置 交回：舞台搭建推迟一天，需与嘉宾接送协调",
      targetGroupId: topic.id,
    });

    expect(deliverSpy).toHaveBeenCalledWith(
      group.id,
      "owner",
      `话题「场地布置」（${topic.id}）交回：舞台搭建推迟一天，需与嘉宾接送协调\n话题里看不到综合说的话：要它接着做什么，或者要别的话题配合，用 open_topic 填 topic 转过去。`,
      "",
      { workDone: true },
    );
  });

  it("reports from a handed-over group topic back to the sender session (including fromTopicId) and reopens closed upstream topic", async () => {
    const hob = createHob();
    addAssistant(hob, "coord", "统筹助手", "统筹", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
    addAssistant(hob, "ops", "运维助手", "运维");
    const { topic: upstreamTopic } = await hob.runtime.assistantTopics.create("coord", { title: "年度迁移", createdBy: "user" });
    const group = hob.runtime.groups.create({
      name: "数据迁移小组",
      purpose: "数据迁移",
      members: ["ops"],
      ownerId: "ops",
    });
    const { topic: handedTopic } = hob.runtime.groups.handOver(group.id, "备份迁移", "coord", {
      text: "迁移历史库",
      files: [],
      fromTopicId: upstreamTopic.id,
    });
    // 上游话题被关掉了
    await hob.runtime.assistantTopics.close("coord", upstreamTopic.id, "先暂停");
    expect(hob.runtime.store.assistantTopic("coord", upstreamTopic.id)?.closedAt).toBeTruthy();

    const eventSpy = vi.spyOn(hob.runtime.router, "event").mockResolvedValue(true);
    const tool = buildRouterTools(hob.runtime, "ops", { groupId: handedTopic.id }).find((item) => item.name === "report_back")!;
    const res = await tool.execute("c2", { text: "目标存储空间不足，需先扩容 3.5 TB" }, undefined, undefined, undefined as never);

    expect(resultText(res)).toBe("已交回「统筹助手」。");
    expect(hob.runtime.store.assistantTopic("coord", upstreamTopic.id)?.closedAt).toBeUndefined();

    const upstreamItems = hob.runtime.router.items("coord", {}, { topicId: upstreamTopic.id }).items;
    expect(upstreamItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "note",
        text: "备份迁移 交回：目标存储空间不足，需先扩容 3.5 TB",
        targetGroupId: handedTopic.id,
      }),
    ]));

    expect(eventSpy).toHaveBeenCalledWith(
      "coord",
      `群「数据迁移小组」的话题「备份迁移」（${handedTopic.id}）交回：目标存储空间不足，需先扩容 3.5 TB\n话题里看不到你这边说的话：要群里接着做什么，用 message_group 填 topic: ${handedTopic.id} 转过去。`,
      { workDone: true },
      { topicId: upstreamTopic.id },
    );
  });

  it("reports from an assistant topic back to its main conversation", async () => {
    const hob = createHob();
    addAssistant(hob, "writer", "写作助手", "写作", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
    const { topic } = await hob.runtime.assistantTopics.create("writer", { title: "第三章修改", createdBy: "user" });
    const eventSpy = vi.spyOn(hob.runtime.router, "event").mockResolvedValue(true);

    const tool = buildRouterTools(hob.runtime, "writer", { topicId: topic.id }).find((item) => item.name === "report_back")!;
    const res = await tool.execute("c3", { text: "主角职业改为海事保险调查员，需同步人物设定" }, undefined, undefined, undefined as never);

    expect(resultText(res)).toBe("已交回主对话。");
    expect((res as { terminate?: boolean }).terminate).toBeUndefined();

    const mainItems = hob.runtime.router.items("writer").items;
    expect(mainItems.at(-1)).toMatchObject({
      kind: "note",
      text: "第三章修改 交回：主角职业改为海事保险调查员，需同步人物设定",
      targetTopicId: topic.id,
    });

    expect(eventSpy).toHaveBeenCalledWith(
      "writer",
      `话题「第三章修改」（${topic.id}）交回：主角职业改为海事保险调查员，需同步人物设定\n话题里看不到主对话说的话：要它接着做什么，或者要别的话题配合，用 open_topic 填 topic 转过去。`,
      { workDone: true },
    );
  });

  it("reports from a non-primary 1-on-1 back to the latest finished or taken-over delegator and reopens closed upstream topic", async () => {
    const hob = createHob();
    addAssistant(hob, "life", "生活管家", "协调", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
    addAssistant(hob, "home", "家务助手", "家务");
    const { topic: lifeTopic } = await hob.runtime.assistantTopics.create("life", { title: "周末安排", createdBy: "user" });
    await hob.runtime.assistantTopics.close("life", lifeTopic.id, "暂时收尾");

    hob.runtime.store.saveDelegation({
      id: "dg-old",
      from: "hob",
      to: "home",
      text: "旧转交",
      createdAt: "2026-11-26T08:00:00.000Z",
      endedAt: "2026-11-26T08:10:00.000Z",
      reportedAt: "2026-11-26T08:10:01.000Z",
      status: "done",
      jobIds: [],
      approvalIds: [],
    });
    hob.runtime.store.saveDelegation({
      id: "dg-latest",
      from: "life",
      fromTopicId: lifeTopic.id,
      to: "home",
      text: "整理一份换季衣物整理清单，按卧室衣柜和玄关鞋柜分类并标出清洗项",
      createdAt: "2026-11-27T01:40:00.000Z",
      endedAt: "2026-11-27T01:50:00.000Z",
      reportedAt: "2026-11-27T01:50:01.000Z",
      status: "takenOver",
      jobIds: [],
      approvalIds: [],
    });

    const eventSpy = vi.spyOn(hob.runtime.router, "event").mockResolvedValue(true);
    const tool = buildRouterTools(hob.runtime, "home").find((item) => item.name === "report_back")!;
    const res = await tool.execute("c4", { text: "换季清单已补入小孩校服和睡袋" }, undefined, undefined, undefined as never);

    expect(resultText(res)).toBe("已交回「生活管家」。");
    expect(hob.runtime.store.assistantTopic("life", lifeTopic.id)?.closedAt).toBeUndefined();

    const items = hob.runtime.router.items("life", {}, { topicId: lifeTopic.id }).items;
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "note",
        text: "家务助手 交回：换季清单已补入小孩校服和睡袋",
      }),
    ]));

    expect(eventSpy).toHaveBeenCalledWith(
      "life",
      "「家务助手」交回（你之前转给它的「整理一份换季衣物整理清单，按卧室衣柜和玄…」）：换季清单已补入小孩校服和睡袋\n要它接着做什么，用 message_assistant 再转给它。",
      { workDone: true },
      { topicId: lifeTopic.id },
    );
  });

  it("passes safe files and rejects sensitive file paths", async () => {
    const hob = createHob();
    addAssistant(hob, "writer", "写作助手", "写作", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
    const { topic } = await hob.runtime.assistantTopics.create("writer", { title: "第三章", createdBy: "user" });
    const workDir = join(hob.home, "assistants", "writer", "work");
    mkdirSync(workDir, { recursive: true });
    const reportFile = join(workDir, "outline.md");
    writeFileSync(reportFile, "# Outline\n");

    const eventSpy = vi.spyOn(hob.runtime.router, "event").mockResolvedValue(true);
    const tool = buildRouterTools(hob.runtime, "writer", { topicId: topic.id }, workDir).find((item) => item.name === "report_back")!;

    // 敏感路径被拒
    const secretPath = join(hob.home, "system", "secrets.json");
    const bad = await tool.execute("c-sec", { text: "附带凭据", files: [secretPath] }, undefined, undefined, undefined as never);
    expect((bad as { isError?: boolean }).isError).toBe(true);
    expect(eventSpy).not.toHaveBeenCalled();

    // 正常文件跟着送到
    const okRes = await tool.execute("c-ok", { text: "附上大纲", files: ["outline.md"] }, undefined, undefined, undefined as never);
    expect(resultText(okRes)).toBe("已交回主对话。");
    expect(eventSpy).toHaveBeenCalledWith(
      "writer",
      expect.stringContaining("附上大纲"),
      { workDone: true, files: [reportFile] },
    );
    const note = hob.runtime.router.items("writer").items.at(-1);
    expect(note).toMatchObject({
      kind: "note",
      text: "第三章 交回：附上大纲（附件：outline.md）",
      files: [reportFile],
    });
  });

  it("delivers files through groups.deliverEvent when reporting back to general", async () => {
    const hob = createHob();
    addAssistant(hob, "owner", "策划助手", "统筹");
    const group = hob.runtime.groups.create({ name: "活动群", purpose: "活动", members: ["owner"], ownerId: "owner" });
    const topic = hob.runtime.groups.createTopic(group.id, "场地布置", "owner");
    const workDir = join(hob.home, "assistants", "owner", "work");
    mkdirSync(workDir, { recursive: true });
    const floorplan = join(workDir, "floorplan.png");
    writeFileSync(floorplan, "fake-png");

    const deliverSpy = vi.spyOn(hob.runtime.groups, "deliverEvent").mockResolvedValue();
    const tool = buildRouterTools(hob.runtime, "owner", { groupId: topic.id }, workDir).find((item) => item.name === "report_back")!;
    const res = await tool.execute("c-gfile", { text: "附上新平面图", files: ["floorplan.png"] }, undefined, undefined, undefined as never);

    expect(resultText(res)).toBe("已交回综合。");
    expect(deliverSpy).toHaveBeenCalledWith(
      group.id,
      "owner",
      expect.stringContaining("附上新平面图"),
      "",
      { workDone: true, files: [floorplan] },
    );
    expect(hob.runtime.store.groupItems(group.id).at(-1)).toMatchObject({
      kind: "note",
      text: "场地布置 交回：附上新平面图（附件：floorplan.png）",
      targetGroupId: topic.id,
      files: [floorplan],
    });
  });

  it("truncates long text into preview with full text in detail", async () => {
    const hob = createHob();
    addAssistant(hob, "writer", "写作助手", "写作", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
    const { topic } = await hob.runtime.assistantTopics.create("writer", { title: "长汇报", createdBy: "user" });
    vi.spyOn(hob.runtime.router, "event").mockResolvedValue(true);

    const longText = "第一行摘要内容\n第二行详细说明\n第三行更多细节";
    const tool = buildRouterTools(hob.runtime, "writer", { topicId: topic.id }).find((item) => item.name === "report_back")!;
    await tool.execute("c-long", { text: longText }, undefined, undefined, undefined as never);

    const note = hob.runtime.router.items("writer").items.at(-1);
    expect(note).toMatchObject({
      kind: "note",
      text: "长汇报 交回：第一行摘要内容…",
      detail: longText,
      targetTopicId: topic.id,
    });
  });

  it("returns exact error messages for empty text, active delegation, no delegation, and missing upstream assistant", async () => {
    const hob = createHob();
    addAssistant(hob, "life", "生活管家", "协调");
    addAssistant(hob, "home", "家务助手", "家务");
    const tool = buildRouterTools(hob.runtime, "home").find((item) => item.name === "report_back")!;

    // text 为空
    const emptyRes = await tool.execute("e1", { text: "   " }, undefined, undefined, undefined as never);
    expect((emptyRes as { isError?: boolean }).isError).toBe(true);
    expect(resultText(emptyRes)).toBe("text 不能为空：写清结果、进展或要对方定什么，再调用一次。");

    // 从没转交过
    const noneRes = await tool.execute("e2", { text: "有进展" }, undefined, undefined, undefined as never);
    expect((noneRes as { isError?: boolean }).isError).toBe(true);
    expect(resultText(noneRes)).toBe("这里没有别的助手转来的事，没有可以交回的地方：结果直接告诉用户。");

    // 转交还没结束
    hob.runtime.store.saveDelegation({
      id: "dg-active",
      from: "life",
      to: "home",
      text: "整理清单",
      createdAt: "2026-11-27T02:00:00.000Z",
      status: "running",
      jobIds: [],
      approvalIds: [],
    });
    const activeRes = await tool.execute("e3", { text: "先报个进度" }, undefined, undefined, undefined as never);
    expect((activeRes as { isError?: boolean }).isError).toBe(true);
    expect(resultText(activeRes)).toBe("你在办「生活管家」转来的事，这一轮说完，结果会自动回到它那里，不用另外交回。");

    // 上一层助手已归档不在了
    hob.runtime.store.saveDelegation({
      id: "dg-done",
      from: "life",
      to: "home",
      text: "整理清单",
      createdAt: "2026-11-27T03:00:00.000Z",
      endedAt: "2026-11-27T03:05:00.000Z",
      reportedAt: "2026-11-27T03:05:01.000Z",
      status: "done",
      jobIds: [],
      approvalIds: [],
    });
    hob.runtime.store.archiveAssistant("life", "life-2026-11-27");
    const goneRes = await tool.execute("e4", { text: "补充结果" }, undefined, undefined, undefined as never);
    expect((goneRes as { isError?: boolean }).isError).toBe(true);
    expect(resultText(goneRes)).toBe("「生活管家」已经不在了，交不回去：结果直接告诉用户。");
  });
});

describe("message_group topic follow-up", () => {
  it("forwards into an existing handed-over topic and wakes the group owner", async () => {
    const hob = createHob();
    addAssistant(hob, "ops", "运维助手", "运维");
    const group = hob.runtime.groups.create({ name: "数据迁移小组", purpose: "数据迁移", members: ["ops"], ownerId: "ops" });
    const { topic } = hob.runtime.groups.handOver(group.id, "备份迁移", "hob", { text: "开始迁移", files: [] });

    const deliverSpy = vi.spyOn(hob.runtime.groups, "deliverEvent").mockResolvedValue();
    const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "message_group")!;
    const res = await tool.execute("mg-1", { groupId: group.id, topic: topic.id, note: "存储已经扩容 4 TB，可以继续迁移。" }, undefined, undefined, undefined as never);

    expect((res as { terminate?: boolean }).terminate).toBe(true);
    expect(resultText(res)).toBe(`已转到群「数据迁移小组」的话题「备份迁移」（${topic.id}），群主「运维助手」接着办。有了结论会回到这里。`);
    const last = hob.runtime.store.groupItems(topic.id).at(-1);
    expect(last).toMatchObject({ kind: "user", text: "存储已经扩容 4 TB，可以继续迁移。", forwardedFrom: { assistantId: "hob" } });
    expect(deliverSpy).toHaveBeenCalledWith(
      topic.id,
      "ops",
      expect.stringContaining("Hob"),
      last!.id,
      { workDone: true, userInitiated: false, bypassBusy: false },
    );
  });

  it("reopens a closed handed-over topic without resuming paused routines and re-delivers conclusion on next close", async () => {
    const hob = createHob();
    addAssistant(hob, "ops", "运维助手", "运维");
    const group = hob.runtime.groups.create({ name: "数据迁移小组", purpose: "数据迁移", members: ["ops"], ownerId: "ops" });
    const { topic } = hob.runtime.groups.handOver(group.id, "备份迁移", "hob", { text: "开始迁移", files: [] });

    // 给话题建一个定时任务
    const routine = hob.runtime.routines.create({
      assistantId: "ops",
      groupId: topic.id,
      name: "巡检迁移进度",
      instruction: "检查同步速率",
      schedules: ["0 9 * * *"],
    });
    expect(routine.active).toBe(true);

    // 第一次关闭：暂停定时任务并向 hob 送一次结论
    hob.faux.setResponses([fauxAssistantMessage("收到第一次结论。"), fauxAssistantMessage("收到第二次结论。")]);
    const pushSpy = vi.spyOn(hob.runtime.router, "handoverResult");
    hob.runtime.groups.closeByOwner(topic.id, "第一阶段迁移完成");
    await vi.waitFor(() => {
      expect(hob.runtime.store.group(topic.id)?.handover?.deliveredAt).toBeTruthy();
    });
    expect(hob.runtime.store.routine(routine.id)?.active).toBe(false);
    expect(pushSpy).toHaveBeenCalledTimes(1);

    // 用 message_group(topic) 重开：不恢复定时任务，清空上次 result / deliveredAt
    const deliverSpy = vi.spyOn(hob.runtime.groups, "deliverEvent").mockResolvedValue();
    const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "message_group")!;
    const res = await tool.execute("mg-reopen", { groupId: group.id, topic: topic.id, note: "请再补跑一次增量校验。" }, undefined, undefined, undefined as never);
    expect(resultText(res)).toContain(`已转到群「数据迁移小组」的话题「备份迁移」（${topic.id}）`);
    expect(deliverSpy).toHaveBeenCalledTimes(1);

    const reopened = hob.runtime.store.group(topic.id)!;
    expect(reopened.closedAt).toBeUndefined();
    expect(reopened.handover?.result).toBeUndefined();
    expect(reopened.handover?.deliveredAt).toBeUndefined();
    expect(hob.runtime.store.routine(routine.id)?.active).toBe(false);

    // 第二次关闭：结论重新送回 hob（不被第一次的 handoverTopicId 去重拦截）
    hob.runtime.groups.closeByOwner(topic.id, "增量校验全部通过");
    await vi.waitFor(() => {
      expect(hob.runtime.store.group(topic.id)?.handover?.deliveredAt).toBeTruthy();
    });
    expect(pushSpy).toHaveBeenCalledTimes(2);
    expect(hob.runtime.store.group(topic.id)?.handover?.result).toContain("增量校验全部通过");
  });

  it("rejects non-handed-over topics with list, validates title/topic exclusivity, and enforces cwd immutability", async () => {
    const hob = createHob();
    addAssistant(hob, "ops", "运维助手", "运维");
    addAssistant(hob, "other", "协作助手", "协作");
    const group = hob.runtime.groups.create({ name: "数据迁移小组", purpose: "数据迁移", members: ["ops"], ownerId: "ops" });
    const generalTopic = hob.runtime.groups.createTopic(group.id, "综合开的话题", "ops");
    const dirA = createTempDir();
    const dirB = createTempDir();
    const { topic: myTopic } = hob.runtime.groups.handOver(group.id, "备份迁移", "hob", { text: "迁移", files: [], cwd: dirA });
    const { topic: otherTopic } = hob.runtime.groups.handOver(group.id, "别人交的话题", "other", { text: "别的事", files: [] });

    vi.spyOn(hob.runtime.groups, "deliverEvent").mockResolvedValue();
    const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "message_group")!;

    // title 和 topic 都不填
    const neither = await tool.execute("mg-none", { groupId: group.id, note: "补充说明" }, undefined, undefined, undefined as never);
    expect((neither as { isError?: boolean }).isError).toBe(true);
    expect(resultText(neither)).toBe("title 和 topic 要填一个：创建新话题填 title，转到已有话题填 topic。");

    // title 和 topic 都填
    const both = await tool.execute("mg-both", { groupId: group.id, title: "新名", topic: myTopic.id, note: "补充说明" }, undefined, undefined, undefined as never);
    expect((both as { isError?: boolean }).isError).toBe(true);
    expect(resultText(both)).toBe("title 和 topic 只能填一个：创建新话题填 title，转到已有话题填 topic。");

    // 不是自己交出去的话题（综合开的 / 别人交的）
    const notMine1 = await tool.execute("mg-nm1", { groupId: group.id, topic: generalTopic.id, note: "补一句" }, undefined, undefined, undefined as never);
    expect((notMine1 as { isError?: boolean }).isError).toBe(true);
    expect(resultText(notMine1)).toBe(`「${generalTopic.id}」不是你交给这个群的话题。你交给这个群的话题：备份迁移（${myTopic.id}）`);

    const notMine2 = await tool.execute("mg-nm2", { groupId: group.id, topic: otherTopic.id, note: "补一句" }, undefined, undefined, undefined as never);
    expect((notMine2 as { isError?: boolean }).isError).toBe(true);
    expect(resultText(notMine2)).toBe(`「${otherTopic.id}」不是你交给这个群的话题。你交给这个群的话题：备份迁移（${myTopic.id}）`);

    // cwd 空串放行
    const cwdEmpty = await tool.execute("mg-c1", { groupId: group.id, topic: myTopic.id, note: "空 cwd", cwd: "" }, undefined, undefined, undefined as never);
    expect((cwdEmpty as { isError?: boolean }).isError).toBeUndefined();

    // cwd 同值放行
    const cwdSame = await tool.execute("mg-c2", { groupId: group.id, topic: myTopic.id, note: "同 cwd", cwd: dirA }, undefined, undefined, undefined as never);
    expect((cwdSame as { isError?: boolean }).isError).toBeUndefined();

    // cwd 换成别的目录报错
    const cwdDiff = await tool.execute("mg-c3", { groupId: group.id, topic: myTopic.id, note: "改 cwd", cwd: dirB }, undefined, undefined, undefined as never);
    expect((cwdDiff as { isError?: boolean }).isError).toBe(true);
    expect(resultText(cwdDiff)).toContain("创建时就定了，不能改");
  });
});

describe("nowBlock handed-over topics and shared pending work check", () => {
  it("lists only open topics handed over from the current session in nowBlock, hasPendingWork, and todosBusy", async () => {
    const hob = createHob();
    addAssistant(hob, "coord", "统筹助手", "统筹", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });
    addAssistant(hob, "ops", "运维助手", "运维");
    const { topic: topicA } = await hob.runtime.assistantTopics.create("coord", { title: "项目甲", createdBy: "user" });
    const { topic: topicB } = await hob.runtime.assistantTopics.create("coord", { title: "项目乙", createdBy: "user" });
    const group = hob.runtime.groups.create({ name: "数据迁移小组", purpose: "迁移", members: ["ops"], ownerId: "ops" });

    // 主对话交出去的（未关）
    const { topic: mainHanded } = hob.runtime.groups.handOver(group.id, "主线迁移", "coord", { text: "办主线", files: [] });
    // 主对话交出去的（已关）
    const { topic: mainClosed } = hob.runtime.groups.handOver(group.id, "已完成迁移", "coord", { text: "旧事", files: [] });
    hob.runtime.groups.closeByOwner(mainClosed.id, "完成了");
    // 话题 A 交出去的（未关）
    const { topic: topicAHanded } = hob.runtime.groups.handOver(group.id, "甲项子迁移", "coord", { text: "办甲", files: [], fromTopicId: topicA.id });
    // 别的助手交出去的（未关）
    hob.runtime.groups.handOver(group.id, "主助手的事", "hob", { text: "办别的事", files: [] });

    // coord 主对话：只列 mainHanded，不列 mainClosed / topicAHanded / hob 的
    const mainNow = nowBlock(hob.runtime, "coord");
    expect(mainNow).toMatch(/交给群的：群「数据迁移小组」话题「主线迁移」，\d{2}:\d{2} 起/);
    expect(mainNow).not.toContain("已完成迁移");
    expect(mainNow).not.toContain("甲项子迁移");
    expect(mainNow).not.toContain("主助手的事");
    expect(hob.runtime.router.hasPendingWork("coord")).toBe(true);
    expect(todosBusy(hob.runtime, "coord")).toBe(true);

    // coord 话题 A：只列 topicAHanded
    const topicANow = nowBlock(hob.runtime, "coord", { topicId: topicA.id });
    expect(topicANow).toMatch(/交给群的：群「数据迁移小组」话题「甲项子迁移」，\d{2}:\d{2} 起/);
    expect(topicANow).not.toContain("主线迁移");
    expect(hob.runtime.router.hasPendingWork("coord", { topicId: topicA.id })).toBe(true);
    expect(todosBusy(hob.runtime, "coord", { topicId: topicA.id })).toBe(true);

    // coord 话题 B：没有交出去的话题
    const topicBNow = nowBlock(hob.runtime, "coord", { topicId: topicB.id });
    expect(topicBNow).not.toContain("交给群的：");
    expect(hob.runtime.router.hasPendingWork("coord", { topicId: topicB.id })).toBe(false);
    expect(todosBusy(hob.runtime, "coord", { topicId: topicB.id })).toBe(false);

    // 关闭 mainHanded 后，主对话不再列出也不再 busy
    hob.runtime.groups.closeByOwner(mainHanded.id, "主线办完");
    expect(nowBlock(hob.runtime, "coord")).not.toContain("交给群的：");
    expect(hob.runtime.router.hasPendingWork("coord")).toBe(false);
    expect(todosBusy(hob.runtime, "coord")).toBe(false);

    // 关闭 topicAHanded 后，话题 A 也不再列出
    hob.runtime.groups.closeByOwner(topicAHanded.id, "甲项办完");
    expect(nowBlock(hob.runtime, "coord", { topicId: topicA.id })).not.toContain("交给群的：");
    expect(hob.runtime.router.hasPendingWork("coord", { topicId: topicA.id })).toBe(false);
    expect(todosBusy(hob.runtime, "coord", { topicId: topicA.id })).toBe(false);
  });
});

describe("report_back prompt sections A1/A2/B/C", () => {
  it("injects A1, A2, B, and C only into their designated sessions", async () => {
    const hob = createHob();
    addAssistant(hob, "owner", "策划助手", "统筹");
    addAssistant(hob, "member", "后勤助手", "执行");
    addAssistant(hob, "writer", "写作助手", "写作", { topics: { enabledAt: "2026-11-26T00:00:00.000Z" } });

    const group = hob.runtime.groups.create({ name: "活动群", purpose: "筹备", members: ["owner", "member"], ownerId: "owner" });
    const generalTopic = hob.runtime.groups.createTopic(group.id, "场地布置", "owner");
    const { topic: handedTopic } = hob.runtime.groups.handOver(group.id, "备份迁移", "hob", { text: "迁移", files: [] });
    const { topic: writerTopic } = await hob.runtime.assistantTopics.create("writer", { title: "第三章", createdBy: "user" });

    const baseSettings = { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const };

    // A1: 综合开的群话题，只给群主
    const ownerGeneralTopicPrompt = buildSystemPrompt(hob.runtime.store, "owner", { ...baseSettings, group: hob.runtime.store.group(generalTopic.id) });
    expect(ownerGeneralTopicPrompt).toContain(GROUP_TOPIC_REPORT_BACK_LINE);
    expect(ownerGeneralTopicPrompt).not.toContain(ONE_ON_ONE_REPORT_BACK_LINE);

    // 普通成员在群话题里不给 A1 / A2
    const memberTopicPrompt = buildSystemPrompt(hob.runtime.store, "member", { ...baseSettings, group: hob.runtime.store.group(generalTopic.id) });
    expect(memberTopicPrompt).not.toContain(GROUP_TOPIC_REPORT_BACK_LINE);
    expect(memberTopicPrompt).not.toContain("report_back");

    // 综合里的群主不给 A1 / A2
    const ownerGeneralPrompt = buildSystemPrompt(hob.runtime.store, "owner", { ...baseSettings, group: hob.runtime.store.group(group.id) });
    expect(ownerGeneralPrompt).not.toContain(GROUP_TOPIC_REPORT_BACK_LINE);
    expect(ownerGeneralPrompt).not.toContain("report_back");

    // A2: 主助手交来的群话题，只给群主，替换 A1
    const ownerHandedPrompt = buildSystemPrompt(hob.runtime.store, "owner", { ...baseSettings, group: hob.runtime.store.group(handedTopic.id) });
    expect(ownerHandedPrompt).toContain(groupTopicHandoverReportBackLine("Hob"));
    expect(ownerHandedPrompt).not.toContain(GROUP_TOPIC_REPORT_BACK_LINE);

    const memberHandedPrompt = buildSystemPrompt(hob.runtime.store, "member", { ...baseSettings, group: hob.runtime.store.group(handedTopic.id) });
    expect(memberHandedPrompt).not.toContain("report_back");

    // B: 助手话题，给 B，不混入 C
    const writerTopicPrompt = buildSystemPrompt(hob.runtime.store, "writer", { ...baseSettings, topicId: writerTopic.id });
    expect(writerTopicPrompt).toContain(ASSISTANT_TOPIC_REPORT_BACK_LINE);
    expect(writerTopicPrompt).not.toContain(ONE_ON_ONE_REPORT_BACK_LINE);

    // C: 非主助手单聊 / 主对话，给 C，不给 B
    const writerMainPrompt = buildSystemPrompt(hob.runtime.store, "writer", baseSettings);
    expect(writerMainPrompt).toContain(ONE_ON_ONE_REPORT_BACK_LINE);
    expect(writerMainPrompt).not.toContain(ASSISTANT_TOPIC_REPORT_BACK_LINE);

    // 主助手单聊：不给 C
    const hobPrompt = buildSystemPrompt(hob.runtime.store, "hob", baseSettings);
    expect(hobPrompt).not.toContain("report_back");
  });
});
