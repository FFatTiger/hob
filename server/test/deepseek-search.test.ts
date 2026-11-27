import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeSearch, type SearchSettings } from "../../shared/search.ts";
import {
  DEEPSEEK_SEARCH_BASE_URL,
  clipDeepSeekQuery,
  createDeepSeekSearchProvider,
  isPrivateOrLocalHost,
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

  it("校验 URL 协议、超长 URL、内网地址，且 raw=true 不绕过协议与凭据校验", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = createDeepSeekSearchProvider("sk-guard-key");

    // 非法 URL、非 HTTP(S) 协议和带凭据 URL 在 raw=false / raw=true 下均被拒绝
    for (const raw of [false, true]) {
      await expect(provider.fetch("not-a-url", raw)).rejects.toThrow("网址无效");
      await expect(provider.fetch("file:///etc/passwd", raw)).rejects.toThrow("仅支持 http 和 https");
      await expect(provider.fetch("ftp://example.test/file", raw)).rejects.toThrow("仅支持 http 和 https");
      await expect(provider.fetch("https://user:pass@example.test/private", raw)).rejects.toThrow("不支持包含用户名或密码");
    }

    // 超长 URL (> 8192) 在走 DeepSeek 云端抓取前拒绝
    const longUrl = `https://example.test/${"a".repeat(8200)}`;
    await expect(provider.fetch(longUrl)).rejects.toThrow("8192");

    // 内网、本机与链路本地地址在走 DeepSeek 云端抓取前拒绝
    const privateUrls = [
      "http://localhost:3000/secret",
      "http://sub.localhost/api",
      "http://localhost./api",
      "http://127.0.0.1:8080/admin",
      "http://10.0.0.5/internal",
      "http://172.16.1.2/status",
      "http://192.168.1.10/config",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/panel",
      "http://0.0.0.0:8000/",
      "http://[::1]:30148/",
      "http://[::ffff:127.0.0.1]/",
      "http://[fe80::1]/",
      "http://[fd12:3456::1]/",
      "http://printer.local/",
      "http://service.internal/",
    ];
    for (const u of privateUrls) {
      await expect(provider.fetch(u), u).rejects.toThrow("不支持内网或本机地址");
    }
    expect(isPrivateOrLocalHost("example.com")).toBe(false);
    expect(isPrivateOrLocalHost("8.8.8.8")).toBe(false);
    expect(isPrivateOrLocalHost("2606:4700:4700::1111")).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("直接调用 DeepSeekSearchProvider 时同样脱敏密钥并截断超长错误详情", async () => {
    const hugeDetail = `leak sk-direct-secret ${"x".repeat(400)}`;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: hugeDetail } }), { status: 401 }),
    );
    const provider = createDeepSeekSearchProvider("sk-direct-secret");
    await expect(provider.search("test")).rejects.toSatisfy((error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      return !msg.includes("sk-direct-secret") && msg.includes("[已隐藏]") && msg.length < 300;
    });
  });

  it("raw=true 经 WebSearch 仍受 40000 字符截断；空搜索结果返回 0 条；支持优先级回退与合并", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://example.test/huge") {
        return new Response("h".repeat(45_000), { headers: { "content-type": "text/html" } });
      }
      if (url === `${DEEPSEEK_SEARCH_BASE_URL}/v1/tools/search`) {
        return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://api.tavily.com/search") {
        return new Response(JSON.stringify({
          results: [{ title: "Tavily", url: "https://example.test/shared", content: "短摘要" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    });

    const home = tempHome();
    writeSecret(home, "search:deepseek", "sk-ds");
    writeSecret(home, "search:tavily", "tvly-key");
    const ws = new WebSearch(home, () => [
      { name: "deepseek", enabled: true },
      { name: "tavily", enabled: true },
    ]);

    const raw = await ws.fetch("https://example.test/huge", true);
    expect(raw.text).toHaveLength(40_000);
    expect(raw.truncated).toBe(true);

    const empty = await ws.search("no-match", "fast");
    expect(empty.providers).toEqual(["deepseek"]);
    expect(empty.results).toEqual([]);

    // deepseek 失败时 fast 自动回退到 tavily
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === `${DEEPSEEK_SEARCH_BASE_URL}/v1/tools/search`) {
        return new Response(JSON.stringify({ error: { message: "rate limit" } }), { status: 429 });
      }
      if (url === "https://api.tavily.com/search") {
        return new Response(JSON.stringify({
          results: [{ title: "Tavily Fallback", url: "https://example.test/fallback", content: "fallback snippet" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    });
    const fallback = await ws.search("fallback query", "fast");
    expect(fallback.providers).toEqual(["tavily"]);
    expect(fallback.errors).toHaveLength(1);
    expect(fallback.errors[0]?.provider).toBe("deepseek");
    expect(fallback.results[0]?.url).toBe("https://example.test/fallback");
  });

  it("对接 127.0.0.1 本地假服务器完成真实 HTTP 搜索与抓取往返", async () => {
    const received: Array<{ path: string; auth?: string; body: Record<string, unknown> }> = [];
    const server: Server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      received.push({ path: req.url ?? "", auth: req.headers.authorization, body });

      if (req.headers.authorization !== "Bearer sk-local-fake") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad token" } }));
        return;
      }
      if (req.url === "/v1/tools/search") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          results: [{
            title: "假服务器结果",
            url: "https://example.test/doc",
            snippet: "短摘要",
            summary: "假服务器返回的长摘要内容",
          }],
        }));
        return;
      }
      if (req.url === "/v1/tools/fetch") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          title: "文档正文",
          content: "# 标题\n\n正文段落",
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const provider = createDeepSeekSearchProvider("sk-local-fake", `http://127.0.0.1:${port}`);

      const search = await provider.search("本地假服务测试", 3);
      expect(search.results).toEqual([{
        title: "假服务器结果",
        url: "https://example.test/doc",
        snippet: "假服务器返回的长摘要内容",
      }]);

      const page = await provider.fetch("https://example.test/doc");
      expect(page).toEqual({
        title: "文档正文",
        text: "# 标题\n\n正文段落",
        contentType: "text/markdown",
        contentLength: "# 标题\n\n正文段落".length,
      });

      expect(received).toEqual([
        { path: "/v1/tools/search", auth: "Bearer sk-local-fake", body: { query: "本地假服务测试", count: 3, need_content: false } },
        { path: "/v1/tools/fetch", auth: "Bearer sk-local-fake", body: { url: "https://example.test/doc" } },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
