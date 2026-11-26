import { describe, expect, it } from "vitest";
import type { DesktopScreen } from "../../shared/types.ts";
import { DesktopWakeTracker } from "../src/desktop-wake.ts";

const screen = (running: boolean, id = "a"): DesktopScreen => ({ id, running, browserRunning: running, viewers: 0, lastActiveAt: null });
/** 用户正开着 a 这个助手的对话，右栏没展开 */
const see = (
  tracker: DesktopWakeTracker,
  activeHere: boolean,
  options: { running?: boolean; eligible?: boolean; collapsed?: boolean; nowWide?: boolean; sessionKey?: string } = {},
) => {
  const running = options.running ?? activeHere;
  return tracker.observe(
    [screen(running)],
    ["a"],
    activeHere ? ["a"] : [],
    options.eligible ?? true,
    options.collapsed ?? false,
    options.nowWide ?? false,
    options.sessionKey ?? "a:a",
  );
};

describe("云桌面唤醒时自动展开右栏", () => {
  it("本会话从未使用变成使用才算唤醒；页面打开时本来就在使用的不算", () => {
    const opened = new DesktopWakeTracker();
    expect(see(opened, true)).toBeUndefined();
    expect(see(opened, true)).toBeUndefined();

    const woken = new DesktopWakeTracker();
    expect(see(woken, false)).toBeUndefined();
    expect(see(woken, true, { collapsed: true })).toBe("expand");
  });

  it("这块屏幕还没建过（列表里没有它）之后第一次被本会话启动也算唤醒", () => {
    const tracker = new DesktopWakeTracker();
    expect(tracker.observe([screen(false, "other")], ["a"], [], true, false, false, "a:a")).toBeUndefined();
    expect(tracker.observe([screen(false, "other"), screen(true)], ["a"], ["a"], true, false, false, "a:a")).toBe("expand");
  });

  it("屏幕原本就开着（闲置），被本会话占用时也会自动展开；释放时收回", () => {
    const tracker = new DesktopWakeTracker();
    expect(see(tracker, false, { running: true })).toBeUndefined();
    expect(see(tracker, true, { running: true })).toBe("expand");
    expect(see(tracker, true, { running: true, nowWide: true })).toBeUndefined();
    // 即使屏幕进程还保持 running=true，只要本会话释放了占用就收回自动展开
    expect(see(tracker, false, { running: true, nowWide: true })).toBe("restore");
  });

  it("屏幕被别处唤醒时，当前会话不自动展开", () => {
    const tracker = new DesktopWakeTracker();
    expect(see(tracker, false, { running: false })).toBeUndefined();
    expect(see(tracker, false, { running: true })).toBeUndefined();
  });

  it("自动展开后用户收起，这一次占用不再弹；释放后再占用又弹", () => {
    const tracker = new DesktopWakeTracker();
    see(tracker, false);
    expect(see(tracker, true)).toBe("expand");
    expect(see(tracker, true, { nowWide: true })).toBeUndefined();
    expect(see(tracker, true, { nowWide: false })).toBeUndefined();
    expect(see(tracker, true, { collapsed: true })).toBeUndefined();
    // 用户已经自己收起过，后来又自己展开：释放时不替他改
    expect(see(tracker, false, { nowWide: true })).toBeUndefined();
    expect(see(tracker, true)).toBe("expand");
  });

  it("自动展开的那一次，停止使用时跟着收回", () => {
    const tracker = new DesktopWakeTracker();
    see(tracker, false);
    expect(see(tracker, true)).toBe("expand");
    expect(see(tracker, true, { nowWide: true })).toBeUndefined();
    expect(see(tracker, false, { nowWide: true })).toBe("restore");
  });

  it("连不上云桌面（空列表）不算停，重连以后也不算唤醒", () => {
    const tracker = new DesktopWakeTracker();
    expect(see(tracker, true)).toBeUndefined();
    expect(tracker.observe([], ["a"], [], true, false, false, "a:a")).toBeUndefined();
    expect(see(tracker, true)).toBeUndefined();
  });

  it("当时在看别的对话、窄屏、右栏卸载期间唤醒的，都不弹，回来也不补弹", () => {
    const elsewhere = new DesktopWakeTracker();
    see(elsewhere, false, { eligible: false });
    expect(see(elsewhere, true, { eligible: false })).toBeUndefined();
    expect(see(elsewhere, true)).toBeUndefined();

    const other = new DesktopWakeTracker();
    other.observe([screen(false)], ["b"], [], true, false, false, "a:b");
    expect(other.observe([screen(true)], ["b"], ["b"], true, false, false, "a:b")).toBeUndefined();
    expect(other.observe([screen(true)], ["a"], ["a"], true, false, false, "a:a")).toBeUndefined();

    // 同一个群内从空闲话题切到已占用话题也不补弹
    const switchTopic = new DesktopWakeTracker();
    see(switchTopic, false, { running: true, sessionKey: "g:t1" });
    expect(see(switchTopic, true, { running: true, sessionKey: "g:t2" })).toBeUndefined();

    const unmounted = new DesktopWakeTracker();
    see(unmounted, false);
    unmounted.unwatch();
    expect(see(unmounted, true)).toBeUndefined();
  });

  it("本来就展开着的不用再展开", () => {
    const tracker = new DesktopWakeTracker();
    see(tracker, false, { nowWide: true });
    expect(see(tracker, true, { nowWide: true })).toBeUndefined();
  });
});
