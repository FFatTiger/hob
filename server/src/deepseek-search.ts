import { isIP } from "node:net";
import { fetchViaGenericHtml } from "@juicesharp/rpiv-web-tools/providers/fetch-helpers.ts";
import type { FetchResponse } from "@juicesharp/rpiv-web-tools/providers/types.ts";

export interface DeepSeekSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface DeepSeekSearchResponse {
  query: string;
  results: DeepSeekSearchResultItem[];
}

export const DEEPSEEK_SEARCH_BASE_URL = "https://api.deepseek.com";
const MAX_QUERY_CHARS = 128;
const MAX_FETCH_URL_CHARS = 8192;

export function clipDeepSeekQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("搜索词不能为空。");
  const clipped = Array.from(trimmed).slice(0, MAX_QUERY_CHARS).join("").trim();
  if (!clipped) throw new Error("搜索词不能为空。");
  return clipped;
}

function normalizeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function urlHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function parseDeepSeekSearchResults(data: unknown, maxResults: number): DeepSeekSearchResultItem[] {
  const limit = Math.max(1, maxResults);
  if (!data || typeof data !== "object" || !Array.isArray((data as { results?: unknown }).results)) {
    throw new Error("DeepSeek 搜索响应缺少 results 列表。");
  }
  const items = new Map<string, DeepSeekSearchResultItem>();
  for (const raw of (data as { results: unknown[] }).results) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const url = normalizeHttpUrl(entry.url);
    if (!url || items.has(url)) continue;
    const title = typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : urlHostname(url);
    const summary = typeof entry.summary === "string" ? entry.summary.trim() : "";
    const snippet = typeof entry.snippet === "string" ? entry.snippet.trim() : "";
    items.set(url, { title, url, snippet: summary || snippet });
  }
  return [...items.values()].slice(0, limit);
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

export function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const ipVersion = isIP(host);
  if (ipVersion === 4) return isPrivateIpv4(host);
  if (ipVersion === 6) {
    if (host === "::" || host === "::1" || /^(0+:){7}0*[01]$/.test(host)) return true;
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      return isPrivateIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
    const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mappedDotted) return isPrivateIpv4(mappedDotted[1]);
    return host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab]/.test(host) || host.startsWith("ff");
  }
  return false;
}

function extractApiErrorDetail(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: unknown }; message?: unknown };
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === "string" && message.trim()) return message.trim().slice(0, 240);
  } catch {
    // 非 JSON 响应直接截断原文
  }
  return trimmed.slice(0, 240);
}

function formatDeepSeekHttpError(status: number, rawText: string, action: "search" | "fetch", apiKey = ""): Error {
  let detail = extractApiErrorDetail(rawText);
  if (detail && apiKey) detail = detail.split(apiKey).join("[已隐藏]");
  const suffix = detail ? `（${detail}）` : "";
  const actionLabel = action === "search" ? "联网搜索" : "网页抓取";
  if (status === 401) {
    return new Error(`DeepSeek API Key 无效或无权限（HTTP 401）${suffix}`);
  }
  if (status === 402) {
    return new Error(`DeepSeek 账号余额不足，请先充值后再试（HTTP 402）${suffix}`);
  }
  if (status === 403) {
    return new Error(
      action === "fetch"
        ? `DeepSeek 网页抓取被安全策略拒绝（HTTP 403）${suffix}`
        : `DeepSeek API Key 无权限（HTTP 403）${suffix}`,
    );
  }
  if (status === 404) {
    return new Error(
      action === "fetch"
        ? `DeepSeek 未能获取该网页的可用正文（HTTP 404）${suffix}`
        : `DeepSeek 搜索接口不可用（HTTP 404）${suffix}`,
    );
  }
  if (status === 429) {
    return new Error(`DeepSeek ${actionLabel}超过速率限制，请稍后重试（HTTP 429）${suffix}`);
  }
  if (status === 408 || status === 504) {
    return new Error(`DeepSeek ${actionLabel}请求超时（HTTP ${status}）${suffix}`);
  }
  return new Error(`DeepSeek ${actionLabel}请求失败（HTTP ${status}）${suffix}`);
}

export class DeepSeekSearchProvider {
  readonly name = "deepseek";
  readonly label = "DeepSeek";
  readonly envVar = "";
  private readonly baseUrl: string;

  constructor(private readonly apiKey: string, baseUrl = DEEPSEEK_SEARCH_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async search(query: string, maxResults = 8, signal?: AbortSignal): Promise<DeepSeekSearchResponse> {
    const count = Number.isFinite(maxResults) ? Math.max(1, Math.min(50, Math.floor(maxResults))) : 8;
    const clippedQuery = clipDeepSeekQuery(query);
    const response = await fetch(`${this.baseUrl}/v1/tools/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        query: clippedQuery,
        count,
        need_content: false,
      }),
      signal,
    });

    const rawText = await response.text().catch(() => "");
    if (!response.ok) {
      throw formatDeepSeekHttpError(response.status, rawText, "search", this.apiKey);
    }

    let data: unknown;
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new Error("DeepSeek 搜索接口返回了无效的 JSON 响应。");
    }

    return {
      query,
      results: parseDeepSeekSearchResults(data, count),
    };
  }

  async fetch(url: string, raw = false, signal?: AbortSignal): Promise<FetchResponse> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("网址无效。");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("仅支持 http 和 https 网址。");
    }
    if (!parsed.hostname) {
      throw new Error("网址无效。");
    }
    if (parsed.username || parsed.password) {
      throw new Error("网页抓取不支持包含用户名或密码的网址。");
    }
    if (raw) {
      return await fetchViaGenericHtml(url, true, signal);
    }
    if (url.length > MAX_FETCH_URL_CHARS) {
      throw new Error("网址长度超过 8192 字符，无法使用 DeepSeek 网页抓取。");
    }
    if (isPrivateOrLocalHost(parsed.hostname)) {
      throw new Error("DeepSeek 网页抓取不支持内网或本机地址。");
    }
    const response = await fetch(`${this.baseUrl}/v1/tools/fetch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ url }),
      signal,
    });

    const rawText = await response.text().catch(() => "");
    if (!response.ok) {
      throw formatDeepSeekHttpError(response.status, rawText, "fetch", this.apiKey);
    }

    let data: unknown;
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new Error("DeepSeek 网页抓取接口返回了无效的 JSON 响应。");
    }

    const record = (data && typeof data === "object" ? data : {}) as { title?: unknown; content?: unknown };
    const content = typeof record.content === "string" ? record.content : "";
    const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : undefined;
    if (!content.trim()) {
      throw new Error("DeepSeek 网页抓取未返回正文内容。");
    }
    return {
      text: content,
      ...(title ? { title } : {}),
      contentType: "text/markdown",
      contentLength: content.length,
    };
  }
}

export function createDeepSeekSearchProvider(
  apiKey: string | undefined,
  baseUrl = DEEPSEEK_SEARCH_BASE_URL,
): DeepSeekSearchProvider {
  const key = apiKey?.trim() ?? "";
  if (!key) {
    throw new Error("未配置 DeepSeek 联网搜索 API Key。");
  }
  return new DeepSeekSearchProvider(key, baseUrl);
}
