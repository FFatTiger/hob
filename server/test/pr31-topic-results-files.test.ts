import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { Assistant, Group } from "../../shared/types.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { createRuntime, type HobRuntime } from "../src/runtime.ts";
import { call, makeHob, text, waitFor, type TestHob } from "./helpers.ts";

const ISO = "2026-11-12T08:00:00.000Z";

function addAssistant(hob: TestHob, id: string, name: string, duty: string): Assistant {
  const base = hob.runtime.store.assistant("hob")!;
  const assistant: Assistant = { ...base, id, name, duty, primary: false, pinned: false, sprite: "page" };
  hob.runtime.store.saveAssistant(assistant);
  return assistant;
}

function setupInspection(): { hob: TestHob; group: Group } {
  const hob = makeHob({}, { memory: "off" });
  addAssistant(hob, "lead", "统筹", "协调排期与交接");
  addAssistant(hob, "inspector", "主检", "负责盘点汇总");
  addAssistant(hob, "reviewer", "复核", "复核清单与数据");
  const group = hob.runtime.groups.create({
    name: "库存盘点组",
    purpose: "负责仓库盘点与核对",
    ownerId: "inspector",
    members: ["hob", "lead", "inspector", "reviewer"],
  });
  return { hob, group };
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

describe("PR #31 基线复现（本地 main 待修问题）", () => {
  it("问题 1：交给群的话题里成员复核后未再 @ 群主，群主收到事件后仍能收尾并收敛上游委派", async () => {
    const { hob, group } = setupInspection();
    try {
      hob.faux.setResponses([
        call("message_group", { groupId: group.id, title: "季度盘点", note: "请复核仓库盘点清单" }),
        text("@复核 请核对盘点清单"),
        text("复核完毕，36 件货品数量无误"),
        call("close_topic", { note: "盘点复核通过，共 36 件" }),
        text("盘点已完成并复核通过"),
        text("收到，归档记录"),
      ]);
      const delegation = await hob.runtime.delegations.start("hob", "lead", "请让库存盘点组核对季度清单");
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.reportedAt), 2_000);
      const [topic] = hob.runtime.groups.topicsOf(group.id);
      expect(hob.runtime.store.group(topic.id)?.closedAt).toBeTruthy();
      expect(hob.runtime.store.delegation(delegation.id)?.status).toBe("done");
      expect(await eventTexts(hob, "hob")).toEqual([expect.stringContaining("盘点复核通过，共 36 件")]);
    } finally {
      hob.close();
    }
  });

  it("问题 2a：群话题关闭时交付文件、完成图片和已完成任务产物按路径去重沿委派链送回，排除失败任务与别的话题文件", async () => {
    const { hob, group } = setupInspection();
    try {
      const sheet = join(hob.home, "inventory.csv");
      const summary = join(hob.home, "summary.csv");
      const chart = join(hob.home, "chart.png");
      const unrelated = join(hob.home, "unrelated.csv");
      writeFileSync(sheet, "sku,qty\nA1,36\n");
      writeFileSync(summary, "total\n36\n");
      writeFileSync(unrelated, "other\n1\n");
      writeFileSync(chart, readFileSync(new URL("../../web/public/icons/favicon-32.png", import.meta.url)));

      hob.faux.setResponses([
        call("message_group", { groupId: group.id, title: "季度盘点", note: "整理盘点结果表" }),
        call("send_file", { path: sheet }),
        text("已发盘点表"),
        call("send_file", { path: sheet }),
        text("盘点结果已整理好"),
        text("收到全部附件"),
      ]);
      const delegation = await hob.runtime.delegations.start("hob", "lead", "请库存盘点组交付盘点表格");
      await waitFor(() =>
        hob.runtime.groups.topicsOf(group.id).some((topic) =>
          hob.runtime.groups.timeline(topic.id).some((item) => item.kind === "assistant" && item.text === "已发盘点表"),
        ),
      );
      const [topic] = hob.runtime.groups.topicsOf(group.id);
      const sibling = hob.runtime.groups.createTopic(group.id, "其他盘点", "user");
      hob.runtime.groups.appendItem(sibling.id, "inspector", { kind: "file", path: unrelated, name: "unrelated.csv" });
      const drawing = hob.runtime.groups.appendItem(topic.id, "inspector", { kind: "image", status: "pending", prompt: "柱状图", startedAt: ISO });
      hob.runtime.groups.updateImageItem(topic.id, drawing.id, { status: "done", path: chart });
      hob.runtime.store.saveJob({
        id: "t-done",
        assistantId: "inspector",
        groupId: topic.id,
        title: "汇总",
        instruction: "生成汇总表",
        status: "done",
        createdAt: ISO,
        activity: [],
        stats: { reads: 0, commands: 0, edits: 0 },
        files: [sheet, summary],
      });
      hob.runtime.store.saveJob({
        id: "t-failed",
        assistantId: "inspector",
        groupId: topic.id,
        title: "失败草稿",
        instruction: "草稿",
        status: "failed",
        createdAt: ISO,
        activity: [],
        stats: { reads: 0, commands: 0, edits: 0 },
        files: [unrelated],
      });

      hob.runtime.groups.closeByOwner(topic.id, "盘点表和图表已备齐");
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.reportedAt), 2_000);
      for (const assistant of ["lead", "hob"]) {
        const lines = (await eventTexts(hob, assistant)).filter((line) => line.includes("盘点表和图表已备齐"));
        expect(lines).toHaveLength(1);
        expect(lines[0].split("\n附件：")[1]).toBe([sheet, chart, summary].join("、"));
      }
    } finally {
      hob.close();
    }
  });

  it("问题 2b：话题关闭后未送达前重启，恢复补送时仍附带关闭快照中的交付文件且排除关闭后追加的文件", async () => {
    const { hob, group } = setupInspection();
    let restarted: HobRuntime | undefined;
    try {
      const sheet = join(hob.home, "inspection-sheet.csv");
      const late = join(hob.home, "late.csv");
      writeFileSync(sheet, "item,ok\nvalve,yes\n");
      writeFileSync(late, "late\n");
      hob.faux.setResponses([
        call("message_group", { groupId: group.id, title: "设备巡检", note: "输出巡检清单" }),
        call("send_file", { path: sheet }),
        text("巡检表已上传"),
        text("已转交主助手"),
        text("已知晓"),
      ]);
      const delegation = await hob.runtime.delegations.start("hob", "lead", "让盘点组做设备巡检");
      await waitFor(() =>
        hob.runtime.groups.topicsOf(group.id).some((topic) =>
          hob.runtime.groups.timeline(topic.id).some((item) => item.kind === "assistant" && item.text === "巡检表已上传"),
        ),
      );
      const [topic] = hob.runtime.groups.topicsOf(group.id);
      vi.spyOn(hob.runtime.router, "handoverResult").mockResolvedValue(false);
      hob.runtime.groups.closeByOwner(topic.id, "设备巡检完成");
      hob.runtime.groups.appendItem(topic.id, "inspector", { kind: "file", path: late, name: "late.csv" });

      hob.runtime.router.disposeAll();
      restarted = createRuntime({ home: hob.home, config: hob.runtime.config, pi: hob.runtime.pi });
      const after = { ...hob, runtime: restarted };
      restarted.delegations.recover();
      restarted.groups.recoverHandovers();
      await waitFor(() => Boolean(restarted!.store.delegation(delegation.id)?.reportedAt), 2_000);
      for (const assistant of ["lead", "hob"]) {
        const lines = (await eventTexts(after, assistant)).filter((line) => line.includes("设备巡检完成"));
        expect(lines).toHaveLength(1);
        expect(lines[0].split("\n附件：")[1]).toBe(sheet);
      }
    } finally {
      restarted?.router.disposeAll();
      restarted?.jobs.disposeAll();
      restarted?.desktopEvents.stop();
      restarted?.desktopControl.dispose();
      hob.close();
    }
  });

  it("问题 3：群结论写入接手助手会话后 sendCustomMessage 抛错，仍标记已送达并收敛原委派", async () => {
    const hob = makeHob({}, { memory: "off", retry: { maxRetries: 0, baseDelayMs: 1 } });
    try {
      addAssistant(hob, "lead", "统筹", "协调排期");
      addAssistant(hob, "inspector", "主检", "负责盘点");
      const group = hob.runtime.groups.create({
        name: "库存盘点组",
        purpose: "负责仓库盘点",
        ownerId: "inspector",
        members: ["hob", "lead", "inspector"],
      });
      hob.faux.setResponses([
        call("message_group", { groupId: group.id, title: "盘点", note: "核查库存" }),
        text("开始核查"),
        text("已知晓异常"),
      ]);
      const delegation = await hob.runtime.delegations.start("hob", "lead", "让盘点组核查库存");
      await waitFor(() =>
        hob.runtime.groups.topicsOf(group.id).some((topic) =>
          hob.runtime.groups.timeline(topic.id).some((item) => item.kind === "assistant" && item.text === "开始核查"),
        ),
      );
      const [topic] = hob.runtime.groups.topicsOf(group.id);
      const leadState = await hob.runtime.router.ensure("lead");
      const origSend = leadState.session!.sendCustomMessage.bind(leadState.session!);
      vi.spyOn(leadState.session!, "sendCustomMessage").mockImplementationOnce(async (msg: any, opts?: any) => {
        leadState.manager!.appendCustomMessageEntry(msg.customType, msg.content, Boolean(msg.display), msg.details);
        throw new Error("上游模型连接断开");
      });
      void origSend;

      hob.runtime.groups.closeByOwner(topic.id, "库存无差异");
      await waitFor(() => {
        const current = hob.runtime.store.delegation(delegation.id);
        return Boolean(current?.reportedAt && current.status !== "running");
      }, 2_000);
      expect(hob.runtime.store.group(topic.id)?.handover?.deliveredAt).toBeTruthy();
      expect(hob.runtime.store.delegation(delegation.id)?.status).not.toBe("running");
      const lines = await eventTexts(hob, "hob");
      expect(lines).toEqual([expect.stringContaining("库存无差异")]);
    } finally {
      hob.close();
    }
  });
});

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

