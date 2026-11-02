import { describe, expect, it, vi } from "vitest";
import type { Delegation, Job } from "../../shared/types.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import { answerApproval } from "../src/actions.ts";
import { call, makeHob, text, waitFor } from "./helpers.ts";

function setup() {
  const hob = makeHob();
  const primary = hob.runtime.store.assistant("hob")!;
  hob.runtime.store.saveAssistant({ ...primary, id: "ops", name: "服务器", primary: false });
  return hob;
}

function record(): Delegation {
  return { id: "dg-test", from: "hob", to: "ops", text: "检查", status: "running", createdAt: new Date().toISOString(), jobIds: [] };
}

function job(id: string, status: Job["status"]): Job {
  return { id, assistantId: "ops", title: id, instruction: "检查", status, createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [], delegationId: "dg-test" };
}

describe("交回 Hob", () => {
  it("只有非主助手有工具；普通回合写入双向定位条目并触发 Hob", async () => {
    const hob = setup();
    try {
      expect(buildRouterTools(hob.runtime, "hob").some((tool) => tool.name === "hand_back_to_hob")).toBe(false);
      const tool = buildRouterTools(hob.runtime, "ops").find((item) => item.name === "hand_back_to_hob")!;
      expect(tool).toBeDefined();
      hob.faux.setResponses([text("我来处理代理问题")]);
      const result = await tool.execute("call", { text: "检查代理", reason: "不负责代理" }) as { terminate?: boolean };
      expect(result.terminate).toBe(true);
      const forwarded = hob.runtime.router.items("hob").items.find((item) => item.kind === "user" && item.from?.assistantId === "ops");
      expect(forwarded).toMatchObject({ text: "检查代理", from: { assistantId: "ops", name: "服务器" } });
      const id = forwarded?.kind === "user" ? forwarded.from!.delegationId : "";
      expect(hob.runtime.router.items("ops").items).toContainEqual(expect.objectContaining({ kind: "note", text: "已交回 Hob：不负责代理", handbackId: id }));
      await waitFor(() => hob.faux.state.callCount > 0);
      await hob.runtime.router.waitIdle("hob");
    } finally { hob.close(); }
  });

  it("转交回合退回只回流一次，不额外创建转来消息", async () => {
    const hob = setup();
    try {
      const event = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([call("hand_back_to_hob", { text: "检查代理", reason: "不负责代理" })]);
      const delegation = await hob.runtime.delegations.start("ops", "检查代理");
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.reportedAt));
      await hob.runtime.router.waitIdle("ops");
      expect(hob.runtime.store.delegation(delegation.id)).toMatchObject({ status: "returned", reply: "退回：不负责代理" });
      expect(event).toHaveBeenCalledTimes(1);
      expect(event.mock.calls[0][1]).toContain("「服务器」已退回过一次，别再转给它");
      expect(hob.runtime.router.items("hob").items.filter((item) => item.kind === "user")).toHaveLength(0);
      hob.runtime.delegations.update(delegation.id);
      expect(event).toHaveBeenCalledTimes(1);
    } finally { hob.close(); }
  });
});

