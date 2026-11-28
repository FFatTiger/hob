import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatConversationMarkdown,
  safeExportFilename,
} from "../../shared/export-markdown.ts";
import { createApp } from "../src/http.ts";
import { makeHob } from "./helpers.ts";

describe("Markdown 导出格式化工具", () => {
  it("safeExportFilename 过滤非法字符、保留中文、限制超长文件名并附加日期后缀", () => {
    expect(safeExportFilename("技术/方案:v1.2", "2026-11-26")).toBe("技术-方案-v1-2-2026-11-26.md");
    expect(safeExportFilename("   ", "2026-11-26")).toBe("conversation-2026-11-26.md");
    const longTitle = "仓储盘点与季度对账协作专项讨论记录".repeat(4);
    const longName = safeExportFilename(longTitle, "2026-11-26");
    expect(longName).toMatch(/-2026-11-26\.md$/);
    expect(Array.from(longName.replace(/-2026-11-26\.md$/, "")).length).toBeLessThanOrEqual(40);
  });

  it("formatConversationMarkdown 格式化标题、元信息、引用、附件并保留缩进代码块", () => {
    const md = formatConversationMarkdown({
      title: "Hob",
      subtitle: "主助手",
      exportedAt: "2026-11-26 14:30:00",
      messages: [
        { speaker: "用户", at: "2026-11-26 14:00:00", text: "帮我看看这份文档", files: ["需求.pdf"] },
        { speaker: "Hob", at: "2026-11-26 14:01:00", text: "\n    const x = 1;\n    const y = 2;\n", quote: "帮我看看这份文档" },
      ],
    });
    expect(md).toContain("# Hob");
    expect(md).toContain("> 主助手 · 导出时间：2026-11-26 14:30:00");
    expect(md).toContain("### 用户 · 2026-11-26 14:00:00");
    expect(md).toContain("_附件：需求.pdf_");
    expect(md).toContain("### Hob · 2026-11-26 14:01:00");
    expect(md).toContain("> 引用：帮我看看这份文档");
    expect(md).toContain("\n    const x = 1;\n    const y = 2;\n");
    expect(md).toContain("\n---\n");

    const emptyMd = formatConversationMarkdown({
      title: "空对话",
      exportedAt: "2026-11-26 14:30:00",
      messages: [],
    });
    expect(emptyMd).toContain("（暂无消息）");
  });
});

