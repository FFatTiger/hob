import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryDir } from "../src/config.ts";
import { createApp } from "../src/http.ts";
import { isValidDailyDate, MAX_MEMORY_BYTES, readLocalMemory } from "../src/local-memory.ts";
import { makeHob } from "./helpers.ts";

describe("本地记忆只读解析（兼容 pi-memory 格式）", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hob-local-mem-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("解析未带时间戳的历史段落与 pi-memory 元数据注释块", () => {
    const dir = memoryDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "MEMORY.md"),
      [
        "第一段未打标签的手写记忆。",
        "",
        "第二段未打标签的手写记忆。",
        "",
        "<!-- 2026-11-24 09:30:00 [user] -->",
        "回复尽量精简",
        "日期用 24 小时制",
        "",
        "<!-- last updated: 2026-11-25 18:12:34 [abc12345] -->",
        "项目使用 TypeScript + Vite",
        "",
        "<!-- HANDOFF 2026-11-26 08:00:00 [deadbeef] -->",
        "待确认发布窗口",
        "",
      ].join("\n"),
      "utf8",
    );

    const view = readLocalMemory(home);
    expect(view.longTerm).toHaveLength(5);
    expect(view.longTerm[0]).toMatchObject({ text: "第一段未打标签的手写记忆。" });
    expect(view.longTerm[0]?.updatedAt).toBeUndefined();
    expect(view.longTerm[1]).toMatchObject({ text: "第二段未打标签的手写记忆。" });
    expect(view.longTerm[2]).toMatchObject({
      text: "回复尽量精简\n日期用 24 小时制",
      updatedAt: "2026-11-24 09:30:00",
      source: "user",
    });
    expect(view.longTerm[3]).toMatchObject({
      text: "项目使用 TypeScript + Vite",
      updatedAt: "2026-11-25 18:12:34",
      source: "abc12345",
    });
    expect(view.longTerm[4]).toMatchObject({
      text: "待确认发布窗口",
      updatedAt: "2026-11-26 08:00:00",
      source: "deadbeef",
    });
  });

  it("解析备忘清单项及其完成状态与时间戳，忽略非清单行", () => {
    const dir = memoryDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SCRATCHPAD.md"),
      [
        "# Scratchpad",
        "",
        "## 重要说明",
        "普通说明文字。",
        "",
        "<!-- 2026-11-25 10:00:00 [abc12345] -->",
        "- [ ] 第一项",
        "<!-- 2026-11-25 11:00:00 [user] -->",
        "- [X] 第二项已完成",
        "",
      ].join("\n"),
      "utf8",
    );

    const view = readLocalMemory(home);
    expect(view.scratchpad).toHaveLength(2);
    expect(view.scratchpad[0]).toMatchObject({ text: "第一项", done: false, updatedAt: "2026-11-25 10:00:00" });
    expect(view.scratchpad[1]).toMatchObject({ text: "第二项已完成", done: true, updatedAt: "2026-11-25 11:00:00" });
  });

  it("每日记录按日期倒序列出并支持按日期读取", () => {
    const dailyDir = join(memoryDir(home), "daily");
    mkdirSync(dailyDir, { recursive: true });
    writeFileSync(join(dailyDir, "2026-11-24.md"), "<!-- 2026-11-24 20:00:00 [user] -->\n旧的一天\n", "utf8");
    writeFileSync(
      join(dailyDir, "2026-11-26.md"),
      "<!-- 2026-11-26 09:00:00 [user] -->\n上午记录\n\n<!-- 2026-11-26 15:00:00 [s1] -->\n下午记录\n",
      "utf8",
    );
    writeFileSync(join(dailyDir, "not-a-date.md"), "忽略我\n", "utf8");

    const view = readLocalMemory(home);
    expect(view.dailyDates).toEqual(["2026-11-26", "2026-11-24"]);
    expect(view.dailyDate).toBe("2026-11-26");
    expect(view.daily.map((d) => d.text)).toEqual(["上午记录", "下午记录"]);

    const older = readLocalMemory(home, "2026-11-24");
    expect(older.dailyDate).toBe("2026-11-24");
    expect(older.daily.map((d) => d.text)).toEqual(["旧的一天"]);
  });

  it("拒绝非法日期、路径穿越、符号链接和超大文件", () => {
    expect(isValidDailyDate("2026-11-26")).toBe(true);
    expect(isValidDailyDate("2026-02-29")).toBe(false);
    expect(isValidDailyDate("../MEMORY")).toBe(false);
    expect(() => readLocalMemory(home, "../etc/passwd")).toThrow("日期格式无效");

    const dir = memoryDir(home);
    mkdirSync(dir, { recursive: true });
    const outside = join(home, "outside.md");
    writeFileSync(outside, "机密\n", "utf8");
    symlinkSync(outside, join(dir, "MEMORY.md"));
    expect(() => readLocalMemory(home)).toThrow("符号链接");

    rmSync(join(dir, "MEMORY.md"));
    writeFileSync(join(dir, "MEMORY.md"), "x".repeat(MAX_MEMORY_BYTES + 1), "utf8");
    expect(() => readLocalMemory(home)).toThrow("512 KiB");
  });
});

describe("本地记忆只读 HTTP 接口", () => {
  async function signedIn(hob: ReturnType<typeof makeHob>) {
    const app = createApp(hob.runtime, { home: hob.home });
    const response = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test" }),
    });
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    const get = (url: string) => app.request(url, { headers: { cookie } });
    return { get };
  }

  it("GET /api/memory/entries 支持空状态、按日期筛选和非法日期 400", async () => {
    const hob = makeHob({}, { memory: "local" });
    try {
      const { get } = await signedIn(hob);

      const emptyRes = await get("/api/memory/entries");
      expect(emptyRes.status).toBe(200);
      expect(await emptyRes.json()).toEqual({ longTerm: [], scratchpad: [], dailyDates: [], daily: [] });

      expect((await get("/api/memory/entries?date=2026-99-99")).status).toBe(400);

      const dir = memoryDir(hob.home);
      const dailyDir = join(dir, "daily");
      mkdirSync(dailyDir, { recursive: true });
      writeFileSync(join(dir, "MEMORY.md"), "<!-- 2026-11-26 10:00:00 [user] -->\n用中文回答\n", "utf8");
      writeFileSync(join(dir, "SCRATCHPAD.md"), "- [ ] 买咖啡豆\n- [x] 备份照片\n", "utf8");
      writeFileSync(join(dailyDir, "2026-11-26.md"), "<!-- 2026-11-26 12:00:00 [user] -->\n今天的日志\n", "utf8");

      const fullRes = await get("/api/memory/entries?date=2026-11-26");
      expect(fullRes.status).toBe(200);
      const data = await fullRes.json();
      expect(data.longTerm).toHaveLength(1);
      expect(data.longTerm[0].text).toBe("用中文回答");
      expect(data.scratchpad).toHaveLength(2);
      expect(data.dailyDates).toEqual(["2026-11-26"]);
      expect(data.daily[0].text).toBe("今天的日志");
    } finally {
      hob.close();
    }
  });
});
