import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroupItem } from "../../shared/types.ts";
import { setLocale } from "../../shared/i18n.ts";
import { applyEngineEnv } from "../src/boot.ts";
import { assistantTopicTodosPath, systemDir } from "../src/config.ts";
import { startHob } from "../src/main.ts";
import { hashPassword } from "../src/password.ts";
import { PiHost } from "../src/pi.ts";
import { EVENT_TYPE, INTERRUPTED_RESUME_WINDOW_MS, ITEM_TYPE, RouterManager, USER_TYPE } from "../src/router.ts";
import { defaultSettings } from "../src/settings.ts";
import { releaseIdleTodosAtStartup, readTodos, writeTodos } from "../src/todos.ts";
import { makeHob, seedPluginSource, text, waitFor } from "./helpers.ts";

const tempHomes: string[] = [];

afterEach(() => {
  setLocale("zh-CN");
  for (const dir of tempHomes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function readSessionEntries(file: string): any[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function writeRawSession(file: string, entries: any[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const header = { type: "session", version: 3, id: "sess-test", timestamp: entries[0]?.timestamp ?? new Date().toISOString(), cwd: dirname(file) };
  writeFileSync(file, [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function userMessageEntry(id: string, parentId: string | null, timestamp: string, content: string) {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role: "user", content, timestamp: Date.parse(timestamp) },
  };
}

function hobUserEntry(id: string, parentId: string | null, timestamp: string, content: string) {
  return {
    type: "custom",
    customType: USER_TYPE,
    id,
    parentId,
    timestamp,
    data: { text: content },
  };
}

function assistantToolEntry(id: string, parentId: string | null, timestamp: string, calls: { id: string; name: string; arguments?: Record<string, unknown> }[]) {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      api: "openai-completions",
      provider: "hob-faux",
      model: "faux-1",
      stopReason: "toolUse",
      timestamp: Date.parse(timestamp),
      usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments ?? {} })),
    },
  };
}

function assistantTextEntry(id: string, parentId: string | null, timestamp: string, content: string, stopReason = "stop") {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      api: "openai-completions",
      provider: "hob-faux",
      model: "faux-1",
      stopReason,
      timestamp: Date.parse(timestamp),
      usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: [{ type: "text", text: content }],
    },
  };
}

function toolResultEntry(id: string, parentId: string | null, timestamp: string, toolCallId: string, toolName: string, content: string, isError = false) {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text: content }],
      isError,
      timestamp: Date.parse(timestamp),
    },
  };
}

function createFakeHome(locale: "zh-CN" | "en" = "zh-CN") {
  const home = mkdtempSync(join(tmpdir(), "hob-resume-"));
  tempHomes.push(home);
  applyEngineEnv(process.env, home);
  const config = {
    host: "127.0.0.1",
    port: 0,
    passwordHash: hashPassword("test"),
    cookieSecret: "cookie-secret",
  };
  const settings = defaultSettings("Asia/Shanghai");
  const defaultModel = "hob-faux/faux-1";
  mkdirSync(join(home, "system"), { recursive: true });
  writeFileSync(join(home, "system", "config.json"), JSON.stringify(config));
  writeFileSync(
    join(home, "system", "settings.json"),
    JSON.stringify({
      revision: 1,
      settings: {
        general: { ...settings.general, locale },
        providers: [],
        models: {
          roster: [{ ref: defaultModel, note: "" }],
          conversation: { ref: defaultModel, thinking: "off" },
          work: { ref: defaultModel, thinking: "off" },
          suggest: null,
        },
        work: settings.work,
      },
      memory: { provider: "off" },
    }),
  );
  seedPluginSource(home);
  return { home, config };
}

