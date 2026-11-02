import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { engineDir, loadConfig, resolveHome } from "./config.ts";
import { createApp } from "./http.ts";
import { PiHost } from "./pi.ts";
import { createRuntime, type HobRuntime } from "./runtime.ts";
import { readLegacyModels } from "./settings.ts";

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

/** 起一个 Hob 进程内全部服务（HTTP + Router + 任务 + 定时）。试跑和测试都走这里。 */
export async function startHob(options: StartOptions = {}): Promise<HobServer> {
  const home = options.home ?? resolveHome();
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

  runtime.delegations.recovering = true;
  runtime.jobs.recover();
  runtime.delegations.recover();
  runtime.routines.start();
  runtime.jobs.startWatchdog();

  const app = createApp(runtime, { webDir: fileURLToPath(new URL("../../dist/web", import.meta.url)), home });
  const port = options.port ?? Number(env.HOB_PORT ?? config.port);
  const server = serve({ fetch: app.fetch, port, hostname: config.host });

  return {
    runtime,
    port,
    close: async () => {
      runtime.routines.stop();
      runtime.jobs.disposeAll();
      runtime.router.disposeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const isMain = process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("main.js");
if (isMain) {
  startHob()
    .then((server) => {
      console.log(`Hob 在 http://${server.runtime.config.host}:${server.port}（数据目录 ${server.runtime.home}）`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
