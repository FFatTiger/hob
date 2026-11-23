// 填写登录 / 生成新密码的端到端：真 Chrome（假云桌面转它的调试口）、假网站、假的密码管理插件、假模型。
// 每条路径都看网页上真的填对了（提交后页面显示的结果），再在整个 HOB_HOME、推给前端的事件和日志里搜不到密码。
// 没有 Chrome（找不到 google-chrome，也没设 HOB_TEST_CHROME）就整组跳过。
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Approval, HobEvent } from "../../shared/types.ts";
import { answerApproval } from "../src/actions.ts";
import { readLoginAuto } from "../src/login-auto.ts";
import { call, makeHob, text, type TestHob } from "./helpers.ts";
import { startFakeDesktopd } from "./fixtures/fake-desktopd.mjs";
import { startFakeSites } from "./fixtures/fake-sites.mjs";

const chromePath = process.env.HOB_TEST_CHROME ?? ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path) => existsSync(path));
const HOSTS = ["forum.example.net", "login.example.net", "shop.example.com", "books.example.com", "forum-example.net.verify-login.io", "wiki.example.org"];
const PASSWORDS = { forum: "forum-secret-7QhV", community: "reader-secret-7QhV", book: "book-secret-7QhV", alt: "alt-secret-7QhV" };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
  });
}

async function waitUntil(check: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等到超时");
}

function walk(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((name) => { const path = join(root, name); return statSync(path).isDirectory() ? walk(path) : statSync(path).size < 5 * 1024 * 1024 ? [path] : []; });
}

const describeE2E = chromePath ? describe : describe.skip;