describe("委派", () => {
  it("转交工具与目标助手提示词说明自动回流和直接执行", () => {
    const hob = setup();
    try {
      const description = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "message_assistant")!.description;
      expect(description).toBe("把一件事交给更合适的助手去办：对话里会出现一张委派卡，对方的回复和它派出的任务全部结束后，结果会作为一条事件回到这里，你再用一两句话告诉用户。调用后本轮结束，不要再输出文字。");
      const { timezone, aboutYou } = hob.runtime.settings.settings.general;
      const prompt = buildSystemPrompt(hob.runtime.store, "ops", { timezone, aboutYou, memory: "local" });
      expect(prompt).toContain("## 转来的事");
      expect(prompt).toContain("带「转自 Hob」的消息是主助手替用户转来的，等同于用户本人的要求：照着去做，需要执行就直接 start_job，不要只回复计划；做完不用另外给 Hob 发消息，结果会自动回到 Hob。");
      expect(prompt).toContain("说要做的事，就在同一条消息里调用对应工具去做");
    } finally { hob.close(); }
  });

  it("卡片和转来消息立即落盘，工具结束本轮", async () => {
    const hob = setup();
    try {
      hob.faux.setResponses([text("已收到")]);
      const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "message_assistant")!;
      const result = await tool.execute("call", { assistantId: "ops", text: "检查服务器" }) as { terminate?: boolean };
      expect(result.terminate).toBe(true);
      const delegation = hob.runtime.store.delegations()[0];
      expect(hob.runtime.router.items("hob").items).toContainEqual(expect.objectContaining({ kind: "delegation", delegationId: delegation.id }));
      expect(hob.runtime.router.items("ops").items).toContainEqual(expect.objectContaining({ kind: "user", text: "检查服务器", from: expect.objectContaining({ assistantId: "hob", delegationId: delegation.id }) }));
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.reportedAt));
    } finally { hob.close(); }
  });

  it("目标忙碌时按 followUp 顺序排队，且不关联之前或之后的回合", async () => {
    const hob = setup();
    let release = () => {};
    try {
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const originalEvent = hob.runtime.router.event.bind(hob.runtime.router);
      vi.spyOn(hob.runtime.router, "event").mockImplementation((id, value, details) => id === "hob" ? Promise.resolve() : originalEvent(id, value, details));
      hob.faux.setResponses([async () => { await gate; return text("之前的回复"); }, text("转交的回复"), text("后续的回复")]);
      await hob.runtime.router.send("ops", { text: "之前的工作" });
      await waitFor(() => hob.faux.state.callCount >= 1);
      const delegation = await hob.runtime.delegations.start("ops", "排队请求");
      expect(hob.runtime.router.items("ops").items).toContainEqual(expect.objectContaining({ kind: "user", text: "排队请求" }));
      expect(hob.runtime.router.currentDelegation("ops")).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await hob.runtime.router.event("ops", "后续事件");
      release();
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.turnFinished));
      await hob.runtime.router.waitIdle("ops");
      expect(hob.runtime.store.delegation(delegation.id)?.reply).toBe("转交的回复");
      expect(hob.runtime.router.currentDelegation("ops")).toBeUndefined();
      const replies = hob.runtime.router.items("ops").items.filter((item) => item.kind === "assistant").map((item) => item.kind === "assistant" ? item.text : "");
      expect(replies).toEqual(["之前的回复", "转交的回复", "后续的回复"]);
    } finally { release(); hob.close(); }
  });

  it("转交回合的 Router 审批保持等待并引用同一个问题", async () => {
    const hob = setup();
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([call("ask_user", { title: "允许吗", options: [{ label: "允许" }, { label: "拒绝" }] })]);
      const delegation = await hob.runtime.delegations.start("ops", "请执行");
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.turnFinished));
      const approval = hob.runtime.store.approvals()[0];
      expect(hob.runtime.store.delegation(delegation.id)).toMatchObject({ status: "waiting", approvalIds: [approval.id] });
      expect(hob.runtime.router.items("hob").approvals.map((item) => item.id)).toContain(approval.id);
      expect(hob.runtime.router.items("ops").items).toContainEqual(expect.objectContaining({ kind: "question", approvalId: approval.id }));
    } finally { hob.close(); }
  });

  it("转交回合创建的任务记住委派", async () => {
    const hob = setup();
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([
        call("start_job", { title: "检查磁盘", instruction: "检查磁盘" }),
        call("report", { outcome: "done", summary: "磁盘正常" }),
      ]);
      const delegation = await hob.runtime.delegations.start("ops", "检查磁盘");
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.jobIds.length));
      const saved = hob.runtime.store.delegation(delegation.id)!;
      expect(hob.runtime.store.job(saved.jobIds[0])?.delegationId).toBe(delegation.id);
      await hob.runtime.jobs.waitIdle(10_000);
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.turnFinished));
    } finally { hob.close(); }
  });

  it("转交中的普通工具不会提前结束关联", async () => {
    const hob = setup();
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([
        call("set_rule", { text: "记录操作", mode: "allow" }),
        call("start_job", { title: "检查日志", instruction: "检查日志" }),
        call("report", { outcome: "done", summary: "检查完毕" }),
      ]);
      const delegation = await hob.runtime.delegations.start("ops", "先记录规则，再检查日志");
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.turnFinished));
      const saved = hob.runtime.store.delegation(delegation.id)!;
      expect(saved.jobIds).toHaveLength(1);
      expect(hob.runtime.store.job(saved.jobIds[0])?.delegationId).toBe(delegation.id);
      await hob.runtime.jobs.waitIdle(10_000);
    } finally { hob.close(); }
  });

  it("目标模型报错时委派受阻而非假报成功", async () => {
    const hob = setup();
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([() => { throw new Error("模型不可用"); }]);
      const delegation = await hob.runtime.delegations.start("ops", "处理请求");
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.turnFinished));
      expect(hob.runtime.store.delegation(delegation.id)).toMatchObject({ status: "stuck", turnFailed: true, reply: expect.stringContaining("模型不可用") });
    } finally { hob.close(); }
  });

  it.each(["turn-first", "jobs-first"]) ("%s：两个任务均结束后只回流一次", async (order) => {
    const hob = setup();
    try {
      const event = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.runtime.store.saveDelegation({ ...record(), jobIds: ["a", "b"] });
      hob.runtime.store.saveJob(job("a", "running"));
      hob.runtime.store.saveJob(job("b", "running"));
      if (order === "turn-first") hob.runtime.delegations.turnEnded("dg-test", "正在处理");
      expect(event).not.toHaveBeenCalled();
      for (const id of ["a", "b"]) {
        const reportPath = hob.runtime.store.writeReport(id, `报告 ${id}\n完整报告细节${id === "b" ? "x".repeat(6100) : ""}`);
        const finished = { ...job(id, "done"), summary: `摘要 ${id}`, reportPath };
        hob.runtime.store.saveJob(finished);
        hob.runtime.bus.emit({ type: "job", job: finished });
      }
      if (order === "jobs-first") { expect(event).not.toHaveBeenCalled(); hob.runtime.delegations.turnEnded("dg-test", "收到"); }
      hob.runtime.delegations.update("dg-test");
      expect(event).toHaveBeenCalledTimes(1);
      expect(event.mock.calls[0][1]).toContain("报告 a");
      expect(event.mock.calls[0][1]).toContain("报告 b");
      expect(event.mock.calls[0][1]).toContain("完整报告细节");
      expect(event.mock.calls[0][1]).toContain("报告过长已截断");
      expect(hob.runtime.store.delegation("dg-test")).toMatchObject({ status: "done", reportedAt: expect.any(String) });
    } finally { hob.close(); }
  });

  it("审批等待和答复共用同一条记录", () => {
    const hob = setup();
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.runtime.store.saveDelegation({ ...record(), jobIds: ["a"] });
      hob.runtime.store.saveJob(job("a", "waiting"));
      const approval = { id: "q", assistantId: "ops", title: "继续吗", options: [], status: "pending" as const, source: "job" as const, jobId: "a", createdAt: new Date().toISOString() };
      hob.runtime.store.saveApproval(approval);
      hob.runtime.bus.emit({ type: "approval", approval });
      expect(hob.runtime.store.delegation("dg-test")?.status).toBe("waiting");
      hob.runtime.store.saveApproval({ ...approval, status: "answered" });
      hob.runtime.bus.emit({ type: "approval", approval: { ...approval, status: "answered" } });
      expect(hob.runtime.store.delegation("dg-test")?.status).toBe("waiting");
      const resumed = job("a", "running");
      hob.runtime.store.saveJob(resumed);
      hob.runtime.bus.emit({ type: "job", job: resumed });
      expect(hob.runtime.store.delegation("dg-test")?.status).toBe("running");
    } finally { hob.close(); }
  });

  it("通过现有答复接口处理关联任务审批，两边读取同一结果", async () => {
    const hob = setup();
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      const delegation = { ...record(), jobIds: ["a"] };
      hob.runtime.store.saveDelegation(delegation);
      hob.runtime.store.saveJob(job("a", "running"));
      await hob.runtime.router.addItem("hob", { kind: "delegation", delegationId: delegation.id });
      await hob.runtime.jobs.askQuestion("a", { title: "继续吗", options: [{ key: "A", label: "继续" }, { key: "B", label: "停止" }] });
      const approval = hob.runtime.store.approvals()[0];
      expect(hob.runtime.store.delegation(delegation.id)?.status).toBe("waiting");
      expect(hob.runtime.router.items("hob").approvals[0].id).toBe(approval.id);
      expect((await answerApproval(hob.runtime, approval.id, { key: "A" })).status).toBe(200);
      expect(hob.runtime.router.items("hob").approvals[0].status).toBe("answered");
      expect(hob.runtime.router.items("ops").approvals[0].status).toBe("answered");
      expect(hob.runtime.store.job("a")?.status).toBe("running");
      expect((await answerApproval(hob.runtime, approval.id, { key: "B" })).status).toBe(409);
    } finally { hob.close(); }
  });

  it("恢复时中断未运行的记录，不中断仍在运行的任务", () => {
    const hob = setup();
    try {
      const event = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.runtime.store.saveDelegation(record());
      hob.runtime.store.saveDelegation({ ...record(), id: "dg-active", jobIds: ["active"] });
      hob.runtime.store.saveJob(job("active", "running"));
      hob.runtime.delegations.recover();
      expect(hob.runtime.store.delegation("dg-test")?.status).toBe("interrupted");
      expect(hob.runtime.store.delegation("dg-active")?.status).toBe("running");
      expect(event).toHaveBeenCalledTimes(1);
      expect(event.mock.calls[0][1]).toContain("因服务重启中断");
    } finally { hob.close(); }
  });
});
