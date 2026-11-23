import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CardActionRequest } from "../../shared/types.ts";
import { answerCard } from "../src/actions.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { makeHob, text } from "./helpers.ts";

const display = { header: { title: "供应商报价" }, body: { elements: [{ tag: "table", columns: [{ name: "vendor", display_name: "供应商" }], rows: [{ vendor: "甲方" }] }] } };
const interactive = { header: { title: "出行偏好" }, body: { elements: [{ tag: "form", name: "trip", elements: [{ tag: "input", name: "days", label: "天数", required: true }, { tag: "button", text: "按这个排", form_action_type: "submit" }] }] } };

function tool(hob: ReturnType<typeof makeHob>, groupId?: string) {
  return buildRouterTools(hob.runtime, "hob", groupId).find((entry) => entry.name === "send_card")!;
}

describe("send_card", () => {
  it("shows display cards without ending the turn and interactive cards with terminate", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const shown = await tool(hob).execute("call", { card: display }) as { content: { text: string }[]; terminate?: boolean };
      expect(shown).toMatchObject({ content: [{ text: "卡片已显示给用户。" }] });
      expect(shown.terminate).toBeUndefined();
      const sent = await tool(hob).execute("call-2", { card: interactive }) as { content: { text: string }[]; terminate?: boolean };
      expect(sent).toMatchObject({ content: [{ text: "卡片已显示给用户，用户操作完结果会回到对话。" }], terminate: true });
      expect(hob.runtime.store.cards()).toHaveLength(2);
      expect(hob.runtime.router.items("hob").items.filter((item) => item.kind === "card")).toHaveLength(2);
    } finally { hob.close(); }
  });

  it("returns the validator reason and blocks assistant password fields", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const unknown = await tool(hob).execute("call", { card: { body: { elements: [{ tag: "slider" }] } } }) as { content: { text: string }[]; isError?: boolean };
      expect(unknown).toMatchObject({ isError: true, content: [{ text: "卡片格式不对：卡片 body里的第 1 个组件的 tag「slider」不支持" }] });
      const password = await tool(hob).execute("call", { card: { body: { elements: [{ tag: "input", input_type: "password" }] } } }) as { content: { text: string }[]; isError?: boolean };
      expect(password).toMatchObject({ isError: true, content: [{ text: "你发的卡片不能有 input_type 为 password 的输入框：密码这类值要交给插件的卡片，不经过你" }] });
      expect(hob.runtime.store.cards()).toEqual([]);
    } finally { hob.close(); }
  });

  it("does not prepend old card history to later user messages", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      await tool(hob).execute("call", { card: interactive });
      hob.faux.setResponses([text("收到。")]);
      await hob.runtime.router.send("hob", { text: "继续处理" });
      await hob.runtime.router.waitIdle("hob");
      const entries = readFileSync(hob.runtime.store.routerFile("hob"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const prompts = entries.filter((entry) => entry.type === "message" && entry.message?.role === "user").map((entry) => JSON.stringify(entry.message.content));
      expect(prompts.at(-1)).toContain("继续处理");
      expect(prompts.at(-1)).not.toContain("卡片「出行偏好」");
    } finally { hob.close(); }
  });

  it("locks an assistant card and sends the exact event message back", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      await tool(hob).execute("call", { card: interactive });
      const record = hob.runtime.store.cards()[0]!;
      hob.faux.setResponses([text("收到偏好，我开始排了。")]);
      const request: CardActionRequest = { action: { tag: "button" }, button_text: "按这个排", form_value: { days: "3" } };
      const response = await answerCard(hob.runtime, record.id, request);
      expect(response.status).toBe(200);
      expect(hob.runtime.store.card(record.id)).toMatchObject({ status: "done", result: { buttonText: "按这个排", fields: { days: "3" } } });
      await hob.runtime.router.waitIdle("hob");
      const transcript = readFileSync(hob.runtime.store.routerFile("hob"), "utf8");
      expect(transcript).toContain("[hob-event] 用户在卡片「出行偏好」上点了「按这个排」，填写的内容：");
      expect(transcript).toContain("- 天数：3");
    } finally { hob.close(); }
  });
});
