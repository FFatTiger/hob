import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown.ts";

describe("renderMarkdown", () => {
  it("行内代码和代码块里的引号、尖括号原样显示，不双重转义", () => {
    expect(renderMarkdown('看 `sprite: "wifi"` 这段')).toContain('<code>sprite: &quot;wifi&quot;</code>');
    expect(renderMarkdown('看 `sprite: "wifi"` 这段')).not.toContain("&amp;quot;");
    expect(renderMarkdown("比较 `a < b && c > d`")).toContain("<code>a &lt; b &amp;&amp; c &gt; d</code>");
    const block = renderMarkdown('```\n<a href="x">y</a>\n```');
    expect(block).toContain("&lt;a href=&quot;x&quot;&gt;y&lt;/a&gt;");
    expect(block).not.toContain("&amp;");
    // 正文里的引号被 marked 转义成实体（浏览器里照原样显示），但不能被转义两次
    const plain = renderMarkdown("正文里写 \"引号\" 和 '单引号'");
    expect(plain).toContain("&quot;引号&quot;");
    expect(plain).not.toContain("&amp;");
  });

  it("原始 HTML 不生效，一律当文本输出", () => {
    const script = renderMarkdown("hello <script>alert(1)</script>");
    expect(script).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(script).not.toContain("<script>");
    expect(renderMarkdown("<b>粗体</b>")).toContain("&lt;b&gt;粗体&lt;/b&gt;");
    expect(renderMarkdown("<b>粗体</b>")).not.toContain("<b>");
    expect(renderMarkdown('<img src=x onerror="alert(1)">')).not.toContain("<img");
  });

  it("链接仍然生成，并且新窗口打开", () => {
    const html = renderMarkdown("[点这里](http://a.b/c)");
    expect(html).toContain('<a target="_blank" rel="noreferrer" href="http://a.b/c">点这里</a>');
  });

  it("javascript: 这类链接不生成可点的地址", () => {
    for (const bad of ["[x](javascript:alert(1))", "[x](  JaVaScRiPt:alert(1))", "[x](data:text/html,hi)"]) {
      const html = renderMarkdown(bad);
      expect(html).not.toMatch(/href=/i);
      expect(html).toContain("<a>x</a>");
    }
    expect(renderMarkdown("[信](mailto:a@b.c)")).toContain('href="mailto:a@b.c"');
  });
});
