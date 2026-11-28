// 全局共享的 60fps 宠物物理调度器与单一鼠标指针分发器：
// 页面同时展示多个活体宠物（首页/置顶/顶栏/右栏）时，整个页面只维护 1 个 rAF 与 1 个 window pointermove 监听，
// 零多余开销，且切后台时统一自动暂停省电。

type FrameListener = (now: number) => void;
type PointerListener = (clientX: number, clientY: number) => void;

const frameListeners = new Set<FrameListener>();
const pointerListeners = new Set<PointerListener>();

let rafId = 0;
let pointerBound = false;
let visBound = false;
let pageVisible = typeof document === "undefined" ? true : document.visibilityState !== "hidden";

function step(now: number) {
  rafId = 0;
  if (!pageVisible || frameListeners.size === 0) return;
  for (const fn of frameListeners) fn(now);
  if (pageVisible && frameListeners.size > 0) {
    rafId = requestAnimationFrame(step);
  }
}

function ensureRunning() {
  if (typeof window === "undefined") return;
  if (!visBound) {
    visBound = true;
    document.addEventListener("visibilitychange", () => {
      pageVisible = document.visibilityState !== "hidden";
      if (pageVisible && frameListeners.size > 0 && !rafId) {
        rafId = requestAnimationFrame(step);
      }
    });
  }
  if (pageVisible && frameListeners.size > 0 && !rafId) {
    rafId = requestAnimationFrame(step);
  }
}

export function subscribePetFrame(fn: FrameListener): () => void {
  frameListeners.add(fn);
  ensureRunning();
  return () => {
    frameListeners.delete(fn);
    if (frameListeners.size === 0 && rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };
}

function onWindowPointerMove(ev: PointerEvent) {
  for (const fn of pointerListeners) fn(ev.clientX, ev.clientY);
}

export function subscribePetPointer(fn: PointerListener): () => void {
  pointerListeners.add(fn);
  if (typeof window !== "undefined" && !pointerBound) {
    pointerBound = true;
    window.addEventListener("pointermove", onWindowPointerMove, { passive: true });
  }
  return () => {
    pointerListeners.delete(fn);
    if (pointerListeners.size === 0 && pointerBound && typeof window !== "undefined") {
      pointerBound = false;
      window.removeEventListener("pointermove", onWindowPointerMove);
    }
  };
}
