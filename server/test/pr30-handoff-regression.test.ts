import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
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
