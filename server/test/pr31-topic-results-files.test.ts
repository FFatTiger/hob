import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Assistant, Group } from "../../shared/types.ts";
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
