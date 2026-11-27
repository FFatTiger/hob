import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildRouterTools } from "../src/router-tools.ts";
import { DesktopToolSession } from "../src/desktop-tools.ts";
import { credentialCandidates, hostsMatch, matchingCandidates, prepareLogin, rememberAutoLogin } from "../src/login.ts";
import { readLoginAuto, saveLoginAuto } from "../src/login-auto.ts";
import { URI_MATCH_BASE_DOMAIN, URI_MATCH_EXACT, URI_MATCH_HOST, URI_MATCH_NEVER, URI_MATCH_REGEX, URI_MATCH_STARTS_WITH } from "../src/uri-match.ts";
import { makeHob } from "./helpers.ts";

describe("login safety boundaries", () => {
  it("only accepts the saved host or one of its subdomains", () => {
    expect(hostsMatch("login.example.net", "example.net")).toBe(true);
    expect(hostsMatch("example.net", "login.example.net")).toBe(false);
    expect(hostsMatch("forum-example.net.verify-login.io", "forum.example.net")).toBe(false);
    expect(hostsMatch("example.net.", "example.net")).toBe(true);
  });

  it("persists only the auto-fill identity and never a password", () => {
    const hob = makeHob();
    const password = "unique-password-that-must-not-be-written";
    try {
      saveLoginAuto(hob.home, { provider: "bitwarden", itemId: "item-1", host: "forum.example.net", username: "user@example.net" });
      assert.deepEqual(readLoginAuto(hob.home), [{ provider: "bitwarden", itemId: "item-1", host: "forum.example.net", username: "user@example.net", at: readLoginAuto(hob.home)[0]!.at }]);
      expect(readFileSync(join(hob.home, "system", "login-auto.json"), "utf8")).not.toContain(password);
    } finally { hob.close(); }
  });

  it("login 没有凭据提供者时只请用户自己登录：没有 account 参数，说明是那一段短话", () => {
    const hob = makeHob();
    try {
      const tool = buildRouterTools(hob.runtime, "hob").find((tool) => tool.name === "login")!;
      expect(tool).toBeDefined();
      expect(tool.parameters.properties).toEqual({ site: expect.anything(), reason: expect.anything() });
      expect(tool.description).toBe("请用户在云桌面里登录一个网站：会出一张卡，用户登录完会告诉你；登录信息所有助手共用，登一次就行。site 写哪个网站，reason 一句话写为什么要登录。");
      expect(buildRouterTools(hob.runtime, "hob").some((tool) => tool.name === "login")).toBe(true);
    } finally { hob.close(); }
  });

  it("finds candidates by name and by host, including a saved parent or child domain, exact host first", async () => {
    const logins = [
      { id: "community", name: "Example 社区", username: "reader@example.net", uris: ["https://example.net/"], folder: "论坛账号" },
      { id: "forum-alt", name: "Example 论坛（小号）", username: "lin.alt@example.com", uris: ["https://forum.example.net/"] },
      { id: "photo", name: "摄影社区", username: "linphoto", uris: ["https://photo.example.org/"] },
    ];
    const runtime = { plugins: { credentialProviders: () => [{ pluginId: "vault", providerName: "测试密码库" }], callCredential: async () => ({ logins }) } } as any;
    const ids = async (site: string, account?: string) => (await credentialCandidates(runtime, "hob", site, account)).map((candidate) => candidate.id);
    // 页面 login.example.net、保存 example.net：按页面网址找也找得到
    expect(await ids("login.example.net")).toEqual(["community"]);
    // 完全一样的排前面，父域名的跟在后面；别的站点不进来
    expect(await ids("forum.example.net")).toEqual(["forum-alt", "community"]);
    expect(await ids("Example 论坛")).toEqual(["forum-alt"]);
    expect(await ids("example.net", "lin.alt")).toEqual(["forum-alt"]);
    expect(await ids("photo.example.org")).toEqual(["photo"]);
    expect(await ids("wiki.example.org")).toEqual([]);
  });

  it("filters same-IP different-port accounts when global default is Host, while honoring per-URI match and legacy strings", async () => {
    const logins = [
      { id: "svc-a", name: "内网看板", username: "ops-a", uris: ["http://10.0.0.5:8080/login"] }, // 老插件纯字符串
      { id: "svc-b", name: "内网仓库", username: "ops-b", uris: [{ uri: "http://10.0.0.5:9090/login", match: null }] },
      { id: "svc-regex-bad", name: "坏正则条目", username: "ops-bad", uris: [{ uri: "[invalid-regex(", match: URI_MATCH_REGEX }] },
      { id: "svc-never", name: "不自动匹配", username: "ops-never", uris: [{ uri: "http://10.0.0.5:8080/login", match: URI_MATCH_NEVER }] },
      { id: "svc-base-override", name: "全端口共用", username: "ops-all", uris: [{ uri: "http://10.0.0.5:7000", match: URI_MATCH_BASE_DOMAIN }] },
    ];
    const makeRuntime = (loginUriMatch: 0 | 1 | 2 | 3 | 5) => ({
      settings: { settings: { general: { loginUriMatch } } },
      plugins: { credentialProviders: () => [{ pluginId: "bitwarden", providerName: "Bitwarden" }], callCredential: async () => ({ logins }) },
    }) as any;

    // 默认基础域名：8080 和 9090、7000 都会命中，但「从不」和坏正则不命中
    const baseCandidates = await credentialCandidates(makeRuntime(URI_MATCH_BASE_DOMAIN), "hob", "10.0.0.5", undefined, "http://10.0.0.5:8080/login");
    expect(matchingCandidates(baseCandidates, "http://10.0.0.5:8080/login", URI_MATCH_BASE_DOMAIN).map((c) => c.id)).toEqual(["svc-a", "svc-b", "svc-base-override"]);

    // 全局默认改成「主机」后：9090 不再被列出来，8080（老插件字符串）和单条覆盖为基础域名的 7000 命中
    const hostCandidates = await credentialCandidates(makeRuntime(URI_MATCH_HOST), "hob", "10.0.0.5", undefined, "http://10.0.0.5:8080/login");
    expect(matchingCandidates(hostCandidates, "http://10.0.0.5:8080/login", URI_MATCH_HOST).map((c) => c.id)).toEqual(["svc-a", "svc-base-override"]);

    // 全局默认「开始于」「精确」也按规则生效
    const startsCandidates = await credentialCandidates(makeRuntime(URI_MATCH_STARTS_WITH), "hob", "10.0.0.5", undefined, "http://10.0.0.5:8080/login?from=home");
    expect(matchingCandidates(startsCandidates, "http://10.0.0.5:8080/login?from=home", URI_MATCH_STARTS_WITH).map((c) => c.id)).toEqual(["svc-a", "svc-base-override"]);
    const exactCandidates = await credentialCandidates(makeRuntime(URI_MATCH_EXACT), "hob", "10.0.0.5", undefined, "http://10.0.0.5:8080/login?from=home");
    expect(matchingCandidates(exactCandidates, "http://10.0.0.5:8080/login?from=home", URI_MATCH_EXACT).map((c) => c.id)).toEqual(["svc-base-override"]);
  });

  it("always-allow recorded on one port does not auto-fill another port under Host match", async () => {
    const hob = makeHob();
    const filled: { url: string; values: string[] }[] = [];
    let currentUrl = "http://10.0.0.5:8080/login";
    const fakePage = {
      url: () => currentUrl,
      locator: () => ({
        evaluateAll: async () => [
          { type: "text", autocomplete: "username", name: "user", id: "user", value: "", index: 0 },
          { type: "password", autocomplete: "current-password", name: "pass", id: "pass", value: "", index: 1 },
        ],
        nth: () => ({ fill: async (value: string) => { filled.push({ url: currentUrl, values: [value] }); } }),
      }),
    };
    const spy = vi.spyOn(DesktopToolSession.prototype, "withCurrentPage").mockImplementation(async (run) => run(fakePage as any));
    const disposeSpy = vi.spyOn(DesktopToolSession.prototype, "dispose").mockResolvedValue();
    try {
      const rev = hob.runtime.settings.get().revision;
      hob.runtime.settings.patch(rev, { general: { loginUriMatch: URI_MATCH_HOST } });
      const logins = [
        {
          id: "shared-item",
          name: "内网管理",
          username: "admin",
          uris: [
            { uri: "http://10.0.0.5:8080", match: URI_MATCH_HOST },
            { uri: "http://10.0.0.5:9090", match: URI_MATCH_HOST },
          ],
        },
      ];
      const runtime = {
        ...hob.runtime,
        plugins: {
          hasCredentialProvider: () => true,
          credentialProviders: (_assistant: string, role: string) => [{ pluginId: "bitwarden", providerName: "Bitwarden", service: "bw", tool: role, role }],
          callCredential: async (provider: { role: string }) => provider.role === "list" ? { logins } : { username: "admin", password: "secret-port-value" },
        },
      } as any;

      // 在 8080 端口记下「总是允许」
      rememberAutoLogin(runtime, { provider: "bitwarden", providerName: "Bitwarden", id: "shared-item", name: "内网管理", username: "admin", uris: logins[0]!.uris }, "10.0.0.5:8080");

      // 打开 8080 端口：自动填写，不出批准卡
      currentUrl = "http://10.0.0.5:8080/login";
      const port8080 = await prepareLogin(runtime, "hob", "10.0.0.5:8080");
      expect(port8080.kind).toBe("message");
      expect(filled.some((entry) => entry.url === "http://10.0.0.5:8080/login")).toBe(true);

      // 打开同一 IP 的 9090 端口：不会自动填写，必须出批准卡
      filled.length = 0;
      currentUrl = "http://10.0.0.5:9090/login";
      const port9090 = await prepareLogin(runtime, "hob", "10.0.0.5:9090");
      expect(port9090.kind).toBe("approval");
      expect(filled).toHaveLength(0);
    } finally {
      spy.mockRestore();
      disposeSpy.mockRestore();
      hob.close();
    }
  });

  it("rejects regex (4) and out-of-range values for global general.loginUriMatch setting", () => {
    const hob = makeHob();
    try {
      const rev = hob.runtime.settings.get().revision;
      expect(hob.runtime.settings.get().settings.general.loginUriMatch).toBe(0);
      expect(() => hob.runtime.settings.patch(rev, { general: { loginUriMatch: 4 as any } })).toThrow(/匹配方式/);
      expect(() => hob.runtime.settings.patch(rev, { general: { loginUriMatch: 99 as any } })).toThrow(/匹配方式/);
      const updated = hob.runtime.settings.patch(rev, { general: { loginUriMatch: 1 } });
      expect(updated?.settings.general.loginUriMatch).toBe(1);
    } finally { hob.close(); }
  });
});
