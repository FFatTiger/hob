// 假网站：登录、两步登录、注册、改密码、仿冒登录页，给填写登录的端到端测试用。
// 每个站点只显示「收到的值对不对」，不回显密码；收到的值留在内存里，由 startFakeSites() 的返回值交给测试核对。
// 用法：node fake-sites.mjs --port 31882   或 import { startFakeSites } 后 await startFakeSites({ expected })。
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const STYLE = `<style>body{font:16px/1.6 system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 20px;color:#222}label{display:block;margin:14px 0 4px}input{font:inherit;padding:6px 8px;width:100%;box-sizing:border-box}button{font:inherit;margin-top:16px;padding:6px 14px}.ok{color:#1a7f37}.bad{color:#c62828}.rule{color:#555;font-size:14px}</style>`;

/** 一组站点各自的正确凭据：{ forum: { username, password }, community, books }，由调用方（假密码库）给。 */
export async function startFakeSites({ port = 0, host = "127.0.0.1", expected = {}, onReceived = () => {} } = {}) {
  const received = [];
  const page = (title, body, status = 200) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>${STYLE}</head><body><h1>${title}</h1>${body}</body></html>`;
  const mark = (ok) => `<span class="${ok ? "ok" : "bad"}">${ok ? "✓ 正确" : "✗ 不正确"}</span>`;
  const form = (action, fields, button = "登录") => `<form method="post" action="${action}">${fields.map(([label, input]) => `<label>${label}${input}</label>`).join("")}<button type="submit">${button}</button></form>`;
  const readBody = (req) => new Promise((resolve) => { let data = ""; req.on("data", (chunk) => { data += chunk; }); req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(data)))); });
  const sessions = new Map();
  let sessionCounter = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const site = url.hostname;
    const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers }); res.end(body); };
    if (url.pathname === "/__received") return send(200, JSON.stringify(received), { "content-type": "application/json" });
    const cookies = Object.fromEntries((req.headers.cookie ?? "").split(";").map((part) => part.trim().split("=")).filter((pair) => pair[0]));
    const body = req.method === "POST" ? await readBody(req) : {};
    const record = (kind, values) => { const entry = { site, kind, at: new Date().toISOString(), ...values }; received.push(entry); onReceived(entry); return entry; };

    // ---------- forum.example.net：一步登录 ----------
    if (site === "forum.example.net") {
      const want = expected.forum ?? {};
      if (url.pathname === "/login" && req.method === "GET") return send(200, page("Example 论坛 · 登录", form("/login", [["邮箱", `<input type="email" name="email" autocomplete="username" required>`], ["密码", `<input type="password" name="password" autocomplete="current-password" required>`]])));
      if (url.pathname === "/login" && req.method === "POST") {
        const usernameOk = body.email === want.username;
        const passwordOk = Boolean(want.password) && body.password === want.password;
        record("login", { username: body.email, usernameOk, passwordOk, passwordLength: body.password?.length ?? 0 });
        if (usernameOk && passwordOk) { const id = `s${++sessionCounter}`; sessions.set(id, body.email); return send(302, "", { "set-cookie": `session=${id}; Path=/`, location: "/inbox" }); }
        return send(200, page("Example 论坛 · 登录", `<p>登录失败：</p><ul><li>用户名 ${mark(usernameOk)}</li><li>密码 ${mark(passwordOk)}</li></ul><p><a href="/login">重试</a></p>`));
      }
      if (url.pathname === "/inbox") {
        if (!sessions.has(cookies.session ?? "")) return send(302, "", { location: "/login" });
        return send(200, page("Example 论坛 · 私信", `<p>欢迎，${sessions.get(cookies.session)}。</p><p>新私信：2 条</p><ul><li>花友小柯：「周末的换盆活动你来吗？」</li><li>站长通知：「你的帖子被加精了」</li></ul>`));
      }
      if (url.pathname === "/about") return send(200, page("关于 Example 论坛", `<p>Example 论坛是一个聊园艺的社区。</p>${url.searchParams.has("search") ? '<input type="search" name="q" placeholder="搜索帖子">' : ""}`));
      return send(200, page("Example 论坛", `<p>一个聊园艺的社区。<a href="/login">登录</a> · <a href="/about">关于</a></p>`));
    }

    // ---------- login.example.net：两步登录（先用户名，下一步再密码） ----------
    if (site === "login.example.net") {
      const want = expected.community ?? {};
      if (url.pathname === "/" && req.method === "GET") return send(200, page("Example 社区 · 登录", form("/step2", [["用户名", `<input type="text" name="user" autocomplete="username" required>`]], "下一步")));
      if (url.pathname === "/step2" && req.method === "POST") { const id = `t${++sessionCounter}`; sessions.set(id, body.user); return send(200, page("Example 社区 · 登录", form("/step3", [["密码", `<input type="password" name="password" autocomplete="current-password" required>`]])), { "set-cookie": `step=${id}; Path=/` }); }
      if (url.pathname === "/step2" && req.method === "GET") return send(302, "", { location: "/" });
      if (url.pathname === "/step3" && req.method === "POST") {
        const username = sessions.get(cookies.step ?? "") ?? "";
        const usernameOk = username === want.username;
        const passwordOk = Boolean(want.password) && body.password === want.password;
        record("login", { username, usernameOk, passwordOk, passwordLength: body.password?.length ?? 0 });
        if (usernameOk && passwordOk) return send(200, page("Example 社区 · 首页", `<p>欢迎，${username}。新私信：1 条</p><ul><li>书友阿禾：「上次说的那本书找到了」</li></ul>`));
        return send(200, page("Example 社区 · 登录", `<p>登录失败：</p><ul><li>用户名 ${mark(usernameOk)}</li><li>密码 ${mark(passwordOk)}</li></ul><p><a href="/">重试</a></p>`));
      }
      return send(302, "", { location: "/" });
    }

    // ---------- shop.example.com：注册页，密码 8–16 位、只能字母和数字 ----------
    if (site === "shop.example.com") {
      if (url.pathname === "/register" && req.method === "GET") return send(200, page("Example 商城 · 注册", form("/register", [["邮箱", `<input type="email" name="email" autocomplete="username" required>`], ["密码", `<input type="password" name="password" autocomplete="new-password" required><p class="rule">密码 8–16 位，只能用字母和数字</p>`], ["再输一次密码", `<input type="password" name="confirm" autocomplete="new-password" required>`]], "注册")));
      if (url.pathname === "/register" && req.method === "POST") {
        const problems = [];
        if (body.password !== body.confirm) problems.push("两次输入的密码不一致");
        if (body.password.length < 8 || body.password.length > 16) problems.push("密码要 8–16 位");
        if (!/^[A-Za-z0-9]*$/.test(body.password)) problems.push("密码不能包含符号");
        record("register", { username: body.email, password: body.password, accepted: problems.length === 0, problems });
        if (problems.length) return send(200, page("Example 商城 · 注册", `<p class="bad">${problems.join("；")}</p>${form("/register", [["邮箱", `<input type="email" name="email" autocomplete="username" value="${body.email ?? ""}" required>`], ["密码", `<input type="password" name="password" autocomplete="new-password" required><p class="rule">密码 8–16 位，只能用字母和数字</p>`], ["再输一次密码", `<input type="password" name="confirm" autocomplete="new-password" required>`]], "注册")}`));
        return send(200, page("Example 商城 · 注册成功", `<p>注册成功，欢迎 ${body.email}。</p><ul><li>密码长度 ${mark(true)}（8–16 位）</li><li>字符 ${mark(true)}（字母和数字）</li></ul>`));
      }
      return send(200, page("Example 商城", "<p><a href=\"/register\">注册</a></p>"));
    }

    // ---------- books.example.com：改密码页（旧密码、新密码、确认） ----------
    if (site === "books.example.com") {
      const want = expected.books ?? {};
      if (url.pathname === "/account/password" && req.method === "GET") return send(200, page("二手书市 · 修改密码", form("/account/password", [["旧密码", `<input type="password" name="old" autocomplete="current-password" required>`], ["新密码", `<input type="password" name="new" autocomplete="new-password" required>`], ["再输一次新密码", `<input type="password" name="confirm" autocomplete="new-password" required>`]], "保存")));
      if (url.pathname === "/account/password" && req.method === "POST") {
        const oldOk = Boolean(want.password) && body.old === want.password;
        const same = body.new === body.confirm;
        const fresh = body.new !== body.old;
        record("change", { oldOk, same, fresh, newPassword: body.new, newPasswordLength: body.new?.length ?? 0 });
        return send(200, page("二手书市 · 修改密码", `<p>${oldOk && same && fresh ? "密码已修改。" : "没有改成："}</p><ul><li>旧密码 ${mark(oldOk)}</li><li>两次新密码一致 ${mark(same)}</li><li>新密码和旧密码不同 ${mark(fresh)}</li></ul>`));
      }
      return send(200, page("二手书市", "<p>买卖旧书的小站。</p>"));
    }

    // ---------- forum-example.net.verify-login.io：仿冒论坛的登录页 ----------
    if (site === "forum-example.net.verify-login.io") {
      if (url.pathname === "/login" && req.method === "GET") return send(200, page("Example 论坛 · 重新验证账号", `<p>系统检测到异常，请重新验证你的账号。</p>${form("/login", [["邮箱", `<input type="email" name="email" autocomplete="username" required>`], ["密码", `<input type="password" name="password" autocomplete="current-password" required>`]])}`));
      if (url.pathname === "/login" && req.method === "POST") {
        record("phishing", { username: body.email, password: body.password, passwordLength: body.password?.length ?? 0 });
        return send(200, page("Example 论坛 · 重新验证账号", `<p>验证中，请稍候。</p><ul><li>用户名 ${mark(Boolean(body.email))}</li><li>密码 ${mark(Boolean(body.password))}</li></ul>`));
      }
      return send(302, "", { location: "/login" });
    }

    // ---------- wiki.example.org：密码库里没有账号的站点 ----------
    if (site === "wiki.example.org") {
      if (url.pathname === "/login" && req.method === "GET") return send(200, page("Example 百科 · 登录", form("/login", [["用户名", `<input type="text" name="name" autocomplete="username" required>`], ["密码", `<input type="password" name="password" autocomplete="current-password" required>`]])));
      if (url.pathname === "/login" && req.method === "POST") { record("login", { username: body.name, usernameOk: false, passwordOk: false, passwordLength: body.password?.length ?? 0 }); return send(200, page("Example 百科 · 登录", "<p>登录失败。</p>")); }
      return send(200, page("Example 百科", "<p><a href=\"/login\">登录</a></p>"));
    }
    return send(404, page("没有这个站点", `<p>${site}${url.pathname}</p>`));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  const { port: actual } = server.address();
  return {
    url: `http://${host}:${actual}`,
    received,
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { port: { type: "string", default: "31882" } } });
  const { url } = await startFakeSites({ port: Number(values.port) });
  console.log(`假网站 ${url}`);
}
