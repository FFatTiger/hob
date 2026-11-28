import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AssistantSummary, AssistantTopicSummary, GroupSummary, ModelInfo, ModelSettings } from "../../shared/types.ts";
import type { ComposerModelOps } from "../src/components/ComposerPlus.tsx";

const storage = new Map<string, string>();

let store: typeof import("../src/store.ts");
let composerModelHelper: typeof import("../src/components/ComposerPlus.tsx").composerModelHelper;

beforeAll(async () => {
  vi.stubGlobal("location", { search: "", hash: "", pathname: "/", protocol: "http:", host: "127.0.0.1" });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  vi.stubGlobal("window", {
    innerWidth: 1280,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
    addEventListener: () => undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      lang: "zh-CN",
      classList: { toggle: () => undefined, contains: () => false },
      setAttribute: () => undefined,
      removeAttribute: () => undefined,
    },
  });
  store = await import("../src/store.ts");
  ({ composerModelHelper } = await import("../src/components/ComposerPlus.tsx"));
});

const models: ModelInfo[] = [
  { ref: "p/m1", provider: "p", id: "m1", name: "Model 1", reasoning: false, images: false },
  { ref: "p/m2", provider: "p", id: "m2", name: "Model 2", reasoning: false, images: false },
];

const settings: ModelSettings = {
  conversation: { ref: "p/m1", thinking: "off" },
  work: { ref: "p/m1", thinking: "off" },
  workThinking: "auto",
  roster: [
    { ref: "p/m1", note: "" },
    { ref: "p/m2", note: "" },
  ],
};

function makeOps(): ComposerModelOps {
  return {
    patchGroup: vi.fn(async () => null),
    patchAssistantTopicConfig: vi.fn(async () => null),
    patchAssistant: vi.fn(async () => null),
    loadGroupProfile: vi.fn(async () => undefined),
    setNotice: vi.fn(),
  };
}

describe("输入框模型选择器开关与话题隔离", () => {
  it("默认开启，切换后持久化到 localStorage", () => {
    expect(store.getState().composerModelPicker).toBe(true);
    store.setComposerModelPicker(false);
    expect(store.getState().composerModelPicker).toBe(false);
    expect(storage.get("hob.composer.model")).toBe("0");
    store.setComposerModelPicker(true);
    expect(store.getState().composerModelPicker).toBe(true);
    expect(storage.get("hob.composer.model")).toBe("1");
  });

  it("群话题切换模型只写入话题本身，不写入父群", async () => {
    const ops = makeOps();
    const parentGroup = { id: "g-parent", name: "研发组", purpose: "", ownerId: "hob", members: ["hob"], busy: [], unread: 0, createdAt: "2026-01-01" } as GroupSummary;
    const topicGroup = { ...parentGroup, id: "g-topic", parentId: "g-parent", name: "性能排查" } as GroupSummary;
    const helper = composerModelHelper({ g: topicGroup, parentGroup, models, settings });

    await helper.save("conversation", "p/m2", ops);
    expect(ops.patchGroup).toHaveBeenCalledWith("g-topic", { models: { conversation: { ref: "p/m2", thinking: "off" } } });
    expect(ops.patchGroup).not.toHaveBeenCalledWith("g-parent", expect.anything());
    expect(ops.loadGroupProfile).toHaveBeenCalledWith("g-topic");
  });

  it("助手话题切换模型只写入话题配置，单聊才写入助手本身", async () => {
    const ops = makeOps();
    const a = { id: "writer", name: "写作", duty: "写稿", sprite: "page", primary: false, pinned: false, hidden: false, notify: true, busy: false, unread: 0, createdAt: "2026-01-01" } as AssistantSummary;
    const topic = { id: "tp-1", assistantId: "writer", name: "年终总结", createdAt: "2026-01-01", createdBy: "user", busy: false, unread: 0 } as AssistantTopicSummary;

    const topicHelper = composerModelHelper({ a, topic, models, settings });
    await topicHelper.save("conversation", "p/m2", ops);
    expect(ops.patchAssistantTopicConfig).toHaveBeenCalledWith("writer", "tp-1", { models: { conversation: { ref: "p/m2", thinking: "off" } } });
    expect(ops.patchAssistant).not.toHaveBeenCalled();

    const directHelper = composerModelHelper({ a, models, settings });
    await directHelper.save("conversation", "p/m2", ops);
    expect(ops.patchAssistant).toHaveBeenCalledWith("writer", { models: { conversation: { ref: "p/m2", thinking: "off" } } });
  });
});
