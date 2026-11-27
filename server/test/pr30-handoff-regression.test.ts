import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { Assistant, Delegation } from "../../shared/types.ts";
import { createApp } from "../src/http.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { call, makeHob, text, waitFor, type TestHob } from "./helpers.ts";

function addAssistant(hob: TestHob, id: string, name: string, duty: string): Assistant {
  const base = hob.runtime.store.assistant("hob")!;
  const assistant: Assistant = { ...base, id, name, duty, primary: false, pinned: false, sprite: "page" };
  hob.runtime.store.saveAssistant(assistant);
  return assistant;
}

async function eventTexts(hob: TestHob, assistantId: string): Promise<string[]> {
  const state = await hob.runtime.router.ensure(assistantId);
  return state.manager!.getEntries()
    .filter((entry) => entry.type === "custom_message" && entry.customType === "hob.event")
    .map((entry) => {
      const content = (entry as { content?: string | { type: string; text?: string }[] }).content;
      if (typeof content === "string") return content;
      return (content ?? []).map((block) => block.text ?? "").join("");
    });
}

function lastGroupInput(hob: TestHob, gid: string, assistantId: string): string {
  const file = hob.runtime.store.groupMemberFile(gid, assistantId);
  if (!existsSync(file)) return "";
  const texts = readFileSync(file, "utf8")
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
  const last = texts.at(-1) ?? "";
  return last.slice(last.indexOf("\n\n") + 2);
}

async function settledGroup(hob: TestHob, gid: string, minCalls = 1): Promise<void> {
  await waitFor(() => hob.faux.state.callCount >= minCalls);
  await waitFor(() => (hob.runtime.groups.summary(gid).busy?.length ?? 0) === 0);
}

