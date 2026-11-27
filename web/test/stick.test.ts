import { describe, expect, it } from "vitest";
import { afterScroll, centerScrollTop, expectAfterResize } from "../src/stick.ts";

// 视口 800 高、内容 1000 高：滚到底时 top 是 200。
const atBottom = { top: 200, height: 1000, view: 800 };

describe("贴底滚动的判断", () => {
  it("离底部很近时重新贴底", () => {
    expect(afterScroll(false, 200, { top: 150, height: 1000, view: 800 }).stuck).toBe(true);
  });

  it("用户往上翻超过阈值才算离开底部", () => {
    expect(afterScroll(true, 200, { top: 100, height: 1000, view: 800 })).toEqual({ stuck: false, expect: 100 });
  });

  it("内容长高、还没轮到我们滚的时候不算离开底部", () => {
    // 流式文字长高 300：位置没变，只是离底部远了
    expect(afterScroll(true, 200, { top: 200, height: 1300, view: 800 }).stuck).toBe(true);
  });

  it("上面掉条目、滚动位置被程序往上挪过之后不算离开底部", () => {
    // 只留最近 60 条：最上面掉了一条，分页那边把位置往上挪了 125 让看的人不跳，位置和预期一致
    expect(afterScroll(true, 1075, { top: 1075, height: 2426, view: 800 }).stuck).toBe(true);
  });

  it("内容变矮被浏览器往上收：预期位置跟着收，收完再往上翻还认得出", () => {
    expect(expectAfterResize(false, 500, { top: 0, height: 1000, view: 800 })).toBe(200);
    expect(afterScroll(false, 200, { top: 100, height: 1000, view: 800 })).toEqual({ stuck: false, expect: 100 });
    // 贴底时内容长高：预期位置就是新的底部
    expect(expectAfterResize(true, 200, { top: 200, height: 1200, view: 800 })).toBe(400);
  });

  it("内容比视口还矮时贴底就是顶部", () => {
    expect(expectAfterResize(true, 0, { top: 0, height: 600, view: 800 })).toBe(0);
    expect(afterScroll(true, 0, { top: 0, height: 600, view: 800 }).stuck).toBe(true);
  });

  it("跳到指定消息时按可见区域中线计算居中的滚动位置并夹在合法范围内", () => {
    // 视口 800 高，上下浮动栏各占 100（可见区 100..700，中线 400）；目标中心在 600 → 往下挪 200
    expect(centerScrollTop(
      { top: 100, height: 2400, view: 800 },
      { top: 0, height: 800 },
      { top: 580, height: 40 },
      100,
      100,
    )).toBe(300);
    // 目标在最顶上时夹到 0；在最底时夹到 maxTop
    expect(centerScrollTop(
      { top: 200, height: 2400, view: 800 },
      { top: 0, height: 800 },
      { top: -150, height: 40 },
    )).toBe(0);
    expect(centerScrollTop(
      { top: 1400, height: 2400, view: 800 },
      { top: 0, height: 800 },
      { top: 1200, height: 40 },
    )).toBe(1600);
  });
});
