import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { realApi } from "../src/api.ts";
import { setLocale } from "../../shared/i18n.ts";
import type { Rule } from "../../shared/types.ts";

const initial: Rule[] = [
  { id: "a", text: "发布前先问我确认", changedAt: new Date().toISOString() },
  { id: "b", text: "沟通默认使用中文", changedAt: "2020-01-01T00:00:00.000Z" },
];

beforeAll(() => {
  vi.stubGlobal("location", { search: "", hash: "" });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
  // 界面文字默认是中文：这里不跟着跑测试那台机器的浏览器语言走
  vi.stubGlobal("navigator", { languages: ["zh-CN"], language: "zh-CN" });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener() {} }), innerWidth: 1440 });
});
afterEach(() => vi.restoreAllMocks());

describe("全局规则设置", () => {
  it("渲染单列表并保存编辑、新增、删除，失败显示原因，事件重拉", async () => {
    let rules = initial.map((rule) => ({ ...rule }));
    const load = vi.spyOn(realApi, "rules").mockImplementation(async () => ({ rules: structuredClone(rules) }));
    const save = vi.spyOn(realApi, "saveRules").mockImplementation(async (next) => {
      rules = next.map((rule, i) => ({ ...rule, id: rule.id ?? `new-${i}`, changedAt: new Date().toISOString() }));
      return { rules: structuredClone(rules) };
    });
    const store = await import("../src/store.ts");
    const { SettingsPage } = await import("../src/components/Settings.tsx");
    // 断言的文案是中文，先把界面语言定下来，不跟 Node 的 navigator 语言走
    setLocale("zh-CN");
    store.openSettings();
    store.setSection("rules");
    await store.loadRules();
    let html = renderToStaticMarkup(createElement(SettingsPage, { narrow: false, leaving: false }));
    expect(html).not.toContain("一律照做");
    expect(html).not.toContain("rule-mode");
    expect(html).toContain("发布前先问我确认");
    expect(html).toContain("沟通默认使用中文");
    expect(html).toContain("最近修改");
    await store.saveRules(rules.map((rule) => rule.id === "a" ? { ...rule, text: "发布需要确认" } : rule));
    await store.saveRules([...store.getState().globalRules.rules!, { text: "新增规则" }]);
    await store.saveRules(store.getState().globalRules.rules!.filter((rule) => rule.id !== "b"));
    expect(save).toHaveBeenCalledTimes(3);
    expect(store.getState().globalRules.rules?.map((rule) => rule.text)).toEqual(["发布需要确认", "新增规则"]);
    save.mockRejectedValueOnce(new Error("磁盘不可写"));
    expect(await store.saveRules([])).toBe(false);
    html = renderToStaticMarkup(createElement(SettingsPage, { narrow: false, leaving: false }));
    expect(html).toContain("保存失败：磁盘不可写");
    expect(html).toContain("新增规则");
    rules = [{ ...initial[0], text: "外部修改" }];
    store.applyEvent({ type: "rules" });
    await vi.waitFor(() => expect(store.getState().globalRules.rules?.[0].text).toBe("外部修改"));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("API 使用整表接口，实时连接收到 rules 事件就重拉", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ rules: initial })) );
    vi.stubGlobal("fetch", fetch);
    await realApi.rules();
    await realApi.saveRules(initial);
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/rules", expect.anything());
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/rules", expect.objectContaining({ method: "PUT", body: JSON.stringify({ rules: initial }) }));
    // 实时事件从 WebSocket 进来，经 realApi.events 交给 store.applyEvent，和页面里接的是同一条路
    const sockets: Array<{ onopen?: () => void; onmessage?: (event: { data: string }) => void; close(): void }> = [];
    vi.stubGlobal("location", { protocol: "http:", host: "hob.test", search: "", hash: "" });
    vi.stubGlobal("WebSocket", class { static OPEN = 1; static CONNECTING = 0; readyState = 0; constructor() { sockets.push(this); } close() {} });
    const store = await import("../src/store.ts");
    // 只有正开着规则设置页时，rules 事件才会重拉
    store.openSettings();
    store.setSection("rules");
    const load = vi.spyOn(realApi, "rules").mockImplementation(async () => ({ rules: [{ ...initial[1], text: "推送后的规则" }] }));
    const stop = realApi.events({ onEvent: store.applyEvent, onReconnect() {}, onDown() {} });
    expect(sockets).toHaveLength(1);
    sockets[0].onopen?.();
    sockets[0].onmessage?.({ data: JSON.stringify({ type: "rules" }) });
    await vi.waitFor(() => expect(store.getState().globalRules.rules?.[0].text).toBe("推送后的规则"));
    expect(load).toHaveBeenCalledTimes(1);
    stop();
  });
});
