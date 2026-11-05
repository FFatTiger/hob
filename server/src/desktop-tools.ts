import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { chromium, type Browser, type Page } from "playwright-core";
import type { HobRuntime } from "./runtime.ts";

const LOGIN = "需要登录的页面不要自己登录，用 ask_user 请用户打开云桌面登录后回复。";
const TAKEN = "用户正在操作云桌面，请稍后再试或用 ask_user 询问";
const point = Type.Object({ x: Type.Integer(), y: Type.Integer() });
const action = Type.Object({
  type: Type.Union([Type.Literal("click"), Type.Literal("move"), Type.Literal("drag"), Type.Literal("type"), Type.Literal("key"), Type.Literal("scroll"), Type.Literal("wait")]),
  x: Type.Optional(Type.Integer()), y: Type.Optional(Type.Integer()),
  from: Type.Optional(point), to: Type.Optional(point),
  button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
  count: Type.Optional(Type.Integer()), text: Type.Optional(Type.String()), keys: Type.Optional(Type.String()),
  dy: Type.Optional(Type.Integer()), dx: Type.Optional(Type.Integer()), ms: Type.Optional(Type.Integer()),
});

type PageConnection = { browser?: Browser; page?: Page; opening?: Promise<Page> };

export class DesktopToolSession {
  private connections = new Map<string, PageConnection>();
  private publicWait?: Promise<void>;
  private active = new Set<Promise<unknown>>();
  private disposed = false;
  private profile: string;
  constructor(private runtime: HobRuntime, private assistantId: string, private canSeeImages: boolean) {
    this.profile = desktopProfile(assistantId);
  }

