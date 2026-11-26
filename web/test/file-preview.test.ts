import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser } from "playwright-core";
import { fileIcon } from "../src/file-icons.ts";
import { numericColumns } from "../src/csv-columns.ts";

describe("文件图标", () => {
  it.each([
    ["/tmp/a.PNG", "image"], ["a.csv", "table"], ["a.tsv", "table"], ["a.xlsx", "table"],
    ["a.ts", "code"], ["a.py", "code"], ["a.json", "code"], ["a.yaml", "code"],
    ["a.md", "doc"], ["a.pdf", "doc"], ["a.docx", "doc"], ["a.html", "globe"],
    ["a.svg", "globe"], ["a.tar.gz", "archive"], ["a.zip", "archive"],
    ["dir.with.dot/no-extension", "file"], [".env", "file"], ["a.unknown", "file"],
    ["C:\\dir\\file.JS", "code"],
  ])("%s → %s", (name, icon) => expect(fileIcon(name)).toBe(icon));
});

describe("数字列", () => {
  it("只对所有数据行都是有限数字的列右对齐", () => {
    expect(numericColumns([
      ["名称", "数量", "变化", "缺失", "混合"],
      ["甲", " 12 ", "-1.5e2", "1", "2"],
      ["乙", "0", ".25", "", "无"],
    ])).toEqual([false, true, true, false, false]);
  });
  it("没有数据、不完整行和非十进制数不算数字列", () => {
    expect(numericColumns([])).toEqual([]);
    expect(numericColumns([["数字"]])).toEqual([false]);
    expect(numericColumns([["甲", "乙", "丙"], ["0x10", "Infinity", "1"], ["2", "3"]])).toEqual([false, false, false]);
  });
});

describe("Markdown 预览表格自适应", () => {
  let server: ViteDevServer;
  let browser: Browser;
  let base: string;
  const BROWSER_TEST_TIMEOUT = 90_000;

  const sampleMd = `# 观测设备对比

| 设备编号 | 适用场景 | 详细说明 | 连续运行时长与维护周期 |
| --- | --- | --- | --- |
| \`spectro-alpha-v2\` | 高原夜间连续观测与自动校准 | 用于广域光谱采集与自动校准；在低温干燥环境下可连续运行八小时以上，支持远程校准参数与分段缓存导出。 | 连续运行 12 小时，每季度校准一次光学基准 |
| \`photometer-mini\` | 便携巡检与多点快速核验 | 轻量级光度测量模块，适合快速定点核验与多点对比。 | 连续运行 6 小时，每半年清洁一次滤光片 |

| 项目 | 地球 | 火星 |
| --- | --- | --- |
| 大气压 | 1013 hPa | 约 6 hPa |
`;

  beforeAll(async () => {
    server = await createServer({ server: { port: 0, host: "127.0.0.1" } });
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("测试服务器没有端口");
    base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  }, BROWSER_TEST_TIMEOUT);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  async function openMdPreview(options: Parameters<Browser["newContext"]>[0]) {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    page.setDefaultNavigationTimeout(60_000);
    await page.route((url) => decodeURIComponent(url.pathname).endsWith("/火星日落示意图.md"), (route) =>
      route.fulfill({ status: 200, contentType: "text/markdown; charset=utf-8", body: sampleMd }),
    );
    await page.goto(`${base}/?mock=1&lang=zh-CN&scene=bubbles`, { waitUntil: "load" });
    await page.locator(".filecard", { hasText: "火星日落示意图.md" }).click();
    await page.locator(".fp-md").waitFor();
    return { context, page };
  }

  it("桌面展开后表格铺满可用宽度，长列不再卡在窄栏里", async () => {
    const { context, page } = await openMdPreview({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
    try {
      await page.locator(".fp-wide-btn").click();
      const metrics = await page.evaluate(() => {
        const md = document.querySelector(".fp-md")!;
        const tables = [...md.querySelectorAll(".md-table table")];
        return {
          mdWidth: md.clientWidth,
          tables: tables.map((table) => {
            const row = table.querySelector("tr")!;
            const cells = [...row.children];
            return {
              display: getComputedStyle(table).display,
              rowWidth: row.getBoundingClientRect().width,
              wideCellWidth: cells[2]!.getBoundingClientRect().width,
            };
          }),
        };
      });
      expect(metrics.mdWidth).toBeGreaterThan(900);
      for (const table of metrics.tables) {
        expect(table.display).toBe("table");
        expect(table.rowWidth).toBeGreaterThanOrEqual(metrics.mdWidth - 2);
      }
      expect(metrics.tables[0]!.wideCellWidth).toBeGreaterThan(400);
    } finally {
      await context.close();
    }
  }, BROWSER_TEST_TIMEOUT);

  it("未展开窄面板和手机视口下，宽表格在框内横向滚动而不撑破布局", async () => {
    for (const view of [
      { viewport: { width: 1440, height: 900 }, locale: "zh-CN" },
      { viewport: { width: 390, height: 844 }, locale: "zh-CN", isMobile: true, hasTouch: true },
    ]) {
      const { context, page } = await openMdPreview(view);
      try {
        const metrics = await page.evaluate(() => {
          const body = document.querySelector(".fp-body")!;
          const wraps = [...document.querySelectorAll(".fp-md .md-table")];
          const secondRow = wraps[1]!.querySelector("tr")!;
          return {
            bodyClientWidth: body.clientWidth,
            bodyScrollWidth: body.scrollWidth,
            firstWrapClientWidth: wraps[0]!.clientWidth,
            firstWrapScrollWidth: wraps[0]!.scrollWidth,
            secondRowWidth: secondRow.getBoundingClientRect().width,
            secondWrapClientWidth: wraps[1]!.clientWidth,
          };
        });
        expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.bodyClientWidth + 1);
        expect(metrics.firstWrapScrollWidth).toBeGreaterThan(metrics.firstWrapClientWidth);
        expect(metrics.secondRowWidth).toBeGreaterThanOrEqual(metrics.secondWrapClientWidth - 2);
      } finally {
        await context.close();
      }
    }
  }, BROWSER_TEST_TIMEOUT);
});
