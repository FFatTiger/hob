import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantSummary, AssistantTopicSummary, GroupSummary, ModelInfo, ModelSettings, StarredMessage, TopicConfigView } from "../../../shared/types.ts";

const mockState = vi.hoisted(() => ({
  sel: "planner" as string | null,
  gsel: null as string | null,
  tsel: "tp-move" as string | null,
  query: "",
  stars: [] as StarredMessage[],
  starsError: null as string | null,
  assistants: [] as AssistantSummary[],
  assistantTopics: [] as AssistantTopicSummary[],
  groups: [] as GroupSummary[],
  approvals: {},
  drafts: {},
  delegations: {},
  livePages: {},
  jobs: {},
  toggleStar: vi.fn(async () => undefined),
}));

vi.mock("../store.ts", () => ({
  useApp: () => mockState,
  toggleStar: mockState.toggleStar,
  photoUrl: (path: string) => path,
  fileUrl: (path: string) => path,
  setQuote: vi.fn(),
  focusComposer: vi.fn(),
  setNotice: vi.fn(),
  goHome: vi.fn(),
  jumpToHistory: vi.fn(),
  searchHistory: vi.fn(async () => ({ results: [], total: 0 })),
  assistantSessionKey: (aid: string, tid?: string | null) => (tid ? `${aid}@${tid}` : aid),
  loadModels: vi.fn(async () => null),
  loadAssistantTopicConfig: vi.fn(async () => undefined),
  loadGroupProfile: vi.fn(async () => undefined),
  patchGroup: vi.fn(async () => null),
  patchAssistantTopicConfig: vi.fn(async () => null),
  patchAssistant: vi.fn(async () => undefined),
}));
vi.mock("./ImageGen.tsx", () => ({ ImageGenCard: () => null }));
vi.mock("./Markdown.tsx", () => ({ Markdown: ({ text }: { text: string }) => <span>{text}</span> }));

import { composerModelHelper } from "./ComposerPlus.tsx";
import { ItemList, starConversation } from "./Items.tsx";
import { Stars } from "./Stars.tsx";

