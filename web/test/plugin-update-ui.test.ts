import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser, type Page } from "playwright-core";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let baseUrl: string;

beforeAll(async () => {
  server = await createServer({ server: { port: 0, host: "127.0.0.1" } });
  await server.listen();
  const addr = server.httpServer?.address() as import("node:net").AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  page.setDefaultTimeout(30_000);
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe("插件更新提示与详情页更新交互", () => {
  it("左栏、插件列表与详情页显示有新版本，点击更新后消失", async () => {
    await page.goto(`${baseUrl}/?mock=1&lang=zh-CN`);

    const sidebarPluginsDot = page.locator(".side-foot .frow", { hasText: "插件" }).locator(".update-dot");
    await expect.poll(() => sidebarPluginsDot.getAttribute("title")).toBe("1 个插件有新版本");

    await page.locator(".side-foot .frow", { hasText: "插件" }).click();
    const githubNavRow = page.locator(".plugin-navrow", { hasText: "GitHub" });
    await expect.poll(() => githubNavRow.locator(".update-dot").getAttribute("title")).toBe("有新版本 1.2.0");

    await githubNavRow.click();
    const updateRow = page.locator(".plugin-update-row");
    await expect.poll(() => updateRow.isVisible()).toBe(true);
    expect(await updateRow.textContent()).toContain("有新版本 1.2.0");

    await updateRow.getByRole("button", { name: "更新" }).click();
    await expect.poll(() => updateRow.count()).toBe(0);
    await expect.poll(() => githubNavRow.locator(".update-dot").count()).toBe(0);

    await page.locator(".setnav-head button[aria-label='返回 Hob']").click();
    await expect.poll(() => sidebarPluginsDot.count()).toBe(0);
  });
});
