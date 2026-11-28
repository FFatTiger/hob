import { describe, expect, it } from "vitest";
import {
  filterPaletteItems,
  resolveGlobalPaletteKey,
  resolveInputPaletteKey,
} from "../src/command-palette.ts";

describe("命令面板快捷键与筛选逻辑", () => {
  it("其他模态框打开时不劫持 ⌘K，面板已打开时允许 ⌘K 与 Escape 关闭", () => {
    expect(
      resolveGlobalPaletteKey({ key: "k", metaKey: true, ctrlKey: false }, { open: false, hasOtherModal: true }),
    ).toBeNull();
    expect(
      resolveGlobalPaletteKey({ key: "k", metaKey: true, ctrlKey: false }, { open: false, hasOtherModal: false }),
    ).toBe("toggle");
    expect(
      resolveGlobalPaletteKey({ key: "Escape", metaKey: false, ctrlKey: false }, { open: true, hasOtherModal: true }),
    ).toBe("close");
    expect(
      resolveGlobalPaletteKey({ key: "Escape", metaKey: false, ctrlKey: false }, { open: false, hasOtherModal: false }),
    ).toBeNull();
    expect(
      resolveGlobalPaletteKey({ key: "k", metaKey: true, ctrlKey: false, isComposing: true }, { open: false, hasOtherModal: false }),
    ).toBeNull();
  });

  it("输入法组合态下忽略 ArrowDown / ArrowUp / Enter，正常状态下循环导航", () => {
    expect(resolveInputPaletteKey({ key: "ArrowDown", isComposing: true }, 0, 5)).toBeNull();
    expect(resolveInputPaletteKey({ key: "ArrowUp", isComposing: true }, 0, 5)).toBeNull();
    expect(resolveInputPaletteKey({ key: "Enter", isComposing: true }, 0, 5)).toBeNull();
    expect(resolveInputPaletteKey({ key: "Escape", isComposing: true }, 0, 5)).toEqual({ kind: "close" });

    expect(resolveInputPaletteKey({ key: "ArrowDown" }, 4, 5)).toEqual({ kind: "move", index: 0 });
    expect(resolveInputPaletteKey({ key: "ArrowUp" }, 0, 5)).toEqual({ kind: "move", index: 4 });
    expect(resolveInputPaletteKey({ key: "Enter" }, 2, 5)).toEqual({ kind: "execute" });
  });

  it("按标签和关键词不区分大小写筛选命令", () => {
    const items = [
      { id: "1", label: "研发组", keywords: "研发组 技术评审" },
      { id: "2", label: "主题 · 深色", keywords: "theme dark 深色" },
    ];
    expect(filterPaletteItems(items, "")).toHaveLength(2);
    expect(filterPaletteItems(items, "DARK").map((i) => i.id)).toEqual(["2"]);
    expect(filterPaletteItems(items, "评审").map((i) => i.id)).toEqual(["1"]);
  });
});
