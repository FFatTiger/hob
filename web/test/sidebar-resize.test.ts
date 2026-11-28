import { describe, expect, it } from "vitest";
import {
  clampSideWidth,
  SIDE_WIDTH_DEFAULT,
  SIDE_WIDTH_MAX,
  SIDE_WIDTH_MIN,
  SIDE_WIDTH_STEP,
  sideWidthForKey,
} from "../src/sidebar-resize.ts";

describe("左栏拖拽与键盘调宽", () => {
  it("clampSideWidth 将宽度限制在合法区间并四舍五入", () => {
    expect(clampSideWidth(120)).toBe(SIDE_WIDTH_MIN);
    expect(clampSideWidth(520)).toBe(SIDE_WIDTH_MAX);
    expect(clampSideWidth(312.6)).toBe(313);
  });

  it("sideWidthForKey 支持左右方向键步进与 Home/Enter 重置", () => {
    expect(sideWidthForKey(undefined, "ArrowRight")).toBe(SIDE_WIDTH_DEFAULT + SIDE_WIDTH_STEP);
    expect(sideWidthForKey(undefined, "ArrowLeft")).toBe(SIDE_WIDTH_DEFAULT - SIDE_WIDTH_STEP);
    expect(sideWidthForKey(SIDE_WIDTH_MIN, "ArrowLeft")).toBe(SIDE_WIDTH_MIN);
    expect(sideWidthForKey(SIDE_WIDTH_MAX, "ArrowRight")).toBe(SIDE_WIDTH_MAX);
    expect(sideWidthForKey(340, "Home")).toBeNull();
    expect(sideWidthForKey(340, "Enter")).toBeNull();
    expect(sideWidthForKey(340, "Tab")).toBeUndefined();
  });
});
