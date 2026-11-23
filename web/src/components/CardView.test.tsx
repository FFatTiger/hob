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
    expect(html).toContain("填写的内容只交给插件");
    expect(html).toContain("保存登录信息");
    expect(html).toContain("用户名");
    expect(html).toContain('type="password"');
    expect(html).toContain("保存");
    expect(html).toContain('data-item-id="item-card"');
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
