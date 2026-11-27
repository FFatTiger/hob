import { describe, expect, it } from "vitest";
import {
  URI_MATCH_BASE_DOMAIN,
  URI_MATCH_EXACT,
  URI_MATCH_HOST,
  URI_MATCH_NEVER,
  URI_MATCH_REGEX,
  URI_MATCH_STARTS_WITH,
  matchCandidateUris,
  matchUriEntry,
  normalizeCredentialUris,
  urisMatchUrl,
} from "../src/uri-match.ts";

describe("uri-match", () => {
  it("mode 0 (base domain): matches exact host or subdomain and ignores port/path", () => {
    expect(matchUriEntry({ uri: "https://example.net", match: URI_MATCH_BASE_DOMAIN }, "https://example.net/login")).toEqual({
      uri: "https://example.net",
      mode: URI_MATCH_BASE_DOMAIN,
      scope: "example.net",
    });
    expect(matchUriEntry({ uri: "https://example.net", match: URI_MATCH_BASE_DOMAIN }, "https://login.example.net:8443/auth")?.scope).toBe("login.example.net");
    expect(matchUriEntry({ uri: "https://login.example.net", match: URI_MATCH_BASE_DOMAIN }, "https://example.net/login")).toBeNull();
    expect(matchUriEntry({ uri: "https://forum.example.net", match: URI_MATCH_BASE_DOMAIN }, "https://forum-example.net.verify-login.io/login")).toBeNull();
    expect(matchUriEntry({ uri: "http://192.168.1.10:8080", match: URI_MATCH_BASE_DOMAIN }, "http://192.168.1.10:9090/login")?.scope).toBe("192.168.1.10");
  });

  it("mode 1 (host): matches hostname and port, using protocol default ports when omitted", () => {
    // 同一 IP 不同端口
    expect(matchUriEntry({ uri: "http://192.168.1.10:8080", match: URI_MATCH_HOST }, "http://192.168.1.10:8080/login")).toEqual({
      uri: "http://192.168.1.10:8080",
      mode: URI_MATCH_HOST,
      scope: "192.168.1.10:8080",
    });
    expect(matchUriEntry({ uri: "http://192.168.1.10:8080", match: URI_MATCH_HOST }, "http://192.168.1.10:9090/login")).toBeNull();

    // 默认端口：http -> 80，https -> 443
    expect(matchUriEntry({ uri: "https://app.example.com", match: URI_MATCH_HOST }, "https://app.example.com:443/signin")?.scope).toBe("app.example.com:443");
    expect(matchUriEntry({ uri: "https://app.example.com:443", match: URI_MATCH_HOST }, "https://app.example.com/signin")?.scope).toBe("app.example.com:443");
    expect(matchUriEntry({ uri: "http://app.example.com", match: URI_MATCH_HOST }, "http://app.example.com:80/signin")?.scope).toBe("app.example.com:80");
    expect(matchUriEntry({ uri: "http://app.example.com", match: URI_MATCH_HOST }, "https://app.example.com/signin")).toBeNull();

    // 主机模式不匹配子域名
    expect(matchUriEntry({ uri: "https://example.net", match: URI_MATCH_HOST }, "https://login.example.net/signin")).toBeNull();
  });

  it("mode 2 (starts with): matches full URL prefix including path", () => {
    expect(matchUriEntry({ uri: "https://portal.example.com/admin/", match: URI_MATCH_STARTS_WITH }, "https://portal.example.com/admin/login?next=/")).toEqual({
      uri: "https://portal.example.com/admin/",
      mode: URI_MATCH_STARTS_WITH,
      scope: "https://portal.example.com/admin/",
    });
    expect(matchUriEntry({ uri: "https://portal.example.com/admin/", match: URI_MATCH_STARTS_WITH }, "https://portal.example.com/member/login")).toBeNull();
    expect(matchUriEntry({ uri: "http://10.0.0.5:8080/app", match: URI_MATCH_STARTS_WITH }, "http://10.0.0.5:9090/app/login")).toBeNull();
  });

  it("mode 3 (exact): requires full URL equality", () => {
    expect(matchUriEntry({ uri: "https://portal.example.com/admin/login", match: URI_MATCH_EXACT }, "https://portal.example.com/admin/login")).toEqual({
      uri: "https://portal.example.com/admin/login",
      mode: URI_MATCH_EXACT,
      scope: "https://portal.example.com/admin/login",
    });
    expect(matchUriEntry({ uri: "https://portal.example.com/admin/login", match: URI_MATCH_EXACT }, "https://portal.example.com/admin/login?tab=2")).toBeNull();
    expect(matchUriEntry({ uri: "https://portal.example.com/admin/login", match: URI_MATCH_EXACT }, "https://portal.example.com/admin/")).toBeNull();
  });

  it("mode 4 (regex): tests saved pattern against full URL and treats invalid regex as non-match without throwing", () => {
    expect(matchUriEntry({ uri: "^https://10\\.0\\.0\\.5:(8080|8443)/login$", match: URI_MATCH_REGEX }, "https://10.0.0.5:8080/login")).toEqual({
      uri: "^https://10\\.0\\.0\\.5:(8080|8443)/login$",
      mode: URI_MATCH_REGEX,
      scope: "10.0.0.5:8080",
    });
    expect(matchUriEntry({ uri: "^https://10\\.0\\.0\\.5:(8080|8443)/login$", match: URI_MATCH_REGEX }, "https://10.0.0.5:9090/login")).toBeNull();
    // 正则语法错误时直接不匹配，不抛异常
    expect(matchUriEntry({ uri: "[unclosed(", match: URI_MATCH_REGEX }, "https://example.com/login")).toBeNull();
  });

  it("mode 5 (never): never matches regardless of URL equality or global default", () => {
    expect(matchUriEntry({ uri: "https://example.com/login", match: URI_MATCH_NEVER }, "https://example.com/login", URI_MATCH_BASE_DOMAIN)).toBeNull();
    expect(matchUriEntry("https://example.com/login", "https://example.com/login", URI_MATCH_NEVER)).toBeNull();
  });

  it("uses global default when match is missing, null, or entry is a plain string; per-URI match overrides global default", () => {
    expect(urisMatchUrl(["http://10.0.0.5:8080"], "http://10.0.0.5:9090/login", URI_MATCH_BASE_DOMAIN)).toBe(true);
    expect(urisMatchUrl(["http://10.0.0.5:8080"], "http://10.0.0.5:9090/login", URI_MATCH_HOST)).toBe(false);
    expect(urisMatchUrl([{ uri: "http://10.0.0.5:8080", match: null }], "http://10.0.0.5:9090/login", URI_MATCH_HOST)).toBe(false);
    expect(urisMatchUrl([{ uri: "http://10.0.0.5:8080", match: URI_MATCH_BASE_DOMAIN }], "http://10.0.0.5:9090/login", URI_MATCH_HOST)).toBe(true);
    expect(urisMatchUrl([{ uri: "http://10.0.0.5:8080", match: URI_MATCH_HOST }], "http://10.0.0.5:9090/login", URI_MATCH_BASE_DOMAIN)).toBe(false);
    expect(urisMatchUrl([{ uri: "http://10.0.0.5:8080", match: URI_MATCH_HOST }], "http://10.0.0.5:8080/login", URI_MATCH_NEVER)).toBe(true);
  });

  it("normalizes mixed legacy strings and { uri, match } entries", () => {
    expect(normalizeCredentialUris([
      "https://legacy.example.com",
      { uri: "http://10.0.0.5:8080", match: 1 },
      { uri: "https://unset-null.example.com", match: null },
      { uri: "https://unset-missing.example.com" },
      { uri: "https://base.example.com", match: 0 },
      { uri: "https://invalid-match.example.com", match: 99 },
      { uri: "" },
      null,
    ])).toEqual([
      "https://legacy.example.com",
      { uri: "http://10.0.0.5:8080", match: 1 },
      { uri: "https://unset-null.example.com" },
      { uri: "https://unset-missing.example.com" },
      { uri: "https://base.example.com", match: 0 },
      { uri: "https://invalid-match.example.com" },
    ]);
  });

  it("picks the narrower scope when multiple saved URIs match the same page", () => {
    const result = matchCandidateUris([
      { uri: "http://10.0.0.5", match: URI_MATCH_BASE_DOMAIN },
      { uri: "http://10.0.0.5:8080", match: URI_MATCH_HOST },
    ], "http://10.0.0.5:8080/login", URI_MATCH_BASE_DOMAIN);
    expect(result).toEqual({
      uri: "http://10.0.0.5:8080",
      mode: URI_MATCH_HOST,
      scope: "10.0.0.5:8080",
    });
  });
});
