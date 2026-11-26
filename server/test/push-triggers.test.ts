import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Assistant, Job } from "../../shared/types.ts";
import { MAX_WAVE_TURNS } from "../src/groups.ts";
import { call, makeHob, text, waitFor, type TestHob } from "./helpers.ts";

function addAssistant(hob: TestHob, id: string, name: string, duty = name): Assistant {
  const base = hob.runtime.store.assistant("hob")!;
  const assistant: Assistant = { ...base, id, name, duty, primary: false, pinned: false, notify: true, sprite: "page" };
  hob.runtime.store.saveAssistant(assistant);
  return assistant;
}

function runningJob(id: string, assistantId: string, groupId?: string): Job {
  return {
    id,
    assistantId,
    ...(groupId ? { groupId } : {}),
    title: `任务 ${id}`,
    instruction: "执行任务",
    status: "running",
    createdAt: new Date().toISOString(),
    stats: { reads: 0, commands: 0, edits: 0 },
    activity: [],
  };
}

describe("推送触发全路径回归", () => {
  it("群话题有 running 长任务时，用户新消息直接答复与并行任务先完成汇报均触发推送", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const push = vi.spyOn(hob.runtime.push, "send").mockResolvedValue({ sent: 1, removed: 0 });
      const group = hob.runtime.groups.create({ name: "研发组", purpose: "开发", ownerId: "hob", members: ["hob"] });
      const topic = hob.runtime.groups.createTopic(group.id, "修复推送", "user");

      // 话题内已有运行中的长任务 A
      hob.runtime.store.saveJob(runningJob("t-long-a", "hob", topic.id));

      // 用户新发一条消息，群主直接答复（未派新任务）-> 推送
      hob.faux.setResponses([text("可以先合并这个改动。")]);
      hob.runtime.groups.send(topic.id, { text: "这个改动现在能合并吗？" });
      await waitFor(() => push.mock.calls.length === 1);
      expect(push.mock.calls[0]).toEqual([
        expect.objectContaining({ title: "修复推送", body: "可以先合并这个改动。", url: `/#/group/${topic.id}` }),
        `group:${topic.id}`,
      ]);

      // 并行任务 B 先完成回报（任务 A 仍在 running），群主直接汇报 -> 推送
      hob.faux.setResponses([text("任务 B 已完成，测试全过。")]);
      await hob.runtime.router.event("hob", "任务 B 已完成", { workDone: true }, topic.id);
      await waitFor(() => push.mock.calls.length === 2);
      expect(push.mock.calls[1]).toEqual([
        expect.objectContaining({ title: "修复推送", body: "任务 B 已完成，测试全过。" }),
        `group:${topic.id}`,
      ]);
    } finally {
      hob.close();
    }
  });

  it("派活不误推：用户发消息后助手回复过渡语并调用 start_job 时不推过渡语", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const push = vi.spyOn(hob.runtime.push, "send").mockResolvedValue({ sent: 1, removed: 0 });
      vi.spyOn(hob.runtime.jobs, "start").mockResolvedValueOnce(runningJob("t-dispatched", "hob"));
      hob.faux.setResponses([
        fauxAssistantMessage([fauxText("我派后台任务去查。"), fauxToolCall("start_job", { title: "查监控", note: "查一下监控指标" })]),
        text("已派任务。"),
      ]);
      await hob.runtime.router.send("hob", { text: "查一下监控" });
      await hob.runtime.router.waitIdle("hob");
      expect(push).not.toHaveBeenCalled();
    } finally {
      hob.close();
    }
  });

  it("定时任务三条路径（单聊 handToAssistant、群聊 handOff、单聊与群聊 check.then=notify）均触发推送", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const push = vi.spyOn(hob.runtime.push, "send").mockResolvedValue({ sent: 1, removed: 0 });
      const group = hob.runtime.groups.create({ name: "值班群", purpose: "巡检", ownerId: "hob", members: ["hob"] });

      // 1. 单聊定时 handToAssistant 直接回复
      const dmRoutine = hob.runtime.routines.create({
        assistantId: "hob",
        name: "每日早报",
        instruction: "汇总今日待办",
        schedules: ["0 9 * * *"],
      });
      hob.faux.setResponses([text("今天有 2 项待办。")]);
      await hob.runtime.routines.runNow(dmRoutine.id);
      await hob.runtime.router.waitIdle("hob");
      expect(push).toHaveBeenCalledTimes(1);
      expect(push.mock.calls[0]).toEqual([
        expect.objectContaining({ title: "Hob", body: "今天有 2 项待办。", url: "/?a=hob" }),
        "assistant:hob",
      ]);

      // 2. 群聊定时 handOff 直接回复
      const groupRoutine = hob.runtime.routines.create({
        assistantId: "hob",
        groupId: group.id,
        name: "群巡检",
        instruction: "汇报集群状态",
        schedules: ["0 10 * * *"],
      });
      hob.faux.setResponses([text("集群状态正常。")]);
      await hob.runtime.routines.runNow(groupRoutine.id);
      await waitFor(() => push.mock.calls.length === 2);
      expect(push.mock.calls[1]).toEqual([
        expect.objectContaining({ title: "值班群", body: "集群状态正常。", url: `/#/group/${group.id}` }),
        `group:${group.id}`,
      ]);

      // 3. 单聊 check.then === "notify" 命中
      const dmNotify = hob.runtime.routines.create({
        assistantId: "hob",
        name: "磁盘告警",
        instruction: "检查磁盘",
        schedules: ["*/10 * * * *"],
        check: { script: "echo '磁盘使用率 92%'", then: "notify" },
      });
      await hob.runtime.routines.runNow(dmNotify.id);
      expect(push).toHaveBeenCalledTimes(3);
      expect(push.mock.calls[2]).toEqual([
        expect.objectContaining({ title: "Hob", body: "磁盘使用率 92%", url: "/?a=hob" }),
        "assistant:hob",
      ]);

      // 4. 群聊 check.then === "notify" 命中
      const groupNotify = hob.runtime.routines.create({
        assistantId: "hob",
        groupId: group.id,
        name: "群告警",
        instruction: "检查服务",
        schedules: ["*/10 * * * *"],
        check: { script: "echo '节点 2 延迟升高'", then: "notify" },
      });
      await hob.runtime.routines.runNow(groupNotify.id);
      expect(push).toHaveBeenCalledTimes(4);
      expect(push.mock.calls[3]).toEqual([
        expect.objectContaining({ title: "值班群", body: "节点 2 延迟升高", url: `/#/group/${group.id}` }),
        `group:${group.id}`,
      ]);
    } finally {
      hob.close();
    }
  });

  it("话题与转交路径：open_topic、转已有话题、message_group、hand_back、群接力超限收尾均推送", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const push = vi.spyOn(hob.runtime.push, "send").mockResolvedValue({ sent: 1, removed: 0 });
      addAssistant(hob, "ops", "运维", "服务器");
      const group = hob.runtime.groups.create({ name: "运维组", purpose: "运维", ownerId: "hob", members: ["hob", "ops"] });

      // 1. open_topic 创建话题，群主首轮直接答复（综合这轮调了 open_topic 不推，话题内首轮答复推）
      hob.faux.setResponses([
        call("open_topic", { title: "磁盘清理", note: "需要清理旧日志" }),
        text("日志已经清理完成。"),
      ]);
      hob.runtime.groups.send(group.id, { text: "帮我清理磁盘" });
      await waitFor(() => push.mock.calls.length === 1);
      const createdTopic = hob.runtime.groups.activeTopics(group.id)[0]!;
      expect(push.mock.calls[0]).toEqual([
        expect.objectContaining({ title: "磁盘清理", body: "日志已经清理完成。", url: `/#/group/${createdTopic.id}` }),
        `group:${createdTopic.id}`,
      ]);

      // 2. 转到已有话题，群主直接回复 -> 推送
      hob.faux.setResponses([
        call("open_topic", { topic: createdTopic.id, note: "补充检查 /var/tmp" }),
        text("/var/tmp 也已清理干净。"),
      ]);
      hob.runtime.groups.send(group.id, { text: "顺便看下 /var/tmp" });
      await waitFor(() => push.mock.calls.length === 2);
      expect(push.mock.calls[1]).toEqual([
        expect.objectContaining({ title: "磁盘清理", body: "/var/tmp 也已清理干净。" }),
        `group:${createdTopic.id}`,
      ]);

      // 3. message_group 交群，群主首轮直接回复（未立即 close_topic）-> 推送
      hob.faux.setResponses([
        call("message_group", { groupId: group.id, title: "端口排查", note: "排查 8080 端口占用" }),
        text("已查明是测试进程占用 8080。"),
      ]);
      await hob.runtime.router.send("hob", { text: "让运维组查下 8080" });
      await waitFor(() => push.mock.calls.length === 3);
      expect(push.mock.calls[2]?.[0]).toMatchObject({ title: "端口排查", body: "已查明是测试进程占用 8080。" });

      // 4. 非主助手 hand_back 交回主助手，主助手直接回复 -> 推送
      hob.faux.setResponses([
        call("hand_back", { text: "帮我写一封邮件", reason: "这归主助手处理" }),
        text("邮件草稿已经写好了。"),
      ]);
      await hob.runtime.router.send("ops", { text: "帮我写一封邮件" });
      await waitFor(() => push.mock.calls.length === 4);
      expect(push.mock.calls[3]).toEqual([
        expect.objectContaining({ title: "Hob", body: "邮件草稿已经写好了。", url: "/?a=hob" }),
        "assistant:hob",
      ]);

      // 5. 群 @ 接力达到 MAX_WAVE_TURNS 上限后，群主收尾 -> 推送
      const relayGroup = hob.runtime.groups.create({ name: "接力群", purpose: "讨论", ownerId: "hob", members: ["hob", "ops"] });
      const beforeRelay = push.mock.calls.length;
      const responses = [];
      for (let i = 0; i < MAX_WAVE_TURNS; i += 1) {
        responses.push(text(i % 2 === 0 ? "@运维 继续看下" : "@Hob 你再确认下"));
      }
      responses.push(text("接力已到上限，这里给出最终汇总。"));
      hob.faux.setResponses(responses);
      hob.runtime.groups.send(relayGroup.id, { text: "开始讨论" });
      await waitFor(() =>
        push.mock.calls.slice(beforeRelay).some(([payload]) => payload.body === "接力已到上限，这里给出最终汇总。"),
      );
    } finally {
      hob.close();
    }
  });

  it("交互路径：answerEvent 回流推送、交互卡片推送且不重复、纯展示卡片标题兜底", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const push = vi.spyOn(hob.runtime.push, "send").mockResolvedValue({ sent: 1, removed: 0 });
      hob.runtime.store.saveJob(runningJob("t-bg", "hob"));

      // 1. answerEvent 回流后助手直接回复 -> 推送
      hob.faux.setResponses([text("已按你的选择执行完毕。")]);
      await hob.runtime.router.answerEvent("hob", "用户选择了 A");
      await hob.runtime.router.waitIdle("hob");
      expect(push).toHaveBeenCalledTimes(1);
      expect(push.mock.calls[0]).toEqual([
        expect.objectContaining({ title: "Hob", body: "已按你的选择执行完毕。" }),
        "assistant:hob",
      ]);

      // 2. send_card 发交互卡片（即使有 running 任务）-> 触发 pushInteractiveCard 且 finishTurn 不重复推第二条
      hob.faux.setResponses([
        fauxAssistantMessage([
          fauxText("请填写以下配置："),
          fauxToolCall("send_card", { markdown: "# 发布确认\n\n::button[确认发布]{primary}" }),
        ]),
      ]);
      await hob.runtime.router.send("hob", { text: "给我发确认卡" });
      await hob.runtime.router.waitIdle("hob");
      expect(push).toHaveBeenCalledTimes(2);
      expect(push.mock.calls[1]).toEqual([
        expect.objectContaining({ title: "发布确认", body: "Hob · 等待你的操作", url: "/?a=hob" }),
        "assistant:hob",
      ]);

      // 3. send_card 发纯展示卡片且模型无气泡文字 -> finishTurn 用卡片标题作为推送正文兜底
      hob.faux.setResponses([
        call("send_card", { markdown: "# 本周数据概览\n\n请求量增长 20%" }),
        text(""),
      ]);
      await hob.runtime.router.send("hob", { text: "发一张数据卡片" });
      await hob.runtime.router.waitIdle("hob");
      expect(push).toHaveBeenCalledTimes(3);
      expect(push.mock.calls[2]).toEqual([
        expect.objectContaining({ title: "Hob", body: "本周数据概览", url: "/?a=hob" }),
        "assistant:hob",
      ]);
    } finally {
      hob.close();
    }
  });

  it("workDone=false 任务提问轮：仅 reply_job 不推；用户中途 steer（群聊 steerMember 与单聊 send）后答复则推送", async () => {
    const hob = makeHob({}, { memory: "off" });
    let releaseGroup = () => {};
    let releaseDm = () => {};
    try {
      const push = vi.spyOn(hob.runtime.push, "send").mockResolvedValue({ sent: 1, removed: 0 });
      const group = hob.runtime.groups.create({ name: "插话群", purpose: "测试", ownerId: "hob", members: ["hob"] });

      // 1. 群聊 workDone=false 事件轮中途用户 steerMember 插话 -> 答复后推送
      const groupGate = new Promise<void>((resolve) => { releaseGroup = resolve; });
      hob.faux.setResponses([
        async () => { await groupGate; return text("先收到你的插话，这是直接答复。"); },
        text("先收到你的插话，这是直接答复。"),
      ]);
      const groupEvent = hob.runtime.groups.deliverEvent(group.id, "hob", "任务提问", "", false);
      await waitFor(() => hob.faux.state.callCount >= 1);
      const steered = await hob.runtime.router.steerMember(group.id, "hob", "顺便告诉我现在几点");
      expect(steered).toBe(true);
      releaseGroup();
      await groupEvent;
      expect(push).toHaveBeenCalledTimes(1);
      expect(push.mock.calls[0]).toEqual([
        expect.objectContaining({ title: "插话群", body: "先收到你的插话，这是直接答复。" }),
        `group:${group.id}`,
      ]);

      // 2. 单聊 workDone=false 事件轮中途用户 send() 走 steer -> 答复后推送
      const dmGate = new Promise<void>((resolve) => { releaseDm = resolve; });
      const beforeDmCalls = hob.faux.state.callCount;
      hob.faux.setResponses([
        async () => { await dmGate; return text("单聊插话已收到并答复。"); },
        text("单聊插话已收到并答复。"),
      ]);
      await hob.runtime.router.event("hob", "任务超时提醒", { workDone: false });
      await waitFor(() => hob.faux.state.callCount > beforeDmCalls);
      await hob.runtime.router.send("hob", { text: "顺便回答我一个问题" });
      releaseDm();
      await hob.runtime.router.waitIdle("hob");
      expect(push).toHaveBeenCalledTimes(2);
      expect(push.mock.calls[1]).toEqual([
        expect.objectContaining({ title: "Hob", body: "单聊插话已收到并答复。" }),
        "assistant:hob",
      ]);
    } finally {
      releaseGroup();
      releaseDm();
      hob.close();
    }
  });

  it("纯静默工具调用（仅 react 或仅 update_todos 无文字）不误推；fail() 与群 runTurn 前置异常触发失败推送", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const push = vi.spyOn(hob.runtime.push, "send").mockResolvedValue({ sent: 1, removed: 0 });

      // 1. 仅调用 update_todos 且未输出任何可见文字 -> 不推空洞的「已完成」
      hob.faux.setResponses([
        call("update_todos", { items: [{ text: "检查配置", status: "in_progress" }] }),
        text(""),
      ]);
      await hob.runtime.router.send("hob", { text: "记个待办" });
      await hob.runtime.router.waitIdle("hob");
      expect(push).not.toHaveBeenCalled();

      // 2. deliver/pushEventNow 抛异常进入 fail() -> 设置 turnFailure 并推送失败通知
      const state = await hob.runtime.router.ensure("hob");
      vi.spyOn(state.session!, "prompt").mockRejectedValueOnce(new Error("上游网关断开"));
      await hob.runtime.router.send("hob", { text: "会抛错的消息" });
      await hob.runtime.router.waitIdle("hob");
      expect(push).toHaveBeenCalledTimes(1);
      expect(push.mock.calls[0]).toEqual([
        expect.objectContaining({ title: "Hob", body: "执行失败：上游网关断开" }),
        "assistant:hob",
      ]);

      // 3. 群 runTurn 在 deliverMember 之前（如 ensure）抛错 -> 补充失败推送
      const group = hob.runtime.groups.create({ name: "异常群", purpose: "测试", ownerId: "hob", members: ["hob"] });
      vi.spyOn(hob.runtime.router, "deliverMember").mockRejectedValueOnce(new Error("会话打开失败"));
      hob.runtime.groups.send(group.id, { text: "触发群异常" });
      await waitFor(() => push.mock.calls.length === 2);
      expect(push.mock.calls[1]).toEqual([
        expect.objectContaining({ title: "异常群", body: "执行失败：会话打开失败", url: `/#/group/${group.id}` }),
        `group:${group.id}`,
      ]);
    } finally {
      hob.close();
    }
  });
});
