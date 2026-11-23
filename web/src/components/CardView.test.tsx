import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CardRecord } from "../../../shared/types.ts";

vi.mock("../store.ts", () => ({ answerCard: vi.fn(async () => true) }));

import { CardView } from "./CardView.tsx";

const record: CardRecord = {
  id: "c-render",
  owner: { type: "plugin", pluginId: "vault", assistantId: "hob" },
  plugin: { service: "main", pluginName: "密码箱", callbackTool: "save" },
  card: {
    header: { title: "保存登录信息", subtitle: "密码不会进入聊天" },
    body: { elements: [{ tag: "form", name: "login", elements: [
      { tag: "input", name: "user", label: "用户名", default_value: "lin" },
      { tag: "input", name: "secret", label: "密码", input_type: "password" },
      { tag: "button", text: "保存", form_action_type: "submit" },
    ] }] },
  },
  status: "open",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("CardView", () => {
  it("renders plugin source, lock notice, nested form fields, and button", () => {
    const html = renderToStaticMarkup(<CardView record={record} fresh itemId="item-card" />);
    expect(html).toContain("密码箱");
    // 来源行用插件自己的图标（/api/plugins/:id/icon），不按插件 id 写死
    expect(html).toContain('src="/api/plugins/vault/icon"');
    expect(html).toContain("填写的内容只交给 密码箱");
    expect(html).toContain("保存登录信息");
    expect(html).toContain("用户名");
    expect(html).toContain('type="password"');
    expect(html).toContain("保存");
    expect(html).toContain('data-item-id="item-card"');
  });

  it("follows select display, column weights, result rows, the generate button and clickable rows", () => {
    const html = renderToStaticMarkup(<CardView record={{ ...record, plugin: undefined, owner: { type: "assistant", assistantId: "hob" }, card: { body: { elements: [
      { tag: "form", name: "f", elements: [
        { tag: "select_static", name: "a", label: "下拉", display: "dropdown", options: [{ text: "甲", value: "a" }, { text: "乙", value: "b" }] },
        { tag: "select_static", name: "b", label: "小块", options: [{ text: "丙", value: "c" }, { text: "丁", value: "d" }] },
        { tag: "input", name: "secret", label: "密码", input_type: "password", generate: true },
      ] },
      { tag: "column_set", background_style: "light", columns: [{ weight: 1, elements: [{ tag: "div", text: "名称" }] }, { weight: 5, elements: [{ tag: "div", text: "值" }] }] },
      { tag: "interactive_container", elements: [{ tag: "div", text: "第一行\n第二行" }, { tag: "div", text: "右侧" }] },
      { tag: "interactive_container", behaviors: [{ type: "open_url", default_url: "https://example.com" }], elements: [{ tag: "div", text: "能点" }] },
      { tag: "div", icon: "check", text: "已保存到「论坛账号」" },
    ] } } } } fresh={false} itemId="item-card" />);
    expect(html).toContain("hc-select-button"); // display: dropdown 画成下拉
    expect(html).toContain("hc-options"); // 不写 display、选项少：画成小块
    expect(html).toMatch(/class="hc-column" style="flex:1"/);
    expect(html).toMatch(/class="hc-column" style="flex:5"/);
    // 「生成」在输入框外面并排，带骰子图标
    expect(html).toMatch(/<\/span><button type="button" class="hc-generate"/);
    expect(html).toContain("hc-input-row");
    // 没有 behaviors 的行不给手型光标
    expect(html.match(/class="hc-interactive"/g)?.length).toBe(1);
    expect(html.match(/class="hc-interactive hc-clickable"/g)?.length).toBe(1);
    expect(html).toMatch(/class="hc-result"><svg[^>]*>[^<]*<path d="M5 12.5 10 17l9-10"/);
    expect(html).toContain("已保存到「论坛账号」");
    expect(html).not.toContain("hc-source");
  });

  it("keeps plugin controls enabled after an unavailable callback", () => {
    const unavailable: CardRecord = { ...record, feedback: { unavailable: "密码箱 现在用不了" } };
    const html = renderToStaticMarkup(<CardView record={unavailable} fresh={false} itemId="item-card" />);
    expect(html).toContain("密码箱 现在用不了");
    expect(html).not.toContain('disabled=""');
  });
  it("disables plugin controls while the callback is in progress", () => {
    const processing: CardRecord = { ...record, processing: true };
    const html = renderToStaticMarkup(<CardView record={processing} fresh={false} itemId="item-card" />);
    expect(html).toContain('disabled=""');
  });
  it("renders a locked result with toast and field error state", () => {
    const done: CardRecord = {
      ...record,
      status: "done",
      feedback: { toast: { type: "success", content: "已保存" } },
      result: { action: { tag: "button" }, buttonText: "保存", fields: { user: "lin" } },
    };
    const html = renderToStaticMarkup(<CardView record={done} fresh={false} itemId="item-card" />);
    expect(html).toContain("已保存");
    expect(html).toContain("lin");
    expect(html).toContain("hc-result-list");
  });
});
