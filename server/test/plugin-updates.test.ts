import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bootstrap, HobEvent, PluginUpdate } from "../../shared/types.ts";
import { createApp } from "../src/http.ts";
import { startHob } from "../src/main.ts";
import { PluginStore } from "../src/plugin-store.ts";
import { findPluginUpdates, PluginUpdateChecker } from "../src/plugin-updates.ts";
import { seedBuiltinVault } from "../src/dev-team.ts";
import { makeHob } from "./helpers.ts";

const dirs: string[] = [];
const servers: Server[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hob-plugin-updates-"));
  dirs.push(dir);
  return dir;
}

async function startJsonSource(
  files: Record<string, string | (() => { status: number; body: string })>,
  onRequest?: (url: string) => void,
) {
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    onRequest?.(url);
    const entry = files[url];
    if (entry === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (typeof entry === "function") {
      const result = entry();
      res.writeHead(result.status);
      res.end(result.body);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(entry);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("findPluginUpdates", () => {
  it("只把来自插件源且源版本较新的非自带/非自定义插件算作有更新，含供应商插件", async () => {
    const files: Record<string, string> = {
      "/index.json": JSON.stringify({
        name: "测试源",
        plugins: [
          { id: "alpha", path: "alpha" },
          { id: "beta", path: "beta" },
          { id: "gamma", path: "gamma" },
          { id: "model-plug", path: "model-plug", files: ["plugin.json"] },
          { id: "broken", path: "broken" },
        ],
      }),
      "/alpha/plugin.json": JSON.stringify({ name: "Alpha", version: "1.2.0" }),
      "/alpha/mcp.json": JSON.stringify({ mcpServers: { alpha: { command: "node" } } }),
      "/beta/plugin.json": JSON.stringify({ name: "Beta", version: "1.0.0" }),
      "/beta/mcp.json": JSON.stringify({ mcpServers: { beta: { command: "node" } } }),
      "/gamma/plugin.json": JSON.stringify({ name: "Gamma", version: "1.0.0" }),
      "/gamma/mcp.json": JSON.stringify({ mcpServers: { gamma: { command: "node" } } }),
      "/model-plug/plugin.json": JSON.stringify({
        name: "ModelPlug",
        version: "0.3.0",
        extensions: {
          "com.hob.plugins": {
            providers: [{ package: "demo-provider", version: "0.3.0", integrity: "sha512-x" }],
          },
        },
      }),
      "/broken/plugin.json": "{}",
      "/broken/mcp.json": "{}",
    };
    const base = await startJsonSource(files);
    const home = tempDir();
    const store = new PluginStore(home, undefined, `${base}/index.json`);
    await store.sources.open();

    // 安装 1.0.0（alpha 旧于 1.2.0、beta 同 1.0.0、gamma 改为 2.0.0 新于源里 1.0.0）
    files["/alpha/plugin.json"] = JSON.stringify({ name: "Alpha", version: "1.0.0" });
    files["/model-plug/plugin.json"] = JSON.stringify({
      name: "ModelPlug",
      version: "0.2.0",
      extensions: {
        "com.hob.plugins": {
          providers: [{ package: "demo-provider", version: "0.2.0", integrity: "sha512-x" }],
        },
      },
    });
    await store.sources.refresh("official");
    store.install("alpha");
    store.install("beta");
    store.install("gamma");
    store.install("model-plug");
    store.addCustom("custom-mcp", { command: "node" });
    seedBuiltinVault(store);

    // 模拟 gamma 已装版本比源里新（2.0.0 vs 1.0.0）
    const docPath = join(home, "system/plugins.json");
    const doc = JSON.parse(readFileSync(docPath, "utf8")) as { plugins: { id: string; version: string }[] };
    doc.plugins.find((p) => p.id === "gamma")!.version = "2.0.0";
    writeFileSync(docPath, JSON.stringify(doc));

    // 把源更新到新版本
    files["/alpha/plugin.json"] = JSON.stringify({ name: "Alpha", version: "1.2.0" });
    files["/model-plug/plugin.json"] = JSON.stringify({
      name: "ModelPlug",
      version: "0.3.0",
      extensions: {
        "com.hob.plugins": {
          providers: [{ package: "demo-provider", version: "0.3.0", integrity: "sha512-x" }],
        },
      },
    });
    await store.sources.refresh("official");

    expect(findPluginUpdates(store)).toEqual([
      { id: "alpha", source: "official", current: "1.0.0", latest: "1.2.0" },
      { id: "model-plug", source: "official", current: "0.2.0", latest: "0.3.0" },
    ]);
  });
});

describe("PluginUpdateChecker", () => {
  it("拉源失败时保留已有缓存与原因，不当成没有新版", async () => {
    let fail = false;
    const files: Record<string, string | (() => { status: number; body: string })> = {
      "/index.json": () =>
        fail
          ? { status: 503, body: "unavailable" }
          : { status: 200, body: JSON.stringify({ name: "测试源", plugins: [{ id: "alpha", path: "alpha" }] }) },
      "/alpha/plugin.json": JSON.stringify({ name: "Alpha", version: "1.0.0" }),
      "/alpha/mcp.json": JSON.stringify({ mcpServers: { alpha: { command: "node" } } }),
    };
    const base = await startJsonSource(files);
    const home = tempDir();
    const store = new PluginStore(home, undefined, `${base}/index.json`);
    await store.sources.open();
    store.install("alpha");

    files["/alpha/plugin.json"] = JSON.stringify({ name: "Alpha", version: "1.5.0" });
    await store.sources.refresh("official");

    const seen: PluginUpdate[][] = [];
    const checker = new PluginUpdateChecker({ store, onChange: (u) => seen.push(u) });
    expect(checker.status()).toEqual([{ id: "alpha", source: "official", current: "1.0.0", latest: "1.5.0" }]);

    fail = true;
    const afterFailure = await checker.check();
    expect(afterFailure).toEqual([{ id: "alpha", source: "official", current: "1.0.0", latest: "1.5.0" }]);
    expect(store.sources.list()[0]!.error).toContain("503");
    expect(seen).toHaveLength(0);
  });

  it("createRuntime 里不发网络请求；定时与各类源刷新拉完变化时会推事件并更新 bootstrap", async () => {
    const requested: string[] = [];
    const files: Record<string, string> = {
      "/index.json": JSON.stringify({ name: "测试源", plugins: [{ id: "alpha", path: "alpha" }] }),
      "/alpha/plugin.json": JSON.stringify({ name: "Alpha", version: "1.0.0" }),
      "/alpha/mcp.json": JSON.stringify({ mcpServers: { alpha: { url: "http://127.0.0.1:1/mcp" } } }),
    };
    const base = await startJsonSource(files, (url) => requested.push(url));
    const prevUrl = process.env.HOB_PLUGIN_OFFICIAL_URL;
    process.env.HOB_PLUGIN_OFFICIAL_URL = `${base}/index.json`;
    const hob = makeHob();
    try {
      expect(requested).toEqual([]);
      expect(hob.runtime.pluginUpdates.status()).toEqual([]);

      await hob.runtime.plugins.store.sources.open();
      hob.runtime.plugins.store.install("alpha");
      requested.length = 0;

      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "test" }),
      });
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

      const events: HobEvent[] = [];
      const off = hob.runtime.bus.subscribe((ev) => events.push(ev));

      // 1) 手动「检查更新」触发拉源并推送事件
      files["/alpha/plugin.json"] = JSON.stringify({ name: "Alpha", version: "1.3.0" });
      const refreshRes = await app.request("/api/plugins/sources/refresh", { method: "POST", headers: { cookie } });
      expect(refreshRes.status).toBe(200);
      expect(events).toContainEqual({
        type: "plugin-updates",
        updates: [{ id: "alpha", source: "official", current: "1.0.0", latest: "1.3.0" }],
      });

      const boot1 = (await (await app.request("/api/bootstrap", { headers: { cookie } })).json()) as Bootstrap;
      expect(boot1.pluginUpdates).toEqual([{ id: "alpha", source: "official", current: "1.0.0", latest: "1.3.0" }]);

      // 2) 打开市场触发超 1 小时后台重拉，拉完有新版再推一次事件
      const sourcesPath = join(hob.home, "system/plugin-sources.json");
      const savedSources = JSON.parse(readFileSync(sourcesPath, "utf8")) as { id: string; updatedAt?: string }[];
      savedSources[0]!.updatedAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
      writeFileSync(sourcesPath, JSON.stringify(savedSources));
      files["/alpha/plugin.json"] = JSON.stringify({ name: "Alpha", version: "1.4.0" });
      await app.request("/api/plugins/catalog", { headers: { cookie } });
      await vi.waitFor(() => {
        expect(events).toContainEqual({
          type: "plugin-updates",
          updates: [{ id: "alpha", source: "official", current: "1.0.0", latest: "1.4.0" }],
        });
      });

      // 3) 更新插件后立即清空并推送事件
      const updateRes = await app.request("/api/plugins/alpha/update", { method: "POST", headers: { cookie } });
      expect(updateRes.status).toBe(200);
      expect(events).toContainEqual({ type: "plugin-updates", updates: [] });

      const boot2 = (await (await app.request("/api/bootstrap", { headers: { cookie } })).json()) as Bootstrap;
      expect(boot2.pluginUpdates).toEqual([]);
      off();
    } finally {
      if (prevUrl === undefined) delete process.env.HOB_PLUGIN_OFFICIAL_URL;
      else process.env.HOB_PLUGIN_OFFICIAL_URL = prevUrl;
      hob.close();
    }
  });

  it("start 启动时查一次并按间隔重复，stop 后不再查", async () => {
    vi.useFakeTimers();
    const home = tempDir();
    const store = new PluginStore(home, undefined, "file:///missing");
    let checks = 0;
    store.sources.refresh = async () => {
      checks += 1;
    };
    mkdirSync(join(home, "system"), { recursive: true });
    writeFileSync(join(home, "system/plugin-sources.json"), JSON.stringify([{ id: "official", url: "file:///missing", name: "Hob 官方" }]));

    const checker = new PluginUpdateChecker({ store, intervalMs: 60_000 });
    checker.start();
    await Promise.resolve();
    expect(checks).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(checks).toBe(2);

    checker.stop();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(checks).toBe(2);
  });

  it("startHob 会启动定时插件更新检查并在 close 时停止", async () => {
    const requested: string[] = [];
    const files: Record<string, string> = {
      "/index.json": JSON.stringify({ name: "测试源", plugins: [{ id: "alpha", path: "alpha" }] }),
      "/alpha/plugin.json": JSON.stringify({ name: "Alpha", version: "1.0.0" }),
      "/alpha/mcp.json": JSON.stringify({ mcpServers: { alpha: { url: "http://127.0.0.1:1/mcp" } } }),
    };
    const base = await startJsonSource(files, (url) => requested.push(url));
    const home = tempDir();
    const prevUrl = process.env.HOB_PLUGIN_OFFICIAL_URL;
    const prevPassword = process.env.HOB_PASSWORD;
    const prevMemoryDir = process.env.PI_MEMORY_DIR;
    process.env.HOB_PLUGIN_OFFICIAL_URL = `${base}/index.json`;
    process.env.HOB_PASSWORD = "test";
    const hobServer = await startHob({ home, port: 0 });
    try {
      await vi.waitFor(() => {
        expect(requested).toContain("/index.json");
      });
    } finally {
      await hobServer.close();
      if (prevUrl === undefined) delete process.env.HOB_PLUGIN_OFFICIAL_URL;
      else process.env.HOB_PLUGIN_OFFICIAL_URL = prevUrl;
      if (prevPassword === undefined) delete process.env.HOB_PASSWORD;
      else process.env.HOB_PASSWORD = prevPassword;
      if (prevMemoryDir === undefined) delete process.env.PI_MEMORY_DIR;
      else process.env.PI_MEMORY_DIR = prevMemoryDir;
    }
  });
});
