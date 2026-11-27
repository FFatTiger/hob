import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { fauxProvider } from "@earendil-works/pi-ai";
import { PiHost } from "../src/pi.ts";
import { call, makeHob, text } from "./helpers.ts";

describe("Router 上下文边界", () => {
  it("仅 Router 对大工具结果落盘，read、助手资料和小结果不截", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const full = "甲".repeat(6000) + "乙".repeat(4000);
      const dir = join(hob.home, "spill");
      const file = join(hob.home, "read.txt");
      writeFileSync(file, full);
      const tool = {
        name: "large", label: "large", description: "test", parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text" as const, text: full.slice(0, 6000) }, { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }, { type: "text" as const, text: full.slice(6000) }], details: {} }),
      };
      const showAssistant = { ...tool, name: "show_assistant", label: "show_assistant" };
      const run = async (name: string, spillDir?: string) => {
        const opened = await hob.runtime.pi.open({ file: join(hob.home, `${name}.jsonl`), cwd: hob.home, model: "hob-faux/faux-1", thinking: "off", memory: "off", systemPrompt: () => "测试", tools: ["large", "read", "show_assistant"], customTools: [tool, showAssistant], spillDir });
        return opened.session;
      };
      const router = await run("router", dir);
      hob.faux.setResponses([call("large", {}), text("好")]);
      await router.prompt("开始");
      const result = router.messages.find((m) => m.role === "toolResult");
      expect(result?.role).toBe("toolResult");
      if (!result || result.role !== "toolResult") throw new Error("工具未执行");
      const first = result.content[0];
      expect(first.type).toBe("text");
      if (first.type !== "text") throw new Error("结果不是文字");
      expect(first.text).toMatch(/^甲{4000}\n\n（共 10000 字，这里是前 4,000 字；全文：.*\.txt）$/);
      const path = first.text.match(/全文：(.*)）$/)![1];
      expect(readFileSync(path, "utf8")).toBe(full);
      expect(result.content[1]).toMatchObject({ type: "image", data: "aGVsbG8=" });
      expect(result.isError).toBe(false);
      hob.faux.setResponses([call("read", { path: file }), text("好")]);
      await router.prompt("读文件");
      const read = router.messages.filter((m) => m.role === "toolResult").at(-1)!;
      expect(JSON.stringify(read.content)).toContain(full);
      hob.faux.setResponses([call("show_assistant", {}), text("好")]);
      await router.prompt("查看助手");
      const profile = router.messages.filter((m) => m.role === "toolResult").at(-1)!;
      expect(JSON.stringify(profile.content)).toContain("甲".repeat(6000));
      expect(JSON.stringify(profile.content)).toContain("乙".repeat(4000));
      const worker = await run("worker");
      hob.faux.setResponses([call("large", {}), text("好")]);
      await worker.prompt("开始");
      const workerResult = worker.messages.find((m) => m.role === "toolResult")!;
      expect(JSON.stringify(workerResult.content)).toContain("甲".repeat(6000));
      router.dispose(); worker.dispose();
    } finally { hob.close(); }
  });

  it("短结果不落盘，写盘失败保留原结果并报告错误", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const dir = join(hob.home, "spill");
      let value = "短".repeat(4000);
      const tool = { name: "sample", label: "sample", description: "test", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: value }], details: {} }) };
      const { session } = await hob.runtime.pi.open({ file: join(hob.home, "test.jsonl"), cwd: hob.home, model: "hob-faux/faux-1", thinking: "off", memory: "off", systemPrompt: () => "测试", tools: ["sample"], customTools: [tool], spillDir: dir });
      hob.faux.setResponses([call("sample", {}), text("好")]);
      await session.prompt("短结果");
      expect(existsSync(dir)).toBe(false);
      expect(JSON.stringify(session.messages.find((m) => m.role === "toolResult")?.content)).toContain(value);
      writeFileSync(dir, "不是目录");
      value = "长".repeat(10000);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      hob.faux.setResponses([call("sample", {}), text("好")]);
      await session.prompt("写盘失败");
      expect(JSON.stringify(session.messages.filter((m) => m.role === "toolResult").at(-1)?.content)).toContain(value);
      expect(error).toHaveBeenCalled();
      error.mockRestore();
      session.dispose();
    } finally { hob.close(); }
  });

  it("加上重试后压缩仍由引擎运行时解析凭据", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const runtime = await hob.runtime.pi.runtime();
      const auth = vi.spyOn(runtime, "getAuth");
      const opened = await hob.runtime.pi.open({ file: join(hob.home, "stall-compact.jsonl"), cwd: hob.home, model: "hob-faux/faux-1", thinking: "off", systemPrompt: () => "测试", tools: [], customTools: [], stall: { milliseconds: () => 1000, onRetry: () => {} } });
      try {
        const session = opened.session as unknown as { _getSummarizationRequestAuth: (model: unknown, signal: AbortSignal) => Promise<unknown> };
        await session._getSummarizationRequestAuth(opened.session.model, new AbortController().signal);
        expect(auth).not.toHaveBeenCalled();
      } finally { opened.session.dispose(); }
    } finally { hob.close(); }
  });

  it("对话和任务一样，接近模型上下文上限才压缩", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const faux = fauxProvider({ provider: "budget", models: [{ id: "large", contextWindow: 1_000_000 }] });
      const host = new PiHost({ engineDir: join(hob.home, "budget-engine"), nativeProviders: [faux.provider] });
      const options = { cwd: hob.home, model: "budget/large", thinking: "off" as const, memory: "off" as const, systemPrompt: () => "测试", tools: [], customTools: [] };
      const router = await host.open({ ...options, file: join(hob.home, "budget-router.jsonl"), spillDir: join(hob.home, "spill") });
      const worker = await host.open({ ...options, file: join(hob.home, "budget-worker.jsonl") });
      const large = (await host.runtime()).getModel("budget", "large")!;
      expect(router.session.settingsManager.getCompactionSettings(large)).toEqual(worker.session.settingsManager.getCompactionSettings(large));
      expect(router.session.settingsManager.getCompactionSettings(large).reserveTokens).toBeLessThan(100_000);
      router.session.dispose(); worker.session.dispose();
    } finally { hob.close(); }
  });

  it("Router 单轮连续做事达到阈值时附带耗时与次数事实，跨轮及派任务后重置", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      let clock = 1_000_000;
      const tool = {
        name: "probe", label: "probe", description: "test", parameters: Type.Object({}),
        execute: async () => {
          clock += 10_000;
          return { content: [{ type: "text" as const, text: "结果" }], details: {} };
        },
      };
      const startJob = {
        name: "start_job", label: "start_job", description: "test", parameters: Type.Object({ note: Type.Optional(Type.String()) }),
        execute: async () => ({ content: [{ type: "text" as const, text: "已派任务" }], details: {} }),
      };
      const updateTodos = {
        name: "update_todos", label: "update_todos", description: "test", parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text" as const, text: "已更新" }], details: {} }),
      };
      const { session } = await hob.runtime.pi.open({
        file: join(hob.home, "fact.jsonl"),
        cwd: hob.home,
        model: "hob-faux/faux-1",
        thinking: "off",
        memory: "off",
        systemPrompt: () => "测试",
        tools: ["probe", "start_job", "update_todos"],
        customTools: [tool, startJob, updateTodos],
        spillDir: join(hob.home, "spill"),
        turnProgressFact: { now: () => clock },
      });

      // 前 3 次未达阈值不附带；meta 工具不计入；第 4 次触发，第 5~7 次不重复，第 8 次再次附带；派发后重置
      hob.faux.setResponses([
        call("probe", {}),
        call("update_todos", {}),
        call("probe", {}),
        call("probe", {}),
        call("probe", {}),
        call("probe", {}),
        call("probe", {}),
        call("probe", {}),
        call("probe", {}),
        call("start_job", {}),
        call("probe", {}),
        text("完成"),
      ]);
      await session.prompt("第一轮");
      const results = session.messages.filter((m) => m.role === "toolResult");
      expect(results).toHaveLength(11);
      expect(JSON.stringify(results[0].content)).not.toContain("这一轮你已经自己连续执行了");
      expect(JSON.stringify(results[1].content)).not.toContain("这一轮你已经自己连续执行了"); // update_todos
      expect(JSON.stringify(results[3].content)).not.toContain("这一轮你已经自己连续执行了"); // 第 3 次 probe
      expect(JSON.stringify(results[4].content)).toContain("这一轮你已经自己连续执行了 4 次操作、耗时 40 秒，用户这段时间还没收到你的回复。");
      expect(JSON.stringify(results[5].content)).not.toContain("这一轮你已经自己连续执行了"); // 第 5 次不重复
      expect(JSON.stringify(results[7].content)).not.toContain("这一轮你已经自己连续执行了"); // 第 7 次不重复
      expect(JSON.stringify(results[8].content)).toContain("这一轮你已经自己连续执行了 8 次操作、耗时 1 分 20 秒，用户这段时间还没收到你的回复。");
      expect(JSON.stringify(results[9].content)).not.toContain("这一轮你已经自己连续执行了"); // start_job
      expect(JSON.stringify(results[10].content)).not.toContain("这一轮你已经自己连续执行了"); // start_job 后重置

      // 新一轮达到 90 秒时间阈值时，第 1 次调用即可触发
      const slowTool = {
        name: "probe", label: "probe", description: "test", parameters: Type.Object({}),
        execute: async () => {
          clock += 95_000;
          return { content: [{ type: "text" as const, text: "长耗时结果" }], details: {} };
        },
      };
      const opened2 = await hob.runtime.pi.open({
        file: join(hob.home, "fact-time.jsonl"),
        cwd: hob.home,
        model: "hob-faux/faux-1",
        thinking: "off",
        memory: "off",
        systemPrompt: () => "测试",
        tools: ["probe"],
        customTools: [slowTool],
        turnProgressFact: { now: () => clock },
      });
      hob.faux.setResponses([call("probe", {}), text("好")]);
      await opened2.session.prompt("慢命令");
      const slowResult = opened2.session.messages.find((m) => m.role === "toolResult")!;
      expect(JSON.stringify(slowResult.content)).toContain("这一轮你已经自己连续执行了 1 次操作、耗时 1 分 35 秒，用户这段时间还没收到你的回复。");

      session.dispose();
      opened2.session.dispose();
    } finally { hob.close(); }
  });
});
