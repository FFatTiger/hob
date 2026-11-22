import type { AgentTool } from "@earendil-works/pi-agent-core";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PluginHost, pluginToolsForAssistant } from "../src/plugin-host.ts";
import { call, makeHob as makeBaseHob, seedPluginSource, text } from "./helpers.ts";
const makeHob = () => { const hob = makeBaseHob(); seedPluginSource(hob.home); return hob; };

const homes: string[] = [];
const hosts: PluginHost[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.close())); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function host(): PluginHost {
  const home = mkdtempSync(join(tmpdir(), "hob-plugin-host-"));
  homes.push(home);
  seedPluginSource(home);
  const instance = new PluginHost(home); hosts.push(instance); return instance;
}
describe("shared plugin connections", () => {
  it("reports missing configuration, connects, shares calls and closes on disable", async () => {
    const instance = host();
    instance.store.install("github");
    await instance.start();
    expect(instance.states("github")[0]).toMatchObject({ status: "pending_config", missing: ["GITHUB_PERSONAL_ACCESS_TOKEN"] });
    const fixture = fileURLToPath(new URL("./fixtures/mcp-fixture.mjs", import.meta.url));
    writeFileSync(join(instance.store.home, "plugins/github/mcp.json"), JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [fixture] } } }));
    instance.store.saveConfig("github", { GITHUB_PERSONAL_ACCESS_TOKEN: "fixture-token" });
    await instance.reload("github");
    expect(instance.states("github")[0]).toMatchObject({ name: "demo", status: "connected" });
    expect(instance.states("github")[0].tools.map(t => t.name)).toEqual(["echo", "fail"]);
    expect((await instance.call("github", "demo", "echo", { message: "hello" })).content).toEqual([{ type: "text", text: "echo: hello" }]);
    expect((await instance.call("github", "demo", "fail", {})).content).toEqual([{ type: "text", text: "工具执行失败" }]);
    const tools: AgentTool<any>[] = pluginToolsForAssistant(instance, "hob");
    expect(tools.map(tool => tool.name)).toEqual(["github_echo", "github_fail"]);
    expect((await tools[0].execute("call", { message: "script" })).content).toEqual([{ type: "text", text: "echo: script" }]);
    instance.store.patch("github", { assistants: ["someone"] });
    expect(pluginToolsForAssistant(instance, "hob")).toEqual([]);
    instance.store.patch("github", { assistants: null });
    expect(pluginToolsForAssistant(instance, "hob").every(tool => tool.exposure === "direct")).toBe(true);
    instance.store.patch("github", { enabled: false });
    await instance.reload("github");
    expect(instance.states("github")).toEqual([]);
  });
  it("migrates and resolves legacy secret commands only when connecting", async () => {
    const instance = host();
    const fixture = fileURLToPath(new URL("./fixtures/mcp-fixture.mjs", import.meta.url));
    const dir = join(instance.store.home, "system/engine"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { sample: { command: process.execPath, args: [fixture], env: { HOB_MCP_DESCRIPTION: "!printf command-result" } } } }));
    instance.store.migrateLegacy();
    expect(JSON.stringify(instance.store.view("sample"))).not.toContain("printf command-result");
    await instance.start();
    expect(instance.states("sample")[0].tools[0].description).toBe("command-result");
  });
  it("calls a plugin tool from a worker and preserves the service failure", async () => {
    const hob = makeHob();
    try {
      const instance = hob.runtime.plugins;
      instance.store.install("github");
      instance.store.saveConfig("github", { GITHUB_PERSONAL_ACCESS_TOKEN: "fixture-token" });
      const fixture = fileURLToPath(new URL("./fixtures/mcp-fixture.mjs", import.meta.url));
      writeFileSync(join(hob.home, "plugins/github/mcp.json"), JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [fixture] } } }));
      await instance.start();
      hob.faux.setResponses([call("github_fail", {}), call("report", { outcome: "done", result: "checked" })]);
      hob.faux.appendResponses([text("已完成。")]);
      const job = await hob.runtime.jobs.start("hob", { title: "检查工具", instruction: "调用服务" });
      await hob.runtime.jobs.waitIdle(30_000);
      const steps = hob.runtime.jobs.transcript(job.id);
      expect(steps.some(step => step.output?.includes("工具执行失败"))).toBe(true);
      expect(hob.runtime.store.job(job.id)?.status).toBe("done");
    } finally { await hob.runtime.plugins.close(); hob.close(); }
  }, 30_000);
  it("registers deferred tools without declaring them until tool_search loads them", async () => {
    const hob = makeHob();
    try {
      const host = hob.runtime.plugins;
      host.store.install("github");
      host.store.saveConfig("github", { GITHUB_PERSONAL_ACCESS_TOKEN: "fixture-token" });
      const fixture = fileURLToPath(new URL("./fixtures/mcp-fixture.mjs", import.meta.url));
      writeFileSync(join(hob.home, "plugins/github/mcp.json"), JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [fixture], env: { HOB_MCP_MANY: "1" } } } }));
      await host.start();
      const tools = pluginToolsForAssistant(host, "hob");
      const opened = await hob.runtime.pi.open({ file: join(hob.home, "search.jsonl"), cwd: hob.home, model: "hob-faux/faux-1", thinking: "off", systemPrompt: () => "test", tools: ["read", "tool_search", ...tools.map(tool => tool.name)], customTools: tools, toolSearch: true });
      try {
        expect(opened.session.getActiveToolNames()).toContain("tool_search");
        expect(opened.session.getActiveToolNames()).not.toContain("github_echo");
        hob.faux.setResponses([call("tool_search", { query: "github echo" }), call("github_echo", { message: "sample" }), text("done")]);
        await opened.session.prompt("查找并调用工具");
        expect(opened.session.getActiveToolNames()).toContain("github_echo");
        expect(readFileSync(join(hob.home, "search.jsonl"), "utf8")).toContain("echo: sample");
      } finally { opened.session.dispose(); }
    } finally { await hob.runtime.plugins.close(); hob.close(); }
  }, 30_000);
  it("searches deferred tools and calls them from an assistant session", async () => {
    const hob = makeHob();
    try {
      const instance = hob.runtime.plugins;
      instance.store.install("github");
      instance.store.saveConfig("github", { GITHUB_PERSONAL_ACCESS_TOKEN: "fixture-token" });
      const fixture = fileURLToPath(new URL("./fixtures/mcp-fixture.mjs", import.meta.url));
      writeFileSync(join(hob.home, "plugins/github/mcp.json"), JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [fixture], env: { HOB_MCP_MANY: "1" } } } }));
      await instance.start();
      expect(instance.states("github")[0].tools.length).toBeGreaterThan(10);
      expect(pluginToolsForAssistant(instance, "hob").every(tool => tool.exposure === "deferred")).toBe(true);
      const pluginTools = pluginToolsForAssistant(instance, "hob");
      const opened = await hob.runtime.pi.open({ file: join(hob.home, "search-test.jsonl"), cwd: hob.home, model: "hob-faux/faux-1", thinking: "off", systemPrompt: () => "test", tools: ["read", "tool_search", ...pluginTools.map(tool => tool.name)], customTools: pluginTools, toolSearch: true });
      try {
        expect(opened.session.getActiveToolNames()).not.toContain("github_fail");
        expect(opened.session.getActiveToolNames()).toContain("tool_search");
        expect(opened.session.getActiveToolNames()).not.toContain("github_echo");
        hob.faux.setResponses([call("tool_search", { query: "github echo" }), call("github_echo", { message: "sample" }), text("已收到结果。")]);
        await opened.session.prompt("请调用 echo");
        expect(opened.session.getActiveToolNames()).toContain("github_echo");
        expect(readFileSync(join(hob.home, "search-test.jsonl"), "utf8")).toContain("echo: sample");
      } finally { opened.session.dispose(); }
      instance.store.patch("github", { tools: {} });
      hob.faux.setResponses([call("tool_search", { query: "github echo" }), call("github_echo", { message: "sample" }), text("已收到结果。")]);
      await hob.runtime.router.send("hob", { text: "请调用 echo" });
      await hob.runtime.router.waitIdle("hob");
      const transcript = readFileSync(join(hob.home, "assistants/hob/router.jsonl"), "utf8");
      expect(transcript).toContain("github_echo");
      expect(transcript).toContain("echo: sample");
    } finally { await hob.runtime.plugins.close(); hob.close(); }
  }, 30_000);
});
