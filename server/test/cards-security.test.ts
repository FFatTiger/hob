import { readdirSync, readFileSync, writeFileSync, type Dirent } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { answerCard } from "../src/actions.ts";
import { call, makeHob, seedPluginSource, text } from "./helpers.ts";

function textFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }) as Dirent[]) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else {
        try { out.push(readFileSync(path, "utf8")); } catch { /* 二进制文件不包含可读表单值 */ }
      }
    }
  };
  visit(root);
  return out;
}

describe("plugin card value safety", () => {
  it("never persists a password field in HOB_HOME or writes it to captured logs", async () => {
    const hob = makeHob({}, { memory: "off" });
    seedPluginSource(hob.home);
    const secret = "card-only-password-7f9c";
    const logs = [vi.spyOn(console, "log").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {})];
    try {
      const host = hob.runtime.plugins;
      host.store.install("github");
      host.store.saveConfig("github", { GITHUB_PERSONAL_ACCESS_TOKEN: "fixture-token" });
      const fixture = fileURLToPath(new URL("./fixtures/mcp-fixture.mjs", import.meta.url));
      writeFileSync(join(hob.home, "plugins/github/mcp.json"), JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [fixture], env: { HOB_MCP_CARDS: "1" } } } }));
      await host.start();
      hob.faux.setResponses([call("github_show_card", {}), text("卡片已显示")]);
      await hob.runtime.router.send("hob", { text: "打开密码卡" });
      await hob.runtime.router.waitIdle("hob");
      const record = hob.runtime.store.cards()[0]!;
      expect(record.card.body.elements.some((element) => element.tag === "form")).toBe(true);
      hob.faux.setResponses([text("插件已处理")]);
      const result = await answerCard(hob.runtime, record.id, { action: { tag: "button" }, button_text: "保存", form_value: { secret } });
      expect(result.status).toBe(200);
      const allText = textFiles(hob.home).join("\n");
      expect(allText).not.toContain(secret);
      expect(logs.flatMap((spy) => spy.mock.calls.flat()).map(String).join("\n")).not.toContain(secret);
      expect(hob.runtime.store.card(record.id)?.result).toBeUndefined();
    } finally {
      logs.forEach((spy) => spy.mockRestore());
      await hob.runtime.plugins.close();
      hob.close();
    }
  });
});
