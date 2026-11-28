import { describe, expect, it } from "vitest";
import { groupSuggestionPrefix } from "../src/mention.ts";

const assistants = [
  { id: "po", name: "产品负责人" },
  { id: "release", name: "发布" },
];

const items = [
  { kind: "assistant", speaker: "po" },
  { kind: "assistant", speaker: "release" },
];

const baseGroup = { ownerId: "po" };

describe("groupSuggestionPrefix", () => {
  it("prefixes @member in owner mode when the last speaker is not the owner", () => {
    expect(groupSuggestionPrefix({ ...baseGroup, replyMode: "owner" }, items, assistants)).toBe("@发布 ");
    expect(groupSuggestionPrefix(baseGroup, items, assistants)).toBe("@发布 ");
  });

  it("omits @member in all-member reply mode so suggestions keep all-member routing", () => {
    expect(groupSuggestionPrefix({ ...baseGroup, replyMode: "all" }, items, assistants)).toBe("");
  });

  it("omits @member when the last speaker is already the group owner", () => {
    expect(groupSuggestionPrefix({ ...baseGroup, replyMode: "owner" }, [items[0]!], assistants)).toBe("");
  });
});
