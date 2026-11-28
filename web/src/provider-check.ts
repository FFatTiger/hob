import type { ProviderView } from "../../shared/types.ts";

export type ProviderConn = {
  status: "connected" | "failed" | "testing";
  ms?: number;
  fingerprint: string;
};

export const PROVIDER_CHECK_CONCURRENCY = 3;

/** 生成用于判断服务商连接缓存是否仍有效的配置指纹。 */
export function providerFingerprint(provider: ProviderView): string {
  if (provider.kind === "builtin") {
    return `builtin:${provider.id}:${provider.keyConfigured ? "1" : "0"}`;
  }
  return `custom:${provider.id}:${provider.api}:${provider.baseUrl}:${provider.keyConfigured ? "1" : "0"}`;
}

/**
 * 同步服务商列表变化：清理已删除项、配置已变化项，以及显式标记为凭据已变更的项。
 */
export function reconcileProviderConns(
  current: Record<string, ProviderConn>,
  providers: readonly ProviderView[],
  invalidatedIds: readonly string[] = [],
): Record<string, ProviderConn> {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const invalidated = new Set(invalidatedIds);
  const next: Record<string, ProviderConn> = {};
  for (const [id, entry] of Object.entries(current)) {
    if (invalidated.has(id)) continue;
    const provider = byId.get(id);
    if (!provider) continue;
    if (entry.fingerprint !== providerFingerprint(provider)) continue;
    next[id] = entry;
  }
  return next;
}

/** 按上限并发执行异步任务，避免批量检测同时打爆所有上游接口。 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const concurrency = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let cursor = 0;
  const runWorker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
}
