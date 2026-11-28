import { describe, expect, it } from "vitest";
import { hasCode, loadHighlight, renderMarkdown } from "../src/markdown.ts";

describe("markdown lazy syntax highlighting", () => {
  it("detects valid fenced code blocks with languages including tilde fences and spaced info strings", () => {
    expect(hasCode("```ts\nconst x = 1;\n```")).toBe(true);
    expect(hasCode("```  js\nconst x = 1;\n```")).toBe(true);
    expect(hasCode("~~~python\nprint(1)\n~~~")).toBe(true);
    expect(hasCode("```\nplain text\n```")).toBe(false);
    expect(hasCode("inline `const x = 1` only")).toBe(false);
  });

  it("renders safely before load, highlights after loadHighlight, and escapes HTML", async () => {
    const snippet = "```ts\nconst tag = '<script>alert(1)</script>';\n```";
    const cold = renderMarkdown(snippet);
    expect(cold).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(cold).not.toContain("<script>");

    await loadHighlight();
    const warm = renderMarkdown(snippet);
    expect(warm).toContain('class="hljs-keyword"');
    expect(warm).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(warm).not.toContain("<script>");

    const unknown = renderMarkdown("```unknownlang\n<b>raw</b>\n```");
    expect(unknown).toContain("&lt;b&gt;raw&lt;/b&gt;");
    expect(unknown).not.toContain("<b>");
  });
});