describe("PR #30 回归复现（本地 main 基线）", () => {
  it("问题 1a：非主助手用 message_group 交给群时，群主看到实际交接人且空结论报错写交接人名字", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "lead", "统筹", "安排排期");
      addAssistant(hob, "designer", "设计", "画原型");
      const group = hob.runtime.groups.create({
        name: "产品组",
        purpose: "方案评审",
        ownerId: "designer",
        members: ["hob", "lead", "designer"],
      });
      hob.faux.setResponses([text("已收到方案要求"), text("收到结论")]);
      const handoff = buildRouterTools(hob.runtime, "lead").find((tool) => tool.name === "message_group")!;
      await handoff.execute("c1", { groupId: group.id, title: "改版评审", note: "评估首页改版方案" });
      const [topic] = hob.runtime.groups.topicsOf(group.id);
      await waitFor(() => lastGroupInput(hob, topic.id, "designer").includes("[hob-event]"));
      const eventLine = lastGroupInput(hob, topic.id, "designer").split("[hob-event]")[1] ?? "";
      expect(eventLine).toContain("统筹");
      expect(eventLine).not.toContain("Hob");
      expect(() => hob.runtime.groups.closeByOwner(topic.id, "")).toThrow(/统筹/);
    } finally {
      hob.close();
    }
  });

  it("问题 1b：主助手委派给 A，A 再用 message_group 交给群，群未出结论前原委派不应提前完成", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "coord", "协调", "协调小组");
      addAssistant(hob, "qa", "测试", "回归验证");
      const group = hob.runtime.groups.create({
        name: "质检组",
        purpose: "发布前验证",
        ownerId: "qa",
        members: ["hob", "coord", "qa"],
      });
      hob.faux.setResponses([
        call("message_group", { groupId: group.id, title: "发布验收", note: "核查三个关键用例" }),
        text("正在执行验收"),
        text("验收全部通过，可以发布"),
        text("收到，准备发布"),
      ]);
      const delegation = await hob.runtime.delegations.start("hob", "coord", "请让质检组做发布验收");
      await waitFor(() => hob.runtime.groups.topicsOf(group.id).length === 1);
      const [topic] = hob.runtime.groups.topicsOf(group.id);
      await waitFor(() => hob.runtime.groups.timeline(topic.id).some((item) => item.kind === "assistant"));
      await hob.runtime.router.waitIdle("coord");
      expect(hob.runtime.store.delegation(delegation.id)?.status).toBe("running");
      expect(await eventTexts(hob, "hob")).toEqual([]);
      hob.runtime.groups.closeByOwner(topic.id, "三项用例全部通过");
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.reportedAt));
      expect(hob.runtime.store.delegation(delegation.id)?.status).toBe("done");
      expect(await eventTexts(hob, "hob")).toEqual([expect.stringContaining("三项用例全部通过")]);
    } finally {
      hob.close();
    }
  });

  it("问题 2a：委派附带 CSV 和图片时，接手助手的模型输入收到附件路径与图片内容", async () => {
    const hob = makeHob({}, { memory: "off", models: [{ id: "vision", input: ["text", "image"] }] });
    try {
      addAssistant(hob, "analyst", "分析", "数据核对");
      const csv = join(hob.home, "清单.csv");
      const img = join(hob.home, "图表.png");
      writeFileSync(csv, "项目,数量\n样本,42\n");
      const png = readFileSync(new URL("../../web/public/icons/favicon-32.png", import.meta.url));
      writeFileSync(img, png);
      let received: UserMessage | undefined;
      hob.faux.setResponses([
        (context) => {
          received = context.messages.findLast((message) => message.role === "user");
          return text("已核对完成");
        },
        text("收到"),
      ]);
      const delegation = await hob.runtime.delegations.start("hob", "analyst", "请核对清单和图表", [csv, img]);
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.reportedAt));
      expect(JSON.stringify(received?.content)).toContain(csv);
      expect(JSON.stringify(received?.content)).toContain(img);
      const images = Array.isArray(received?.content) ? received.content.filter((part) => part.type === "image") : [];
      expect(images).toEqual([{ type: "image", mimeType: "image/png", data: png.toString("base64") }]);
    } finally {
      hob.close();
    }
  });

  it("问题 2b：中断的委派通过 HTTP 重试时保留原附件", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "analyst", "分析", "数据核对");
      const files = [join(hob.home, "明细.csv")];
      const original: Delegation = {
        id: "dg-interrupted",
        from: "hob",
        to: "analyst",
        text: "请核对明细",
        status: "interrupted",
        createdAt: new Date().toISOString(),
        jobIds: [],
      };
      hob.runtime.store.saveDelegation(original);
      await hob.runtime.router.addForwarded("analyst", original.text, original.id, original.from, files);
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "test" }),
      });
      hob.faux.setResponses([text("已重新核对"), text("收到")]);
      const res = await app.request(`/api/delegations/${original.id}/retry`, {
        method: "POST",
        headers: { cookie: login.headers.get("set-cookie")!.split(";")[0] },
      });
      expect(res.status).toBe(200);
      const { delegation } = (await res.json()) as { delegation: Delegation };
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.reportedAt));
      await hob.runtime.router.waitIdle("hob");
      expect(hob.runtime.router.items("analyst").items).toContainEqual(
        expect.objectContaining({ kind: "user", files, from: expect.objectContaining({ delegationId: delegation.id }) }),
      );
    } finally {
      hob.close();
    }
  });

  it("问题 2c：接手助手用 send_file 交回成品时，发起方模型输入收到成品路径", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "analyst", "分析", "数据核对");
      const output = join(hob.runtime.store.assistantDir("analyst"), "files", "汇总表.csv");
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, "总计\n99\n");
      let received: UserMessage | undefined;
      hob.faux.setResponses([
        call("send_file", { path: output }),
        text("整理完成，见附件"),
        (context) => {
          received = context.messages.findLast((message) => message.role === "user");
          return text("已收到汇总表");
        },
      ]);
      const delegation = await hob.runtime.delegations.start("hob", "analyst", "请产出汇总表");
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.reportedAt));
      expect(JSON.stringify(received?.content)).toContain(output);
    } finally {
      hob.close();
    }
  });

  it("问题 3a：群里点名一位成员，不结束其他成员正在等用户回答的问题卡", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "ops", "运维", "环境");
      addAssistant(hob, "qa", "测试", "回归");
      const group = hob.runtime.groups.create({
        name: "发布群",
        purpose: "上线配合",
        ownerId: "hob",
        members: ["hob", "ops", "qa"],
      });
      const base = {
        title: "是否继续",
        options: [],
        status: "pending" as const,
        source: "router" as const,
        groupId: group.id,
        createdAt: new Date().toISOString(),
      };
      hob.runtime.store.saveApproval({ ...base, id: "q-hob", assistantId: "hob" });
      hob.runtime.store.saveApproval({ ...base, id: "q-ops", assistantId: "ops" });
      hob.runtime.store.saveApproval({ ...base, id: "q-qa", assistantId: "qa" });
      hob.faux.setResponses([text("收到")]);
      await hob.runtime.groups.send(group.id, { text: "@运维 看一下日志" });
      await settledGroup(hob, group.id, 1);
      expect(hob.runtime.store.approval("q-ops")?.status).toBe("expired");
      expect(hob.runtime.store.approval("q-hob")?.status).toBe("pending");
      expect(hob.runtime.store.approval("q-qa")?.status).toBe("pending");
    } finally {
      hob.close();
    }
  });

  it("问题 3b：群成员发文件或生成图片后点名同事复核，对方收到文件路径、图片与失败原因", async () => {
    const hob = makeHob({}, { memory: "off", models: [{ id: "vision", input: ["text", "image"] }] });
    try {
      addAssistant(hob, "reviewer", "复核", "交叉核对");
      const group = hob.runtime.groups.create({
        name: "复核群",
        purpose: "核对交付物",
        ownerId: "hob",
        members: ["hob", "reviewer"],
      });
      const report = join(hob.runtime.store.assistantDir("hob"), "files", "报表.csv");
      const preview = join(hob.home, "预览.png");
      mkdirSync(dirname(report), { recursive: true });
      writeFileSync(report, "指标,值\n通过率,100%\n");
      writeFileSync(preview, readFileSync(new URL("../../web/public/icons/favicon-32.png", import.meta.url)));
      hob.runtime.groups.appendItem(group.id, "hob", { kind: "image", prompt: "画预览", status: "done", path: preview });
      hob.runtime.groups.appendItem(group.id, "hob", { kind: "image", prompt: "画全貌", status: "failed", error: "接口超时" });
      let received: unknown;
      hob.faux.setResponses([
        call("send_file", { path: report }),
        text("@复核 请核对报表和预览图"),
        (context) => {
          received = context.messages.findLast((message) => message.role === "user")?.content;
          return text("核对无误");
        },
      ]);
      await hob.runtime.groups.send(group.id, { text: "发报表给复核看" });
      await settledGroup(hob, group.id, 2);
      const serialized = JSON.stringify(received);
      expect(serialized).toContain(report);
      expect(serialized).toContain(preview);
      expect(serialized).toContain("接口超时");
      expect(received).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image", mimeType: "image/png" })]));
    } finally {
      hob.close();
    }
  });
});

