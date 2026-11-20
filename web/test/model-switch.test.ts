import { describe, expect, it } from "vitest";
import type { Group, ModelInfo } from "../../shared/types.ts";
import { modelOwner, ownModelRef, switchableRefs, switchOptions, thinkingForSwitch } from "../src/model-list.ts";

function model(ref: string): ModelInfo {
  return { ref, provider: ref.split("/")[0]!, id: ref.split("/")[1]!, name: ref.toUpperCase(), reasoning: true, thinkingLevels: ["off", "low", "high"], input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0 } };
}

const group = (id: string, extra: Partial<Group> = {}): Group => ({ id, name: id, purpose: "", ownerId: "hob", members: ["hob"], createdAt: "2026-01-01", ...extra });

describe("对话顶部的模型切换", () => {
  it("话题的模型记在所属的群上", () => {
    const parent = group("g-1", { models: { conversation: { ref: "a/one", thinking: "low" } } });
    const topic = group("g-2", { parentId: "g-1" });
    expect(modelOwner(topic, [parent, topic])?.id).toBe("g-1");
    expect(modelOwner(parent, [parent, topic])?.id).toBe("g-1");
    expect(modelOwner(undefined, [parent])).toBeUndefined();
  });

  it("群用自己的、单聊用助手的，都没设过就是空串（跟随）", () => {
    const own = group("g-1", { models: { conversation: { ref: "a/one", thinking: "off" } } });
    expect(ownModelRef(own, undefined)).toBe("a/one");
    expect(ownModelRef(undefined, { models: { conversation: { ref: "a/two", thinking: "off" } } })).toBe("a/two");
    // 没单独设过：显示「跟随」，不把全局模型当成自己的
    expect(ownModelRef(undefined, {})).toBe("");
  });

  it("只列名单里现在可用的模型", () => {
    const roster = [{ ref: "a/one" }, { ref: "a/gone", unavailable: true }, { ref: "a/two" }];
    expect(switchableRefs(roster, [model("a/one"), model("a/two")])).toEqual(["a/one", "a/two"]);
    // 名单里有、但注册表现在拿不到（服务商 Key 掉了）也不列
    expect(switchableRefs([{ ref: "a/one" }], [])).toEqual([]);
  });

  it("菜单第一行是跟随，后面按名单顺序", () => {
    const options = switchOptions(["a/one", "a/two"], [model("a/one"), model("a/two")], "跟随全局（A/ONE）");
    expect(options).toEqual([
      { value: "", label: "跟随全局（A/ONE）" },
      { value: "a/one", label: "A/ONE" },
      { value: "a/two", label: "A/TWO" },
    ]);
  });

  it("换模型时名单里定的档优先，其次保持当前档并收进新模型的档", () => {
    const capped = { ...model("a/one"), thinkingLevels: ["off", "low"] as ModelInfo["thinkingLevels"] };
    expect(thinkingForSwitch(capped, "high", "off")).toBe("low");
    expect(thinkingForSwitch(capped, undefined, "high")).toBe("low");
    expect(thinkingForSwitch(capped, undefined, "off")).toBe("off");
  });
});
