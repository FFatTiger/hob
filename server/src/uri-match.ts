import type { CredentialUri, UriMatchMode } from "../../shared/types.ts";

export const URI_MATCH_BASE_DOMAIN = 0 as const;
export const URI_MATCH_HOST = 1 as const;
export const URI_MATCH_STARTS_WITH = 2 as const;
export const URI_MATCH_EXACT = 3 as const;
export const URI_MATCH_REGEX = 4 as const;
export const URI_MATCH_NEVER = 5 as const;

const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
  "ws:": "80",
  "wss:": "443",
  "ftp:": "21",
};

const MODE_SPECIFICITY: Record<UriMatchMode, number> = {
  3: 5, // 精确
  2: 4, // 开始于
  1: 3, // 主机
  4: 2, // 正则
  0: 1, // 基础域名
  5: 0, // 从不
};

export interface UriMatchResult {
  uri: string;
  mode: UriMatchMode;
  /** 「总是允许」和 10 分钟内批准的记录键，按实际匹配所用的那一级记。 */
  scope: string;
}

export function isUriMatchMode(value: unknown): value is UriMatchMode {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 5;
}

export function credentialUriText(entry: CredentialUri): string {
  return typeof entry === "string" ? entry : entry.uri;
}

/**
 * 规整凭据服务商返回的 uris：
 * - 字符串（老插件）原样保留；
 * - `{ uri, match }` 保留有效取值（0–5），`match` 为 `null`、缺失或不合法时按未设处理。
 */
export function normalizeCredentialUris(value: unknown): CredentialUri[] {
  if (!Array.isArray(value)) return [];
  const out: CredentialUri[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      if (item) out.push(item);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.uri !== "string" || !record.uri) continue;
    if (isUriMatchMode(record.match)) out.push({ uri: record.uri, match: record.match });
    else out.push({ uri: record.uri });
  }
  return out;
}

export function parseUrl(value: string): URL | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return undefined;
  }
}

export function hostnameOf(value: string): string | undefined {
  const parsed = parseUrl(value);
  return parsed ? parsed.hostname.toLowerCase().replace(/\.$/, "") || undefined : undefined;
}

export function portOfUrl(parsed: URL): string {
  return parsed.port || DEFAULT_PORTS[parsed.protocol] || "";
}

export function portOf(value: string): string | undefined {
  const parsed = parseUrl(value);
  return parsed ? portOfUrl(parsed) : undefined;
}

export function hostPortOf(value: string): string | undefined {
  const parsed = parseUrl(value);
  if (!parsed) return undefined;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return undefined;
  const port = portOfUrl(parsed);
  return port ? `${host}:${port}` : host;
}

/** 界面和提示里展示用的站点名：标准端口省掉，非标准端口带上（如 10.0.0.1:8080）。 */
export function displayHostOf(value: string): string | undefined {
  const parsed = parseUrl(value);
  if (!parsed) return undefined;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return undefined;
  return parsed.port ? `${host}:${parsed.port}` : host;
}

/** 基础域名匹配：页面主机名必须等于保存的主机名，或是它的子域名。 */
export function hostsMatch(pageHost: string, savedHost: string): boolean {
  const page = pageHost.toLowerCase().replace(/\.$/, "");
  const saved = savedHost.toLowerCase().replace(/\.$/, "");
  return Boolean(page && saved) && (page === saved || page.endsWith(`.${saved}`));
}

export function effectiveMatchMode(entry: CredentialUri): UriMatchMode {
  if (typeof entry === "string") return URI_MATCH_BASE_DOMAIN;
  return isUriMatchMode(entry.match) ? entry.match : URI_MATCH_BASE_DOMAIN;
}

export function hasActiveUri(uris: readonly CredentialUri[]): boolean {
  return uris.some((entry) => effectiveMatchMode(entry) !== URI_MATCH_NEVER);
}

/**
 * 按一条保存网址自己的 match（未设或纯字符串按基础域名）判断当前页面完整网址是否匹配。
 * 返回命中后的匹配方式和审批作用域键；不匹配返回 null。
 */
export function matchUriEntry(entry: CredentialUri, pageUrl: string): UriMatchResult | null {
  const savedUri = credentialUriText(entry);
  if (!savedUri || !pageUrl) return null;
  const mode = effectiveMatchMode(entry);
  if (mode === URI_MATCH_NEVER) return null;
  switch (mode) {
    case URI_MATCH_BASE_DOMAIN: {
      const pageHost = hostnameOf(pageUrl);
      const savedHost = hostnameOf(savedUri);
      if (!pageHost || !savedHost || !hostsMatch(pageHost, savedHost)) return null;
      return { uri: savedUri, mode, scope: pageHost };
    }
    case URI_MATCH_HOST: {
      const parsedPage = parseUrl(pageUrl);
      const parsedSaved = parseUrl(savedUri);
      if (!parsedPage || !parsedSaved) return null;
      const pageHost = parsedPage.hostname.toLowerCase().replace(/\.$/, "");
      const savedHost = parsedSaved.hostname.toLowerCase().replace(/\.$/, "");
      const pagePort = portOfUrl(parsedPage);
      const savedPort = portOfUrl(parsedSaved);
      if (!pageHost || !savedHost || pageHost !== savedHost || pagePort !== savedPort) return null;
      return { uri: savedUri, mode, scope: pagePort ? `${pageHost}:${pagePort}` : pageHost };
    }
    case URI_MATCH_STARTS_WITH: {
      if (!pageUrl.startsWith(savedUri)) return null;
      return { uri: savedUri, mode, scope: savedUri };
    }
    case URI_MATCH_EXACT: {
      if (pageUrl !== savedUri) return null;
      return { uri: savedUri, mode, scope: pageUrl };
    }
    case URI_MATCH_REGEX: {
      let matched = false;
      try {
        matched = new RegExp(savedUri).test(pageUrl);
      } catch {
        return null;
      }
      if (!matched) return null;
      return { uri: savedUri, mode, scope: hostPortOf(pageUrl) ?? pageUrl };
    }
    default:
      return null;
  }
}

/**
 * 判断候选账号的多条保存网址是否命中当前页面；多条同时命中时取更具体的一条，
 * 让「总是允许」和 10 分钟批准记录落在更窄的作用域上。
 */
export function matchCandidateUris(uris: readonly CredentialUri[], pageUrl: string): UriMatchResult | null {
  let best: UriMatchResult | null = null;
  for (const entry of uris) {
    const matched = matchUriEntry(entry, pageUrl);
    if (!matched) continue;
    if (!best || MODE_SPECIFICITY[matched.mode] > MODE_SPECIFICITY[best.mode]) best = matched;
  }
  return best;
}

export function urisMatchUrl(uris: readonly CredentialUri[], pageUrl: string): boolean {
  return matchCandidateUris(uris, pageUrl) !== null;
}