  private check(screen: string) {
    if (this.disposed) throw new Error("任务已结束。");
    if (this.runtime.desktopControl.state("", screen).taken) throw new Error(TAKEN);
  }
  private async screen(value: unknown): Promise<string> {
    if (value !== undefined && value !== "own" && value !== "public") throw new Error("屏幕参数无效。");
    const screen = value === "public" ? "public" : this.profile;
    this.check(screen);
    if (screen === "public") {
      if (!this.runtime.settings.settings.desktop?.publicAssistants?.includes(this.assistantId)) throw new Error("这个助手没有使用公共屏幕的权限。");
      if (!this.publicWait) {
        const name = this.runtime.store.assistant(this.assistantId)?.name ?? this.assistantId;
        this.publicWait = this.runtime.desktopPublic.acquire(this, name).catch((error) => { this.publicWait = undefined; throw error; });
      }
      await this.publicWait;
      this.check(screen);
      if (!this.runtime.settings.settings.desktop?.publicAssistants?.includes(this.assistantId)) throw new Error("这个助手没有使用公共屏幕的权限。");
    }
    return screen;
  }
  private async getPage(screen: string): Promise<Page> {
    this.check(screen);
    let connection = this.connections.get(screen);
    if (!connection) { connection = {}; this.connections.set(screen, connection); }
    if (connection.page && !connection.page.isClosed() && connection.browser?.isConnected()) return connection.page;
    if (!connection.opening) connection.opening = this.openPage(screen, connection).finally(() => { connection!.opening = undefined; });
    return connection.opening;
  }
  private async openPage(screen: string, connection: PageConnection): Promise<Page> {
    const result = await (await this.runtime.desktop.request(`/api/screens/${encodeURIComponent(screen)}/browser/start`, { method: "POST" })).json() as { cdp: string };
    this.check(screen);
    if (result.cdp !== `/cdp/${screen}`) throw new Error("云桌面返回了无效的浏览器地址。");
    const { url, token } = this.runtime.desktop.connection();
    const endpoint = new URL(result.cdp, url);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    const browser = await chromium.connectOverCDP(endpoint.toString(), { headers: { Authorization: `Bearer ${token}` }, timeout: 15_000 });
    try {
      this.check(screen);
      const context = browser.contexts()[0];
      if (!context) throw new Error("云桌面浏览器没有可用的窗口。");
      const page = await context.newPage();
      this.check(screen);
      page.setDefaultTimeout(15_000);
      connection.browser = browser;
      connection.page = page;
      return page;
    } catch (error) { await browser.close().catch(() => undefined); throw error; }
  }
  async dispose() {
    this.disposed = true;
    this.runtime.desktopPublic.cancelWait(this);
    await Promise.allSettled([...this.active]);
    await Promise.all([...this.connections.values()].map(async (connection) => {
      await connection.opening?.catch(() => undefined);
      await connection.browser?.close().catch(() => undefined);
    }));
    this.runtime.desktopPublic.release(this);
    this.connections.clear();
  }
  tools(): ToolDefinition<any, any>[] {
    const allowPublic = this.runtime.settings.settings.desktop?.publicAssistants?.includes(this.assistantId) ?? false;
    const make = (name: string, label: string, description: string, parameters: any, run: (params: any, screen: string) => Promise<string | Buffer>): ToolDefinition<any, any> => ({
      name, label, description: `${description} ${LOGIN}`,
      parameters: Type.Object({ ...parameters.properties, ...(allowPublic ? { screen: Type.Optional(Type.Union([Type.Literal("own"), Type.Literal("public")])) } : {}) }),
      execute: async (_id, params) => {
        const operation = (async () => {
          try {
            const values = (params ?? {}) as Record<string, unknown>;
            const screen = await this.screen(values.screen);
            const value = await run(values, screen);
            if (Buffer.isBuffer(value)) {
              if (!this.canSeeImages) return { content: [{ type: "text" as const, text: "当前模型不能看图，请使用页面快照或请用户查看云桌面。" }], details: undefined };
              return { content: [{ type: "image" as const, data: value.toString("base64"), mimeType: "image/png" }], details: undefined };
            }
            return { content: [{ type: "text" as const, text: value }], details: undefined };
          } catch (error) {
            return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
          }
        })();
        this.active.add(operation);
        try { return await operation; } finally { this.active.delete(operation); }
      },
    });
    return [
      make("browser_open", "打开网页", "在助手的浏览器中打开 HTTP(S) 网页。", Type.Object({ url: Type.String() }), async ({ url }, screen) => {
        const target = new URL(url);
        if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("只支持 HTTP(S) 网页。");
        const page = await this.getPage(screen); this.check(screen); await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 }); return `已打开 ${page.url()}`;
      }),
      make("browser_snapshot", "读取页面", "读取当前页面的无障碍快照；引用用于点击或输入。", Type.Object({}), async (_, screen) => { const page = await this.getPage(screen); this.check(screen); return page.ariaSnapshot({ mode: "ai" }); }),
      make("browser_click", "点击网页", "点击最新页面快照中的引用。", Type.Object({ ref: Type.String() }), async ({ ref }, screen) => { const page = await this.getPage(screen); this.check(screen); await page.getByRef(ref).click(); return "已点击。"; }),
      make("browser_type", "输入文字", "向最新页面快照中的引用输入文字。", Type.Object({ ref: Type.String(), text: Type.String(), submit: Type.Optional(Type.Boolean()) }), async ({ ref, text, submit }, screen) => { const page = await this.getPage(screen); this.check(screen); const target = page.getByRef(ref); await target.fill(text); if (submit) { this.check(screen); await target.press("Enter"); } return "已输入。"; }),
      make("browser_press", "按键", "向当前网页发送按键，如 Enter、Control+L。", Type.Object({ key: Type.String() }), async ({ key }, screen) => { const page = await this.getPage(screen); this.check(screen); await page.keyboard.press(key); return "已按键。"; }),
      make("browser_back", "返回网页", "返回浏览器上一页。", Type.Object({}), async (_, screen) => { const page = await this.getPage(screen); this.check(screen); await page.goBack({ waitUntil: "domcontentloaded" }); return `当前页面：${page.url()}`; }),
      make("browser_screenshot", "网页截图", "截取当前浏览器页面。", Type.Object({}), async (_, screen) => { const page = await this.getPage(screen); this.check(screen); return page.screenshot(); }),
      make("desktop_screenshot", "桌面截图", "截取整个云桌面。", Type.Object({}), async (_, screen) => {
        await this.runtime.desktop.request(`/api/screens/${screen}/start`, { method: "POST" });
        this.check(screen);
        return Buffer.from(await (await this.runtime.desktop.request(`/api/screens/${screen}/screenshot`)).arrayBuffer());
      }),
      make("desktop_action", "操作桌面", "按顺序执行桌面动作：click、move、drag、type、key、scroll、wait。", Type.Object({ actions: Type.Array(action, { minItems: 1, maxItems: 100 }) }), async ({ actions }, screen) => {
        await this.runtime.desktop.request(`/api/screens/${screen}/start`, { method: "POST" });
        const health = await (await this.runtime.desktop.request("/api/health")).json() as { screens: { id: string; browserRunning: boolean }[] };
        this.check(screen);
        if (health.screens.some((item) => item.id === screen && item.browserRunning)) {
          await this.runtime.desktop.request(`/api/screens/${screen}/browser/focus`, { method: "POST" });
        }
        this.check(screen);
        await this.runtime.desktop.request(`/api/screens/${screen}/input`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actions }), signal: AbortSignal.timeout(60_000) });
        return "桌面操作已完成。";
      }),
    ];
  }
}

/** 公共屏幕保留 public；无效或冲突的助手 id 用稳定哈希。 */
export function desktopProfile(assistantId: string): string {
  return assistantId !== "public" && /^[a-z0-9-]{1,64}$/.test(assistantId) ? assistantId : `p-${createHash("sha256").update(assistantId).digest("hex").slice(0, 62)}`;
}

/** 在云桌面里打开（或提到最前）这个助手的浏览器：用户接管后自己登录网站用。 */
export async function openDesktopBrowser(runtime: HobRuntime, assistantId: string): Promise<void> {
  const profile = encodeURIComponent(desktopProfile(assistantId));
  await runtime.desktop.request(`/api/screens/${profile}/browser/start`, { method: "POST" });
  await runtime.desktop.request(`/api/screens/${profile}/browser/focus`, { method: "POST" });
}

export async function availableDesktopTools(runtime: HobRuntime, profile: string, canSeeImages: boolean): Promise<DesktopToolSession | undefined> {
  try { await runtime.desktop.request("/api/health"); return new DesktopToolSession(runtime, profile, canSeeImages); }
  catch { return undefined; }
}
