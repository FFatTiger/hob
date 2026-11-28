import { describe, expect, it } from "vitest";
import { resolveDesktopShortcut, type ShortcutContext, type ShortcutEventLike } from "../src/shortcuts.ts";

const baseEvent: ShortcutEventLike = {
  key: "",
  code: "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
};

const baseCtx: ShortcutContext = {
  inChat: true,
  inEditable: false,
  hasModal: false,
};

describe("桌面全局快捷键解析", () => {
  it("支持 macOS Option+数字（物理键码 Digit1~Digit9）与普通 Alt+数字切换置顶对话", () => {
    // macOS Option+1 产生 key="¡" 但 code="Digit1"
    expect(
      resolveDesktopShortcut({ ...baseEvent, altKey: true, key: "¡", code: "Digit1" }, baseCtx),
    ).toEqual({ kind: "pin", index: 0 });
    expect(
      resolveDesktopShortcut({ ...baseEvent, altKey: true, key: "9", code: "Digit9" }, baseCtx),
    ).toEqual({ kind: "pin", index: 8 });
    // Digit0 不触发
    expect(
      resolveDesktopShortcut({ ...baseEvent, altKey: true, key: "0", code: "Digit0" }, baseCtx),
    ).toBeNull();
    // 输入框内不劫持 Alt+数字
    expect(
      resolveDesktopShortcut({ ...baseEvent, altKey: true, key: "¡", code: "Digit1" }, { ...baseCtx, inEditable: true }),
    ).toBeNull();
  });

  it("支持 ⌘\\ / Ctrl+\\、⌘. / Ctrl+. 与 ⇧⌘H / Ctrl+Shift+H", () => {
    expect(resolveDesktopShortcut({ ...baseEvent, metaKey: true, key: "\\", code: "Backslash" }, baseCtx)).toEqual({ kind: "toggle-side" });
    expect(resolveDesktopShortcut({ ...baseEvent, ctrlKey: true, key: ".", code: "Period" }, baseCtx)).toEqual({ kind: "toggle-panel" });
    expect(resolveDesktopShortcut({ ...baseEvent, metaKey: true, shiftKey: true, key: "H", code: "KeyH" }, { ...baseCtx, inChat: false })).toEqual({ kind: "go-home" });
    // 不在对话页时不触发左右栏切换
    expect(resolveDesktopShortcut({ ...baseEvent, metaKey: true, key: "\\", code: "Backslash" }, { ...baseCtx, inChat: false })).toBeNull();
    expect(resolveDesktopShortcut({ ...baseEvent, metaKey: true, key: ".", code: "Period" }, { ...baseCtx, inChat: false })).toBeNull();
  });

  it("弹窗打开、输入法组合态或事件已阻止时全部跳过", () => {
    expect(resolveDesktopShortcut({ ...baseEvent, metaKey: true, shiftKey: true, key: "H", code: "KeyH" }, { ...baseCtx, hasModal: true })).toBeNull();
    expect(resolveDesktopShortcut({ ...baseEvent, metaKey: true, key: "\\", code: "Backslash", isComposing: true }, baseCtx)).toBeNull();
    expect(resolveDesktopShortcut({ ...baseEvent, metaKey: true, key: "\\", code: "Backslash", keyCode: 229 }, baseCtx)).toBeNull();
    expect(resolveDesktopShortcut({ ...baseEvent, metaKey: true, key: ".", code: "Period", defaultPrevented: true }, baseCtx)).toBeNull();
  });

  it("命令面板打开时快捷键不触发", () => {
    // 命令面板以 aria-modal="true" 弹窗打开时 hasModal 为 true，所有全局快捷键均应跳过
    const modalCtx: ShortcutContext = { ...baseCtx, hasModal: true };
    expect(resolveDesktopShortcut({ ...baseEvent, metaKey: true, key: "\\", code: "Backslash" }, modalCtx)).toBeNull();
    expect(resolveDesktopShortcut({ ...baseEvent, metaKey: true, key: ".", code: "Period" }, modalCtx)).toBeNull();
    expect(resolveDesktopShortcut({ ...baseEvent, metaKey: true, shiftKey: true, key: "H", code: "KeyH" }, modalCtx)).toBeNull();
    expect(resolveDesktopShortcut({ ...baseEvent, altKey: true, key: "1", code: "Digit1" }, modalCtx)).toBeNull();
  });
});
