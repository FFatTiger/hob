import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeSearch, type SearchSettings } from "../../shared/search.ts";
import {
  DEEPSEEK_SEARCH_BASE_URL,
  clipDeepSeekQuery,
  createDeepSeekSearchProvider,
  parseDeepSeekSearchResults,
} from "../src/deepseek-search.ts";
import { createApp } from "../src/http.ts";
import { WebSearch } from "../src/search.ts";
import { writeSecret } from "../src/secrets.ts";
import { makeHob } from "./helpers.ts";

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), "hob-deepseek-search-"));
  homes.push(home);
  return home;
}

describe("DeepSeek 联网搜索与网页抓取", () => {
  it("normalizeSearch 包含 deepseek 且不保留多余字段", () => {
    const normalized = normalizeSearch([
      { name: "deepseek", enabled: true, providerId: "deepseek", model: "deepseek-chat" },
    ]);
    const ds = normalized.find((p) => p.name === "deepseek");
    expect(ds).toEqual({ name: "deepseek", enabled: true });
  });

  it("clipDeepSeekQuery 按 Unicode 码点安全截断到 128 字符", () => {
    expect(() => clipDeepSeekQuery("   ")).toThrow("搜索词不能为空");
    const longEmoji = "🔍".repeat(140);
    expect(Array.from(clipDeepSeekQuery(longEmoji))).toHaveLength(128);
    expect(clipDeepSeekQuery("  DeepSeek site:github.com  ")).toBe("DeepSeek site:github.com");
  });

  it("parseDeepSeekSearchResults 优先使用 summary，去重并过滤无效链接", () => {
    const parsed = parseDeepSeekSearchResults({
      results: [
        {
          title: "DeepSeek 文档",
          url: "https://api-docs.deepseek.com/zh-cn/api/search/",
          snippet: "短摘要",
          summary: "这是给模型阅读的 600 字长摘要",
        },
        {
          title: "重复链接应跳过",
          url: "https://api-docs.deepseek.com/zh-cn/api/search/",
          snippet: "duplicate",
          summary: "duplicate",
        },
        {
          title: "",
          url: "https://example.com/page",
          snippet: "仅短摘要",
          summary: "",
        },
        {
          title: "非法协议",
          url: "javascript:alert(1)",
          snippet: "bad",
          summary: "bad",
        },
      ],
    }, 5);

    expect(parsed).toEqual([
      {
        title: "DeepSeek 文档",
        url: "https://api-docs.deepseek.com/zh-cn/api/search/",
        snippet: "这是给模型阅读的 600 字长摘要",
      },
      {
        title: "example.com",
        url: "https://example.com/page",
        snippet: "仅短摘要",
      },
    ]);
  });

  it("通过 WebSearch 固定走官方地址调用 /v1/tools/search 与 /v1/tools/fetch", async () => {
    const seen: Array<{ url: string; auth?: string; body: unknown }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      seen.push({ url, auth: headers.Authorization, body });

      if (url === `${DEEPSEEK_SEARCH_BASE_URL}/v1/tools/search`) {
        return new Response(JSON.stringify({
          results: [
            {
              rerank_score: 2.5,
              title: "DeepSeek Search",
              url: "https://api-docs.deepseek.com/zh-cn/api/search/",
              snippet: "short",
              summary: "DeepSeek 原生搜索长摘要",
              content: "",
            },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === `${DEEPSEEK_SEARCH_BASE_URL}/v1/tools/fetch`) {
        return new Response(JSON.stringify({
          title: "DeepSeek Fetch",
          content: "# DeepSeek Fetch\n\nMarkdown 正文内容",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    });

    const home = tempHome();
    writeSecret(home, "search:deepseek", "sk-ds-key");
    const searchSettings: SearchSettings = [{ name: "deepseek", enabled: true }];
    const service = new WebSearch(home, () => searchSettings);

    const searchResult = await service.search("DeepSeek 搜索测试", "fast", 5);
    expect(searchResult.providers).toEqual(["deepseek"]);
    expect(searchResult.results).toEqual([
      {
        title: "DeepSeek Search",
        url: "https://api-docs.deepseek.com/zh-cn/api/search/",
        snippet: "DeepSeek 原生搜索长摘要",
        sources: ["deepseek"],
      },
    ]);

    const fetchResult = await service.fetch("https://example.test/article");
    expect(fetchResult).toMatchObject({
      title: "DeepSeek Fetch",
      text: "# DeepSeek Fetch\n\nMarkdown 正文内容",
      contentType: "text/markdown",
      truncated: false,
    });

    expect(seen).toEqual([
      {
        url: "https://api.deepseek.com/v1/tools/search",
        auth: "Bearer sk-ds-key",
        body: { query: "DeepSeek 搜索测试", count: 5, need_content: false },
      },
      {
        url: "https://api.deepseek.com/v1/tools/fetch",
        auth: "Bearer sk-ds-key",
        body: { url: "https://example.test/article" },
      },
    ]);
  });

  it("raw=true 走通用 HTML 抓取；校验带凭据 URL、错误码提示并脱敏密钥", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("<html>raw html</html>", { headers: { "content-type": "text/html" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "insufficient balance" } }), { status: 402 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "blocked by policy" } }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "invalid sk-secret-key" } }), { status: 401 }));

    expect(() => createDeepSeekSearchProvider("")).toThrow("未配置 DeepSeek 联网搜索 API Key");
    const provider = createDeepSeekSearchProvider("sk-secret-key");

    const rawResult = await provider.fetch("https://example.test/raw", true);
    expect(rawResult.text).toContain("<html>raw html</html>");
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://example.test/raw");

    await expect(provider.fetch("https://user:pass@example.test/private")).rejects.toThrow("不支持包含用户名或密码");
    await expect(provider.search("test")).rejects.toThrow("余额不足");
    await expect(provider.fetch("https://example.test/blocked")).rejects.toThrow("安全策略拒绝");

    const home = tempHome();
    writeSecret(home, "search:deepseek", "sk-secret-key");
    const ws = new WebSearch(home, () => [{ name: "deepseek", enabled: true }]);
    await expect(ws.search("test")).rejects.toThrow("[已隐藏]");
  });

  it("HTTP 接口 /api/search 与 /api/search/test 正常保存并测试 DeepSeek Key", async () => {
    const hob = makeHob();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        results: [{ title: "Hob", url: "https://github.com/FFatTiger/hob", snippet: "s", summary: "Hob 摘要" }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "test" }),
      });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];

      const rev1 = hob.runtime.settings.get().revision;
      const put = await app.request("/api/search", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          revision: rev1,
          providers: [{ name: "deepseek", enabled: true }],
          keys: { deepseek: "sk-deepseek-test" },
        }),
      });
      expect(put.status).toBe(200);
      expect(await put.text()).not.toContain("sk-deepseek-test");

      const get = await (await app.request("/api/search", { headers: { cookie } })).json();
      const dsView = get.providers.find((p: { name: string }) => p.name === "deepseek");
      expect(dsView).toEqual({ name: "deepseek", enabled: true, keyConfigured: true });

      const testRes = await (await app.request("/api/search/test", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "deepseek" }),
      })).json();
      expect(testRes).toEqual({ ok: true, count: 1 });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.deepseek.com/v1/tools/search",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer sk-deepseek-test" }),
        }),
      );
    } finally {
      hob.close();
    }
  });
});