describe("PR #30 审查修复（安全边界与本地话题/异常收口）", () => {
  it("安全：转交事件与普通消息不内联目录外、符号链接越界和敏感目录的图片，允许工作区内的图片正常内联", async () => {
    const hob = makeHob({}, { memory: "off", models: [{ id: "vision", input: ["text", "image"] }] });
    const outsideDir = mkdtempSync(join(tmpdir(), "hob-outside-img-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "hob-workspace-img-"));
    const png = readFileSync(new URL("../../web/public/icons/favicon-32.png", import.meta.url));
    try {
      const base = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...base, id: "reviewer", name: "审核", duty: "审图", primary: false, cwd: workspaceDir });
      const outsideImg = join(outsideDir, "outside.png");
      const linkImg = join(hob.home, "escape-link.png");
      const systemImg = join(hob.home, "system", "secret.png");
      const workspaceImg = join(workspaceDir, "diagram.png");
      writeFileSync(outsideImg, png);
      symlinkSync(outsideImg, linkImg);
      mkdirSync(dirname(systemImg), { recursive: true });
      writeFileSync(systemImg, png);
      writeFileSync(workspaceImg, png);

      const seenImages: number[] = [];
      hob.faux.setResponses([
        (context) => {
          const last = context.messages.findLast((message) => message.role === "user");
          seenImages.push(Array.isArray(last?.content) ? last.content.filter((part) => part.type === "image").length : 0);
          return text("已处理敏感路径委派");
        },
        text("收到 1"),
        (context) => {
          const last = context.messages.findLast((message) => message.role === "user");
          seenImages.push(Array.isArray(last?.content) ? last.content.filter((part) => part.type === "image").length : 0);
          return text("已处理工作区委派");
        },
        text("收到 2"),
        (context) => {
          const last = context.messages.findLast((message) => message.role === "user");
          seenImages.push(Array.isArray(last?.content) ? last.content.filter((part) => part.type === "image").length : 0);
          return text("已处理单聊");
        },
      ]);

      const blocked = await hob.runtime.delegations.start("hob", "reviewer", "检查越界图", [outsideImg, linkImg, systemImg]);
      await waitFor(() => Boolean(hob.runtime.store.delegation(blocked.id)?.reportedAt));
      const allowed = await hob.runtime.delegations.start("hob", "reviewer", "检查工作区图", [workspaceImg]);
      await waitFor(() => Boolean(hob.runtime.store.delegation(allowed.id)?.reportedAt));
      await hob.runtime.router.send("hob", { text: "看这两张图", files: [outsideImg, systemImg] });
      await hob.runtime.router.waitIdle("hob");

      expect(seenImages).toEqual([0, 1, 0]);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
      hob.close();
    }
  });

  it("安全：message_assistant、message_group 和 open_topic 拒绝敏感路径附件", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const base = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...base, id: "worker", name: "经办", duty: "处理", primary: false, topics: true });
      const group = hob.runtime.groups.create({
        name: "协作群",
        purpose: "协作",
        ownerId: "hob",
        members: ["hob", "worker"],
      });
      const secretPath = join(hob.home, "system", "secrets.json");
      const envPath = join(hob.home, ".env");

      const msgAssistant = buildRouterTools(hob.runtime, "hob").find((tool) => tool.name === "message_assistant")!;
      const r1 = await msgAssistant.execute("c1", { assistantId: "worker", note: "查看", files: [secretPath] });
      expect((r1 as { isError?: boolean }).isError).toBe(true);

      const msgGroup = buildRouterTools(hob.runtime, "hob").find((tool) => tool.name === "message_group")!;
      const r2 = await msgGroup.execute("c2", { groupId: group.id, title: "检查", note: "查看", files: [envPath] });
      expect((r2 as { isError?: boolean }).isError).toBe(true);

      const openGroupTopic = buildRouterTools(hob.runtime, "hob", { groupId: group.id }).find((tool) => tool.name === "open_topic")!;
      const r3 = await openGroupTopic.execute("c3", { title: "核查", note: "查看", files: [join(hob.home, ".ssh", "id_rsa")] });
      expect((r3 as { isError?: boolean }).isError).toBe(true);

      const openAssistantTopic = buildRouterTools(hob.runtime, "worker").find((tool) => tool.name === "open_topic")!;
      const r4 = await openAssistantTopic.execute("c4", { title: "核查", note: "查看", files: [secretPath] });
      expect((r4 as { isError?: boolean }).isError).toBe(true);
    } finally {
      hob.close();
    }
  });

  it("中断：message_group 在落话题卡时中止，不会把已中止的话题挂进当前委派", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "coord", "协调", "统筹");
      addAssistant(hob, "qa", "测试", "验收");
      const group = hob.runtime.groups.create({
        name: "测试群",
        purpose: "验收",
        ownerId: "qa",
        members: ["hob", "coord", "qa"],
      });
      const delegation: Delegation = {
        id: "dg-abort-test",
        from: "hob",
        to: "coord",
        text: "请验收",
        createdAt: new Date().toISOString(),
        status: "running",
        jobIds: [],
        approvalIds: [],
      };
      hob.runtime.store.saveDelegation(delegation);
      vi.spyOn(hob.runtime.router, "currentDelegation").mockReturnValue(delegation.id);
      const controller = new AbortController();
      vi.spyOn(hob.runtime.router, "addItem").mockImplementationOnce(async () => {
        controller.abort(new Error("aborted"));
        throw new Error("aborted");
      });

      const msgGroup = buildRouterTools(hob.runtime, "coord").find((tool) => tool.name === "message_group")!;
      const result = await msgGroup.execute("c1", { groupId: group.id, title: "验收", note: "请执行验收" }, controller.signal);
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(hob.runtime.store.internalDelegation(delegation.id)?.topics).toBeUndefined();
    } finally {
      hob.close();
    }
  });

  it("冲突：主对话委派已有待结群话题时，open_topic 拒绝把委派挪进助手话题", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const base = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...base, id: "coord", name: "协调", duty: "统筹", primary: false, topics: true });
      addAssistant(hob, "qa", "测试", "验收");
      const group = hob.runtime.groups.create({
        name: "测试群",
        purpose: "验收",
        ownerId: "qa",
        members: ["hob", "coord", "qa"],
      });
      const { topic } = hob.runtime.groups.handOver(group.id, "回归验收", "coord", { text: "请回归", files: [] });
      const delegation: Delegation = {
        id: "dg-open-topic-conflict",
        from: "hob",
        to: "coord",
        text: "协调回归",
        createdAt: new Date().toISOString(),
        status: "running",
        jobIds: [],
        approvalIds: [],
      };
      hob.runtime.store.saveDelegation(delegation);
      hob.runtime.delegations.addTopic(delegation.id, topic.id);
      vi.spyOn(hob.runtime.router, "currentDelegation").mockReturnValue(delegation.id);

      const openTopic = buildRouterTools(hob.runtime, "coord").find((tool) => tool.name === "open_topic")!;
      const result = await openTopic.execute("c1", { title: "新话题", note: "转到话题处理" });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain("交给群处理");
    } finally {
      hob.close();
    }
  });

  it("话题重试：从助手话题发起的中断委派重试时同时保留原附件和 fromTopicId", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const base = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...base, id: "lead", name: "统筹", duty: "排期", primary: false, topics: true });
      addAssistant(hob, "analyst", "分析", "核对");
      const { topic } = await hob.runtime.assistantTopics.create("lead", { title: "季度核账", createdBy: "user" });
      const file = join(hob.home, "账单.csv");
      writeFileSync(file, "项,金额\nA,99\n");
      const interrupted: Delegation = {
        id: "dg-topic-retry",
        from: "lead",
        fromTopicId: topic.id,
        to: "analyst",
        text: "请核对账单",
        files: [file],
        createdAt: new Date().toISOString(),
        status: "interrupted",
        endedAt: new Date().toISOString(),
        reportedAt: new Date().toISOString(),
        jobIds: [],
      };
      hob.runtime.store.saveDelegation(interrupted);

      hob.faux.setResponses([text("已重新核对完成"), text("收到核对结果")]);
      const retried = await hob.runtime.delegations.retry(interrupted);
      expect(retried.fromTopicId).toBe(topic.id);
      expect(retried.files).toEqual([file]);
      await waitFor(() => Boolean(hob.runtime.store.delegation(retried.id)?.reportedAt));
      await hob.runtime.router.waitIdle("lead", 2_000, { topicId: topic.id });
      expect(hob.runtime.router.items("lead", { limit: 50 }, { topicId: topic.id }).items).toContainEqual(
        expect.objectContaining({ kind: "delegation", delegationId: retried.id }),
      );
    } finally {
      hob.close();
    }
  });

  it("异常收口：handoverResult 在 resumeForTopic 后异常失败未进入 turn_end 时，清理状态并让委派可正常收尾", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "coord", "协调", "统筹");
      addAssistant(hob, "qa", "测试", "验收");
      const group = hob.runtime.groups.create({
        name: "验收群",
        purpose: "验收",
        ownerId: "qa",
        members: ["hob", "coord", "qa"],
      });
      const { topic } = hob.runtime.groups.handOver(group.id, "验收", "coord", { text: "请验收", files: [] });
      const delegation: Delegation = {
        id: "dg-handover-fail",
        from: "hob",
        to: "coord",
        text: "请协调验收",
        createdAt: new Date().toISOString(),
        status: "running",
        turnFinished: true,
        jobIds: [],
        approvalIds: [],
      };
      hob.runtime.store.saveDelegation(delegation);
      hob.runtime.delegations.addTopic(delegation.id, topic.id);

      const state = await hob.runtime.router.ensure("coord");
      vi.spyOn(state.session!, "sendCustomMessage").mockImplementationOnce(async () => {
        // 模拟 message_start 已触发 resumeForTopic，但随后未走 turn_end 即抛错
        const resumed = hob.runtime.delegations.resumeForTopic(topic.id);
        expect(resumed).toBe(delegation.id);
        (state as { currentDelegationId?: string }).currentDelegationId = resumed;
        throw new Error("simulated transport drop");
      });

      const ok = await hob.runtime.router.handoverResult("coord", topic.id, "验收失败详情");
      expect(ok).toBe(false);
      expect(hob.runtime.router.currentDelegation("coord")).toBeUndefined();
      expect(hob.runtime.store.internalDelegation(delegation.id)?.turnFinished).toBe(true);
      expect(hob.runtime.store.internalDelegation(delegation.id)?.turnFailed).toBe(true);

      hob.faux.setResponses([text("已知悉受阻")]);
      hob.runtime.delegations.topicEnded(topic.id, "验收失败详情");
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.reportedAt));
      expect(hob.runtime.store.delegation(delegation.id)?.status).toBe("stuck");
    } finally {
      hob.close();
    }
  });
});
