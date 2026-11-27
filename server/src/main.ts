import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { engineDir, loadConfig, resolveHome } from "./config.ts";
import { createApp } from "./http.ts";
import { prepareHome } from "./layout.ts";
import { createDesktopUpgrade } from "./desktop-control.ts";
import { createEventsUpgrade } from "./events-ws.ts";
import { PiHost } from "./pi.ts";
import { createRuntime, type HobRuntime } from "./runtime.ts";
import { generalSkillsDir, syncGeneralIndex } from "./skills.ts";
import { ensurePlaywrightCli } from "./playwright-cli.ts";
import { readLegacyModels } from "./settings.ts";
import { releaseIdleTodosAtStartup } from "./todos.ts";
import { seedBuiltinVault, seedDefaultPlugins } from "./dev-team.ts";
import { retirePluginCards } from "./actions.ts";

export interface StartOptions {
  home?: string;
  port?: number;
  pi?: PiHost;
}

export interface HobServer {
  runtime: HobRuntime;
  port: number;
  close: () => Promise<void>;
}

/** 统一分发 WebSocket 升级：未知路径一律回 404 并销毁 socket，避免泄漏或客户端 RST 拖垮进程。 */
export function attachWebSockets(server: ReturnType<typeof serve>, runtime: HobRuntime): () => void {
  const desktop = createDesktopUpgrade(runtime);
  const events = createEventsUpgrade(runtime);
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = "";
    try { pathname = new URL(req.url ?? "/", "http://localhost").pathname; } catch { /* 非法 URL 当未匹配处理 */ }
    if (pathname === "/api/events/ws") { events.handle(req, socket, head); return; }
    if (pathname === "/api/desktop/vnc") { desktop.handle(req, socket, head); return; }
    socket.on("error", () => undefined);
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  };
  server.on("upgrade", onUpgrade);
  return () => {
    server.off("upgrade", onUpgrade);
    events.close();
    desktop.close();
  };
}

/** 起一个 Hob 进程内全部服务（HTTP + Router + 任务 + 定时）。试跑和测试都走这里。 */
export async function startHob(options: StartOptions = {}): Promise<HobServer> {
  const home = options.home ?? resolveHome();
  // 从 boot.ts 进来时已经迁过（幂等）；直接从 main 起的路径也补上
  prepareHome(home);
  ensurePlaywrightCli(engineDir(home));
  const env = process.env;
  const pi = options.pi ?? new PiHost({ engineDir: engineDir(home) });
  // config.json 里的旧模型字段在 loadConfig 里被清掉，所以先读出来搬进设置
  const legacyModels = readLegacyModels(home);
  const config = loadConfig(home, env);
  const runtime = createRuntime({
    home,
    config,
    pi,
    ...(legacyModels ? { legacyModels } : {}),
  });

  seedBuiltinVault(runtime.plugins.store, id => retirePluginCards(runtime, id));
  seedDefaultPlugins(runtime.plugins.store);
  runtime.delegations.recovering = true;
  // 通用技能目录里可能放着从别处来的技能：启动时给没登记的补上索引，之后改、删、回退都按索引走
  syncGeneralIndex(generalSkillsDir(home));
  runtime.jobs.recover();
  runtime.delegations.recover();
  runtime.groups.recoverHandovers();
  await runtime.router.recover();
  // 重启后没有在跑的一轮（且不在等待自动续跑），任务按中断、转交按中断处理过了：手上没活的待办这时候收起
  releaseIdleTodosAtStartup(runtime);
  void runtime.plugins.start().catch(error => console.error("插件连接启动失败：", error));
  runtime.routines.start();
  runtime.jobs.startWatchdog();
  runtime.desktopEvents.restart();
  // 消耗统计第一次要扫一遍会话文件（几百 MB）：先异步跑起来，服务不等它
  runtime.usage.warmup();
  // 版本检查只在真正启动服务时跑（启动查一次，之后每 6 小时查一次）
  runtime.update.start();
  runtime.pluginUpdates.start();

  const app = createApp(runtime, { webDir: fileURLToPath(new URL("../../dist/web", import.meta.url)), home });
  const port = options.port ?? Number(env.HOB_PORT ?? config.port);
  const server = serve({ fetch: app.fetch, port, hostname: config.host });
  const detachWebSockets = attachWebSockets(server, runtime);

  return {
    runtime,
    port,
    close: async () => {
      detachWebSockets();
      runtime.update.stop();
      runtime.pluginUpdates.stop();
      runtime.desktopEvents.stop();
      runtime.desktopControl.dispose();
      runtime.routines.stop();
      runtime.scriptTools.close();
      runtime.jobs.disposeAll();
      runtime.router.recordShutdownTurns();
      runtime.router.disposeAll();
      await runtime.providerPlugins.close();
      await runtime.plugins.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 收到退出信号时执行优雅关机，记录仍在运行的对话回合并退出。 */
export function attachShutdownSignals(server: HobServer): () => void {
  let closing = false;
  const onSignal = () => {
    if (closing) return;
    closing = true;
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
}

const isMain = process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("main.js");
if (isMain) {
  startHob()
    .then((server) => {
      console.log(`Hob 在 http://${server.runtime.config.host}:${server.port}（数据目录 ${server.runtime.home}）`);
      attachShutdownSignals(server);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