describe("重启时恢复被打断的对话回合", () => {
  it("近期悬空工具调用（bash + read）：补完整工具结果、出正在接着做的提示并自动接着做，系统提示不推通知、完成后正常推送", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const push = vi.spyOn(hob.runtime.push, "send").mockResolvedValue({ sent: 1, removed: 0 });
      const recent = new Date(Date.now() - 5 * 60_000).toISOString();
      const file = hob.runtime.store.routerFile("hob");
      writeRawSession(file, [
        hobUserEntry("u1", null, recent, "帮我检查日志和脚本"),
        userMessageEntry("m1", "u1", recent, "帮我检查日志和脚本"),
        assistantToolEntry("a1", "m1", recent, [
          { id: "call-read", name: "read", arguments: { path: "a.txt" } },
          { id: "call-bash", name: "bash", arguments: { command: "sleep 300" } },
        ]),
        toolResultEntry("r1", "a1", recent, "call-read", "read", "文件已读取"),
      ]);

      hob.faux.setResponses([text("已重新检查，这是最终结果。")]);
      await hob.runtime.router.recover();
      // 系统提示本身在 recover 时就已写入，且不发推送
      expect(push).not.toHaveBeenCalled();
      expect(hob.runtime.router.items("hob").items.find((item) => item.kind === "note")?.text).toBe(
        "Hob 重启过，刚才这一轮被打断了，正在接着做",
      );

      await hob.runtime.router.waitIdle("hob");
      const entries = readSessionEntries(file);
      const addedResult = entries.find((e) => e.type === "message" && e.message?.role === "toolResult" && e.message.toolCallId === "call-bash");
      expect(addedResult?.message.content[0].text).toBe(
        "Hob 重启，这次调用被中断，没有结果。命令可能跑到一半，要用到它的结果就重跑。",
      );
      expect(addedResult?.message.isError).toBe(true);

      const resumeEvent = entries.find((e) => e.type === "custom_message" && e.customType === EVENT_TYPE);
      expect(resumeEvent?.content).toContain("Hob 刚刚重启");
      expect(resumeEvent?.content).toContain("bash");

      // 模型看到的上下文是合法的：assistant(toolCall) -> toolResult(call-read) -> toolResult(call-bash) -> (system) -> resumeEvent -> assistant(reply)
      const manager = SessionManager.open(file, dirname(file), hob.home);
      const roles = manager.buildSessionContext().messages.map((m) => m.role).filter((r) => r !== "system");
      expect(roles).toEqual(["user", "assistant", "toolResult", "toolResult", "custom", "assistant"]);

      const items = hob.runtime.router.items("hob").items;
      expect(items.some((item) => item.kind === "assistant" && item.text === "已重新检查，这是最终结果。")).toBe(true);
      await waitFor(() => push.mock.calls.length === 1);
      expect(push.mock.calls[0]?.[0]).toMatchObject({ body: "已重新检查，这是最终结果。" });
    } finally {
      hob.close();
    }
  });

  it("非 bash 悬空工具调用补常规中断提示，超过时间窗的不自动接着做且二次重启幂等", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const push = vi.spyOn(hob.runtime.push, "send").mockResolvedValue({ sent: 1, removed: 0 });
      const old = new Date(Date.now() - INTERRUPTED_RESUME_WINDOW_MS - 10 * 60_000).toISOString();
      const file = hob.runtime.store.routerFile("hob");
      writeRawSession(file, [
        hobUserEntry("u1", null, old, "查一下外部网页"),
        userMessageEntry("m1", "u1", old, "查一下外部网页"),
        assistantToolEntry("a1", "m1", old, [{ id: "call-web", name: "web_fetch", arguments: { url: "https://example.com" } }]),
      ]);

      await hob.runtime.router.recover();
      expect(hob.faux.state.callCount).toBe(0);
      expect(push).not.toHaveBeenCalled();

      const entries = readSessionEntries(file);
      const addedResult = entries.find((e) => e.type === "message" && e.message?.role === "toolResult" && e.message.toolCallId === "call-web");
      expect(addedResult?.message.content[0].text).toBe("Hob 重启，这次调用被中断，没有结果。");
      expect(hob.runtime.router.items("hob").items.filter((item) => item.kind === "note").map((item) => item.text)).toEqual([
        "Hob 重启过，刚才这一轮被打断了",
      ]);

      // 二次重启不再重复写提示行
      const router2 = new RouterManager(hob.runtime);
      await router2.recover();
      expect(router2.items("hob").items.filter((item) => item.kind === "note").map((item) => item.text)).toEqual([
        "Hob 重启过，刚才这一轮被打断了",
      ]);
      router2.disposeAll();
    } finally {
      hob.close();
    }
  });

  it("最后是用户消息（含 steer 插话）没有助手回复：近期接着做、早期只出提示", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const assistant = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...assistant, id: "ops", name: "运维", primary: false });

      const recent = new Date(Date.now() - 10 * 60_000).toISOString();
      writeRawSession(hob.runtime.store.routerFile("hob"), [
        hobUserEntry("u1", null, recent, "看下服务"),
        userMessageEntry("m1", "u1", recent, "看下服务"),
        assistantToolEntry("a1", "m1", recent, [{ id: "c1", name: "read", arguments: { path: "x" } }]),
        toolResultEntry("r1", "a1", recent, "c1", "read", "ok"),
        hobUserEntry("u2", "r1", recent, "顺便再看下端口"),
        userMessageEntry("m2", "u2", recent, "顺便再看下端口"),
      ]);

      const old = new Date(Date.now() - INTERRUPTED_RESUME_WINDOW_MS - 60_000).toISOString();
      writeRawSession(hob.runtime.store.routerFile("ops"), [
        hobUserEntry("u1", null, old, "昨天的消息"),
        userMessageEntry("m1", "u1", old, "昨天的消息"),
      ]);

      hob.faux.setResponses([text("端口一切正常。")]);
      await hob.runtime.router.recover();
      await hob.runtime.router.waitIdle("hob");

      expect(hob.faux.state.callCount).toBe(1);
      expect(hob.runtime.router.items("hob").items.some((item) => item.kind === "note" && item.text === "Hob 重启过，刚才这一轮被打断了，正在接着做")).toBe(true);
      expect(hob.runtime.router.items("hob").items.some((item) => item.kind === "assistant" && item.text === "端口一切正常。")).toBe(true);

      expect(hob.runtime.router.items("ops").items.some((item) => item.kind === "note" && item.text === "Hob 重启过，刚才这一轮被打断了")).toBe(true);
      expect(hob.runtime.router.items("ops").items.some((item) => item.kind === "assistant")).toBe(false);
    } finally {
      hob.close();
    }
  });

  it("正常结束的会话（文本收尾、start_job 终止工具收尾、报错收尾）在重启后不动", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const base = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...base, id: "a2", name: "二号", primary: false });
      hob.runtime.store.saveAssistant({ ...base, id: "a3", name: "三号", primary: false });

      const recent = new Date(Date.now() - 2 * 60_000).toISOString();
      writeRawSession(hob.runtime.store.routerFile("hob"), [
        hobUserEntry("u1", null, recent, "你好"),
        userMessageEntry("m1", "u1", recent, "你好"),
        assistantTextEntry("a1", "m1", recent, "你好！"),
      ]);
      writeRawSession(hob.runtime.store.routerFile("a2"), [
        hobUserEntry("u1", null, recent, "跑个后台任务"),
        userMessageEntry("m1", "u1", recent, "跑个后台任务"),
        assistantToolEntry("a1", "m1", recent, [{ id: "c1", name: "start_job", arguments: { title: "t", note: "n" } }]),
        toolResultEntry("r1", "a1", recent, "c1", "start_job", "已交给后台任务"),
      ]);
      writeRawSession(hob.runtime.store.routerFile("a3"), [
        hobUserEntry("u1", null, recent, "试一下"),
        userMessageEntry("m1", "u1", recent, "试一下"),
        assistantTextEntry("a1", "m1", recent, "API Error", "error"),
        { type: "custom", customType: ITEM_TYPE, id: "n1", parentId: "a1", timestamp: recent, data: { kind: "note", icon: "info", text: "未能回复" } },
        { type: "custom_message", customType: "hob.context", id: "ctx1", parentId: "n1", timestamp: recent, content: "未能回复", display: false },
      ]);

      await hob.runtime.router.recover();
      expect(hob.faux.state.callCount).toBe(0);
      expect(hob.runtime.router.items("hob").items.some((item) => item.kind === "note")).toBe(false);
      expect(hob.runtime.router.items("a2").items.some((item) => item.kind === "note")).toBe(false);
      expect(hob.runtime.router.items("a3").items.filter((item) => item.kind === "note")).toHaveLength(1);
    } finally {
      hob.close();
    }
  });

  it("助手话题会话被打断时补结果、保留未完待办并在该话题里自动接着做", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const base = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...base, id: "dev", name: "开发", primary: false, topics: true });
      const { topic } = await hob.runtime.assistantTopics.create("dev", { title: "长命令排查" });
      const place = { topicId: topic.id };
      const recent = new Date(Date.now() - 3 * 60_000).toISOString();
      const file = hob.runtime.store.assistantTopicRouterFile("dev", topic.id);
      writeRawSession(file, [
        hobUserEntry("u1", null, recent, "跑测试并总结"),
        userMessageEntry("m1", "u1", recent, "跑测试并总结"),
        assistantToolEntry("a1", "m1", recent, [{ id: "c1", name: "bash", arguments: { command: "npm test" } }]),
      ]);
      const todosPath = assistantTopicTodosPath(hob.home, "dev", topic.id);
      writeTodos(todosPath, [{ text: "跑完测试并汇总", status: "doing" }]);

      hob.faux.setResponses([text("测试全部通过。")]);
      await hob.runtime.router.recover();
      // 启动收起闲置待办不得提前清掉正在排队续跑的话题待办
      releaseIdleTodosAtStartup(hob.runtime);
      expect(readTodos(todosPath)).toEqual([{ text: "跑完测试并汇总", status: "doing" }]);

      await hob.runtime.router.waitIdle("dev", 10_000, place);
      const items = hob.runtime.router.items("dev", {}, place).items;
      expect(items.some((item) => item.kind === "note" && item.text === "Hob 重启过，刚才这一轮被打断了，正在接着做")).toBe(true);
      expect(items.some((item) => item.kind === "assistant" && item.text === "测试全部通过。")).toBe(true);
    } finally {
      hob.close();
    }
  });

  it("群成员会话被打断时补结果、群时间线不重复出提示并在群里接着回复", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const base = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...base, id: "ops", name: "运维", primary: false });
      const group = hob.runtime.groups.create({ name: "值班群", purpose: "排障", ownerId: "hob", members: ["hob", "ops"] });

      const recent = new Date(Date.now() - 4 * 60_000).toISOString();
      const userItem: GroupItem = { kind: "user", speaker: "user", id: "g-2", at: recent, text: "@运维 查下磁盘" };
      const streamingItem: GroupItem = { kind: "assistant", speaker: "ops", id: "g-3", at: recent, text: "正在查看", streaming: true };
      hob.runtime.store.appendGroupItem(group.id, userItem);
      hob.runtime.store.appendGroupItem(group.id, streamingItem);
      hob.runtime.store.saveGroupState(group.id, { seen: { ops: "g-2" } });

      // 重新构造 GroupManager 模拟重启（会先把 g-3 收尾并写占位重启提示，随后 router.recover 替换它）
      const { GroupManager } = await import("../src/groups.ts");
      hob.runtime.groups = new GroupManager(hob.runtime);

      const memberFile = hob.runtime.store.groupMemberFile(group.id, "ops");
      writeRawSession(memberFile, [
        userMessageEntry("m1", null, recent, "用户：@运维 查下磁盘"),
        assistantToolEntry("a1", "m1", recent, [{ id: "c1", name: "bash", arguments: { command: "df -h" } }]),
      ]);

      hob.faux.setResponses([text("磁盘使用率 42%。")]);
      await hob.runtime.router.recover();
      await hob.runtime.router.waitIdle("ops", 10_000, { groupId: group.id });

      const entries = readSessionEntries(memberFile);
      expect(entries.find((e) => e.type === "message" && e.message?.role === "toolResult" && e.message.toolCallId === "c1")?.message.content[0].text).toBe(
        "Hob 重启，这次调用被中断，没有结果。命令可能跑到一半，要用到它的结果就重跑。",
      );

      const items = hob.runtime.groups.items(group.id).items;
      const restartNotes = items.filter((item) => item.kind === "note" && item.text.includes("重启"));
      expect(restartNotes).toHaveLength(1);
      expect(restartNotes[0]?.text).toBe("Hob 重启过，刚才这一轮被打断了，正在接着做");
      expect(items.find((item) => item.id === "g-3")).toMatchObject({ streaming: false, text: "正在查看" });
      expect(items.some((item) => item.kind === "assistant" && item.speaker === "ops" && item.text === "磁盘使用率 42%。")).toBe(true);
    } finally {
      hob.close();
    }
  });

  it("多个会话同时被打断时，接着做是顺序排着来的（上一个完成才开下一个）", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const base = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...base, id: "ops", name: "运维", primary: false });
      const recent = new Date(Date.now() - 2 * 60_000).toISOString();

      writeRawSession(hob.runtime.store.routerFile("hob"), [
        hobUserEntry("u1", null, recent, "任务一"),
        userMessageEntry("m1", "u1", recent, "任务一"),
      ]);
      writeRawSession(hob.runtime.store.routerFile("ops"), [
        hobUserEntry("u1", null, recent, "任务二"),
        userMessageEntry("m1", "u1", recent, "任务二"),
      ]);

      let enteredFirst!: () => void;
      let releaseFirst!: () => void;
      const firstStarted = new Promise<void>((resolve) => { enteredFirst = resolve; });
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const order: string[] = [];

      hob.faux.setResponses([
        async () => {
          order.push("start-1");
          enteredFirst();
          await firstGate;
          order.push("end-1");
          return fauxAssistantMessage("第一个好了");
        },
        async () => {
          order.push("start-2");
          return fauxAssistantMessage("第二个好了");
        },
      ]);

      await hob.runtime.router.recover();
      await firstStarted;
      // 第一个还没放行时，第二个已经在排队等、尚未调用模型
      expect(hob.faux.state.callCount).toBe(1);
      expect(hob.runtime.router.isBusy("ops")).toBe(true);
      expect(order).toEqual(["start-1"]);

      releaseFirst();
      await Promise.all([hob.runtime.router.waitIdle("hob"), hob.runtime.router.waitIdle("ops")]);
      expect(order).toEqual(["start-1", "end-1", "start-2"]);
      expect(hob.runtime.router.items("hob").items.some((i) => i.kind === "assistant" && i.text === "第一个好了")).toBe(true);
      expect(hob.runtime.router.items("ops").items.some((i) => i.kind === "assistant" && i.text === "第二个好了")).toBe(true);
    } finally {
      hob.close();
    }
  });

  it("startHob 正常关闭时记录仍在跑的会话，重启后依记录接着做并清理状态文件", async () => {
    const { home } = createFakeHome();
    const faux1 = fauxProvider({ provider: "hob-faux", models: [{ id: "faux-1", contextWindow: 200_000 }], tokensPerSecond: 200_000 });
    let modelEntered!: () => void;
    const entered = new Promise<void>((resolve) => { modelEntered = resolve; });
    faux1.setResponses([
      () => {
        modelEntered();
        return new Promise<never>(() => undefined);
      },
    ]);
    const pi1 = new PiHost({ engineDir: join(home, "system", "engine"), nativeProviders: [faux1.provider] });
    const server1 = await startHob({ home, port: 0, pi: pi1 });
    try {
      await server1.runtime.router.send("hob", { text: "帮我跑个检查" });
      await entered;
      await server1.close();
    } catch (error) {
      await server1.close().catch(() => undefined);
      throw error;
    }

    const shutdownFile = join(systemDir(home), "interrupted-turns.json");
    expect(existsSync(shutdownFile)).toBe(true);
    const recorded = JSON.parse(readFileSync(shutdownFile, "utf8")) as { assistantId: string; place: object }[];
    expect(recorded).toMatchObject([{ assistantId: "hob", place: {} }]);

    const faux2 = fauxProvider({ provider: "hob-faux", models: [{ id: "faux-1", contextWindow: 200_000 }], tokensPerSecond: 200_000 });
    faux2.setResponses([text("重启后已接上并完成检查。")]);
    const pi2 = new PiHost({ engineDir: join(home, "system", "engine"), nativeProviders: [faux2.provider] });
    const server2 = await startHob({ home, port: 0, pi: pi2 });
    try {
      expect(existsSync(shutdownFile)).toBe(false);
      await server2.runtime.router.waitIdle("hob");
      const items = server2.runtime.router.items("hob").items;
      expect(items.some((item) => item.kind === "note" && item.text === "Hob 重启过，刚才这一轮被打断了，正在接着做")).toBe(true);
      expect(items.some((item) => item.kind === "assistant" && item.text === "重启后已接上并完成检查。")).toBe(true);
    } finally {
      await server2.close();
    }
  });

  it("英文界面语言下系统提示行按英文输出", async () => {
    const hob = makeHob({}, { settings: { general: { locale: "en" } }, memory: "off" });
    try {
      const recent = new Date(Date.now() - 2 * 60_000).toISOString();
      writeRawSession(hob.runtime.store.routerFile("hob"), [
        hobUserEntry("u1", null, recent, "Check status"),
        userMessageEntry("m1", "u1", recent, "Check status"),
      ]);
      hob.faux.setResponses([text("All good.")]);
      await hob.runtime.router.recover();
      await hob.runtime.router.waitIdle("hob");
      expect(hob.runtime.router.items("hob").items.some((item) =>
        item.kind === "note" && item.text === "Hob restarted and the previous turn was interrupted. Continuing now.",
      )).toBe(true);
    } finally {
      hob.close();
    }
  });
});
