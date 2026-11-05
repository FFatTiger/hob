import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRouterTools } from "../src/router-tools.ts";
import { lookupFile } from "../src/files.ts";
import { activityLabel } from "../src/router-activity.ts";
import { makeHob } from "./helpers.ts";

describe("Router read", () => {
  it("只读允许的文件，拒绝凭据和越界链接", async () => {
    const hob = makeHob();
    const work = mkdtempSync(join(tmpdir(), "hob-read-work-"));
    const outside = mkdtempSync(join(tmpdir(), "hob-read-outside-"));
    try {
      hob.runtime.store.saveJob({ id: "read-test", assistantId: "hob", title: "测试", instruction: "", status: "done", createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [], cwd: work });
      mkdirSync(join(hob.home, "jobs", "read-test", "work"), { recursive: true });
      mkdirSync(join(hob.home, "lore"), { recursive: true });
      mkdirSync(join(hob.home, "engine"), { recursive: true });
      mkdirSync(join(work, ".ssh"));
      for (const [path, value] of [[join(hob.home, "hello.txt"), "你好"], [join(hob.home, "jobs", "read-test", "report.md"), "报告"], [join(hob.home, "jobs", "read-test", "work", "a.txt"), "工作"], [join(work, "a.txt"), "外部工作"], [join(work, ".env"), "secret"], [join(work, ".ssh", "id_rsa"), "secret"], [join(hob.home, "engine", "private.txt"), "secret"], [join(hob.home, "lore", "private.txt"), "secret"], [join(outside, "a.txt"), "outside"]]) writeFileSync(path, value);
      symlinkSync(join(outside, "a.txt"), join(hob.home, "link.txt"));
      const read = buildRouterTools(hob.runtime, "hob").find((tool) => tool.name === "read")!;
      for (const [path, value] of [["hello.txt", "你好"], [join(hob.home, "jobs", "read-test", "report.md"), "报告"], [join(hob.home, "jobs", "read-test", "work", "a.txt"), "工作"], [join(work, "a.txt"), "外部工作"]]) {
        expect((await read.execute("x", { path })).content[0].text).toBe(value);
      }
      for (const path of [join(hob.home, "secrets.json"), join(hob.home, "settings.json"), join(hob.home, "engine", "private.txt"), join(hob.home, "lore", "private.txt"), join(work, ".env"), join(work, ".ssh", "id_rsa"), join(hob.home, "link.txt")]) {
        if (path.endsWith("secrets.json")) writeFileSync(path, "secret");
        const expected = lookupFile(hob.home, path, [work]);
        expect(expected.ok).toBe(false);
        const result = await read.execute("x", { path });
        expect(result.isError).toBe(true);
        if (!expected.ok) expect(result.content[0].text).toBe(expected.error);
      }
      const lines = Array.from({ length: 200 }, (_, i) => `第${i + 1}行`.padEnd(50, "字"));
      writeFileSync(join(hob.home, "long.txt"), lines.join("\n"));
      const first = await read.execute("x", { path: "long.txt" });
      expect(first.content[0].text.length).toBeLessThanOrEqual(4000);
      const offset = Number(first.content[0].text.match(/offset=(\d+)/)?.[1]);
      expect(offset).toBeGreaterThan(1);
      expect((await read.execute("x", { path: "long.txt", offset })).content[0].text).toContain(lines[offset - 1]);
      expect(activityLabel("read", { path: "/tmp/report.md" })).toBe("正在读：report.md");
    } finally { hob.close(); rmSync(work, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });

  it("超长首行返回前 3900 字并可继续读后续行", async () => {
    const hob = makeHob();
    try {
      const long = "字".repeat(10000);
      const path = join(hob.home, "long-line.txt");
      const read = buildRouterTools(hob.runtime, "hob").find((tool) => tool.name === "read")!;
      writeFileSync(path, `${long}\n第二行\n第三行`);
      const first = await read.execute("x", { path });
      expect(first.isError).not.toBe(true);
      expect(first.content[0].text).toBe(`${long.slice(0, 3900)}\n（第 1 行共 10000 字，这里只有前 3,900 字；接着读用 offset=2）`);
      expect(first.content[0].text.length).toBeLessThanOrEqual(4000);
      const offset = Number(first.content[0].text.match(/offset=(\d+)/)?.[1]);
      expect((await read.execute("x", { path, offset })).content[0].text).toBe("第二行\n第三行");

      writeFileSync(path, `短行\n${long}`);
      expect((await read.execute("x", { path })).content[0].text).toBe("短行\n（共 2 行，这里到第 1 行；接着读用 offset=2）");
      expect((await read.execute("x", { path, offset: 2 })).content[0].text).toBe(`${long.slice(0, 3900)}\n（第 2 行共 10000 字，这里只有前 3,900 字）`);
    } finally { hob.close(); }
  });

  it("图片只交给支持图片的模型", async () => {
    const hob = makeHob();
    try {
      const path = join(hob.home, "a.png");
      writeFileSync(path, readFileSync(join(process.cwd(), "docs/design/v2/s1.png")));
      const read = buildRouterTools(hob.runtime, "hob").find((tool) => tool.name === "read")!;
      const noVision = await read.execute("x", { path }, undefined, undefined, { model: { input: ["text"] } } as any);
      expect(noVision).toMatchObject({ isError: true, content: [{ text: "当前对话模型看不了图片" }] });
      const vision = await read.execute("x", { path }, undefined, undefined, { model: { input: ["text", "image"] } } as any);
      expect(vision.content.some((block: { type: string }) => block.type === "image")).toBe(true);
    } finally { hob.close(); }
  });
});
