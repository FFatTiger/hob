import { useEffect, useRef, useState } from "react";
import { clamp, type PetStateId } from "../../../shared/pet.ts";

let measureCtx: CanvasRenderingContext2D | null = null;

function measureLinePx(str: string, font?: string): number {
  if (font && typeof document !== "undefined") {
    try {
      if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
      if (measureCtx) {
        measureCtx.font = font;
        return measureCtx.measureText(str).width;
      }
    } catch {
      // jsdom 等无 canvas 2d 环境回退到字符宽估算
    }
  }
  let px = 0;
  for (const ch of str) {
    px += ch.codePointAt(0)! > 0x2e7f ? 15.5 : 8.5;
  }
  return px;
}

/** 根据当前输入行内容、光标位置与输入框实际宽度，推算宠物低头追看光标的 3D 球面视线 [turnDeg, gazeY]。 */
export function typingLook(
  text: string,
  caret?: number,
  boxWidthPx = 460,
  font?: string,
): readonly [number, number] {
  const upto = caret === undefined ? text : text.slice(0, Math.max(0, caret));
  const line = upto.slice(upto.lastIndexOf("\n") + 1);
  const usableW = Math.max(160, boxWidthPx);
  const linePx = measureLinePx(line, font);
  const colPx = linePx === 0 ? 0 : linePx % usableW;
  const ratio = clamp(colPx / usableW, 0, 1);
  const turn = -32 + ratio * 64;
  // 贴合球面下弧：正下方最深 (+36)，两侧略收 (+31)，真实感强且不贴边
  const gazeY = 36 - Math.abs(ratio - 0.5) * 10;
  return [turn, gazeY] as const;
}

export interface HomeMoodInput {
  waitingCount: number;
  liveCount: number;
  typing: boolean;
  idleAsleep: boolean;
}

/** 首页大球情绪推导：输入倾听 > 等你确认好奇 > 任务思考 > 久置/深夜静置打盹 > 待机。 */
export function deriveHomeMood(input: HomeMoodInput): PetStateId {
  if (input.typing) return "listening";
  if (input.waitingCount > 0) return "curious";
  if (input.liveCount > 0) return "thinking";
  if (input.idleAsleep) return "sleeping";
  return "idle";
}

export interface ChatMoodInput {
  thinking: boolean;
  busy: boolean;
  hasPendingAsk: boolean;
  hasError: boolean;
  typing: boolean;
  justFinished: boolean;
}

/** 对话态情绪推导：报错委屈 > 思考中 > 刚回复完成开心 > 等你确认好奇 > 正在输入倾听 > 待机。 */
export function deriveChatMood(input: ChatMoodInput): PetStateId {
  if (input.hasError) return "sad";
  if (input.thinking || input.busy) return "thinking";
  if (input.justFinished) return "happy";
  if (input.hasPendingAsk) return "curious";
  if (input.typing) return "listening";
  return "idle";
}

/** 输入文字时短时点亮倾听状态，停笔 delayMs 后自然回正。 */
export function useTypingPulse(text: string, delayMs = 2000): boolean {
  const [active, setActive] = useState(false);
  const prev = useRef(text);

  useEffect(() => {
    if (text === prev.current) return;
    prev.current = text;
    if (!text.trim()) {
      setActive(false);
      return;
    }
    setActive(true);
    const timer = window.setTimeout(() => setActive(false), delayMs);
    return () => window.clearTimeout(timer);
  }, [text, delayMs]);

  return active;
}

/** 同一个对话从忙碌切回空闲的瞬间，返回持续 durationMs 的庆祝窗口与递增序号。 */
export function useJustFinished(active: boolean, scopeKey: string, durationMs = 1900): { justFinished: boolean; seq: number } {
  const [state, setState] = useState({ justFinished: false, seq: 0 });
  const prev = useRef({ active, scopeKey });

  useEffect(() => {
    const was = prev.current;
    prev.current = { active, scopeKey };
    if (was.scopeKey !== scopeKey) {
      setState((s) => (s.justFinished ? { ...s, justFinished: false } : s));
      return;
    }
    if (was.active && !active) {
      setState((s) => ({ justFinished: true, seq: s.seq + 1 }));
      const timer = window.setTimeout(() => {
        setState((s) => (s.justFinished ? { ...s, justFinished: false } : s));
      }, durationMs);
      return () => window.clearTimeout(timer);
    }
    if (active) {
      setState((s) => (s.justFinished ? { ...s, justFinished: false } : s));
    }
  }, [active, scopeKey, durationMs]);

  return state;
}

/** 首页无待办且长时间无交互时自然打盹；深夜首次打开先轻睡，一有鼠标或键盘动静立刻惊醒并保持活跃。 */
export function useIdleSleep(enabled: boolean, delayMs = 60000, initialAsleep = false): boolean {
  const [asleep, setAsleep] = useState(enabled && initialAsleep);

  useEffect(() => {
    if (!enabled) {
      setAsleep(false);
      return;
    }
    let timer = 0;
    const arm = () => {
      setAsleep(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setAsleep(true), delayMs);
    };
    if (!initialAsleep) {
      arm();
    }
    const onWake = () => arm();
    window.addEventListener("pointerdown", onWake, { passive: true });
    window.addEventListener("pointermove", onWake, { passive: true });
    window.addEventListener("keydown", onWake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", onWake);
      window.removeEventListener("pointermove", onWake);
      window.removeEventListener("keydown", onWake);
    };
  }, [enabled, delayMs, initialAsleep]);

  return asleep;
}