describe("完整对话导出 HTTP 接口", () => {
  async function signedIn(hob: ReturnType<typeof makeHob>) {
    const app = createApp(hob.runtime, { home: hob.home });
    const response = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test" }),
    });
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    const get = (url: string) => app.request(url, { headers: { cookie } });
    return { app, get };
  }

  it("未登录调用导出接口返回 401", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      expect((await app.request("/api/assistants/hob/export")).status).toBe(401);
      expect((await app.request("/api/groups/g-1/export")).status).toBe(401);
    } finally {
      hob.close();
    }
  });

  it("GET /api/assistants/:id/export 导出超过 50 条的完整历史并在缺失时返回 404", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const { get } = await signedIn(hob);
      expect((await get("/api/assistants/not-exist/export")).status).toBe(404);

      // 直接写入 60 条对话消息（30 轮），验证不被 /items 默认 50 条截断
      const file = hob.runtime.store.routerFile("hob");
      mkdirSync(dirname(file), { recursive: true });
      const lines: string[] = [
        JSON.stringify({ type: "session", version: 3, id: "s-export", timestamp: "2026-11-26T00:00:00.000Z", cwd: hob.home }),
      ];
      let parentId: string | null = null;
      for (let i = 1; i <= 30; i++) {
        const uId = `u-${i}`;
        const aId = `a-${i}`;
        const uTs = new Date(Date.UTC(2026, 10, 26, 0, i, 0)).toISOString();
        const aTs = new Date(Date.UTC(2026, 10, 26, 0, i, 30)).toISOString();
        lines.push(JSON.stringify({
          type: "custom",
          customType: "hob.user",
          id: uId,
          parentId,
          timestamp: uTs,
          data: { text: `用户问题第 ${i} 条` },
        }));
        lines.push(JSON.stringify({
          type: "message",
          id: aId,
          parentId: uId,
          timestamp: aTs,
          message: { role: "assistant", content: [{ type: "text", text: `助手回复第 ${i} 条` }], timestamp: Date.parse(aTs) },
        }));
        parentId = aId;
      }
      writeFileSync(file, `${lines.join("\n")}\n`, "utf8");

      const res = await get("/api/assistants/hob/export");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { filename: string; content: string };
      expect(data.filename).toMatch(/^Hob-\d{4}-\d{2}-\d{2}\.md$/);
      expect(data.content).toContain("# Hob");
      expect(data.content).toContain("用户问题第 1 条");
      expect(data.content).toContain("助手回复第 30 条");
      expect((data.content.match(/^### /gm) ?? []).length).toBe(60);
    } finally {
      hob.close();
    }
  });

  it("GET /api/assistants/:id/export?topicId=... 导出助手话题且不与主对话串扰", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const { get } = await signedIn(hob);
      const assistant = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...assistant, topics: true });
      const { topic } = await hob.runtime.assistantTopics.create("hob", { title: "季度复盘" });

      // 分别写入主对话与话题对话记录
      const mainFile = hob.runtime.store.routerFile("hob");
      mkdirSync(dirname(mainFile), { recursive: true });
      writeFileSync(
        mainFile,
        [
          JSON.stringify({ type: "session", version: 3, id: "s-main", timestamp: "2026-11-26T00:00:00.000Z", cwd: hob.home }),
          JSON.stringify({ type: "custom", customType: "hob.user", id: "m-1", parentId: null, timestamp: "2026-11-26T00:01:00.000Z", data: { text: "主对话专属内容" } }),
        ].join("\n") + "\n",
        "utf8",
      );

      const topicFile = hob.runtime.store.assistantTopicRouterFile("hob", topic.id);
      mkdirSync(dirname(topicFile), { recursive: true });
      writeFileSync(
        topicFile,
        [
          JSON.stringify({ type: "session", version: 3, id: "s-topic", timestamp: "2026-11-26T00:00:00.000Z", cwd: hob.home }),
          JSON.stringify({ type: "custom", customType: "hob.user", id: "t-1", parentId: null, timestamp: "2026-11-26T00:02:00.000Z", data: { text: "话题专属复盘要点" } }),
        ].join("\n") + "\n",
        "utf8",
      );

      expect((await get("/api/assistants/hob/export?topicId=missing")).status).toBe(404);

      const topicRes = await get(`/api/assistants/hob/export?topicId=${encodeURIComponent(topic.id)}`);
      expect(topicRes.status).toBe(200);
      const topicData = (await topicRes.json()) as { filename: string; content: string };
      expect(topicData.filename).toMatch(/^Hob-季度复盘-\d{4}-\d{2}-\d{2}\.md$/);
      expect(topicData.content).toContain("# Hob · 季度复盘");
      expect(topicData.content).toContain("话题专属复盘要点");
      expect(topicData.content).not.toContain("主对话专属内容");

      const mainRes = await get("/api/assistants/hob/export");
      expect(mainRes.status).toBe(200);
      const mainData = (await mainRes.json()) as { filename: string; content: string };
      expect(mainData.content).toContain("主对话专属内容");
      expect(mainData.content).not.toContain("话题专属复盘要点");
    } finally {
      hob.close();
    }
  });

  it.each(["单聊", "群聊"])("%s导出保留任务、卡片、文件、图片与提问卡交付内容", async (scope) => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const { get } = await signedIn(hob);
      const gid = scope === "群聊" ? hob.runtime.groups.create({ name: "核账组", purpose: "核账", ownerId: "hob", members: ["hob"] }).id : undefined;
      const createdAt = new Date().toISOString();
      hob.runtime.store.saveJob({
        id: "t-export",
        assistantId: "hob",
        groupId: gid,
        title: "核账",
        instruction: "读取账本",
        status: "failed",
        statusReason: "找不到账本",
        createdAt,
        stats: { reads: 0, commands: 0, edits: 0 },
        activity: [],
      });
      await hob.runtime.router.addItem("hob", { kind: "job", jobId: "t-export" }, gid ? { groupId: gid } : undefined);
      await hob.runtime.router.addCard("hob", {
        id: "c-export",
        owner: { type: "assistant", assistantId: "hob" },
        status: "done",
        createdAt,
        card: { header: { title: "核账单" }, config: { summary: { content: "明细已复核" } }, body: { elements: [] } },
      }, gid ? { groupId: gid } : undefined);
      const reportPath = join(hob.home, "report.pdf");
      const trendPath = join(hob.home, "trend.png");
      writeFileSync(reportPath, "pdf", "utf8");
      writeFileSync(trendPath, "png", "utf8");
      await hob.runtime.router.addItem("hob", {
        kind: "file",
        path: reportPath,
        name: "report.pdf",
        meta: "3200 字",
      }, gid ? { groupId: gid } : undefined);
      await hob.runtime.router.addItem("hob", {
        kind: "image",
        prompt: "月度趋势图",
        startedAt: createdAt,
        status: "done",
        path: trendPath,
      }, gid ? { groupId: gid } : undefined);
      hob.runtime.store.saveApproval({
        id: "ap-export",
        assistantId: "hob",
        title: "是否归档本月账单？",
        options: [{ key: "A", label: "确认归档" }, { key: "B", label: "暂不" }],
        status: "answered",
        chosen: "A",
        source: "router",
        ...(gid ? { groupId: gid } : {}),
        createdAt,
      });
      await hob.runtime.router.addItem("hob", {
        kind: "question",
        approvalId: "ap-export",
      }, gid ? { groupId: gid } : undefined);

      const res = await get(gid ? `/api/groups/${gid}/export` : "/api/assistants/hob/export");
      expect(res.status).toBe(200);
      const { content } = (await res.json()) as { content: string };
      expect(content).toContain("核账\n\n找不到账本");
      expect(content).toContain("卡片「核账单」：明细已复核");
      expect(content).toContain("_附件：report.pdf_");
      expect(content).toContain("3200 字");
      expect(content).toContain("_附件：trend.png_");
      expect(content).toContain("图片：月度趋势图");
      expect(content).toContain("是否归档本月账单？");
      expect(content).toContain("已回答：确认归档");
    } finally {
      hob.close();
    }
  });

  it("GET /api/groups/:id/export 导出完整群聊与话题并在缺失时返回 404", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const { get } = await signedIn(hob);
      expect((await get("/api/groups/g-missing/export")).status).toBe(404);

      const group = hob.runtime.groups.create({ name: "研发组", purpose: "技术评审", ownerId: "hob", members: ["hob"] });
      const topic = hob.runtime.groups.createTopic(group.id, "内存优化", "user");
      await hob.runtime.router.addItem("hob", { kind: "topic", topicId: topic.id }, { groupId: group.id });

      for (let i = 1; i <= 55; i++) {
        hob.runtime.store.appendGroupItem(topic.id, {
          kind: "user",
          id: `g-bulk-${i}`,
          at: new Date(Date.UTC(2026, 10, 26, 7, i, 0)).toISOString(),
          speaker: "user",
          text: `批量消息 ${i}`,
        });
      }
      hob.runtime.store.appendGroupItem(topic.id, {
        kind: "user",
        id: "g-1",
        at: "2026-11-26T08:00:00.000Z",
        speaker: "user",
        text: "我们来排查内存占用",
      });
      hob.runtime.store.appendGroupItem(topic.id, {
        kind: "note",
        id: "g-2",
        at: "2026-11-26T08:00:10.000Z",
        speaker: "hob",
        icon: "info",
        text: "系统提示不应作为普通消息混入",
      });
      hob.runtime.store.appendGroupItem(topic.id, {
        kind: "assistant",
        id: "g-3",
        at: "2026-11-26T08:01:00.000Z",
        speaker: "hob",
        text: "先从堆快照看起。",
        quote: { itemId: "g-1", text: "我们来排查内存占用" },
      });

      const res = await get(`/api/groups/${topic.id}/export`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { filename: string; content: string };
      expect(data.filename).toMatch(/^研发组-内存优化-\d{4}-\d{2}-\d{2}\.md$/);
      expect(data.content).toContain("# 研发组 · 内存优化");
      expect(data.content).toContain("批量消息 1");
      expect(data.content).toContain("批量消息 55");
      expect(data.content).toContain("### 用户 · ");
      expect(data.content).toContain("### Hob · ");
      expect(data.content).toContain("> 引用：我们来排查内存占用");
      expect(data.content).not.toContain("系统提示不应作为普通消息混入");

      const generalRes = await get(`/api/groups/${group.id}/export`);
      expect(generalRes.status).toBe(200);
      const generalData = (await generalRes.json()) as { filename: string; content: string };
      expect(generalData.content).toContain("# 研发组");
      expect(generalData.content).toContain("创建了话题「内存优化」");
    } finally {
      hob.close();
    }
  });

  it("导出包含待办历史、转交、助手草稿、多轮任务与内部备注过滤", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const { get } = await signedIn(hob);
      const createdAt = new Date().toISOString();
      hob.runtime.store.saveAssistant({
        id: "reviewer",
        name: "审校",
        duty: "文稿审校",
        sprite: "page",
        primary: false,
        pinned: false,
        hidden: false,
        notify: false,
        createdAt,
      });
      const specPath = join(hob.home, "u-abc123-排版规范.md");
      writeFileSync(specPath, "spec", "utf8");
      hob.runtime.store.saveDelegation({
        id: "dg-export",
        from: "hob",
        to: "reviewer",
        text: "请核对最终版目录和术语",
        files: [specPath],
        createdAt,
        status: "done",
        jobIds: [],
        reply: "术语已统一，目录页码无误。",
      });
      hob.runtime.store.saveDraft({
        id: "dr-export",
        assistantId: "hob",
        status: "created",
        name: "排版助手",
        sprite: "doc",
        duty: "处理排版",
        dutyLong: "负责技术文档的版式与目录校准",
        routines: [],
        routinesText: "",
        askFirst: [],
        createdAssistantId: "reviewer",
        createdAt,
      });
      hob.runtime.store.saveJob({
        id: "t-multi",
        assistantId: "hob",
        title: "整理交付清单",
        instruction: "整理",
        status: "done",
        summary: "第 2 轮已补全验收项",
        createdAt,
        stats: { reads: 0, commands: 0, edits: 0 },
        activity: [],
        rounds: [
          { status: "done", summary: "第 1 轮初稿完成", startedAt: createdAt, endedAt: createdAt },
          { status: "done", summary: "第 2 轮已补全验收项", startedAt: createdAt, endedAt: createdAt },
        ],
      });

      await hob.runtime.router.addItem("hob", { kind: "note", icon: "info", text: "内部备注不应该出现在导出里" });
      await hob.runtime.router.addItem("hob", {
        kind: "todos",
        why: "done",
        items: [
          { text: "核对章节编号", status: "done" },
          { text: "确认图表说明", status: "doing" },
          { text: "导出归档", status: "todo" },
        ],
      });
      await hob.runtime.router.addItem("hob", { kind: "delegation", delegationId: "dg-export" });
      await hob.runtime.router.addItem("hob", { kind: "draft", draftId: "dr-export" });
      await hob.runtime.router.addItem("hob", { kind: "job", jobId: "t-multi", round: 0 });

      const res = await get("/api/assistants/hob/export");
      expect(res.status).toBe(200);
      const { content } = (await res.json()) as { content: string };
      expect(content).not.toContain("内部备注不应该出现在导出里");
      expect(content).toContain("待办已完成");
      expect(content).toContain("- [x] 核对章节编号");
      expect(content).toContain("- [ ] 确认图表说明（进行中）");
      expect(content).toContain("- [ ] 导出归档");
      expect(content).toContain("转交给「审校」（已完成）");
      expect(content).toContain("请核对最终版目录和术语");
      expect(content).toContain("回复：术语已统一，目录页码无误。");
      expect(content).toContain("_附件：排版规范.md_");
      expect(content).toContain("排版助手（新助手 · 已创建）");
      expect(content).toContain("负责技术文档的版式与目录校准");
      expect(content).toContain("整理交付清单\n\n第 1 轮初稿完成");
    } finally {
      hob.close();
    }
  });
});
