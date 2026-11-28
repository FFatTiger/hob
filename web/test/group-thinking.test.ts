import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../../shared/i18n.ts";
import "../src/i18n/en/index.ts";
import { groupThinkingText } from "../src/group-thinking.ts";

afterEach(() => setLocale("zh-CN"));

describe("groupThinkingText", () => {
  it("shows the member's live tool activity label when present", () => {
    expect(groupThinkingText("开发", { label: "正在读取文件" })).toBe("开发 · 正在读取文件");
  });

  it("falls back to thinking text when activity label is missing or empty", () => {
    expect(groupThinkingText("开发")).toBe("开发 正在思考…");
    expect(groupThinkingText("开发", { label: "" })).toBe("开发 正在思考…");
    setLocale("en");
    expect(groupThinkingText("Dev", null)).toBe("Dev is thinking…");
    expect(groupThinkingText("Dev", { label: "Reading files" })).toBe("Dev · Reading files");
  });
});
