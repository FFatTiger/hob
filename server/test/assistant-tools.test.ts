import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Assistant } from "../../shared/types.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { makeHob, type TestHob } from "./helpers.ts";

function tool(hob: TestHob, who: string, name: string) {
  const found = buildRouterTools(hob.runtime, who).find((item) => item.name === name);
  if (!found) throw new Error(`没有工具：${name}`);
  return found;
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((part) => part.text ?? "").join("");
}

/** 再造一个助手：和 hob 同样的字段，换个 id / 名字。 */
function addOps(hob: TestHob, patch: Partial<Assistant> = {}): Assistant {
  const primary = hob.runtime.store.assistant("hob")!;
  const ops: Assistant = {
    ...primary,
    id: "ops",
    name: "运维",
    duty: "服务器",
    dutyLong: "旧的详细职责",
    instructions: "旧的补充说明",
    primary: false,
    pinned: false,
    hidden: true,
    createdAt: new Date().toISOString(),
    ...patch,
  };
  hob.runtime.store.saveAssistant(ops);
  return ops;
}

describe("list_assistants", () => {
  it("包含收起的助手，出一张列表卡", async () => {
    const hob = makeHob();
    try {
      addOps(hob);
      const result = await tool(hob, "hob", "list_assistants").execute("call-1", {});
      const text = textOf(result as never);
      expect(text).toContain("Hob（hob）");
      expect(text).toContain("运维（ops）：服务器");
      // 收起的助手不能从列表里消失：否则「把助手藏起来」就等于让 Hob 失忆
      expect(text).toContain("已收起");
      const card = hob.runtime.router.items("hob").items.find((item) => item.kind === "assistants");
      expect(card).toMatchObject({ kind: "assistants", ids: expect.arrayContaining(["hob", "ops"]) });
      expect(hob.runtime.router.items("hob").items.filter((item) => item.kind === "assistants")).toHaveLength(1);
    } finally { hob.close(); }
  });

  it("置顶的排在前面", async () => {
    const hob = makeHob();
    try {
      addOps(hob, { pinned: true, pinOrder: 0 });
      const result = await tool(hob, "hob", "list_assistants").execute("call-1", {});
      const text = textOf(result as never);
      expect(text.indexOf("运维（ops）")).toBeLessThan(text.indexOf("Hob（hob）"));
    } finally { hob.close(); }
  });
});

describe("get_assistant", () => {
  it("给出完整资料，带一张详情卡", async () => {
    const hob = makeHob();
    try {
      addOps(hob);
      const result = await tool(hob, "hob", "get_assistant").execute("call-1", { assistantId: "ops" });
      const text = textOf(result as never);
      expect(text).toContain("名字：运维");
      expect(text).toContain("详细职责：旧的详细职责");
      expect(text).toContain("补充说明：旧的补充说明");
      expect(text).toContain("收起：是");
      expect(text).toContain("模型：跟随设置");
      expect(hob.runtime.router.items("hob").items.some((item) => item.kind === "assistantDetail" && item.assistantId === "ops")).toBe(true);
    } finally { hob.close(); }
  });

  it("助手不存在时失败，不出卡片", async () => {
    const hob = makeHob();
    try {
      const result = await tool(hob, "hob", "get_assistant").execute("call-1", { assistantId: "nope" }) as { isError?: boolean };
      expect(result.isError).toBe(true);
      expect(hob.runtime.router.items("hob").items.some((item) => item.kind === "assistantDetail")).toBe(false);
    } finally { hob.close(); }
  });
});

