// 置顶头像按住拖动换位置：鼠标和触摸走同一套指针事件，松手后按新先后保存。
// 换位置的算法在 ../pin-drag.ts，这里只管指针、拖动中的预览和落盘。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import type { AssistantSummary } from "../../../shared/types.ts";
import { reorderAt, type Box } from "../pin-drag.ts";
import { closeAssistantMenu, savePinOrder, useApp } from "../store.ts";

/** 按住后移动超过这么多像素才算在拖：点一下照旧打开对话，长按照旧弹菜单。 */
const SLOP = 6;

export interface PinHandlers {
  onPointerDown: (e: ReactPointerEvent) => void;
}

/** 一个置顶头像要接的东西：指针事件挂在头像上，抬起时的点击不算数。 */
export interface PinDragTarget {
  handlers: PinHandlers;
  takeMoved: () => boolean;
}

export interface PinDrag {
  /** 包住头像那一层：从这里往下找带 data-pin 的头像格子 */
  grid: RefObject<HTMLDivElement | null>;
  /** 这一排是不是不让拖（搜索时只显示筛出来的几位，这时候排位置会把别的助手的挤掉） */
  locked: boolean;
  /** 拖动中的先后；没在拖就是传进来的先后 */
  order: AssistantSummary[];
  /** 正拖着的那一个助手 */
  lifted: string | null;
  /** 每个头像接的指针事件 */
  target: (id: string) => PinDragTarget;
  /** 包住头像那一层的类名：抬起的那一格加 lift，跟着指针走 */
  className: (id: string) => string | undefined;
}

interface Press {
  id: string;
  pointerId: number;
  /** 按下时的指针位置 */
  from: { x: number; y: number };
  /** 手指落在头像里的位置，拖动时这一块始终对着手指 */
  grab: { x: number; y: number };
  active: boolean;
}

/**
 * 量一格的位置。跟着指针走的那一格要先把它自己的位移拿掉再量，不然量到的是已经平移过的地方。
 */
function measure(el: HTMLElement, plain = false): Box {
  const keep = el.style.transform;
  if (plain) el.style.transform = "none";
  const r = el.getBoundingClientRect();
  if (plain) el.style.transform = keep;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

export function usePinDrag(pins: AssistantSummary[], locked = false): PinDrag {
  const menuOpen = useApp().menu !== null;
  const grid = useRef<HTMLDivElement | null>(null);
  /** 拖动中的先后（只存 id）；松手就清掉，跟着保存后的先后走 */
  const [orderIds, setOrderIds] = useState<string[] | null>(null);
  const [press, setPress] = useState<Press | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  /** 这次按下有没有真拖过：拖过就跟一次点击，别顺手打开对话 */
  const moved = useRef(false);

  const order = useMemo(() => {
    if (!orderIds) return pins;
    const byId = new Map(pins.map((a) => [a.id, a]));
    const out = orderIds.map((id) => byId.get(id)).filter((a): a is AssistantSummary => Boolean(a));
    // 拖动的同时别处加减了置顶：新来的接在后面
    for (const a of pins) if (!orderIds.includes(a.id)) out.push(a);
    return out;
  }, [orderIds, pins]);

  /** 每一格现在的位置：只认当前先后里的那几个，离场动画里的行不算。抬起的那一格按没位移的位置算。 */
  const boxes = (ids: string[]): Box[] => {
    const root = grid.current;
    if (!root) return [];
    return [...root.querySelectorAll<HTMLElement>("[data-pin]")]
      .filter((el) => ids.includes(el.dataset.pin ?? ""))
      .map((el) => measure(el, press?.id === el.dataset.pin));
  };

  useEffect(() => {
    if (!press) return;
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== press.pointerId) return;
      if (!press.active) {
        if (Math.abs(e.clientX - press.from.x) <= SLOP && Math.abs(e.clientY - press.from.y) <= SLOP) return;
        // 开始拖了：长按菜单让位
        closeAssistantMenu();
        moved.current = true;
        setPress({ ...press, active: true });
      }
      setPos({ x: e.clientX, y: e.clientY });
      const ids = orderIds ?? pins.map((a) => a.id);
      const next = reorderAt(ids, boxes(ids), press.id, e.clientX, e.clientY);
      if (next !== ids) setOrderIds(next);
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== press.pointerId) return;
      const ids = orderIds ?? pins.map((a) => a.id);
      const dropped = press.active;
      setPress(null);
      setPos(null);
      setOrderIds(null);
      if (dropped) void savePinOrder(ids);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [press, orderIds, pins]);

  // 抬起的那一格跟着指针：量它现在这一格的布局位置，再平移到手指下的位置。
  useLayoutEffect(() => {
    if (!press) return;
    const root = grid.current;
    const el = [...(root?.querySelectorAll<HTMLElement>("[data-pin]") ?? [])].find((x) => x.dataset.pin === press.id);
    if (!el) return;
    if (!press.active || !pos) {
      el.style.transform = "";
      return;
    }
    const r = measure(el, true);
    el.style.transform = `translate(${pos.x - press.grab.x - r.left}px, ${pos.y - press.grab.y - r.top}px)`;
    return () => {
      el.style.transform = "";
    };
  }, [press, pos, order]);

  const target = (id: string): PinDragTarget => ({
    handlers: {
      onPointerDown(e) {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        // 菜单开着：这一下算点别处关菜单，不接拖动；搜索时这一排是筛出来的几位，也不接
        if (menuOpen || locked) return;
        const el = [...(grid.current?.querySelectorAll<HTMLElement>("[data-pin]") ?? [])].find((x) => x.dataset.pin === id);
        if (!el) return;
        const r = el.getBoundingClientRect();
        moved.current = false;
        setPress({
          id,
          pointerId: e.pointerId,
          from: { x: e.clientX, y: e.clientY },
          grab: { x: e.clientX - r.left, y: e.clientY - r.top },
          active: false,
        });
        setPos({ x: e.clientX, y: e.clientY });
      },
    },
    takeMoved() {
      const was = moved.current;
      moved.current = false;
      return was;
    },
  });

  return {
    grid,
    locked,
    order,
    lifted: press?.active ? press.id : null,
    target,
    className: (id) => (press?.active && press.id === id ? "lift" : undefined),
  };
}