describe("issue 269 step 3 component fixes", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    mockState.sel = "planner";
    mockState.gsel = null;
    mockState.tsel = "tp-move";
    mockState.assistants = [
      {
        id: "planner",
        name: "日程统筹",
        duty: "搬家与预约",
        sprite: "page",
        primary: false,
        pinned: true,
        hidden: false,
        notify: true,
        topics: { enabledAt: "2026-11-26T00:00:00Z" },
        createdAt: "2026-11-26T00:00:00Z",
        unread: 0,
        busy: false,
      },
    ];
    mockState.assistantTopics = [
      {
        id: "tp-move",
        assistantId: "planner",
        name: "搬家筹备",
        createdAt: "2026-11-26T01:00:00Z",
        createdBy: "user",
        unread: 0,
        busy: false,
      },
    ];
    mockState.groups = [];
    mockState.stars = [];
  });

  it("报告 3：助手话题内收藏使用 kind=topic 与话题 id，收藏页按话题归属显示名称与头像", () => {
    expect(starConversation({ gsel: null, sel: "planner", tsel: "tp-move" })).toEqual({ kind: "topic", id: "tp-move" });
    expect(starConversation({ gsel: null, sel: "planner", tsel: null })).toEqual({ kind: "assistant", id: "planner" });
    expect(starConversation({ gsel: "g-1", sel: null, tsel: null })).toEqual({ kind: "group", id: "g-1" });

    // 主对话的 a-1 收藏不应在话题里显示为已收藏
    mockState.stars = [{ conversation: { kind: "assistant", id: "planner" }, itemId: "a-1", speaker: "planner", text: "主对话回复", at: "2026-11-26T01:00:00Z", starredAt: "2026-11-26T01:01:00Z" }];
    const htmlWithoutTopicStar = renderToStaticMarkup(<ItemList items={[{ kind: "assistant", id: "a-1", at: "2026-11-26T01:05:00Z", text: "话题回复" }]} />);
    expect(htmlWithoutTopicStar).not.toContain("message-star");

    // 话题的 a-1 收藏在话题里显示已收藏，在收藏页显示「日程统筹 · 搬家筹备」
    mockState.stars = [{ conversation: { kind: "topic", id: "tp-move" }, itemId: "a-1", speaker: "user", text: "记下新地址", at: "2026-11-26T01:05:00Z", starredAt: "2026-11-26T01:06:00Z" }];
    const htmlWithTopicStar = renderToStaticMarkup(<ItemList items={[{ kind: "assistant", id: "a-1", at: "2026-11-26T01:05:00Z", text: "话题回复" }]} />);
    expect(htmlWithTopicStar).toContain("message-star");

    const starsHtml = renderToStaticMarkup(<Stars narrow={false} />);
    expect(starsHtml).toContain("日程统筹 · 搬家筹备");
    expect(starsHtml).not.toContain(">tp-move<");
  });

  it("报告 4：ComposerPlus 在群话题与助手话题读写话题覆盖层，选跟随发 null", async () => {
    const mkModel = (id: string, name: string): ModelInfo => ({
      ref: `p/${id}`,
      provider: "p",
      id,
      name,
      reasoning: false,
      thinkingLevels: ["off"],
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 4096,
      cost: { input: 0, output: 0 },
    });
    const models: ModelInfo[] = [
      mkModel("m-group", "GroupModel"),
      mkModel("m-topic", "TopicModel"),
      mkModel("m-next", "NextModel"),
      mkModel("m-asst", "AsstModel"),
      mkModel("m-global", "GlobalModel"),
    ];
    const settings: ModelSettings = {
      conversation: { ref: "p/m-global", thinking: "off" },
      work: { ref: "p/m-global", thinking: "off" },
      roster: models.map((m) => ({ ref: m.ref, note: "" })),
    };

    const ops = {
      patchGroup: vi.fn(async () => null),
      patchAssistantTopicConfig: vi.fn(async () => null),
      patchAssistant: vi.fn(async () => null),
      loadGroupProfile: vi.fn(async () => undefined),
      setNotice: vi.fn(),
    };

    // 1. 群话题：读话题层覆盖、写 patchGroup(topic.id)、跟随发 null
    const parentGroup: GroupSummary = {
      id: "g-1",
      name: "交付群",
      purpose: "协作",
      ownerId: "planner",
      members: ["planner"],
      models: { conversation: { ref: "p/m-group", thinking: "off" } },
      createdAt: "2026-11-26T00:00:00Z",
      unread: 0,
      busy: [],
    };
    const groupTopic: GroupSummary = {
      ...parentGroup,
      id: "gt-1",
      parentId: "g-1",
      name: "发版排查",
      models: { conversation: { ref: "p/m-topic", thinking: "off" } },
      overrides: { models: { conversation: { ref: "p/m-topic", thinking: "off" } } },
    };

    const gHelper = composerModelHelper({ g: groupTopic, parentGroup, models, settings });
    expect(gHelper.own("conversation")?.ref).toBe("p/m-topic");
    expect(gHelper.current("conversation")).toBe("TopicModel");
    expect(gHelper.follow("conversation")).toBe("跟随群 · GroupModel");

    await gHelper.save("conversation", "p/m-next", ops);
    expect(ops.patchGroup).toHaveBeenCalledWith("gt-1", { models: { conversation: { ref: "p/m-next", thinking: "off" } } });
    expect(ops.loadGroupProfile).toHaveBeenCalledWith("gt-1");

    await gHelper.save("conversation", "", ops);
    expect(ops.patchGroup).toHaveBeenLastCalledWith("gt-1", { models: { conversation: null } });

    // 2. 助手话题：读 assistantTopicConfigs、写 patchAssistantTopicConfig、跟随发 null
    const assistant: AssistantSummary = {
      ...mockState.assistants[0]!,
      models: { conversation: { ref: "p/m-asst", thinking: "off" } },
    };
    const topicConfig: TopicConfigView = {
      rules: [],
      hiddenRules: [],
      models: {
        conversation: {
          source: "topic",
          pick: { ref: "p/m-topic", thinking: "off" },
          inherited: { source: "assistant", pick: { ref: "p/m-asst", thinking: "off" } },
        },
        work: {
          source: "assistant",
          pick: { ref: "p/m-asst", thinking: "off" },
          inherited: { source: "assistant", pick: { ref: "p/m-asst", thinking: "off" } },
        },
      },
    };

    const aHelper = composerModelHelper({ a: assistant, topic: mockState.assistantTopics[0]!, topicConfig, models, settings });
    expect(aHelper.own("conversation")?.ref).toBe("p/m-topic");
    expect(aHelper.own("work")).toBeUndefined();
    expect(aHelper.current("conversation")).toBe("TopicModel");
    expect(aHelper.follow("conversation")).toBe("跟随助手 · AsstModel");

    await aHelper.save("conversation", "p/m-next", ops);
    expect(ops.patchAssistantTopicConfig).toHaveBeenCalledWith("planner", "tp-move", { models: { conversation: { ref: "p/m-next", thinking: "off" } } });
    expect(ops.patchAssistant).not.toHaveBeenCalled();

    await aHelper.save("conversation", "", ops);
    expect(ops.patchAssistantTopicConfig).toHaveBeenLastCalledWith("planner", "tp-move", { models: { conversation: null } });
  });
});
