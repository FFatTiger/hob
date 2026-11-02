import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/http.ts";
import type { HobRuntime } from "../src/runtime.ts";
import { makeHob } from "./helpers.ts";

/** 登录拿 cookie：/api/* 都要它。 */
async function signIn(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test" }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function appWithCookie(runtime: HobRuntime, home: string) {
  const app = createApp(runtime, { home });
  return { app, cookie: await signIn(app) };
}

describe("GET /api/files 的安全规则", () => {
  it("符号链接指出 HOB_HOME 的 → 403，目录里的正常文件照常", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const work = join(hob.home, "jobs", "t-aaaa", "work");
      mkdirSync(work, { recursive: true });
      // 指向数据目录外的链接：解开 realpath 后不在 HOB_HOME 里
      symlinkSync(join(tmpdir(), "..", "etc", "hostname"), join(work, "escape"));
      const outside = await app.request(`/api/files?path=${encodeURIComponent(join(work, "escape"))}`, { headers: { cookie } });
      expect(outside.status).toBe(403);

      writeFileSync(join(work, "ok.txt"), "正常");
      const inside = await app.request(`/api/files?path=${encodeURIComponent(join(work, "ok.txt"))}`, { headers: { cookie } });
      expect(inside.status).toBe(200);
      expect(await inside.text()).toBe("正常");
    } finally {
      hob.close();
    }
  });

  it("凭据和内部状态文件不给读：secrets/config/settings/push.json、engine/、lore/、*.bak*", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      mkdirSync(join(hob.home, "engine"), { recursive: true });
      mkdirSync(join(hob.home, "lore"), { recursive: true });
      const secret = '{"provider:openai":"sk-x"}';
      for (const rel of [
        "secrets.json",
        "config.json",
        "settings.json",
        "push.json",
        "engine/auth.json",
        "lore/config.json",
        "notes.bak",
        "secrets.json.1234.tmp",
      ]) {
        writeFileSync(join(hob.home, rel), secret);
        const response = await app.request(`/api/files?path=${encodeURIComponent(join(hob.home, rel))}`, { headers: { cookie } });
        expect(response.status, rel).toBe(403);
        // 元数据接口同样不给
        const meta = await app.request(`/api/files/meta?path=${encodeURIComponent(join(hob.home, rel))}`, { headers: { cookie } });
        expect(meta.status, rel).toBe(403);
      }
    } finally {
      hob.close();
    }
  });

  it("能执行脚本的类型：默认附件下载 + sandbox CSP + nosniff，?inline=1 才内联", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const uploads = join(hob.home, "uploads");
      mkdirSync(uploads, { recursive: true });
      const html = join(uploads, "报告.html");
      writeFileSync(html, "<html><script>fetch('/api/settings')</script></html>");
      const svg = join(uploads, "图.svg");
      writeFileSync(svg, "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");

      const htmlResponse = await app.request(`/api/files?path=${encodeURIComponent(html)}`, { headers: { cookie } });
      expect(htmlResponse.status).toBe(200);
      expect(htmlResponse.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(htmlResponse.headers.get("x-content-type-options")).toBe("nosniff");
      expect(htmlResponse.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
      expect(htmlResponse.headers.get("content-disposition")).toMatch(/^attachment;/);

      const inline = await app.request(`/api/files?path=${encodeURIComponent(html)}&inline=1`, { headers: { cookie } });
      expect(inline.headers.get("content-disposition")).toMatch(/^inline;/);
      expect(inline.headers.get("content-security-policy")).toBe("sandbox allow-scripts");

      // svg 也一样：sandbox（不给跑脚本）+ 默认附件
      const svgResponse = await app.request(`/api/files?path=${encodeURIComponent(svg)}`, { headers: { cookie } });
      expect(svgResponse.headers.get("content-security-policy")).toBe("sandbox");
      expect(svgResponse.headers.get("content-disposition")).toMatch(/^attachment;/);
    } finally {
      hob.close();
    }
  });

  it("正常图片照常给，带 nosniff", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const uploads = join(hob.home, "uploads");
      mkdirSync(uploads, { recursive: true });
      const png = join(uploads, "图.png");
      writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const response = await app.request(`/api/files?path=${encodeURIComponent(png)}`, { headers: { cookie } });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-disposition")).toBeNull();
    } finally {
      hob.close();
    }
  });
});

describe("GET /api/files/meta", () => {
  it("给预览面板要的元数据：类型、是否文本；不认识的扩展名按内容嗅探", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const work = join(hob.home, "jobs", "t-bbbb", "work");
      mkdirSync(work, { recursive: true });
      writeFileSync(join(work, "说明.md"), "# hi");
      writeFileSync(join(work, "README"), "plain text no ext");
      writeFileSync(join(work, "blob"), Buffer.from([0, 1, 2, 3]));

      const md = await app.request(`/api/files/meta?path=${encodeURIComponent(join(work, "说明.md"))}`, { headers: { cookie } });
      expect(md.status).toBe(200);
      expect(((await md.json()) as { kind: string; text: boolean; mime: string }).kind).toBe("markdown");

      const noExt = await app.request(`/api/files/meta?path=${encodeURIComponent(join(work, "README"))}`, { headers: { cookie } });
      expect(((await noExt.json()) as { kind: string; text: boolean }).kind).toBe("text");

      const bin = await app.request(`/api/files/meta?path=${encodeURIComponent(join(work, "blob"))}`, { headers: { cookie } });
      const binMeta = (await bin.json()) as { kind: string; text: boolean };
      expect(binMeta.kind).toBe("other");
      expect(binMeta.text).toBe(false);
    } finally {
      hob.close();
    }
  });
});

describe("GET /api/jobs/:id/files", () => {
  it("递归列出任务工作目录，跳过 node_modules/.git 和符号链接，新的在前；任务不存在 404", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      hob.runtime.store.saveJob({
        id: "t-cc01",
        assistantId: "hob",
        title: "干活",
        instruction: "干活",
        kind: "local",
        status: "done",
        createdAt: "2026-11-01T01:00:00.000Z",
        stats: { reads: 0, commands: 0, edits: 0 },
        activity: [],
      });
      const work = hob.runtime.store.workDir("t-cc01");
      mkdirSync(join(work, "src", "deep"), { recursive: true });
      mkdirSync(join(work, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(work, "新.txt"), "a");
      writeFileSync(join(work, "src", "main.ts"), "b");
      writeFileSync(join(work, "node_modules", "pkg", "junk.js"), "c");
      symlinkSync(join(work, "新.txt"), join(work, "link.txt"));

      const response = await app.request("/api/jobs/t-cc01/files", { headers: { cookie } });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { files: { rel: string }[]; hasMore: boolean };
      expect(body.files.map((file) => file.rel).sort()).toEqual(["src/main.ts", "新.txt"]);
      expect(body.hasMore).toBe(false);

      const missing = await app.request("/api/jobs/t-zzzz/files", { headers: { cookie } });
      expect(missing.status).toBe(404);
    } finally {
      hob.close();
    }
  });
});
