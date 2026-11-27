import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createServer } from "vite";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/http.ts";
import { attachEventsWebSocket } from "../src/events-ws.ts";
import { makeHob } from "./helpers.ts";

async function expectUpgradeStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("unexpected-response", (_req, res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    ws.once("open", () => {
      ws.close();
      reject(new Error("expected upgrade rejection"));
    });
    ws.once("error", () => { /* unexpected-response already handles status */ });
  });
}

describe("实时事件 WebSocket (/api/events/ws)", () => {
  it("校验登录态和同源，转发总线事件并在断线时清理可见性", async () => {
    const hob = makeHob();
    const app = createApp(hob.runtime, { home: hob.home });
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    const detach = attachEventsWebSocket(server, hob.runtime);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const wsBase = `ws://127.0.0.1:${port}`;

    try {
      // 未登录拒绝 401
      expect(await expectUpgradeStatus(`${wsBase}/api/events/ws?clientId=tab-1`)).toBe(401);

      const login = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "test" }),
      });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];

      // 跨源 Origin 拒绝 403
      expect(await expectUpgradeStatus(`${wsBase}/api/events/ws?clientId=tab-1`, { cookie, origin: "http://evil.example" })).toBe(403);

      // 正常登录且同源建立连接
      const ws = new WebSocket(`${wsBase}/api/events/ws?clientId=tab-1`, { headers: { cookie, origin: base } });
      await once(ws, "open");

      // 记录并维持可见性
      hob.runtime.push.setVisibility("tab-1", true);
      expect(hob.runtime.push.hasVisible()).toBe(true);

      // 收到总线事件（云桌面屏幕与接管状态）
      const received: unknown[] = [];
      ws.on("message", (data) => received.push(JSON.parse(data.toString())));
      const screens = [{ id: "a-fjl7", running: true, browserRunning: true, viewers: 1, lastActiveAt: null }];
      hob.runtime.bus.emit({ type: "desktop-screens", screens });
      hob.runtime.bus.emit({ type: "desktop-control", screen: "a-fjl7", taken: true });

      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 3000;
        const poll = () => {
          if (received.length >= 2) return resolve();
          if (Date.now() > deadline) return reject(new Error("timed out waiting for ws events"));
          setTimeout(poll, 10);
        };
        poll();
      });

      expect(received).toEqual([
        { type: "desktop-screens", screens },
        { type: "desktop-control", screen: "a-fjl7", taken: true },
      ]);

      // 断开后自动清掉该 clientId 的可见性
      ws.close();
      await once(ws, "close");
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 3000;
        const poll = () => {
          if (!hob.runtime.push.hasVisible()) return resolve();
          if (Date.now() > deadline) return reject(new Error("visibility was not cleared"));
          setTimeout(poll, 10);
        };
        poll();
      });
      expect(hob.runtime.push.hasVisible()).toBe(false);
    } finally {
      detach();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      hob.close();
    }
  });
  it("经开发用的 Vite 代理连接时同源校验仍按浏览器地址判断", async () => {
    const hob = makeHob();
    const app = createApp(hob.runtime, { home: hob.home });
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    const detach = attachEventsWebSocket(server, hob.runtime);
    await once(server, "listening");
    const cacheDir = mkdtempSync(join(tmpdir(), "hob-events-ws-vite-"));
    const previousPort = process.env.HOB_PORT;
    // vite.config.ts 读 HOB_PORT 决定代理目标：指到这个测试服务，不碰本机其他实例
    process.env.HOB_PORT = String((server.address() as AddressInfo).port);
    const vite = await createServer({ cacheDir, logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] }, server: { port: 0, host: "127.0.0.1" } });
    try {
      await vite.listen();
      const devBase = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
      const login = await fetch(`${devBase}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "test" }),
      });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const wsUrl = `${devBase.replace("http:", "ws:")}/api/events/ws?clientId=tab-dev`;

      const ws = new WebSocket(wsUrl, { headers: { cookie, origin: devBase } });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("unexpected-response", (_req, res) => reject(new Error(`upgrade rejected: ${res.statusCode}`)));
      });
      ws.close();
      await once(ws, "close");

      expect(await expectUpgradeStatus(wsUrl, { cookie, origin: "http://evil.example" })).toBe(403);
    } finally {
      await vite.close();
      if (previousPort === undefined) delete process.env.HOB_PORT;
      else process.env.HOB_PORT = previousPort;
      rmSync(cacheDir, { recursive: true, force: true });
      detach();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      hob.close();
    }
  });
});
