import { describe, expect, it } from "vitest";
import { detectGroupControl } from "../src/group-control.ts";

describe("识别群队列控制", () => {
  it.each(["先暂停一下！", "暂停吧", "暂停", "先停", "停一下", "停下", "停一停", "停住", "停吧", "先别说了。", "别说", "打住…", " Pause! ", "STOP.", "hold on", "wait", "Wait a sec~"])("%s 暂停", (text) => {
    expect(detectGroupControl(text)).toBe("pause");
  });

  it.each(["继续", "继续吧！", "继续呀", "接着来", "接着说吧", "接着走", "接着继续", "恢复", "恢复吧", "往下走。", "RESUME!", "continue", "go on", "proceed..."])("%s 继续", (text) => {
    expect(detectGroupControl(text)).toBe("resume");
  });

  it.each(["", "  ", "暂停一下，帮我改个bug", "为什么要暂停？", "暂停？", "继续查一下日志", "@开发 暂停", "继续 @dev", "stop?", "please hold on", "continue reading", "wait a second", "先停\n继续", `暂停${"！".repeat(29)}`])("%s 按普通消息处理", (text) => {
    expect(detectGroupControl(text)).toBeNull();
  });
});
