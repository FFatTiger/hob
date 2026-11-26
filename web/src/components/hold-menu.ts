// 列表行 / 头像的右键与触屏长按菜单手势 + 浮层定位：助手菜单和话题菜单共用。
import { useEffect, useLayoutEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

/** 长按多久算“长按”。 */
const HOLD_MS = 500;
/** 按住之后移动超过这么多像素就算在滚动，不弹菜单。 */
const MOVE_MAX = 10;

export interface HoldMenuHandlers {
  onContextMenu: (e: ReactMouseEvent) => void;
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
}

/**
 * 挂在列表行或头像上：桌面右键或触屏长按触发菜单。
 * 长按弹出后还会跟一次 click，takeHeld 让那个 click 不算数（不然会顺手打开对话）。
 */
export function useHoldMenu(onOpen: (x: number, y: number) => void, enabled = true): {
  handlers: HoldMenuHandlers;
  takeHeld: () => boolean;
} {
  const timer = useRef<number | null>(null);
  const from = useRef<{ x: number; y: number } | null>(null);
  const held = useRef(false);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  const stop = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    from.current = null;
  };

  useEffect(() => {
    if (!enabled) stop();
    return stop;
  }, [enabled]);

  const handlers: HoldMenuHandlers = {
    onContextMenu(e) {
      if (!enabled) return;
      e.preventDefault();
      stop();
      openRef.current(e.clientX, e.clientY);
    },
    onPointerDown(e) {
      if (!enabled || e.pointerType !== "touch") return;
      stop();
      held.current = false;
      from.current = { x: e.clientX, y: e.clientY };
      timer.current = window.setTimeout(() => {
        timer.current = null;
        const p = from.current;
        if (!p) return;
        held.current = true;
        // 有的浏览器长按不补 click，过了这段时间就别再拦点击了
        window.setTimeout(() => (held.current = false), 1000);
        openRef.current(p.x, p.y);
      }, HOLD_MS);
    },
    onPointerMove(e) {
      const p = from.current;
      if (!p) return;
      if (Math.abs(e.clientX - p.x) > MOVE_MAX || Math.abs(e.clientY - p.y) > MOVE_MAX) stop();
    },
    onPointerUp: stop,
    onPointerCancel: stop,
  };

  return {
    handlers,
    takeHeld() {
      if (!held.current) return false;
      held.current = false;
      return true;
    },
  };
}

/**
 * 按指针坐标弹出的 .amenu 浮层：贴着视口边收进屏幕内，点外部 / Esc / 外部滚动时关闭。
 */
export function useContextBox(pos: { x: number; y: number } | null, onClose: () => void) {
  const box = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    if (!pos || !box.current) return;
    const rect = box.current.getBoundingClientRect();
    const w = rect.width || 160;
    const h = rect.height || 44;
    const left = Math.max(8, Math.min(pos.x, window.innerWidth - w - 8));
    const top = Math.max(8, Math.min(pos.y, window.innerHeight - h - 8));
    box.current.style.left = `${left}px`;
    box.current.style.top = `${top}px`;
    box.current.style.transformOrigin = `${pos.x - left}px ${pos.y - top}px`;
  }, [pos]);

  useEffect(() => {
    if (!pos) return;
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      }
    };
    const onScroll = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) closeRef.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [pos]);

  return box;
}
