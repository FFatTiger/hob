import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/store.ts", () => ({ markUpdateReady: () => undefined }));
const { newerBuild } = await import("../src/pwa.ts");

function loadSw() {
  const listeners = new Map<string, (event: any) => void>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const existingNotifications: { data?: { url?: string }; close: ReturnType<typeof vi.fn> }[] = [];
  const opened: string[] = [];
  const selfObj = {
    location: { origin: "https://hob.example" },
    addEventListener: (type: string, fn: (event: any) => void) => { listeners.set(type, fn); },
    registration: {
      active: null,
      showNotification: vi.fn(async (title: string, options: Record<string, unknown>) => { shown.push({ title, options }); }),
      getNotifications: vi.fn(async () => existingNotifications),
    },
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => []),
      openWindow: vi.fn(async (url: string) => { opened.push(url); }),
    },
    skipWaiting: vi.fn(async () => undefined),
  };
  const code = readFileSync(resolve(import.meta.dirname, "../public/sw.js"), "utf8");
  vm.runInNewContext(code, { self: selfObj, URL, Response, caches: { open: vi.fn(), keys: vi.fn(async () => []), delete: vi.fn() }, fetch: vi.fn() });
  return { listeners, shown, existingNotifications, opened, selfObj };
}

describe("newerBuild", () => {
  const page = (src: string) => `<head><script type="module" crossorigin src="${src}"></script></head>`;
  it("服务器上的入口脚本换了才算有新构建", () => {
    expect(newerBuild(page("/assets/index-B.js"), "/assets/index-A.js")).toBe(true);
    expect(newerBuild(page("/assets/index-A.js"), "/assets/index-A.js")).toBe(false);
  });
  it("取不到首页或者自己不是构建出来的页面，不提示", () => {
    expect(newerBuild("", "/assets/index-A.js")).toBe(false);
    expect(newerBuild(page("/assets/index-B.js"), "")).toBe(false);
  });
});

describe("sw.js 通知行为", () => {
  it("默认不加会话级 tag，显式传 tag 时才附带 renotify: true", async () => {
    const { listeners, shown } = loadSw();
    const waitPromises: Promise<unknown>[] = [];
    const push = listeners.get("push")!;

    push({
      data: { json: () => ({ title: "话题 A", body: "第一条", url: "/#/group/g1" }) },
      waitUntil: (p: Promise<unknown>) => waitPromises.push(p),
    });
    push({
      data: { json: () => ({ title: "话题 A", body: "第二条", url: "/#/group/g1", tag: "custom-tag" }) },
      waitUntil: (p: Promise<unknown>) => waitPromises.push(p),
    });
    await Promise.all(waitPromises);

    expect(shown).toHaveLength(2);
    expect(shown[0]?.options).not.toHaveProperty("tag");
    expect(shown[0]?.options).toMatchObject({ body: "第一条", data: { url: "/#/group/g1" } });
    expect(shown[1]?.options).toMatchObject({ body: "第二条", tag: "custom-tag", renotify: true });
  });

  it("点开通知时清理同 url 旧通知，不影响其他会话通知", async () => {
    const { listeners, existingNotifications, opened } = loadSw();
    const same1 = { data: { url: "/#/group/g1" }, close: vi.fn() };
    const same2 = { data: { url: "/#/group/g1" }, close: vi.fn() };
    const other = { data: { url: "/#/group/g2" }, close: vi.fn() };
    existingNotifications.push(same1, same2, other);

    const clickedClose = vi.fn();
    const waitPromises: Promise<unknown>[] = [];
    listeners.get("notificationclick")!({
      notification: { close: clickedClose, data: { url: "/#/group/g1" } },
      waitUntil: (p: Promise<unknown>) => waitPromises.push(p),
    });
    await Promise.all(waitPromises);

    expect(clickedClose).toHaveBeenCalledTimes(1);
    expect(same1.close).toHaveBeenCalledTimes(1);
    expect(same2.close).toHaveBeenCalledTimes(1);
    expect(other.close).not.toHaveBeenCalled();
    expect(opened).toEqual(["https://hob.example/#/group/g1"]);
  });
});
