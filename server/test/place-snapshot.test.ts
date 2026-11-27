import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSystemPrompt } from "../src/prompt.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { makeHob } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
});

function normalize(text: string, home: string, groupId: string, topicId: string): string {
  return text
    .replaceAll(home, "<HOB_HOME>")
    .replaceAll(groupId, "<GROUP_ID>")
    .replaceAll(topicId, "<TOPIC_ID>")
    .replace(/（g-[a-z0-9]+）/g, "（<OTHER_GROUP_ID>）");
}

describe("单聊与群的系统提示词和工具名单快照（Place 重构基准）", () => {
  it("buildSystemPrompt 与 buildRouterTools：单聊、群综合、群话题", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T08:00:00Z"));
    const hob = makeHob({}, { memory: "off" });
    try {
      const store = hob.runtime.store;
      const base = store.assistant("hob")!;
      store.saveAssistant({
        ...base,
        id: "ops",
        name: "运维",
        duty: "服务器与发布",
        primary: false,
        pinned: false,
        sprite: "server",
      });
      store.saveRules("hob", [
        { id: "r-hob", text: "删除前先确认", changedAt: "2026-11-26T00:00:00Z" },
      ]);
      store.saveRules("ops", [
        { id: "r-ops", text: "发布前先跑测试", changedAt: "2026-11-26T00:00:00Z" },
      ]);
      vi.advanceTimersByTime(1000);
      const group = hob.runtime.groups.create({
        name: "运维协同群",
        purpose: "处理部署与故障排查",
        ownerId: "hob",
        members: ["hob", "ops"],
      });
      vi.advanceTimersByTime(1000);
      const topic = hob.runtime.groups.createTopic(group.id, "排查网关超时", "user");

      const promptOpts = {
        timezone: "Asia/Shanghai",
        locale: "zh-CN" as const,
        aboutYou: { name: "", language: "", notes: "" },
        memory: "off" as const,
      };
      const norm = (s: string) => normalize(s, hob.home, group.id, topic.id);

      const singleHobPrompt = norm(buildSystemPrompt(store, "hob", promptOpts));
      const singleOpsPrompt = norm(buildSystemPrompt(store, "ops", promptOpts));
      const groupOwnerPrompt = norm(
        buildSystemPrompt(store, "hob", { ...promptOpts, group: store.group(group.id)! }),
      );
      const groupMemberPrompt = norm(
        buildSystemPrompt(store, "ops", { ...promptOpts, group: store.group(group.id)! }),
      );
      const topicOwnerPrompt = norm(
        buildSystemPrompt(store, "hob", { ...promptOpts, group: store.group(topic.id)! }),
      );
      const topicMemberPrompt = norm(
        buildSystemPrompt(store, "ops", { ...promptOpts, group: store.group(topic.id)! }),
      );

      expect({
        singleHobPrompt,
        singleOpsPrompt,
        groupOwnerPrompt,
        groupMemberPrompt,
        topicOwnerPrompt,
        topicMemberPrompt,
      }).toMatchSnapshot("system-prompts");

      const toolShape = (assistantId: string, groupId?: string) =>
        buildRouterTools(hob.runtime, assistantId, groupId ? { groupId } : undefined).map((tool) => ({
          name: tool.name,
          description: norm(tool.description),
          params: Object.keys(((tool.parameters as unknown as { properties?: Record<string, unknown> }).properties) ?? {}),
        }));

      expect({
        singleHobTools: toolShape("hob"),
        singleOpsTools: toolShape("ops"),
        groupOwnerTools: toolShape("hob", group.id),
        groupMemberTools: toolShape("ops", group.id),
        topicOwnerTools: toolShape("hob", topic.id),
        topicMemberTools: toolShape("ops", topic.id),
      }).toMatchSnapshot("router-tools");
    } finally {
      hob.close();
    }
  });

  it("RouterManager.ensure 会话实际激活的系统提示词和工具名单：单聊与群", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T08:00:00Z"));
    const hob = makeHob({}, { memory: "off" });
    try {
      const store = hob.runtime.store;
      const base = store.assistant("hob")!;
      store.saveAssistant({
        ...base,
        id: "ops",
        name: "运维",
        duty: "服务器与发布",
        primary: false,
        pinned: false,
        sprite: "server",
      });
      vi.advanceTimersByTime(1000);
      const group = hob.runtime.groups.create({
        name: "运维协同群",
        purpose: "处理部署与故障排查",
        ownerId: "hob",
        members: ["hob", "ops"],
      });
      vi.advanceTimersByTime(1000);
      const topic = hob.runtime.groups.createTopic(group.id, "排查网关超时", "user");
      const norm = (s: string) => normalize(s, hob.home, group.id, topic.id);

      const sHob = await hob.runtime.router.ensure("hob");
      const sOps = await hob.runtime.router.ensure("ops");
      const gHob = await hob.runtime.router.ensure("hob", { groupId: group.id });
      const gOps = await hob.runtime.router.ensure("ops", { groupId: group.id });
      const tHob = await hob.runtime.router.ensure("hob", { groupId: topic.id });
      const tOps = await hob.runtime.router.ensure("ops", { groupId: topic.id });

      expect({
        singleHob: {
          prompt: norm(sHob.session!.systemPrompt),
          tools: sHob.session!.getActiveToolNames(),
        },
        singleOps: {
          prompt: norm(sOps.session!.systemPrompt),
          tools: sOps.session!.getActiveToolNames(),
        },
        groupOwner: {
          prompt: norm(gHob.session!.systemPrompt),
          tools: gHob.session!.getActiveToolNames(),
        },
        groupMember: {
          prompt: norm(gOps.session!.systemPrompt),
          tools: gOps.session!.getActiveToolNames(),
        },
        topicOwner: {
          prompt: norm(tHob.session!.systemPrompt),
          tools: tHob.session!.getActiveToolNames(),
        },
        topicMember: {
          prompt: norm(tOps.session!.systemPrompt),
          tools: tOps.session!.getActiveToolNames(),
        },
      }).toMatchSnapshot("router-sessions");
    } finally {
      hob.close();
    }
  });
});
