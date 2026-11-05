import { describe, expect, it } from "vitest";
import { popPage, pushPage, removeMissingLivePages, replacePage, selectPanelStack, type PanelPage } from "../src/panel-stack.ts";

describe("右栏页面栈", () => {
  it("压栈、退回已有页面并更新参数、逐层返回", () => {
    const job: PanelPage = { kind: "job", id: "one", round: 0 };
    const stack = pushPage(pushPage([], job), { kind: "file", path: "/a", full: false });
    expect(pushPage(stack, { ...job, round: 1 })).toEqual([{ ...job, round: 1 }]);
    expect(popPage(stack)).toEqual([job]);
    expect(popPage(popPage(stack))).toEqual([]);
  });

  it("切换助手清空栈，保留栈例外保留历史", () => {
    const stack: PanelPage[] = [{ kind: "jobs" }];
    expect(selectPanelStack(stack, "a", "b", false)).toEqual([]);
    expect(selectPanelStack(stack, "a", "b", true)).toEqual(stack);
    expect(selectPanelStack(stack, "a", "a", false)).toEqual(stack);
  });

  it("创建定时后替换顶页", () => {
    expect(replacePage([{ kind: "assistant" }, { kind: "newRoutine" }], { kind: "routine", id: "r" }))
      .toEqual([{ kind: "assistant" }, { kind: "routine", id: "r" }]);
  });

  it("只移除消失的实时预览", () => {
    const stack: PanelPage[] = [{ kind: "file", path: "", full: false, liveId: "gone" }, { kind: "file", path: "", full: false, liveId: "here" }];
    expect(removeMissingLivePages(stack, { here: {} })).toEqual([stack[1]]);
  });
});