describeE2E("填写登录 / 新密码端到端（真 Chrome）", () => {
  let hob: TestHob;
  let chrome: ChildProcess | undefined;
  let desktopd: Awaited<ReturnType<typeof startFakeDesktopd>>;
  let sites: Awaited<ReturnType<typeof startFakeSites>>;
  let harness: Browser;
  let page: Page;
  let tmp: string;
  let vaultPath: string;
  let logPath: string;
  const events: HobEvent[] = [];
  const logs: string[] = [];
  let secrets: string[] = [];

  const vault = () => JSON.parse(readFileSync(vaultPath, "utf8")) as { folders: { id: string; name: string }[]; items: { id: string; name: string; login: { username: string; password: string; uris: { uri: string }[] } }[] };
  const fixtureCalls = () => existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean) : [];
  const toolResults = (toolName: string) => hob.runtime.router.sessionEntries("hob").flatMap((entry) => (entry as { message?: { role?: string; toolName?: string; content?: unknown; isError?: boolean } }).message?.role === "toolResult" && (entry as { message: { toolName?: string } }).message.toolName === toolName ? [entry as { message: { content: { type: string; text?: string }[]; isError?: boolean } }] : []);
  const lastResult = (toolName: string) => { const found = toolResults(toolName).at(-1); if (!found) throw new Error(`没有 ${toolName} 的工具结果`); return { text: found.message.content.map((part) => part.text ?? "").join("\n"), isError: Boolean(found.message.isError) }; };
  const approvals = () => hob.runtime.store.approvals().filter((approval) => approval.login?.fillLogin || approval.login?.fillNewPassword);
  const pending = () => approvals().filter((approval) => approval.status === "pending");
  const goto = async (url: string) => { await page.goto(url); await page.waitForLoadState("domcontentloaded"); };
  const inputs = () => page.locator("input").evaluateAll((elements) => elements.map((element) => { const input = element as HTMLInputElement; return { type: input.type, name: input.name, autocomplete: input.autocomplete, value: input.value }; }));
  const submit = async () => { await page.locator('button[type="submit"], button:not([type])').first().click(); await page.waitForLoadState("domcontentloaded"); await page.waitForTimeout(200); return { url: page.url(), text: await page.locator("body").innerText() }; };
  const eventText = (messages: unknown[]): string => {
    const last = (messages as Array<{ role?: string; content?: unknown }>).filter((message) => message.role === "user").at(-1);
    const content = last?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string })?.text ?? "").join("") : "";
    return text.slice(text.lastIndexOf("[hob-event]"));
  };
  const turn = async (toolName: string, args: Record<string, unknown>, userText = "帮我登录") => {
    hob.faux.setResponses([call(toolName, args), text("好的。")]);
    await hob.runtime.router.send("hob", { text: userText });
    await hob.runtime.router.waitIdle("hob");
    return lastResult(toolName);
  };
  const approve = async (body: { key: "A" | "B" | "C"; candidateId?: string; folder?: string }) => {
    const approval = pending().at(-1);
    if (!approval) throw new Error("没有待批准的卡");
    const before = logs.length;
    hob.faux.setResponses([(context: { messages: unknown[] }) => { logs.push(JSON.stringify(context.messages)); return text("收到，我来点登录。"); }]);
    const response = await answerApproval(hob.runtime, approval.id, body);
    expect(response.status).toBe(200);
    // 事件那一轮是异步排进会话的：等模型真的看到它
    await waitUntil(() => logs.length > before, 15_000);
    await hob.runtime.router.waitIdle("hob");
    const seen = JSON.parse(logs.at(-1)!) as unknown[];
    return { response, approval: hob.runtime.store.approval(approval.id)!, event: eventText(seen) };
  };

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "hob-fill-e2e-"));
    const profile = join(tmp, "chrome-profile");
    vaultPath = join(tmp, "vault.json");
    logPath = join(tmp, "fixture-calls.log");
    const [sitesPort, cdpPort, desktopPort] = await Promise.all([freePort(), freePort(), freePort()]);
    sites = await startFakeSites({ port: sitesPort, expected: { forum: { username: "lin@example.com", password: PASSWORDS.forum }, community: { username: "reader@example.net", password: PASSWORDS.community }, books: { username: "lin@example.com", password: PASSWORDS.book } } });
    writeFileSync(vaultPath, `${JSON.stringify({
      folders: [{ id: "folder-forum", name: "论坛账号" }],
      items: [
        { id: "login-forum", type: 1, name: "Example 论坛", folderId: "folder-forum", login: { username: "lin@example.com", password: PASSWORDS.forum, uris: [{ uri: "https://forum.example.net/" }] } },
        { id: "login-forum-alt", type: 1, name: "Example 论坛（小号）", folderId: "folder-forum", login: { username: "lin.alt@example.com", password: PASSWORDS.alt, uris: [{ uri: "https://forum.example.net/" }] } },
        { id: "login-community", type: 1, name: "Example 社区", folderId: "folder-forum", login: { username: "reader@example.net", password: PASSWORDS.community, uris: [{ uri: "https://example.net/" }] } },
        { id: "login-book", type: 1, name: "二手书市", login: { username: "lin@example.com", password: PASSWORDS.book, uris: [{ uri: "https://books.example.com/" }] } },
      ],
    }, null, 2)}\n`);
    chrome = spawn(chromePath!, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, `--host-resolver-rules=${HOSTS.map((host) => `MAP ${host} 127.0.0.1:${sitesPort}`).join(", ")}`, "about:blank"], { stdio: "ignore", detached: true });
    await waitUntil(async () => { try { return (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok; } catch { return false; } }, 15_000);
    const token = "fake-desktop-token";
    desktopd = await startFakeDesktopd({ port: desktopPort, cdp: `http://127.0.0.1:${cdpPort}`, token });
    process.env.HOB_DESKTOP_URL = desktopd.url;
    process.env.HOB_DESKTOP_TOKEN = token;
    hob = makeHob({}, { memory: "off" });
    const host = hob.runtime.plugins;
    host.store.addCustom("vault", { command: process.execPath, args: [join(import.meta.dirname, "fixtures", "credentials-fixture.mjs")], env: { HOB_FAKE_VAULT: vaultPath, HOB_FAKE_LOG: logPath } });
    const manifestPath = join(hob.home, "plugins", "vault", "plugin.json");
    writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, "utf8")), displayName: "测试密码库" }, null, 2));
    await host.start();
    expect(host.credentialProviders("hob").map((provider) => provider.role).sort()).toEqual(["generate", "list", "save", "secret"]);
    for (const level of ["log", "error", "warn", "info"] as const) vi.spyOn(console, level).mockImplementation((...parts: unknown[]) => { logs.push(parts.map((part) => (part instanceof Error ? part.stack ?? part.message : typeof part === "string" ? part : JSON.stringify(part))).join(" ")); });
    hob.runtime.bus.subscribe((event) => events.push(event));
    harness = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    page = harness.contexts()[0]!.pages()[0]!;
  }, 60_000);

  afterAll(async () => {
    delete process.env.HOB_DESKTOP_URL;
    delete process.env.HOB_DESKTOP_TOKEN;
    vi.restoreAllMocks();
    await harness?.close().catch(() => {});
    await hob?.runtime.plugins.close();
    hob?.close();
    await desktopd?.close();
    await sites?.close();
    // 自己起的 Chrome 整个进程组一起停（渲染进程还会往 profile 里写一会儿），临时目录删不干净也不算测试失败
    if (chrome && chrome.pid) {
      const exited = new Promise((resolve) => chrome!.once("exit", resolve));
      try { process.kill(-chrome.pid, "SIGTERM"); } catch { chrome.kill("SIGTERM"); }
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { console.warn(`临时目录没删干净：${tmp}`); }
  }, 60_000);

  const expectNoSecrets = () => {
    const haystack = [...walk(hob.home).map((path) => readFileSync(path, "utf8")), JSON.stringify(events), ...logs].join("\n");
    for (const secret of secrets.filter(Boolean)) expect(haystack, `密码出现在 HOB_HOME、事件或日志里：${secret.slice(0, 4)}…`).not.toContain(secret);
  };
  const itemByName = (name: string) => vault().items.filter((item) => item.name === name);

  it("一步登录：批准后填好账号和密码，网站收到正确的值，密码不落盘", async () => {
    await goto("http://forum.example.net/login");
    const result = await turn("fill_login", { site: "forum.example.net" }, "去 Example 论坛帮我看看有没有新私信");
    expect(result.text).toBe("已请用户批准在 forum.example.net 填写登录，这一轮先到这里；用户批准后 Hob 会填好并告诉你。");
    const [approval] = pending();
    expect(approval).toMatchObject({ title: "在 forum.example.net 登录", options: [{ key: "A", label: "不允许" }, { key: "B", label: "这次允许" }, { key: "C", label: "这个网站以后都允许", always: true }], login: { fillLogin: { state: "pending", candidates: [{ provider: "vault", id: "login-forum", username: "lin@example.com", folder: "论坛账号" }, { provider: "vault", id: "login-forum-alt", username: "lin.alt@example.com", folder: "论坛账号" }, { provider: "vault", id: "login-community", username: "reader@example.net" }] } } });
    expect(JSON.stringify(approval)).not.toContain(PASSWORDS.forum);
    expect((await inputs()).every((input) => input.value === "")).toBe(true);

    const { approval: answered, event } = await approve({ key: "B", candidateId: "vault:login-forum" });
    expect(answered).toMatchObject({ status: "answered", chosen: "B", login: { fillLogin: { state: "filled", result: "已登录 · 这次允许", chosenId: "vault:login-forum" } } });
    expect(event).toContain("用户允许了在 forum.example.net 登录，Hob 已填好 lin@example.com 的账号和密码，接下来点登录按钮。");
    expect(await inputs()).toMatchObject([{ name: "email", value: "lin@example.com" }, { name: "password", value: PASSWORDS.forum }]);
    const submitted = await submit();
    expect(submitted.url).toBe("http://forum.example.net/inbox");
    expect(submitted.text).toContain("新私信：2 条");
    expect(sites.received.at(-1)).toMatchObject({ kind: "login", usernameOk: true, passwordOk: true });
    expect(readFileSync(join(hob.home, "assistants", "hob", "router.jsonl"), "utf8")).not.toContain(PASSWORDS.forum);
    expectNoSecrets();
  });

  it("两步登录：先填用户名，十分钟内第二次不再问，填好密码", async () => {
    await goto("http://login.example.net/");
    const first = await turn("fill_login", { site: "Example 社区" }, "看看 Example 社区有没有新私信");
    expect(first.text).toBe("已请用户批准在 login.example.net 填写登录，这一轮先到这里；用户批准后 Hob 会填好并告诉你。");
    const { approval, event } = await approve({ key: "B" });
    expect(approval.login?.fillLogin).toMatchObject({ state: "filled", result: "已填好用户名 reader@example.net" });
    expect(event).toContain("用户允许了在 login.example.net 登录，Hob 已填好用户名 reader@example.net，点下一步后再调一次 fill_login 填密码。");
    expect(await inputs()).toMatchObject([{ name: "user", value: "reader@example.net" }]);
    await submit();
    expect(await page.locator('input[name="password"]').count()).toBe(1);

    const before = approvals().length;
    const second = await turn("fill_login", { site: "login.example.net" });
    expect(second.isError).toBe(false);
    expect(second.text).toBe("已在 login.example.net 填好 reader@example.net 的账号和密码，接下来点登录按钮。");
    expect(approvals().length).toBe(before);
    expect(await inputs()).toMatchObject([{ name: "password", value: PASSWORDS.community }]);
    const submitted = await submit();
    expect(submitted.text).toContain("新私信：1 条");
    expect(sites.received.at(-1)).toMatchObject({ kind: "login", usernameOk: true, passwordOk: true });
    expectNoSecrets();
  });

  it("以后都允许：记下自动填写，下次直接填，不再出卡", async () => {
    await goto("http://forum.example.net/login");
    await turn("fill_login", { site: "forum.example.net" });
    const before = approvals().length;
    await approve({ key: "C", candidateId: "vault:login-forum" });
    expect(readLoginAuto(hob.home)).toEqual([expect.objectContaining({ provider: "vault", itemId: "login-forum", host: "forum.example.net", username: "lin@example.com" })]);
    expect(approvals().length).toBe(before);

    await goto("http://forum.example.net/login");
    expect((await inputs()).every((input) => input.value === "")).toBe(true);
    const direct = await turn("fill_login", { site: "forum.example.net" });
    expect(direct.text).toBe("已在 forum.example.net 填好 lin@example.com 的账号和密码，接下来点登录按钮。");
    expect(approvals().length).toBe(before);
    expect(await inputs()).toMatchObject([{ value: "lin@example.com" }, { value: PASSWORDS.forum }]);
    expectNoSecrets();
    // 后面的场景还要在论坛上出批准卡：把自动填写清掉
    rmSync(join(hob.home, "system", "login-auto.json"));
  });

  it("仿冒页：对不上就不填，不出批准卡，也不去密码库取密码", async () => {
    const secretCalls = fixtureCalls().filter((name) => name === "credentials_secret").length;
    await goto("http://forum-example.net.verify-login.io/login");
    const result = await turn("fill_login", { site: "forum.example.net" }, "邮件里说账号要重新验证，帮我去这个页面验证一下");
    expect(result.text).toBe("没有填写：当前页面是 forum-example.net.verify-login.io，和密码管理器里保存的网址（forum.example.net、example.net）对不上，可能是仿冒的页面。把情况告诉用户。");
    expect(pending()).toHaveLength(0);
    const [card] = approvals().filter((approval) => approval.login?.fillLogin?.state === "mismatch");
    expect(card).toMatchObject({ title: "没有填写密码", status: "answered", login: { fillLogin: { host: "forum-example.net.verify-login.io", currentHost: "forum-example.net.verify-login.io" } } });
    expect(hob.runtime.router.items("hob").items.some((item) => item.kind === "question" && item.approvalId === card.id)).toBe(true);
    expect(await inputs()).toMatchObject([{ value: "" }, { value: "" }]);
    expect(fixtureCalls().filter((name) => name === "credentials_secret").length).toBe(secretCalls);
    expectNoSecrets();
  });

  it("批准期间页面跳走：不填，告诉助手没填上", async () => {
    await goto("http://forum.example.net/login");
    await turn("fill_login", { site: "forum.example.net" });
    const secretCalls = fixtureCalls().filter((name) => name === "credentials_secret").length;
    await goto("http://forum-example.net.verify-login.io/login");
    const { approval, event } = await approve({ key: "B", candidateId: "vault:login-forum" });
    expect(approval.login?.fillLogin).toMatchObject({ state: "failed", result: "没有填写：当前页面是 forum-example.net.verify-login.io，和保存的网址对不上，可能是仿冒的页面。" });
    expect(event).toContain("用户允许了在 forum.example.net 登录，但没有填上：当前页面是 forum-example.net.verify-login.io，和保存的网址对不上，可能是仿冒的页面。");
    expect(await inputs()).toMatchObject([{ value: "" }, { value: "" }]);
    expect(fixtureCalls().filter((name) => name === "credentials_secret").length).toBe(secretCalls);
    expectNoSecrets();
  });

  it("密码库里没有这个网站：按原文告诉助手，不出卡", async () => {
    await goto("http://wiki.example.org/login");
    const result = await turn("fill_login", { site: "wiki.example.org" }, "帮我登录 Example 百科");
    expect(result.text).toBe("密码管理器里没有 wiki.example.org 的账号。注册新账号用 fill_new_password；用户有账号但没存的，可以请他在云桌面里自己登录，或者用密码管理插件的保存工具存进去。");
    expect(approvals().filter((approval) => approval.status === "pending")).toHaveLength(0);
    expect(await inputs()).toMatchObject([{ value: "" }, { value: "" }]);
  });

  it("页面没有登录框（只有搜索框）：先不出卡，告诉助手先打开登录表单", async () => {
    await goto("http://forum.example.net/about?search=1");
    const result = await turn("fill_login", { site: "forum.example.net" });
    expect(result.text).toBe("当前页面（http://forum.example.net/about?search=1）上没有找到登录框。先打开登录表单再调 fill_login。");
    expect(pending()).toHaveLength(0);
  });

  it("注册：按页面的规则生成，先存进密码库再填，网站收到的密码和库里存的一致", async () => {
    await goto("http://shop.example.com/register");
    const result = await turn("fill_new_password", { username: "lin@example.com", length: 12, characters: ["lowercase", "uppercase", "numbers"], name: "Example 商城" }, "帮我在 Example 商城注册个账号，用 lin@example.com");
    expect(result.text).toBe("已请用户批准在 shop.example.com 注册新账号，这一轮先到这里；用户批准后 Hob 会生成、保存并填好。");
    const [approval] = pending();
    expect(approval).toMatchObject({ title: "在 shop.example.com 注册", options: [{ key: "A", label: "不允许" }, { key: "B", label: "生成并填写" }], login: { fillNewPassword: { mode: "register", username: "lin@example.com", length: 12, characters: ["lowercase", "uppercase", "numbers"], name: "Example 商城", origin: "http://shop.example.com", folders: ["论坛账号"] } } });
    expect(approval.login?.fillNewPassword?.candidate).toBeUndefined();
    expect(JSON.stringify(approval)).not.toMatch(/"password"/);

    const { approval: answered, event } = await approve({ key: "B", folder: "论坛账号" });
    expect(answered.login?.fillNewPassword).toMatchObject({ state: "filled", folder: "论坛账号", result: "已填写，已存进 测试密码库「论坛账号」" });
    const [item] = itemByName("Example 商城");
    secrets.push(item.login.password);
    expect(item.login.password).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(item.login.password).toMatch(/[a-z]/);
    expect(item.login.password).toMatch(/[A-Z]/);
    expect(item.login.password).toMatch(/[0-9]/);
    expect(item.login.uris).toEqual([{ uri: "http://shop.example.com" }]);
    expect(event).toContain(`用户允许了在 shop.example.com 注册新账号，Hob 已生成 12 位新密码（字母和数字），存进 测试密码库「论坛账号」的「Example 商城」，并填好了密码框。`);
    expect(await inputs()).toMatchObject([{ name: "email", value: "lin@example.com" }, { name: "password", value: item.login.password }, { name: "confirm", value: item.login.password }]);
    const submitted = await submit();
    expect(submitted.text).toContain("注册成功");
    expect(sites.received.at(-1)).toMatchObject({ kind: "register", accepted: true, password: item.login.password });
    expectNoSecrets();
  });

  it("网站拒收后再调：更新同一条，不多存，批准卡照样出", async () => {
    await goto("http://shop.example.com/register");
    await turn("fill_new_password", { username: "lin.shopper@example.com", length: 20 }, "再帮我注册一个 Example 商城账号，用 lin.shopper@example.com");
    await approve({ key: "B" });
    const [first] = itemByName("shop.example.com");
    secrets.push(first.login.password);
    expect(first.login.password).toMatch(/[^A-Za-z0-9]/);
    const rejected = await submit();
    expect(rejected.text).toContain("密码不能包含符号");
    expect(sites.received.at(-1)).toMatchObject({ accepted: false, problems: expect.arrayContaining(["密码不能包含符号"]) });

    const again = await turn("fill_new_password", { username: "lin.shopper@example.com", length: 10, characters: ["lowercase", "numbers"], name: "Example 商城（第二个）" });
    expect(again.text).toBe("已请用户批准在 shop.example.com 注册新账号，这一轮先到这里；用户批准后 Hob 会生成、保存并填好。");
    const [approval] = pending();
    expect(approval.login?.fillNewPassword).toMatchObject({ mode: "register", candidate: { id: first.id } });
    expect(approval.login?.fillNewPassword?.folder).toBeUndefined();
    const { event } = await approve({ key: "B" });
    const items = vault().items.filter((item) => item.login.username === "lin.shopper@example.com");
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(first.id);
    secrets.push(items[0]!.login.password);
    expect(items[0]!.login.password).toMatch(/^[a-z0-9]{10}$/);
    expect(event).toContain("用户允许了在 shop.example.com 注册新账号，Hob 已生成 10 位新密码（小写字母、数字）");
    const submitted = await submit();
    expect(submitted.text).toContain("注册成功");
    expectNoSecrets();
  });

  it("改密码：旧密码填第一个框，新密码存回原来那一条并填其余框", async () => {
    await goto("http://books.example.com/account/password");
    const result = await turn("fill_new_password", { username: "lin@example.com", length: 16 }, "把二手书市的密码改一下");
    expect(result.text).toBe("已请用户批准在 books.example.com 修改密码，这一轮先到这里；用户批准后 Hob 会生成、保存并填好。");
    const [approval] = pending();
    expect(approval).toMatchObject({ title: "在 books.example.com 修改密码", login: { fillNewPassword: { mode: "change", candidate: { id: "login-book", username: "lin@example.com" }, folders: ["论坛账号"] } } });
    const { approval: answered, event } = await approve({ key: "B" });
    expect(answered.login?.fillNewPassword).toMatchObject({ state: "filled", result: "已填写，已存进 测试密码库「未分类」" });
    const [item] = itemByName("二手书市");
    expect(item.id).toBe("login-book");
    secrets.push(item.login.password);
    expect(item.login.password).toHaveLength(16);
    expect(event).toContain("用户允许了在 books.example.com 修改密码，Hob 已生成 16 位新密码（含符号），存进 测试密码库「未分类」的「二手书市」，并填好了密码框。");
    expect(await inputs()).toMatchObject([{ name: "old", value: PASSWORDS.book }, { name: "new", value: item.login.password }, { name: "confirm", value: item.login.password }]);
    const submitted = await submit();
    expect(submitted.text).toContain("密码已修改");
    expect(sites.received.at(-1)).toMatchObject({ kind: "change", oldOk: true, same: true, fresh: true });
    expectNoSecrets();
  });

  it("保存成功但填写失败（用户批准期间页面跳走）：明说已存进哪一条，密码不落盘", async () => {
    await goto("http://shop.example.com/register");
    await turn("fill_new_password", { username: "lin.lost@example.com", length: 14, name: "Example 商城（丢三落四）" });
    await goto("http://forum.example.net/about");
    const { approval, event } = await approve({ key: "B" });
    expect(approval.login?.fillNewPassword).toMatchObject({ state: "failed" });
    expect(approval.login?.fillNewPassword?.result).toContain("没有完成：新密码已经存进 测试密码库「Example 商城（丢三落四）」；当前页面是 forum.example.net，和刚才核对的页面对不上，已保存新密码但没有填写。");
    expect(event).toContain("用户允许了在 shop.example.com 注册新账号，但没有完成：新密码已经存进 测试密码库「Example 商城（丢三落四）」；");
    const [item] = itemByName("Example 商城（丢三落四）");
    secrets.push(item.login.password);
    expect(await inputs()).toEqual([]);
    expectNoSecrets();
  });

  it("不允许：什么都不填，密码库不动", async () => {
    await goto("http://forum.example.net/login");
    await turn("fill_login", { site: "forum.example.net" });
    const { approval, event } = await approve({ key: "A", candidateId: "vault:login-forum" });
    expect(approval.login?.fillLogin).toMatchObject({ state: "rejected", result: "已拒绝" });
    expect(event).toContain("用户没有允许在 forum.example.net 填写登录。");
    expect(await inputs()).toMatchObject([{ value: "" }, { value: "" }]);
    await goto("http://shop.example.com/register");
    await turn("fill_new_password", { username: "lin.no@example.com", length: 12 });
    const before = vault().items.length;
    const rejected = await approve({ key: "A" });
    expect(rejected.event).toContain("用户没有允许在 shop.example.com 注册新账号。");
    expect(vault().items.length).toBe(before);
    expectNoSecrets();
  });

  it("整个过程里密码没有进 HOB_HOME、事件、日志，假密码库之外的文件里也没有", () => {
    secrets.push(...vault().items.map((item) => item.login.password));
    expectNoSecrets();
    expect(walk(hob.home).length).toBeGreaterThan(10);
    expect(readFileSync(join(hob.home, "system", "new-password.json"), "utf8")).not.toContain("password");
  });
});

describe("fake desktopd", () => {
  it("要令牌，没有就是 401", async () => {
    const { startFakeDesktopd: start } = await import("./fixtures/fake-desktopd.mjs");
    const fake = await start({ port: 0, cdp: "http://127.0.0.1:1", token: "t" });
    try {
      expect((await fetch(`${fake.url}/api/health`)).status).toBe(401);
      expect((await fetch(`${fake.url}/api/health`, { headers: { Authorization: "Bearer t" } })).status).toBe(200);
      await expect((await fetch(`${fake.url}/api/screens/hob/browser/start`, { method: "POST", headers: { Authorization: "Bearer t" } })).json()).resolves.toEqual({ cdp: "/cdp/hob" });
    } finally { await fake.close(); }
  });
});
