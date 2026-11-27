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
  it("并行任务收紧：有在跑任务时用户新消息仍推，后台正常回流抑制，全部收口与失败/受阻回流照推", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const push = vi.spyOn(hob.runtime.push, "send").mockResolvedValue({ sent: 1, removed: 0 });
      const group = hob.runtime.groups.create({ name: "研发组", purpose: "开发", ownerId: "hob", members: ["hob"] });
      const topic = hob.runtime.groups.createTopic(group.id, "修复推送", "user");

      // 话题内已有运行中的长任务 A
      const jobA = runningJob("t-long-a", "hob", topic.id);
      hob.runtime.store.saveJob(jobA);

      // 1. 用户新发一条消息，群主直接答复（未分派新任务）-> 照常推送
      hob.faux.setResponses([text("可以先合并这个改动。")]);
      hob.runtime.groups.send(topic.id, { text: "这个改动现在能合并吗？" });
      await waitFor(() => push.mock.calls.length === 1);
      expect(push.mock.calls[0]).toEqual([
        expect.objectContaining({ title: "修复推送", body: "可以先合并这个改动。", url: `/#/group/${topic.id}` }),
        `group:${topic.id}`,
      ]);

      // 2. 并行任务 B 正常完成回流（任务 A 仍在 running）-> 不推中间进度播报
      const beforeMid = hob.faux.state.callCount;
      hob.faux.setResponses([text("任务 B 已完成，还在等任务 A。")]);
      await hob.runtime.router.event("hob", "任务 B 已完成", { workDone: true }, { groupId: topic.id });
      await waitFor(() => hob.faux.state.callCount > beforeMid && hob.runtime.router.busyMembers(topic.id).length === 0);
      expect(push).toHaveBeenCalledTimes(1);

      // 3. 并行任务 C 失败/受阻回流（任务 A 仍在 running），群主直接回报问题未重试 -> 照常推送
      hob.faux.setResponses([text("任务 C 执行受阻，需要检查凭证。")]);
      await hob.runtime.router.event("hob", "任务 C 受阻", { workDone: true, urgent: true }, { groupId: topic.id });
      await waitFor(() => push.mock.calls.length === 2);
      expect(push.mock.calls[1]).toEqual([
        expect.objectContaining({ title: "修复推送", body: "任务 C 执行受阻，需要检查凭证。" }),
        `group:${topic.id}`,
      ]);

      // 4. 并行任务 C 失败回流但群主派了新任务重试 -> 不推过渡语
      vi.spyOn(hob.runtime.jobs, "start").mockResolvedValueOnce(runningJob("t-retry", "hob", topic.id));
      const beforeRetry = hob.faux.state.callCount;
      hob.faux.setResponses([
        fauxAssistantMessage([fauxText("我重新发起一次重试。"), fauxToolCall("start_job", { title: "重试任务 C", note: "重新执行" })]),
        text("已重试。"),
      ]);
      await hob.runtime.router.event("hob", "任务 C 失败", { workDone: true, urgent: true }, { groupId: topic.id });
      await waitFor(() => hob.faux.state.callCount > beforeRetry && hob.runtime.router.busyMembers(topic.id).length === 0);
      expect(push).toHaveBeenCalledTimes(2);

      // 5. 所有在跑任务全部结束，最后一次收口汇报 -> 照常推送
      hob.runtime.store.saveJob({ ...jobA, status: "done", endedAt: new Date().toISOString() });
      hob.faux.setResponses([text("全部任务已完成，可以验收。")]);
      await hob.runtime.router.event("hob", "任务 A 已完成", { workDone: true }, { groupId: topic.id });
      await waitFor(() => push.mock.calls.length === 3);
      expect(push.mock.calls[2]).toEqual([
        expect.objectContaining({ title: "修复推送", body: "全部任务已完成，可以验收。" }),
        `group:${topic.id}`,
      ]);
    } finally {
      hob.close();
    }
  });

  it("单聊并行任务与未结转交收紧：未全部收口不推中间播报，用户新消息/失败回流/全部收口照推", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const push = vi.spyOn(hob.runtime.push, "send").mockResolvedValue({ sent: 1, removed: 0 });
      const jobA = runningJob("t-dm-a", "hob");
      hob.runtime.store.saveJob(jobA);

      // 1. 单聊有在跑任务时，后台完成回流不推中间播报
      hob.faux.setResponses([text("子任务 B 先跑完了，继续等 A。")]);
      await hob.runtime.router.event("hob", "子任务 B 已完成", { workDone: true });
      await hob.runtime.router.waitIdle("hob");
      expect(push).not.toHaveBeenCalled();

      // 2. 用户主动发消息 -> 即使任务 A 仍在 running，直接答复照推
      hob.faux.setResponses([text("目前已完成一半，预计 5 分钟。")]);
      await hob.runtime.router.send("hob", { text: "现在进度如何？" });
      await hob.runtime.router.waitIdle("hob");
      expect(push).toHaveBeenCalledTimes(1);
      expect(push.mock.calls[0]?.[0]).toMatchObject({ title: "Hob", body: "目前已完成一半，预计 5 分钟。" });

      // 3. 失败/受阻回流（urgent=true）即使任务 A 仍在 running 也照推
      hob.faux.setResponses([text("部署任务失败：缺少密钥。")]);
      await hob.runtime.router.event("hob", "部署任务失败", { workDone: true, urgent: true });
      await hob.runtime.router.waitIdle("hob");
      expect(push).toHaveBeenCalledTimes(2);
      expect(push.mock.calls[1]?.[0]).toMatchObject({ title: "Hob", body: "部署任务失败：缺少密钥。" });

      // 4. 任务 A 收口但仍有未结转交 -> 不推；转交也结束后 -> 推送
      hob.runtime.store.saveJob({ ...jobA, status: "done", endedAt: new Date().toISOString() });
      addAssistant(hob, "dev", "开发", "写代码");
      hob.runtime.store.saveDelegation({
        id: "dg-open",
        from: "hob",
        to: "dev",
        text: "帮忙排查",
        createdAt: new Date().toISOString(),
        status: "running",
        jobIds: [],
        approvalIds: [],
      });
      hob.faux.setResponses([text("任务 A 完了，还在等开发那边结果。")]);
      await hob.runtime.router.event("hob", "任务 A 已完成", { workDone: true });
      await hob.runtime.router.waitIdle("hob");
      expect(push).toHaveBeenCalledTimes(2);

      // 转交完成后回流 -> 无剩余活跃任务/转交，最终结论正常推送
      hob.runtime.store.saveDelegation({
        id: "dg-open",
        from: "hob",
        to: "dev",
        text: "帮忙排查",
        createdAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        status: "done",
        jobIds: [],
        approvalIds: [],
      });
      hob.faux.setResponses([text("全部排查完毕，问题已定位。")]);
      await hob.runtime.router.delegationResult("hob", "dg-open", "转交给「开发」的事已结束：已定位");
      await hob.runtime.router.waitIdle("hob");
      expect(push).toHaveBeenCalledTimes(3);
      expect(push.mock.calls[2]?.[0]).toMatchObject({ title: "Hob", body: "全部排查完毕，问题已定位。" });
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

  it("话题与转交路径：open_topic、转已有话题、hand_back 推送；群 @ 接力中间轮不推、下游全 NO_REPLY 补推、超限仅推收尾", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const push = vi.spyOn(hob.runtime.push, "send").mockResolvedValue({ sent: 1, removed: 0 });
      addAssistant(hob, "ops", "运维", "服务器");
      addAssistant(hob, "dev", "开发", "写代码");
      const group = hob.runtime.groups.create({ name: "运维组", purpose: "运维", ownerId: "hob", members: ["hob", "ops", "dev"] });

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

      // 3. 非主助手 hand_back 交回主助手，主助手直接回复 -> 推送
      hob.faux.setResponses([
        call("hand_back", { text: "帮我写一封邮件", reason: "这归主助手处理" }),
        text("邮件草稿已经写好了。"),
      ]);
      await hob.runtime.router.send("ops", { text: "帮我写一封邮件" });
      await waitFor(() => push.mock.calls.length === 3);
      expect(push.mock.calls[2]).toEqual([
        expect.objectContaining({ title: "Hob", body: "邮件草稿已经写好了。", url: "/?a=hob" }),
        "assistant:hob",
      ]);

      // 4. 群内 @ 接力中间轮不推，仅最终收口轮推送 1 次
      const beforeChain = push.mock.calls.length;
      hob.faux.setResponses([
        text("我先核对配置，@运维 你查一下机器日志。"),
        text("日志看完了，@开发 你确认下代码逻辑。"),
        text("代码已确认，根因是超时参数过短，现已修复。"),
      ]);
      hob.runtime.groups.send(createdTopic.id, { text: "帮我联合排查超时" });
      await waitFor(() => push.mock.calls.length === beforeChain + 1 && hob.runtime.groups.summary(createdTopic.id).busy.length === 0);
      expect(push.mock.calls.slice(beforeChain)).toEqual([
        [
          expect.objectContaining({ title: "磁盘清理", body: "代码已确认，根因是超时参数过短，现已修复。" }),
          `group:${createdTopic.id}`,
        ],
      ]);

      // 5. 上游有实质回复并 @ 下游，但下游全部 NO_REPLY -> 整波结束时补推上游实质回复
      const beforeFallback = push.mock.calls.length;
      const beforeFallbackCalls = hob.faux.state.callCount;
      hob.faux.setResponses([
        text("我已经把限流阈值调好了，@运维 @开发 如有补充再说。"),
        text("NO_REPLY"),
        text("NO_REPLY"),
      ]);
      hob.runtime.groups.send(createdTopic.id, { text: "调一下限流阈值" });
      await waitFor(
        () => hob.faux.state.callCount >= beforeFallbackCalls + 3 && hob.runtime.groups.summary(createdTopic.id).busy.length === 0 && push.mock.calls.length === beforeFallback + 1,
      );
      expect(push.mock.calls.slice(beforeFallback)).toEqual([
        [
          expect.objectContaining({ title: "磁盘清理", body: "我已经把限流阈值调好了，@运维 @开发 如有补充再说。" }),
          `group:${createdTopic.id}`,
        ],
      ]);

      // 6. 上游 @ 下游，下游调用 start_job 派发任务 -> 不回退推送上游 @ 过渡语
      const beforeDispatchRelay = push.mock.calls.length;
      const beforeDispatchCalls = hob.faux.state.callCount;
      vi.spyOn(hob.runtime.jobs, "start").mockResolvedValueOnce(runningJob("t-relay-job", "ops", createdTopic.id));
      hob.faux.setResponses([
        text("@运维 跑一下全量巡检脚本。"),
        fauxAssistantMessage([fauxText("好的，我开后台任务跑。"), fauxToolCall("start_job", { title: "全量巡检", note: "跑巡检" })]),
        text("已启动。"),
      ]);
      hob.runtime.groups.send(createdTopic.id, { text: "跑一下全量巡检" });
      await waitFor(() => hob.faux.state.callCount >= beforeDispatchCalls + 2 && hob.runtime.groups.summary(createdTopic.id).busy.length === 0);
      expect(push).toHaveBeenCalledTimes(beforeDispatchRelay);

      // 7. 群 @ 接力达到 MAX_WAVE_TURNS 上限后：中间轮全部不推，仅推群主收尾 1 次
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
        push.mock.calls.slice(beforeRelay).some(([payload]) => payload.body === "接力已到上限，这里给出最终汇总。") &&
        hob.runtime.groups.summary(relayGroup.id).busy.length === 0,
      );
      expect(push.mock.calls.slice(beforeRelay)).toEqual([
        [
          expect.objectContaining({ title: "接力群", body: "接力已到上限，这里给出最终汇总。" }),
          `group:${relayGroup.id}`,
        ],
      ]);
    } finally {
      hob.close();
    }
  });

  it("主助手 message_group 委托话题收紧：关闭前不推纯文字内部沟通，确认卡/报错/用户亲自发言照推，关闭后由委托方推最终结论", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const push = vi.spyOn(hob.runtime.push, "send").mockResolvedValue({ sent: 1, removed: 0 });
      addAssistant(hob, "ops", "运维", "服务器");
      const group = hob.runtime.groups.create({ name: "运维组", purpose: "运维", ownerId: "hob", members: ["hob", "ops"] });

      // 1. 主助手 message_group 委托群办，群主内部接力并给出纯文字沟通 -> 未关闭前均不推送
      hob.faux.setResponses([
        call("message_group", { groupId: group.id, title: "端口排查", note: "排查 8080 端口占用" }),
        text("@运维 先帮我查下 8080 进程。"),
        text("查到了，是测试脚本占用了 8080，先汇报给群主。"),
        text("收到，准备整理结论。"),
      ]);
      await hob.runtime.router.send("hob", { text: "让运维组查下 8080" });
      await waitFor(() => hob.runtime.groups.activeTopics(group.id).length === 1);
      const handoverTopic = hob.runtime.groups.activeTopics(group.id)[0]!;
      await waitFor(() => hob.faux.state.callCount >= 4 && hob.runtime.groups.summary(handoverTopic.id).busy.length === 0);
      expect(push).not.toHaveBeenCalled();

      // 2. 例外 1：委托话题内群成员发出 ask_user 确认卡 -> 照常推送
      hob.faux.setResponses([
        call("ask_user", {
          title: "是否立即终止 8080 进程？",
          detail: "终止后测试服务将下线",
          options: [{ label: "终止" }, { label: "先保留" }],
        }),
        text("等待你确认。"),
      ]);
      await hob.runtime.groups.deliverEvent(handoverTopic.id, "ops", "需要用户确认是否终止进程");
      await waitFor(() => push.mock.calls.length === 1);
      expect(push.mock.calls[0]).toEqual([
        expect.objectContaining({ title: "是否立即终止 8080 进程？", body: "运维 · 等待你的回答", url: `/#/group/${handoverTopic.id}` }),
        `group:${handoverTopic.id}`,
      ]);

      // 3. 例外 3a：用户答复该确认卡（answerEvent）-> 针对用户这一轮的回复照常推送
      hob.faux.setResponses([text("收到，先保留 8080 进程。")]);
      await hob.runtime.router.answerEvent("ops", "用户选择了「先保留」", { groupId: handoverTopic.id });
      await waitFor(() => push.mock.calls.length === 2);
      expect(push.mock.calls[1]).toEqual([
        expect.objectContaining({ title: "端口排查", body: "收到，先保留 8080 进程。" }),
        `group:${handoverTopic.id}`,
      ]);

      // 4. 例外 3b：用户本人主动进入委托话题发消息 -> 回复照常推送
      hob.faux.setResponses([text("目前 8080 是 dev-server 在用。")]);
      hob.runtime.groups.send(handoverTopic.id, { text: "具体是哪个进程？" });
      await waitFor(() => push.mock.calls.length === 3);
      expect(push.mock.calls[2]).toEqual([
        expect.objectContaining({ title: "端口排查", body: "目前 8080 是 dev-server 在用。" }),
        `group:${handoverTopic.id}`,
      ]);

      // 5. 例外 2：委托话题内群成员执行报错 -> 照常推送失败通知
      vi.spyOn(hob.runtime.router, "deliverMember").mockRejectedValueOnce(new Error("模型超时"));
      await hob.runtime.groups.deliverEvent(handoverTopic.id, "ops", "继续检查端口");
      await waitFor(() => push.mock.calls.length === 4);
      expect(push.mock.calls[3]).toEqual([
        expect.objectContaining({ title: "端口排查", body: "执行失败：模型超时" }),
        `group:${handoverTopic.id}`,
      ]);

      // 6. 例外 3c：委托话题内成员正在进行内部回合时，用户中途插话（steer）-> 回复照常推送
      let releaseSteer = () => {};
      const steerGate = new Promise<void>((resolve) => { releaseSteer = resolve; });
      const beforeSteerCalls = hob.faux.state.callCount;
      hob.faux.setResponses([
        async () => { await steerGate; return text("收到你在委托话题里的插话，正在核对端口监听。"); },
        text("收到你在委托话题里的插话，正在核对端口监听。"),
      ]);
      const internalTurn = hob.runtime.groups.deliverEvent(handoverTopic.id, "ops", "内部继续排查");
      await waitFor(() => hob.faux.state.callCount > beforeSteerCalls);
      const steered = await hob.runtime.router.steerMember(handoverTopic.id, "ops", "顺便告诉我监听地址是 0.0.0.0 吗？");
      expect(steered).toBe(true);
      releaseSteer();
      await internalTurn;
      await waitFor(() => push.mock.calls.length === 5);
      expect(push.mock.calls[4]).toEqual([
        expect.objectContaining({ title: "端口排查", body: "收到你在委托话题里的插话，正在核对端口监听。" }),
        `group:${handoverTopic.id}`,
      ]);

      // 7. 群主关闭委托话题并提交结论：群话题内不推，deliverHandover -> Hob 汇报最终结论只推 1 次
      hob.faux.setResponses([
        call("close_topic", { note: "8080 端口由 dev-server 占用，已按用户要求保留。" }),
        text("运维组排查完成：8080 端口由 dev-server 占用，已为你保留。"),
      ]);
      await hob.runtime.groups.deliverEvent(handoverTopic.id, "hob", "排查结束，可以关闭话题");
      await waitFor(() => push.mock.calls.length === 6 && !hob.runtime.router.isBusy("hob"));
      expect(push.mock.calls.slice(5)).toEqual([
        [
          expect.objectContaining({ title: "Hob", body: "运维组排查完成：8080 端口由 dev-server 占用，已为你保留。", url: "/?a=hob" }),
          "assistant:hob",
        ],
      ]);
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

      // 4. send_card 发纯展示卡片且模型随后回 NO_REPLY -> 不挂 👀、不隐藏推送，仍用卡片标题推送
      hob.faux.setResponses([
        call("send_card", { markdown: "# 四家供应商比价\n\n华盛包装综合最划算" }),
        text("NO_REPLY"),
      ]);
      const sent = await hob.runtime.router.send("hob", { text: "给我发比价卡片" });
      await hob.runtime.router.waitIdle("hob");
      expect(push).toHaveBeenCalledTimes(4);
      expect(push.mock.calls[3]).toEqual([
        expect.objectContaining({ title: "Hob", body: "四家供应商比价", url: "/?a=hob" }),
        "assistant:hob",
      ]);
      const userItem = hob.runtime.router.items("hob").items.find((item) => item.id === sent.id);
      expect(userItem?.kind === "user" ? userItem.reactions : undefined).toBeUndefined();

      // 5. 群聊 send_card 发纯展示卡片且模型随后回 NO_REPLY -> 不挂 👀、群波次照常推送卡片标题
      const grp = hob.runtime.groups.create({ name: "比价群", purpose: "比价", ownerId: "hob", members: ["hob"] });
      hob.faux.setResponses([
        call("send_card", { markdown: "# 采购对账结果\n\n28 笔已核对" }),
        text("NO_REPLY"),
      ]);
      const groupSent = await hob.runtime.groups.send(grp.id, { text: "把对账结果发一下" });
      await waitFor(() => hob.runtime.groups.summary(grp.id).busy.length === 0 && push.mock.calls.length === 5);
      expect(push.mock.calls[4]).toEqual([
        expect.objectContaining({ title: "比价群", body: "采购对账结果", url: `/#/group/${grp.id}` }),
        `group:${grp.id}`,
      ]);
      const groupUser = hob.runtime.groups.items(grp.id).items.find((item) => item.id === (groupSent as { id: string }).id);
      expect(groupUser?.kind === "user" ? groupUser.reactions : undefined).toBeUndefined();
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

  it("真实后台任务 finish 联动：并行任务存在时 done 回流抑制、stuck 回流照推", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const push = vi.spyOn(hob.runtime.push, "send").mockResolvedValue({ sent: 1, removed: 0 });
      // 预置一个仍在跑的并行长任务
      hob.runtime.store.saveJob(runningJob("t-parallel-keep", "hob"));

      // 1. 真实任务 1 正常 done -> 回流到 Hob，因仍有 t-parallel-keep 在跑，不推中间播报
      hob.faux.setResponses([
        call("report", { outcome: "done", result: "子检查已通过" }),
        text("已交结果。"),
        text("子检查已通过，还在等另一个任务。"),
      ]);
      const doneJob = await hob.runtime.jobs.start("hob", { title: "子检查", instruction: "跑子检查" });
      await waitFor(() => hob.runtime.store.job(doneJob.id)?.status === "done");
      await waitFor(() => hob.faux.state.callCount >= 3 && !hob.runtime.router.isBusy("hob"));
      expect(push).not.toHaveBeenCalled();

      // 2. 真实任务 2 受阻 stuck -> jobs.finish 标 urgent=true，回流到 Hob 未重试 -> 照常推送
      const beforeStuck = hob.faux.state.callCount;
      hob.faux.setResponses([
        call("report", { outcome: "stuck", result: "缺少发布凭据，无法继续" }),
        text("已报告受阻。"),
        text("发布任务受阻：缺少发布凭据，需要你补充。"),
      ]);
      const stuckJob = await hob.runtime.jobs.start("hob", { title: "发布任务", instruction: "执行发布" });
      await waitFor(() => hob.runtime.store.job(stuckJob.id)?.status === "stuck");
      await waitFor(() => hob.faux.state.callCount >= beforeStuck + 3 && push.mock.calls.length === 1);
      expect(push.mock.calls[0]).toEqual([
        expect.objectContaining({ title: "Hob", body: "发布任务受阻：缺少发布凭据，需要你补充。", url: "/?a=hob" }),
        "assistant:hob",
      ]);
    } finally {
      hob.close();
    }
  });
});
