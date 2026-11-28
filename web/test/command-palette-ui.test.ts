import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser, type Page } from "playwright-core";

let server: ViteDevServer;
let cacheDir: string;
let browser: Browser;
let page: Page;
let base: string;
const TIMEOUT = 90_000;

beforeAll(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), "hob-cmdk-vite-"));
  server = await createServer({ cacheDir, server: { port: 0, host: "127.0.0.1" } });
  await server.listen();
  await server.transformRequest("/src/main.tsx");
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("测试服务器没有端口");
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  page = await browser.newPage({ locale: "zh-CN" });
  page.setDefaultTimeout(60_000);
});

afterAll(async () => {
  await page?.close();
  await browser?.close();
  await server?.close();
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});

async function dismissPushPrompt() {
  const later = page.getByRole("button", { name: "暂不开启" });
  if (await later.isVisible().catch(() => false)) await later.click();
}

describe("命令面板与消息定位端到端", () => {
  it("桌面：侧栏搜索框与快捷键打开面板，键盘导航、防抖搜消息并定位居中高亮较早消息", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/?mock=1&lang=zh-CN`, { waitUntil: "load" });
    await dismissPushPrompt();

    // 侧栏搜索框点击打开命令面板
    await page.locator(".side-top .search").click();
    const dialog = page.getByRole("dialog", { name: "快速跳转" });
    await expect.poll(() => dialog.isVisible()).toBe(true);

    // 命令面板打开时，全局快捷键不触发（不折叠左栏、不回首页）
    const beforeHash = await page.evaluate(() => location.hash);
    await page.keyboard.press("Control+Backslash");
    await page.keyboard.press("Control+Shift+H");
    expect(await page.locator(".app.side-collapsed").count()).toBe(0);
    expect(await page.evaluate(() => location.hash)).toBe(beforeHash);

    // Esc 关闭
    await page.keyboard.press("Escape");
    await expect.poll(() => dialog.isVisible()).toBe(false);

    // Ctrl+K 打开并搜索较早消息关键词「背压」
    await page.keyboard.press("Control+k");
    await expect.poll(() => dialog.isVisible()).toBe(true);
    const input = dialog.locator("input");
    await input.fill("背压");

    // 命中片段带高亮且归在「消息」组下
    const hitRow = dialog.locator('[role="option"]', { hasText: "背压" });
    await expect.poll(() => hitRow.count()).toBeGreaterThan(0);
    await expect.poll(() => dialog.locator(".cmdk-group", { hasText: "消息" }).isVisible()).toBe(true);
    expect(await hitRow.first().locator("mark.cmdk-hit").textContent()).toBe("背压");

    // 上下键选择后回车跳转
    await page.keyboard.press("ArrowDown");
    const activeId = await input.getAttribute("aria-activedescendant");
    expect(activeId).toBeTruthy();
    await page.keyboard.press("ArrowUp");
    expect(await input.getAttribute("aria-activedescendant")).toBe("cmdk-opt-0");

    await page.keyboard.press("Enter");
    await expect.poll(() => dialog.isVisible()).toBe(false);

    // 目标消息（位于更早分页）已加载并居中滚进可见区，且停留不回弹到底部
    const target = page.locator('[data-item-id="i-bk-old-1"]');
    await expect.poll(() => target.count()).toBe(1);
    await page.waitForTimeout(300);

    const pos = await page.evaluate(() => {
      const container = document.querySelector<HTMLElement>(".msgs")!;
      const row = document.querySelector<HTMLElement>('[data-item-id="i-bk-old-1"]')!;
      const cr = container.getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      const mid = rr.top + rr.height / 2;
      return {
        scrollTop: container.scrollTop,
        maxTop: container.scrollHeight - container.clientHeight,
        inVisibleMiddle: mid > cr.top + 80 && mid < cr.bottom - 80,
      };
    });
    expect(pos.inVisibleMiddle).toBe(true);
    expect(pos.scrollTop).toBeLessThan(pos.maxTop - 200);

    // 跳到某条消息后，浏览器后退回到原来的对话
    const jumpedHash = await page.evaluate(() => location.hash);
    expect(jumpedHash).not.toBe(beforeHash);
    await page.goBack();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(beforeHash);
  }, TIMEOUT);

  it("手机：首页搜索入口全屏打开命令面板并能定位较早消息", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/?mock=1&lang=zh-CN`, { waitUntil: "load" });
    await dismissPushPrompt();

    await page.locator('.mhead button[title="搜索对话和消息"]').click();
    const dialog = page.getByRole("dialog", { name: "快速跳转" });
    await expect.poll(() => dialog.isVisible()).toBe(true);

    // 手机上卡片全屏铺满
    const box = await dialog.locator(".cmdk-card").boundingBox();
    expect(box?.width).toBe(390);
    expect(box?.height).toBe(844);

    await dialog.locator("input").fill("背压");
    const hitRow = dialog.locator('[role="option"]', { hasText: "背压" });
    await expect.poll(() => hitRow.count()).toBeGreaterThan(0);
    await hitRow.first().click();

    await expect.poll(() => dialog.isVisible()).toBe(false);
    const target = page.locator('[data-item-id="i-bk-old-1"]');
    await expect.poll(() => target.count()).toBe(1);
    await page.waitForTimeout(300);

    const inView = await page.evaluate(() => {
      const container = document.querySelector<HTMLElement>(".mmsgs")!;
      const row = document.querySelector<HTMLElement>('[data-item-id="i-bk-old-1"]')!;
      const cr = container.getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      return rr.top >= cr.top && rr.bottom <= cr.bottom;
    });
    expect(inView).toBe(true);
  }, TIMEOUT);
});
