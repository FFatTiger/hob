import { describe, expect, it } from "vitest";
import { extractMentions } from "../../shared/mention.ts";
import { renderMarkdown } from "../src/markdown.ts";
import { mentionAt } from "../src/mention.ts";

const candidates = [
  { id: "qa", name: "qa" },
  { id: "dev", name: "dev" },
  { id: "dev_cn", name: "开发" },
  { id: "dev_helper", name: "开发助手" },
];
const names = candidates.map((c) => c.name);

describe("mention boundary consistency across dispatch, highlight, and autocomplete", () => {
  it("ignores emails and Latin identifier continuations consistently", () => {
    const email = "请联系 alice@qa.example.com 或 @devops 看下";
    expect(extractMentions(email, candidates)).toEqual([]);
    expect(renderMarkdown(email, names)).not.toContain('<span class="at">');
    expect(mentionAt("alice@qa", 8, names)).toBeNull();
  });

  it("matches full-width ＠ and prefers longer overlapping names consistently", () => {
    const text = "请 ＠开发助手 和 @dev，看看进展";
    expect(extractMentions(text, candidates)).toEqual(["dev_helper", "dev"]);
    const html = renderMarkdown(text, names);
    expect(html).toContain('<span class="at">＠开发助手</span>');
    expect(html).toContain('<span class="at">@dev</span>');
    expect(mentionAt("请 ＠开发", 5, names)).toEqual({ start: 2, query: "开发" });
  });

  it("ignores mentions inside fenced code, 4-space indented code, inline code, and link URLs", () => {
    const sample = [
      "看看 `@qa` 和 [主页](https://example.com/@qa) 还有 https://example.com/@dev",
      "",
      "    @qa indented code",
      "",
      "```ts",
      "// @dev fenced code",
      "```",
      "",
      "~~~txt",
      "@开发 tilde code",
      "~~~",
    ].join("\n");
    expect(extractMentions(sample, candidates)).toEqual([]);
    expect(renderMarkdown(sample, names)).not.toContain('<span class="at">');
  });
});