describe("PR #31 审查加固与设计对齐", () => {
  it("成员回复后给群主的是写事实的事件，群主可自行决定回 NO_REPLY 不出声", async () => {
    const { hob, group } = setupInspection();
    try {
      hob.faux.setResponses([
        text("@复核 请确认货位编号"),
        text("已核对，货位编号正确"),
        text("NO_REPLY"),
      ]);
      const handoff = buildRouterTools(hob.runtime, "hob").find((tool) => tool.name === "message_group")!;
      await handoff.execute("c1", { groupId: group.id, title: "货位核对", note: "确认货位编号" });
      const [topic] = hob.runtime.groups.topicsOf(group.id);
      await waitFor(() => hob.faux.state.callCount >= 3);
      await hob.runtime.router.waitIdle("inspector", 10_000, { groupId: topic.id });

      const ownerInput = lastGroupInput(hob, topic.id, "inspector");
      expect(ownerInput).toContain("[hob-event] 群成员已结束这一轮发言。");
      expect(ownerInput).not.toContain("send_file");
      expect(ownerInput).not.toContain("close_topic");
      expect(hob.runtime.store.group(topic.id)?.closedAt).toBeUndefined();
      expect(hob.runtime.groups.timeline(topic.id).filter((item) => item.kind === "assistant" && item.speaker === "inspector")).toHaveLength(1);
    } finally {
      hob.close();
    }
  });

  it("全员回应（replyMode: all）波次下，成员轮流发言后不重复唤醒群主", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "inspector", "主检", "盘点");
      addAssistant(hob, "reviewer", "复核", "核对");
      const group = hob.runtime.groups.create({
        name: "巡检组",
        purpose: "巡检",
        ownerId: "inspector",
        members: ["inspector", "reviewer"],
        replyMode: "all",
      });
      const { topic } = hob.runtime.groups.handOver(group.id, "全员核查", "hob", { text: "核查巡检记录", files: [] });
      hob.faux.setResponses([text("主检已确认"), text("复核也已确认")]);
      await hob.runtime.groups.send(topic.id, { text: "大家分别看下有没有遗漏" });
      await waitFor(() => hob.faux.state.callCount >= 2);
      await hob.runtime.router.waitIdle("inspector", 10_000, { groupId: topic.id });
      await hob.runtime.router.waitIdle("reviewer", 10_000, { groupId: topic.id });
      expect(hob.faux.state.callCount).toBe(2);
    } finally {
      hob.close();
    }
  });

  it("用户在交给群的话题里显式 @ 非群主成员时，不自动唤醒群主", async () => {
    const { hob, group } = setupInspection();
    try {
      const { topic } = hob.runtime.groups.handOver(group.id, "盘点答疑", "hob", { text: "核对清单", files: [] });
      hob.faux.setResponses([text("第二列表示可用库存数量")]);
      await hob.runtime.groups.send(topic.id, { text: "@复核 第二列是什么意思？" });
      await waitFor(() => hob.faux.state.callCount >= 1);
      await hob.runtime.router.waitIdle("reviewer", 10_000, { groupId: topic.id });
      await hob.runtime.router.waitIdle("inspector", 10_000, { groupId: topic.id });
      expect(hob.faux.state.callCount).toBe(1);
    } finally {
      hob.close();
    }
  });

  it("成员回复时已显式 @ 群主，群主只运行一轮不重复触发", async () => {
    const { hob, group } = setupInspection();
    try {
      hob.faux.setResponses([
        text("@复核 请复核盘点数量"),
        text("@主检 复核完成，无差异"),
        text("收到，准备整理结论"),
      ]);
      const handoff = buildRouterTools(hob.runtime, "hob").find((tool) => tool.name === "message_group")!;
      await handoff.execute("c1", { groupId: group.id, title: "数量核对", note: "核对仓库盘点数量" });
      const [topic] = hob.runtime.groups.topicsOf(group.id);
      await waitFor(() => hob.faux.state.callCount >= 3);
      await hob.runtime.router.waitIdle("reviewer", 10_000, { groupId: topic.id });
      await hob.runtime.router.waitIdle("inspector", 10_000, { groupId: topic.id });
      expect(hob.faux.state.callCount).toBe(3);
    } finally {
      hob.close();
    }
  });

  it("成员本轮调模型报错时，不误唤醒群主", async () => {
    const hob = makeHob({}, { memory: "off", retry: { maxRetries: 0, baseDelayMs: 1 } });
    try {
      addAssistant(hob, "inspector", "主检", "盘点");
      addAssistant(hob, "reviewer", "复核", "核对");
      const group = hob.runtime.groups.create({
        name: "巡检组",
        purpose: "巡检",
        ownerId: "inspector",
        members: ["hob", "inspector", "reviewer"],
      });
      hob.faux.setResponses([
        text("@复核 请核对"),
        () => { throw new Error("模型暂时不可用"); },
      ]);
      const handoff = buildRouterTools(hob.runtime, "hob").find((tool) => tool.name === "message_group")!;
      await handoff.execute("c1", { groupId: group.id, title: "异常检查", note: "请核对明细" });
      const [topic] = hob.runtime.groups.topicsOf(group.id);
      await waitFor(() => hob.faux.state.callCount >= 2);
      await hob.runtime.router.waitIdle("reviewer", 10_000, { groupId: topic.id });
      await hob.runtime.router.waitIdle("inspector", 10_000, { groupId: topic.id });
      expect(hob.faux.state.callCount).toBe(2);
    } finally {
      hob.close();
    }
  });

  it("票 276 协同：message_group(topic) 再次转入已关闭话题并关闭时（含重启补送），清空旧 resultFiles 且不漏送、不重复送", async () => {
    const { hob, group } = setupInspection();
    let restarted: HobRuntime | undefined;
    try {
      const v1 = join(hob.home, "v1.csv");
      const v2 = join(hob.home, "v2.csv");
      writeFileSync(v1, "round\n1\n");
      writeFileSync(v2, "round\n2\n");
      const handoff = buildRouterTools(hob.runtime, "hob").find((tool) => tool.name === "message_group")!;

      hob.faux.setResponses([
        call("send_file", { path: v1 }),
        text("第一版已上传"),
        text("收到第一版"),
      ]);
      await handoff.execute("c1", { groupId: group.id, title: "季度盘点", note: "先整理第一版" });
      const [topic] = hob.runtime.groups.topicsOf(group.id);
      await waitFor(() => hob.runtime.groups.timeline(topic.id).some((item) => item.kind === "file"));
      hob.runtime.groups.closeByOwner(topic.id, "第一版盘点完成");
      await waitFor(() => Boolean(hob.runtime.store.group(topic.id)?.handover?.deliveredAt));
      const firstEvents = await eventTexts(hob, "hob");
      expect(firstEvents).toHaveLength(1);
      expect(firstEvents[0].split("\n附件：")[1]).toBe(v1);

      // 二次转入已有话题：清空旧 result / resultFiles / deliveredAt 并刷新 handover.at
      hob.faux.setResponses([
        call("send_file", { path: v2 }),
        text("第二版已上传"),
        text("收到第二版"),
      ]);
      await handoff.execute("c2", { groupId: group.id, topic: topic.id, note: "再补第二版附件" });
      const reopened = hob.runtime.store.group(topic.id)!;
      expect(reopened.closedAt).toBeUndefined();
      expect(reopened.handover?.result).toBeUndefined();
      expect(reopened.handover?.resultFiles).toBeUndefined();
      expect(reopened.handover?.deliveredAt).toBeUndefined();
      await waitFor(() => hob.runtime.groups.timeline(topic.id).filter((item) => item.kind === "file").length === 2);

      // 模拟第二次关闭后投递前重启
      vi.spyOn(hob.runtime.router, "handoverResult").mockResolvedValue(false);
      hob.runtime.groups.closeByOwner(topic.id, "第二版盘点完成");
      hob.runtime.router.disposeAll();
      restarted = createRuntime({ home: hob.home, config: hob.runtime.config, pi: hob.runtime.pi });
      const after = { ...hob, runtime: restarted };
      restarted.groups.recoverHandovers();
      await waitFor(() => Boolean(restarted!.store.group(topic.id)?.handover?.deliveredAt));
      const allEvents = await eventTexts(after, "hob");
      const r1 = allEvents.filter((line) => line.includes("第一版盘点完成"));
      const r2 = allEvents.filter((line) => line.includes("第二版盘点完成"));
      expect(r1).toHaveLength(1);
      expect(r2).toHaveLength(1);
      expect(r2[0].split("\n附件：")[1]).toBe([v1, v2].join("、"));
    } finally {
      restarted?.router.disposeAll();
      restarted?.jobs.disposeAll();
      restarted?.desktopEvents.stop();
      restarted?.desktopControl.dispose();
      hob.close();
    }
  });

  it("票 276 协同：report_back 附带文件后，话题继续交付并关闭时照常送回结论和文件", async () => {
    const { hob, group } = setupInspection();
    try {
      const interim = join(hob.home, "interim.csv");
      const finalFile = join(hob.home, "final.csv");
      writeFileSync(interim, "stage\ninterim\n");
      writeFileSync(finalFile, "stage\nfinal\n");
      hob.faux.setResponses([
        call("report_back", { text: "先交一份中期盘点表", files: [interim] }),
        text("已向主助手汇报中期进度"),
        text("收到中期表"),
        text("收到最终结论"),
      ]);
      const handoff = buildRouterTools(hob.runtime, "hob").find((tool) => tool.name === "message_group")!;
      await handoff.execute("c1", { groupId: group.id, title: "分阶段盘点", note: "盘点并汇总" });
      const [topic] = hob.runtime.groups.topicsOf(group.id);
      await waitFor(() =>
        hob.runtime.router.items("hob").items.some((item) => item.kind === "note" && item.text.includes("先交一份中期盘点表")),
      );
      await hob.runtime.router.waitIdle("hob");
      const midEvents = await eventTexts(hob, "hob");
      expect(midEvents.some((line) => line.includes("先交一份中期盘点表") && line.split("\n附件：")[1] === interim)).toBe(true);

      hob.runtime.groups.appendItem(topic.id, "inspector", { kind: "file", path: finalFile, name: "final.csv" });
      hob.runtime.groups.closeByOwner(topic.id, "最终盘点完成");
      await waitFor(() => Boolean(hob.runtime.store.group(topic.id)?.handover?.deliveredAt));
      const closeEvents = (await eventTexts(hob, "hob")).filter((line) => line.includes("最终盘点完成"));
      expect(closeEvents).toHaveLength(1);
      expect(closeEvents[0].split("\n附件：")[1]).toBe(finalFile);
    } finally {
      hob.close();
    }
  });

  it("安全边界：关闭话题过滤敏感路径与敏感软链，且视觉模型仅内联 safeImageFiles 允许目录内的图片", async () => {
    const hob = makeHob({}, { memory: "off", models: [{ id: "vision", input: ["text", "image"] }] });
    const outsideDir = mkdtempSync(join(tmpdir(), "hob-outside-pr31-"));
    try {
      addAssistant(hob, "inspector", "主检", "盘点");
      const group = hob.runtime.groups.create({
        name: "巡检组",
        purpose: "巡检",
        ownerId: "inspector",
        members: ["hob", "inspector"],
      });
      const png = readFileSync(new URL("../../web/public/icons/favicon-32.png", import.meta.url));
      const safePng = join(hob.home, "safe-chart.png");
      const outsidePng = join(outsideDir, "outside-secret.png");
      const envFile = join(hob.home, ".env");
      const sysDir = join(hob.home, "system");
      mkdirSync(sysDir, { recursive: true });
      const sysSecret = join(sysDir, "secrets.json");
      const symlinkToEnv = join(hob.home, "public-link.csv");
      writeFileSync(safePng, png);
      writeFileSync(outsidePng, png);
      writeFileSync(envFile, "API_KEY=secret\n");
      writeFileSync(sysSecret, "{\"token\":\"secret\"}\n");
      symlinkSync(envFile, symlinkToEnv);

      const { topic } = hob.runtime.groups.handOver(group.id, "图表汇总", "hob", { text: "输出图表", files: [] });
      hob.runtime.groups.appendItem(topic.id, "inspector", { kind: "image", status: "done", prompt: "合法图", path: safePng, startedAt: ISO });
      hob.runtime.groups.appendItem(topic.id, "inspector", { kind: "image", status: "done", prompt: "越界图", path: outsidePng, startedAt: ISO });
      hob.runtime.store.saveJob({
        id: "t-sec",
        assistantId: "inspector",
        groupId: topic.id,
        title: "安全测试任务",
        instruction: "汇总",
        status: "done",
        createdAt: ISO,
        activity: [],
        stats: { reads: 0, commands: 0, edits: 0 },
        files: [envFile, sysSecret, symlinkToEnv, safePng],
      });

      let received: UserMessage | undefined;
      hob.faux.setResponses([
        (context) => {
          received = context.messages.findLast((message) => message.role === "user");
          return text("已收到图表");
        },
      ]);
      hob.runtime.groups.closeByOwner(topic.id, "图表输出完毕");
      await waitFor(() => Boolean(hob.runtime.store.group(topic.id)?.handover?.deliveredAt));

      const savedFiles = hob.runtime.store.group(topic.id)?.handover?.resultFiles ?? [];
      expect(savedFiles).toContain(safePng);
      expect(savedFiles).not.toContain(envFile);
      expect(savedFiles).not.toContain(sysSecret);
      expect(savedFiles).not.toContain(symlinkToEnv);

      const images = Array.isArray(received?.content) ? received.content.filter((part) => part.type === "image") : [];
      // 只有 HOB_HOME 内的 safePng 被内联为图片块，目录外 outsidePng 不被内联
      expect(images).toHaveLength(1);
      expect(images[0]).toEqual({ type: "image", mimeType: "image/png", data: png.toString("base64") });
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
      hob.close();
    }
  });

  it("用户叫停（groups.stop）后，成员回合结束不唤醒群主", async () => {
    const { hob, group } = setupInspection();
    try {
      let releaseMember!: () => void;
      const memberEntered = new Promise<void>((resolve) => {
        hob.faux.setResponses([
          text("@复核 请复核盘点数据"),
          async () => {
            resolve();
            await new Promise<void>((done) => { releaseMember = done; });
            return text("复核中");
          },
        ]);
      });
      const handoff = buildRouterTools(hob.runtime, "hob").find((tool) => tool.name === "message_group")!;
      await handoff.execute("c1", { groupId: group.id, title: "叫停测试", note: "请复核数据" });
      const [topic] = hob.runtime.groups.topicsOf(group.id);
      await memberEntered;
      const stopPromise = hob.runtime.groups.stop(topic.id);
      releaseMember();
      await stopPromise;
      await hob.runtime.router.waitIdle("reviewer", 10_000, { groupId: topic.id });
      await hob.runtime.router.waitIdle("inspector", 10_000, { groupId: topic.id });
      expect(hob.faux.state.callCount).toBe(2);
    } finally {
      hob.close();
    }
  });

  it("同一委派回合里用 message_group(topic) 重新转入已关闭的群话题，委派继续等待第二次关闭", async () => {
    const { hob, group } = setupInspection();
    try {
      const f1 = join(hob.home, "round1.csv");
      const f2 = join(hob.home, "round2.csv");
      writeFileSync(f1, "a\n1\n");
      writeFileSync(f2, "b\n2\n");
      let topicId = "";
      hob.faux.setResponses([
        call("message_group", { groupId: group.id, title: "多轮盘点", note: "先查第一批" }),
        call("send_file", { path: f1 }),
        text("第一批查完"),
        () => call("message_group", { groupId: group.id, topic: topicId, note: "请补查第二批" }),
        call("send_file", { path: f2 }),
        text("第二批查完"),
        text("两批盘点都已完成"),
        text("收到全部两批结论"),
      ]);
      const delegation = await hob.runtime.delegations.start("hob", "lead", "让盘点组分两批核查");
      await waitFor(() =>
        hob.runtime.groups.topicsOf(group.id).some((topic) =>
          hob.runtime.groups.timeline(topic.id).some((item) => item.kind === "assistant" && item.text === "第一批查完"),
        ),
      );
      topicId = hob.runtime.groups.topicsOf(group.id)[0]!.id;
      hob.runtime.groups.closeByOwner(topicId, "第一批完成");
      await waitFor(() =>
        hob.runtime.groups.timeline(topicId).some((item) => item.kind === "assistant" && item.text === "第二批查完"),
      );
      // 第二批还未关闭，原委派应继续保持 running 而不提前结束
      await hob.runtime.router.waitIdle("lead");
      expect(hob.runtime.store.delegation(delegation.id)?.status).toBe("running");
      expect(hob.runtime.store.delegation(delegation.id)?.reportedAt).toBeUndefined();

      hob.runtime.groups.closeByOwner(topicId, "第二批完成");
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.reportedAt));
      expect(hob.runtime.store.delegation(delegation.id)?.status).toBe("done");
      const hobEvents = await eventTexts(hob, "hob");
      expect(hobEvents).toHaveLength(1);
      expect(hobEvents[0]).toContain("第二批完成");
      expect(hobEvents[0].split("\n附件：")[1]).toBe([f1, f2].join("、"));
    } finally {
      hob.close();
    }
  });
});