describe("update_assistant", () => {
  it("改资料、留旧值备份、留一行灰字", async () => {
    const hob = makeHob();
    try {
      addOps(hob);
      const events: string[] = [];
      hob.runtime.bus.subscribe((event) => events.push(event.type));
      const result = await tool(hob, "hob", "update_assistant").execute("call-1", {
        assistantId: "ops",
        duty: "服务器和网络",
        dutyLong: "管 NAS 和路由器",
        instructions: "公网 IP 每周变一次",
        pinned: true,
        hidden: false,
      });
      const text = textOf(result as never);
      expect(text).toContain("已改「运维」");
      expect(text).toContain("职责简介");
      expect(text).toContain("详细职责");
      expect(text).toContain("补充说明");
      expect(text).toContain("收起");
      expect(events).toContain("assistant");

      const saved = hob.runtime.store.assistant("ops")!;
      expect(saved.duty).toBe("服务器和网络");
      expect(saved.dutyLong).toBe("管 NAS 和路由器");
      expect(saved.instructions).toBe("公网 IP 每周变一次");
      expect(saved.pinned).toBe(true);
      expect(saved.hidden).toBe(false);

      // 旧值留档：backups 目录里那份还是改之前的样子
      const backups = join(hob.home, "assistants", "ops", "backups");
      const files = readdirSync(backups);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^profile-.*\.json$/);
      const old = JSON.parse(readFileSync(join(backups, files[0]), "utf8")) as Assistant;
      expect(old.duty).toBe("服务器");
      expect(old.dutyLong).toBe("旧的详细职责");
      expect(old.instructions).toBe("旧的补充说明");
      expect(old.hidden).toBe(true);
      expect(text).toContain(join(backups, files[0]));

      // 对话里留一行灰字，告诉用户改了什么
      const note = hob.runtime.router.items("hob").items.find((item) => item.kind === "note" && item.text.includes("已改「运维」"));
      expect(note).toBeTruthy();
    } finally { hob.close(); }
  });

  it("没有实际改动时不写备份", async () => {
    const hob = makeHob();
    try {
      addOps(hob);
      const result = await tool(hob, "hob", "update_assistant").execute("call-1", { assistantId: "ops", duty: "服务器" });
      expect(textOf(result as never)).toContain("没有改动");
      expect(existsSync(join(hob.home, "assistants", "ops", "backups"))).toBe(false);
    } finally { hob.close(); }
  });

  it("校验：空名字、未知助手、收起主助手、未知知识库都拒绝，也不留备份", async () => {
    const hob = makeHob();
    try {
      addOps(hob);
      const update = tool(hob, "hob", "update_assistant");
      const failing = async (params: Record<string, unknown>) => {
        const result = await update.execute("call-1", params) as { isError?: boolean };
        expect(result.isError).toBe(true);
        return textOf(result as never);
      };
      expect(await failing({ assistantId: "ops", name: "  " })).toContain("名字不能为空");
      expect(await failing({ assistantId: "nope", name: "别的" })).toContain("没有这个助手");
      expect(await failing({ assistantId: "hob", hidden: true })).toContain("主助手不能收起");
      expect(await failing({ assistantId: "ops", knowledge: ["missing"] })).toContain("知识库不存在");
      expect(await failing({ assistantId: "ops" })).toContain("没给要改的字段");
      expect(hob.runtime.store.assistant("ops")!.duty).toBe("服务器");
      expect(existsSync(join(hob.home, "assistants", "ops", "backups"))).toBe(false);
    } finally { hob.close(); }
  });

  it("只有主助手有这三个工具，别的助手连工具都看不到", () => {
    const hob = makeHob();
    try {
      addOps(hob);
      const names = (who: string) => buildRouterTools(hob.runtime, who).map((item) => item.name);
      expect(names("hob")).toEqual(expect.arrayContaining(["list_assistants", "get_assistant", "update_assistant"]));
      expect(names("ops")).not.toContain("list_assistants");
      expect(names("ops")).not.toContain("update_assistant");
    } finally { hob.close(); }
  });
});

describe("界面的逐字段保存不写备份", () => {
  it("PATCH 改完没有 backups 目录（否则每敲一次都留一份）", async () => {
    const hob = makeHob();
    try {
      addOps(hob);
      const { createApp } = await import("../src/http.ts");
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      const response = await app.request("/api/assistants/ops", {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ duty: "界面改的" }),
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { assistant: Assistant }).assistant.duty).toBe("界面改的");
      expect(existsSync(join(hob.home, "assistants", "ops", "backups"))).toBe(false);
    } finally { hob.close(); }
  });
});
