import { describe, expect, it } from "vitest";
import type { ProviderView } from "../../shared/types.ts";
import {
  PROVIDER_CHECK_CONCURRENCY,
  providerFingerprint,
  reconcileProviderConns,
  runWithConcurrency,
  type ProviderConn,
} from "../src/provider-check.ts";

describe("服务商批量检测并发控制与缓存失效", () => {
  it("runWithConcurrency 限制最大并发数且覆盖全部条目", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    let active = 0;
    let maxActive = 0;
    const visited: number[] = [];

    await runWithConcurrency(items, PROVIDER_CHECK_CONCURRENCY, async (item) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      visited.push(item);
      active--;
    });

    expect(maxActive).toBeLessThanOrEqual(PROVIDER_CHECK_CONCURRENCY);
    expect(maxActive).toBe(PROVIDER_CHECK_CONCURRENCY);
    expect(visited.sort((a, b) => a - b)).toEqual(items);
  });

  it("reconcileProviderConns 在 URL/协议/Key 状态改变、显式失效或删除时清空旧缓存", () => {
    const builtin: ProviderView = { kind: "builtin", id: "openai", keyConfigured: true };
    const custom: ProviderView = {
      kind: "custom",
      id: "proxy",
      name: "Proxy",
      api: "openai-completions",
      baseUrl: "https://a.example.com/v1",
      keyConfigured: true,
      models: [],
    };
    const initial: Record<string, ProviderConn> = {
      openai: { status: "connected", ms: 120, fingerprint: providerFingerprint(builtin) },
      proxy: { status: "connected", ms: 85, fingerprint: providerFingerprint(custom) },
      removed: { status: "connected", ms: 50, fingerprint: "builtin:removed:1" },
    };

    // URL 变化 -> proxy 失效；removed 删除 -> 移除；openai 未变 -> 保留
    const afterUrlChange = reconcileProviderConns(initial, [
      builtin,
      { ...custom, baseUrl: "https://b.example.com/v1" },
    ]);
    expect(Object.keys(afterUrlChange)).toEqual(["openai"]);

    // 显式失效（如更换 API Key 后 keyConfigured 仍为 true）-> 立即清除缓存
    const afterKeyRotate = reconcileProviderConns(initial, [builtin, custom], ["openai"]);
    expect(Object.keys(afterKeyRotate)).toEqual(["proxy"]);
  });
});
