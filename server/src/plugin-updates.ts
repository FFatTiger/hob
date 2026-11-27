// 插件更新检查：比对已安装的非自带/非自定义插件与各插件源目录里的版本，只在内存缓存结果。
// 定时由 main.ts 在真正启动服务时开启；createRuntime 里不发网络请求。
import { newerPluginVersion } from "../../shared/plugin-version.ts";
import type { PluginUpdate } from "../../shared/types.ts";
import { BUILTIN_SOURCE, type PluginStore } from "./plugin-store.ts";
import { UPDATE_INTERVAL_MS } from "./update-check.ts";

function sameUpdates(a: PluginUpdate[], b: PluginUpdate[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index]!;
    return (
      item.id === other.id &&
      item.source === other.source &&
      item.current === other.current &&
      item.latest === other.latest
    );
  });
}

/** 找出所有已安装、来自插件源、且源里版本比已安装版本更新的插件（不含 builtin 与 custom）。 */
export function findPluginUpdates(store: PluginStore): PluginUpdate[] {
  let installed;
  let entries;
  try {
    installed = store.list();
    entries = store.sources.catalog();
  } catch {
    return [];
  }
  const updates: PluginUpdate[] = [];
  for (const plugin of installed) {
    if (plugin.source === BUILTIN_SOURCE || plugin.source === "custom") continue;
    const match = entries.find(
      (entry) => entry.id === plugin.id && entry.source === plugin.source && !entry.error && entry.version,
    );
    if (match && newerPluginVersion(match.version, plugin.version)) {
      updates.push({
        id: plugin.id,
        source: plugin.source,
        current: plugin.version,
        latest: match.version,
      });
    }
  }
  updates.sort((a, b) => a.id.localeCompare(b.id) || a.source.localeCompare(b.source));
  return updates;
}

export interface PluginUpdateCheckerOptions {
  store: PluginStore;
  intervalMs?: number;
  onChange?: (updates: PluginUpdate[]) => void;
}

/** 定时拉取所有插件源并在源目录或已安装插件变化时计算可更新插件列表。 */
export class PluginUpdateChecker {
  private result: PluginUpdate[];
  private checking?: Promise<PluginUpdate[]>;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: PluginUpdateCheckerOptions) {
    this.result = findPluginUpdates(options.store);
  }

  /** 返回当前缓存的可更新插件列表。 */
  status(): PluginUpdate[] {
    return this.result;
  }

  /** 从本机磁盘同步当前可更新列表（不发网络请求、不广播事件）。 */
  sync(): PluginUpdate[] {
    this.result = findPluginUpdates(this.options.store);
    return this.result;
  }

  /** 重新比对本机已安装插件与源缓存；结果变化时通知订阅者。 */
  refresh(): PluginUpdate[] {
    const next = findPluginUpdates(this.options.store);
    const changed = !sameUpdates(this.result, next);
    this.result = next;
    if (changed) this.options.onChange?.(next);
    return next;
  }

  /** 立刻查一次并开始每 6 小时定时拉取所有插件源（幂等）。 */
  start(): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => {
      void this.check();
    }, this.options.intervalMs ?? UPDATE_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** 停止定时检查。 */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 拉取全部插件源并重新计算可更新列表；单个源拉取失败时保留其上次缓存，不当成没有新版。 */
  async check(): Promise<PluginUpdate[]> {
    this.checking ??= this.doCheck().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async doCheck(): Promise<PluginUpdate[]> {
    await Promise.allSettled(this.options.store.sources.list().map((source) => this.options.store.sources.refresh(source.id)));
    return this.refresh();
  }
}
