// GrokBot 极简果冻宠物双模渲染器：
// - StaticPet：列表小头像与 5×4 选择器缩略图，纯预计算 SVG 路径，零 RAF。
// - LivePet：全功能 60fps 阻尼弹簧物理宠物（48 点身形/表情 Morph、球面 3D 眼神跟随、自动眨眼与自然微瞥、
//   点击戳一戳 > < 回弹、拖拽惊讶拉扯回弹、双击随机触发 6 种果冻动作），共用全局单一 rAF 与指针监听。
//
// Attribution: Adapted from zhulin025/LaoA-GrokBot (https://github.com/zhulin025/LaoA-GrokBot),
// licensed under the MIT License.
import { useEffect, useId, useRef, type RefObject } from "react";
import {
  PET_EXPRESSIONS,
  PET_SHAPES,
  PET_STATES,
  Spring,
  clamp,
  rgba,
  ringToPath,
  smoothRing,
  type PetActionId,
  type PetExpressionId,
  type PetShapeId,
  type PetStateId,
  type Point2,
} from "../../../shared/pet.ts";
import { subscribePetFrame, subscribePetPointer } from "./pet-ticker.ts";

const AMBIENT_DRAMAS: readonly PetExpressionId[] = ["wink", "curious", "happy"];

interface ExprSnapshot {
  left: Point2[];
  right: Point2[];
  gap: number;
  offsetY: number;
}

function cloneExpr(key: PetExpressionId): ExprSnapshot {
  const e = PET_EXPRESSIONS[key];
  return {
    left: e.left.map((p) => [p[0], p[1]]),
    right: e.right.map((p) => [p[0], p[1]]),
    gap: e.gap,
    offsetY: e.offsetY,
  };
}

/** 计算静态帧下双眼坐标与路径（支持球面 3D 视线偏移），同时用于 StaticPet 与 LivePet 的 SSR 首帧。 */
function staticEyeTransforms(
  shapeKey: PetShapeId,
  exprKey: PetExpressionId,
  look: readonly [number, number] = [0, 0],
) {
  const shape = PET_SHAPES[shapeKey];
  const expr = PET_EXPRESSIONS[exprKey];
  const scale = shape.eye.scale;
  const [turn, gazeY] = look;
  const rad = (turn * Math.PI) / 180;
  const sphereR = 104;
  const ey = 114.5 + (expr.offsetY + gazeY) * scale + shape.eye.shiftY;
  const project = (side: -1 | 1) => {
    const baseLon = Math.asin(clamp((side * expr.gap * scale) / sphereR, -0.68, 0.68));
    const lon = baseLon + rad;
    const depth = Math.cos(lon);
    const perspective = clamp(depth / Math.max(Math.cos(baseLon), 0.1), 0.14, 1.32);
    const ex = 114.5 + sphereR * Math.sin(lon);
    return `translate(${ex.toFixed(2)} ${ey.toFixed(2)}) scale(${(perspective * scale).toFixed(3)} ${scale.toFixed(3)})`;
  };
  return {
    leftD: expr.leftD,
    rightD: expr.rightD,
    leftT: project(-1),
    rightT: project(1),
  };
}

export function StaticPet({
  shape,
  body,
  eye,
  isDarkBody,
  expression = "neutral",
  defaultLook,
}: {
  shape: PetShapeId;
  body: string;
  eye: string;
  isDarkBody: boolean;
  expression?: PetExpressionId;
  defaultLook?: readonly [number, number];
}) {
  const spec = PET_SHAPES[shape];
  const eyes = staticEyeTransforms(shape, expression, defaultLook);
  return (
    <svg
      className={`pet-svg pet-static${isDarkBody ? " pet-obsidian" : ""}`}
      viewBox="-14 -14 257 257"
      aria-hidden="true"
    >
      <path className="pet-body" d={spec.pathD} fill={body} />
      <g className="pet-eyes">
        <path d={eyes.leftD} fill={eye} transform={eyes.leftT} />
        <path d={eyes.rightD} fill={eye} transform={eyes.rightT} />
      </g>
    </svg>
  );
}

export function LivePet({
  shape,
  body,
  eye,
  glow,
  isDarkBody,
  state = "idle",
  interactive = false,
  draggable = true,
  follow = true,
  followZone,
  defaultLook,
  focusLook,
  glowEnabled = false,
  morphBounce = false,
  ambient = false,
  action,
  actionSeq = 0,
}: {
  shape: PetShapeId;
  body: string;
  eye: string;
  glow: string;
  isDarkBody: boolean;
  state?: PetStateId;
  /** 允许点击戳一戳（连戳分阶段情绪反馈）与双击果冻动作 */
  interactive?: boolean;
  /** interactive 时是否允许拖拽拉扯（列表置顶位需留给排序手势，设为 false） */
  draggable?: boolean;
  /** 是否开启 3D 球面鼠标视线跟随 */
  follow?: boolean;
  /** 限定鼠标跟随的触发区域（如列表行框），鼠标在框内时跟随，移出后回正到默认视线 */
  followZone?: RefObject<HTMLElement | null>;
  /** 待机默认视线偏置 [turnDeg, gazeY]，例如 [11, -7] 表示默认向右上方瞟 */
  defaultLook?: readonly [number, number];
  /** 主动注视目标 [turnDeg, gazeY]（如低头追看输入框打字），覆盖鼠标滞留与默认状态视线 */
  focusLook?: readonly [number, number];
  /** 是否开启情绪光晕 */
  glowEnabled?: boolean;
  /** 切换造型或颜色时自动播放 Q 弹 Morph 回弹 */
  morphBounce?: boolean;
  /** 开启主球低频空闲微剧场与轻抚手势（仅用于首页/关于页大球） */
  ambient?: boolean;
  action?: PetActionId;
  actionSeq?: number;
}) {
  const uid = useId().replace(/:/g, "");
  const haloGradId = `pet-halo-${uid}`;
  const clipId = `pet-clip-${uid}`;

  // 用 HTML div 承载指针事件，避免内联 SVG 子路径和 IntersectionObserver 兼容性问题
  const hostRef = useRef<HTMLDivElement>(null);
  const rigRef = useRef<SVGGElement>(null);
  const haloRef = useRef<SVGCircleElement>(null);
  const bodyRef = useRef<SVGPathElement>(null);
  const clipRef = useRef<SVGPathElement>(null);
  const eye0Ref = useRef<SVGPathElement>(null);
  const eye1Ref = useRef<SVGPathElement>(null);

  const followZoneRef = useRef(followZone);
  followZoneRef.current = followZone;
  const defaultTurn = defaultLook?.[0] ?? 0;
  const defaultGazeY = defaultLook?.[1] ?? 0;
  const focusTurn = focusLook?.[0] ?? null;
  const focusGazeY = focusLook?.[1] ?? null;

  const engineRef = useRef<{
    shapeKey: PetShapeId;
    stateKey: PetStateId;
    exprKey: PetExpressionId;
    follow: boolean;
    interactive: boolean;
    draggable: boolean;
    glowEnabled: boolean;
    ambient: boolean;
    defaultTurn: number;
    defaultGazeY: number;
    focusTurn: number | null;
    focusGazeY: number | null;
    exprFrom: ExprSnapshot;
    exprTo: ExprSnapshot;
    exprMorph: Spring;
    flashTimer: number | null;
    shapeFrom: Point2[];
    shapeTo: Point2[];
    shapeMorph: Spring;
    eyeScale: Spring;
    eyeShiftY: Spring;
    sx: Spring;
    sy: Spring;
    tx: Spring;
    ty: Spring;
    rot: Spring;
    turn: Spring;
    gazeY: Spring;
    targetTurn: number;
    targetGazeY: number;
    targetTilt: number;
    lastPointerAt: number;
    pointerInZone: boolean;
    idleGlanceTurn: number;
    idleGlanceY: number;
    nextGlanceAt: number;
    nextDramaAt: number;
    dramaCycle: number;
    nextFocusBeatAt: number;
    focusBeatCycle: number;
    dragging: boolean;
    dragMoved: boolean;
    dragSurprised: boolean;
    dragStartX: number;
    dragStartY: number;
    dragOffsetX: number;
    dragOffsetY: number;
    lastDragX: number;
    pokeStreak: number;
    pokeResetAt: number;
    rubLastX: number;
    rubDir: number;
    rubFlips: number;
    rubWindowStart: number;
    rubCooldownAt: number;
    actionCycle: number;
    suppressNextClick: boolean;
    blinkStart: number;
    nextBlinkAt: number;
    activeAction: PetActionId | null;
    actionStart: number;
    actionPhase: number;
    lastTime: number;
    phaseOffset: number;
  } | null>(null);

  if (!engineRef.current) {
    const initShape = PET_SHAPES[shape];
    const initCfg = PET_STATES[state];
    const initExpr = initCfg.expression;
    const initTurn = state === "idle" ? defaultTurn : initCfg.lookBias[0];
    const initGazeY = state === "idle" ? defaultGazeY : initCfg.lookBias[1];
    const now = typeof performance !== "undefined" ? performance.now() : 0;
    // 给每个实例错开呼吸与眨眼相位，多只同屏不会机械同步
    const phaseOffset = Math.random() * 5000;
    engineRef.current = {
      shapeKey: shape,
      stateKey: state,
      exprKey: initExpr,
      follow,
      interactive,
      draggable,
      glowEnabled,
      ambient,
      defaultTurn,
      defaultGazeY,
      focusTurn,
      focusGazeY,
      exprFrom: cloneExpr(initExpr),
      exprTo: cloneExpr(initExpr),
      exprMorph: new Spring(1, 240, 21, 0.78),
      flashTimer: null,
      shapeFrom: initShape.ring.map((p) => [p[0], p[1]]),
      shapeTo: initShape.ring.map((p) => [p[0], p[1]]),
      shapeMorph: new Spring(1, 210, 18, 0.85),
      eyeScale: new Spring(initShape.eye.scale, 200, 19, 0.85),
      eyeShiftY: new Spring(initShape.eye.shiftY, 200, 19, 0.85),
      sx: new Spring(1, 230, 14.5, 0.78),
      sy: new Spring(1, 230, 14.5, 0.78),
      tx: new Spring(0, 185, 14.5, 0.82),
      ty: new Spring(0, 185, 14.5, 0.82),
      rot: new Spring(0, 180, 15, 0.85),
      turn: new Spring(initTurn, 135, 16.5, 0.9),
      gazeY: new Spring(initGazeY, 135, 16.5, 0.9),
      targetTurn: 0,
      targetGazeY: 0,
      targetTilt: 0,
      lastPointerAt: 0,
      pointerInZone: false,
      idleGlanceTurn: 0,
      idleGlanceY: 0,
      nextGlanceAt: now + 1800 + Math.random() * 2800,
      nextDramaAt: now + 10000 + Math.random() * 8000,
      dramaCycle: Math.floor(Math.random() * AMBIENT_DRAMAS.length),
      nextFocusBeatAt: 0,
      focusBeatCycle: 0,
      dragging: false,
      dragMoved: false,
      dragSurprised: false,
      dragStartX: 0,
      dragStartY: 0,
      dragOffsetX: 0,
      dragOffsetY: 0,
      lastDragX: 0,
      pokeStreak: 0,
      pokeResetAt: 0,
      rubLastX: 0,
      rubDir: 0,
      rubFlips: 0,
      rubWindowStart: 0,
      rubCooldownAt: 0,
      actionCycle: 0,
      suppressNextClick: false,
      blinkStart: 0,
      nextBlinkAt: now + 1500 + Math.random() * 2600,
      activeAction: null,
      actionStart: 0,
      actionPhase: 0,
      lastTime: now,
      phaseOffset,
    };
  }

  const currentExpr = () => {
    const e = engineRef.current!;
    const t = clamp(e.exprMorph.x, 0, 1.08);
    return {
      left: e.exprFrom.left.map((p, i): Point2 => [
        p[0] + (e.exprTo.left[i][0] - p[0]) * t,
        p[1] + (e.exprTo.left[i][1] - p[1]) * t,
      ]),
      right: e.exprFrom.right.map((p, i): Point2 => [
        p[0] + (e.exprTo.right[i][0] - p[0]) * t,
        p[1] + (e.exprTo.right[i][1] - p[1]) * t,
      ]),
      gap: e.exprFrom.gap + (e.exprTo.gap - e.exprFrom.gap) * t,
      offsetY: e.exprFrom.offsetY + (e.exprTo.offsetY - e.exprFrom.offsetY) * t,
    };
  };

  const currentShapeRing = (): Point2[] => {
    const e = engineRef.current!;
    const t = clamp(e.shapeMorph.x, 0, 1.08);
    return e.shapeFrom.map((p, i): Point2 => [
      p[0] + (e.shapeTo[i][0] - p[0]) * t,
      p[1] + (e.shapeTo[i][1] - p[1]) * t,
    ]);
  };

  const setExpressionImmediate = (key: PetExpressionId) => {
    const e = engineRef.current!;
    e.exprFrom = currentExpr();
    e.exprTo = cloneExpr(key);
    e.exprKey = key;
    e.exprMorph.snap(0);
  };

  const flashExpression = (key: PetExpressionId, durationMs = 420) => {
    const e = engineRef.current!;
    if (e.flashTimer !== null) window.clearTimeout(e.flashTimer);
    setExpressionImmediate(key);
    e.flashTimer = window.setTimeout(() => {
      e.flashTimer = null;
      const baseKey = PET_STATES[e.stateKey].expression;
      if (!e.dragging) setExpressionImmediate(baseKey);
    }, durationMs);
  };

  const triggerAction = (act: PetActionId) => {
    const e = engineRef.current!;
    e.activeAction = act;
    e.actionStart = performance.now();
    e.actionPhase = 0;
    if (act === "bounce") {
      e.sx.impulse(2.2);
      e.sy.impulse(-2.2);
      e.ty.impulse(1.6);
      flashExpression("squeeze", 170);
    } else if (act === "shake") {
      e.rot.impulse(5.2);
      flashExpression("squeeze", 680);
    } else if (act === "peek") {
      flashExpression("curious", 1100);
    } else if (act === "pinch") {
      e.sx.impulse(-3.2);
      e.sy.impulse(3.0);
      flashExpression("squeeze", 700);
    } else if (act === "squish") {
      e.sx.impulse(3.6);
      e.sy.impulse(-3.6);
      e.ty.impulse(2.2);
      flashExpression("squeeze", 580);
    } else if (act === "celebrate") {
      e.sy.impulse(-2.4);
      e.sx.impulse(2.0);
      flashExpression("happy", 1250);
    }
  };

  const scheduleBlink = (now: number) => {
    const e = engineRef.current!;
    const cfg = PET_STATES[e.stateKey];
    if (!cfg.blink) {
      e.nextBlinkAt = Infinity;
      return;
    }
    const [min, max] = cfg.blink;
    e.nextBlinkAt = now + min + Math.random() * (max - min);
  };

  useEffect(() => {
    const e = engineRef.current!;
    e.follow = follow;
    e.interactive = interactive;
    e.draggable = draggable;
    e.glowEnabled = glowEnabled;
    e.ambient = ambient;
    e.defaultTurn = defaultTurn;
    e.defaultGazeY = defaultGazeY;
    const prevFocusTurn = e.focusTurn;
    e.focusTurn = focusTurn;
    e.focusGazeY = focusGazeY;
    // 追看打字光标移动时给一点极轻的点头弹性，像真的在跟着读你敲下的字
    if (
      focusTurn !== null &&
      prevFocusTurn !== null &&
      Math.abs(focusTurn - prevFocusTurn) >= 1.2 &&
      !e.dragging &&
      !e.activeAction
    ) {
      e.ty.impulse(0.95);
      e.sx.impulse(0.32);
      e.sy.impulse(-0.32);
    }
    if (!follow) {
      e.targetTurn = 0;
      e.targetGazeY = 0;
      e.targetTilt = 0;
      e.pointerInZone = false;
    }
  }, [follow, interactive, draggable, glowEnabled, ambient, defaultTurn, defaultGazeY, focusTurn, focusGazeY]);

  useEffect(() => {
    const zone = followZone?.current;
    if (!zone) return;
    const onLeave = () => {
      const e = engineRef.current;
      if (!e || e.dragging) return;
      e.pointerInZone = false;
      e.targetTurn = 0;
      e.targetGazeY = 0;
      e.targetTilt = 0;
    };
    zone.addEventListener("pointerleave", onLeave);
    return () => zone.removeEventListener("pointerleave", onLeave);
  }, [followZone]);

  useEffect(() => {
    const e = engineRef.current!;
    if (e.shapeKey === shape) return;
    e.shapeFrom = currentShapeRing();
    e.shapeTo = PET_SHAPES[shape].ring.map((p) => [p[0], p[1]]);
    e.shapeKey = shape;
    e.shapeMorph.snap(0);
    if (morphBounce) {
      e.sx.impulse(2.2);
      e.sy.impulse(-2.2);
      e.rot.impulse(PET_SHAPES[shape].tilt * 0.28);
    }
  }, [shape, morphBounce]);

  const prevBodyRef = useRef(body);
  useEffect(() => {
    if (prevBodyRef.current === body) return;
    prevBodyRef.current = body;
    if (morphBounce) {
      const e = engineRef.current!;
      e.sx.impulse(1.8);
      e.sy.impulse(-1.8);
    }
  }, [body, morphBounce]);

  useEffect(() => {
    const e = engineRef.current!;
    if (e.stateKey === state) return;
    const prevState = e.stateKey;
    if (e.flashTimer !== null) {
      window.clearTimeout(e.flashTimer);
      e.flashTimer = null;
    }
    e.stateKey = state;
    const cfg = PET_STATES[state];
    // 从休眠惊醒：短暂闪一下圆眼惊讶 + 轻弹，再落回目标表情
    if (prevState === "sleeping" && state !== "sleeping") {
      e.sx.impulse(-1.8);
      e.sy.impulse(2.1);
      flashExpression("surprised", 420);
    } else {
      setExpressionImmediate(cfg.expression);
    }
    scheduleBlink(performance.now());
    e.idleGlanceTurn = 0;
    e.idleGlanceY = 0;
    if (cfg.motion === "happy" || cfg.motion === "excited") {
      e.sy.impulse(-2.6);
      e.sx.impulse(2.0);
    } else if (cfg.motion === "pop") {
      e.sx.impulse(-2.4);
      e.sy.impulse(2.6);
    } else if (cfg.motion === "shy") {
      e.sx.impulse(1.5);
      e.sy.impulse(-1.3);
    }
  }, [state]);

  useEffect(() => {
    if (!action || !actionSeq) return;
    triggerAction(action);
  }, [action, actionSeq]);

  // 接入全局共享 60fps 调度器与单一鼠标指针分发器
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const e = engineRef.current!;
    let lastShapeKey: PetShapeId | null = e.shapeKey;
    let lastExprKey: PetExpressionId | null = e.exprKey;
    const reduced = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    e.lastTime = performance.now();

    const blinkScale = (now: number) => {
      if (!e.blinkStart) return 1;
      const t = (now - e.blinkStart) / 230;
      if (t >= 1) {
        e.blinkStart = 0;
        return 1;
      }
      return Math.max(t < 0.4 ? 1 - t / 0.4 : (t - 0.4) / 0.6, 0.06);
    };

    const onFrame = (now: number) => {
      const dt = Math.min(Math.max((now - e.lastTime) / 1000, 0.001), 0.05);
      e.lastTime = now;
      const phaseNow = now + e.phaseOffset;

      if (e.pointerInZone && !e.dragging && !followZoneRef.current?.current && now - e.lastPointerAt > 2200) {
        e.pointerInZone = false;
        e.targetTurn = 0;
        e.targetGazeY = 0;
        e.targetTilt = 0;
      }

      if (!reduced && now >= e.nextBlinkAt) {
        if (e.exprKey !== "happy" && e.exprKey !== "wink" && e.exprKey !== "sleeping" && e.exprKey !== "squeeze") {
          e.blinkStart = now;
        }
        scheduleBlink(now);
      }

      // 主球低频空闲微剧场：待机且无指针打扰时偶发 wink / 好奇 / 轻笑，随时让位于真实交互
      if (!reduced && e.ambient && now >= e.nextDramaAt) {
        if (e.stateKey === "idle" && !e.pointerInZone && !e.dragging && !e.activeAction && e.flashTimer === null) {
          const expr = AMBIENT_DRAMAS[e.dramaCycle % AMBIENT_DRAMAS.length];
          e.dramaCycle += 1;
          flashExpression(expr, expr === "wink" ? 1350 : 1850);
          if (expr === "curious") e.rot.impulse(3.2);
          else if (expr === "happy") e.ty.impulse(-1.6);
          else e.rot.impulse(-2.2);
        }
        e.nextDramaAt = now + 10000 + Math.random() * 8000;
      }

      // 专注看打字时的轻节拍动作：首次 1.8 秒、之后每 3.5 秒轮播轻跳好奇 / 软糯点头微笑 / 俏皮歪头眨眼
      if (!reduced && e.focusTurn !== null && e.focusGazeY !== null && !e.dragging && !e.activeAction) {
        if (!e.nextFocusBeatAt) e.nextFocusBeatAt = now + 1800;
        if (now >= e.nextFocusBeatAt && e.flashTimer === null) {
          const step = e.focusBeatCycle % 3;
          e.focusBeatCycle += 1;
          if (step === 0) {
            e.ty.impulse(-3.4);
            e.sx.impulse(-1.6);
            e.sy.impulse(2.0);
            e.rot.impulse(4.8);
            flashExpression("curious", 1150);
          } else if (step === 1) {
            e.sx.impulse(2.5);
            e.sy.impulse(-2.5);
            e.ty.impulse(2.4);
            flashExpression("happy", 1050);
          } else {
            e.rot.impulse(-5.2);
            e.sx.impulse(-1.4);
            e.sy.impulse(1.6);
            flashExpression("wink", 1150);
          }
          e.nextFocusBeatAt = now + 3500;
        }
      } else {
        e.nextFocusBeatAt = 0;
      }

      if (!reduced && now >= e.nextGlanceAt) {
        if (e.stateKey === "idle" && !e.pointerInZone && !e.activeAction) {
          const hasDefaultLook = e.defaultTurn !== 0 || e.defaultGazeY !== 0;
          if (Math.abs(e.idleGlanceTurn) > 1 || Math.random() < 0.35) {
            e.idleGlanceTurn = 0;
            e.idleGlanceY = 0;
          } else if (hasDefaultLook) {
            e.idleGlanceTurn = (Math.random() - 0.5) * 8;
            e.idleGlanceY = (Math.random() - 0.5) * 4;
          } else {
            e.idleGlanceTurn = (Math.random() - 0.5) * 14;
            e.idleGlanceY = (Math.random() - 0.5) * 6;
          }
        } else {
          e.idleGlanceTurn = 0;
          e.idleGlanceY = 0;
        }
        e.nextGlanceAt = now + 2600 + Math.random() * 3200;
      }

      const stateCfg = PET_STATES[e.stateKey];
      const biasTurn = e.stateKey === "idle" ? e.defaultTurn : stateCfg.lookBias[0];
      const biasY = e.stateKey === "idle" ? e.defaultGazeY : stateCfg.lookBias[1];

      let baseTx = e.dragOffsetX;
      let baseTy = e.dragOffsetY + (reduced ? 0 : Math.sin(phaseNow * 0.0024) * 3.4);
      let baseSx = 1 + (reduced ? 0 : Math.sin(phaseNow * 0.0024 + 0.7) * 0.016);
      let baseSy = 1 - (reduced ? 0 : Math.sin(phaseNow * 0.0024 + 0.7) * 0.016);
      if (e.dragging && !reduced) {
        const stretch = clamp((Math.abs(e.dragOffsetX) - Math.abs(e.dragOffsetY)) / 280, -0.14, 0.14);
        baseSx += stretch;
        baseSy -= stretch;
      }
      let baseRot = e.targetTilt;
      let extraTurn = e.pointerInZone ? 0 : biasTurn + e.idleGlanceTurn;
      let extraGazeY = e.pointerInZone ? 0 : biasY + e.idleGlanceY;

      if (!reduced) {
        if (e.stateKey === "sleeping") {
          const s = Math.sin(phaseNow * 0.0014);
          baseTy = e.dragOffsetY + s * 3.4 + 7;
          baseSx = 1.03 + s * 0.03;
          baseSy = 0.94 - s * 0.03;
          extraTurn = 0;
          extraGazeY = biasY;
        } else if (e.stateKey === "listening") {
          baseRot += 5 + Math.sin(phaseNow * 0.0025) * 1.5;
        } else if (e.stateKey === "thinking") {
          baseRot += -6 + Math.sin(phaseNow * 0.002) * 2.5;
          if (!e.pointerInZone) extraTurn = biasTurn + Math.sin(phaseNow * 0.0018) * 5;
        } else if (e.stateKey === "happy") {
          const hop = Math.abs(Math.sin(phaseNow * 0.0038));
          baseTy -= hop * 6;
          baseRot += Math.sin(phaseNow * 0.0038) * 3.2;
        } else if (e.stateKey === "excited") {
          const hop = Math.abs(Math.sin(phaseNow * 0.0052));
          baseTy -= hop * 9.5;
          baseSx = 1 - hop * 0.04;
          baseSy = 1 + hop * 0.05;
        } else if (e.stateKey === "curious") {
          baseRot += 8 + Math.sin(phaseNow * 0.0022) * 2;
        } else if (e.stateKey === "shy") {
          baseTy += 4;
          baseRot += Math.sin(phaseNow * 0.0028) * 4.5;
          baseSx = 0.98;
          baseSy = 0.98;
        } else if (e.stateKey === "sad") {
          baseTy += 8;
          baseSx = 1.03;
          baseSy = 0.95;
          baseRot += Math.sin(phaseNow * 0.0015) * 1.8;
        }
      }

      if (e.activeAction) {
        const elapsed = (now - e.actionStart) / 1000;
        if (e.activeAction === "bounce") {
          if (elapsed < 0.17) {
            const u = Math.sin((elapsed / 0.17) * (Math.PI / 2));
            baseTy += u * 14;
            baseSx = 1 + u * 0.2;
            baseSy = 1 - u * 0.2;
          } else if (elapsed < 0.56) {
            if (e.actionPhase < 2) {
              e.actionPhase = 2;
              flashExpression("excited", 720);
            }
            const jump = Math.sin(((elapsed - 0.17) / 0.39) * Math.PI);
            baseTy -= jump * 42;
            baseSx = 1 - jump * 0.14;
            baseSy = 1 + jump * 0.18;
          } else if (elapsed < 0.86) {
            const impact = Math.sin(((elapsed - 0.56) / 0.3) * Math.PI);
            baseTy += impact * 12;
            baseSx = 1 + impact * 0.22;
            baseSy = 1 - impact * 0.2;
          } else {
            e.activeAction = null;
          }
        } else if (e.activeAction === "shake") {
          if (elapsed < 0.72) {
            const wave = Math.sin(elapsed * 28) * Math.pow(1 - elapsed / 0.72, 1.2);
            baseTx += wave * 16;
            baseRot += wave * 10;
            extraTurn = wave * 24;
          } else {
            e.activeAction = null;
          }
        } else if (e.activeAction === "peek") {
          if (elapsed < 1.05) {
            const ease = Math.pow(Math.sin((elapsed / 1.05) * Math.PI), 0.75);
            baseTx += ease * 26;
            baseTy -= ease * 7;
            baseRot += ease * 11;
            extraTurn = ease * 22;
            extraGazeY = -ease * 4;
          } else {
            e.activeAction = null;
          }
        } else if (e.activeAction === "pinch") {
          if (elapsed < 0.68) {
            const s = Math.sin((elapsed / 0.68) * Math.PI);
            baseSx = 1 - s * 0.26;
            baseSy = 1 + s * 0.26;
            baseTy -= s * 6;
          } else {
            e.activeAction = null;
          }
        } else if (e.activeAction === "squish") {
          if (elapsed < 0.42) {
            const u = Math.sin((elapsed / 0.42) * Math.PI);
            baseSx = 1 + u * 0.32;
            baseSy = 1 - u * 0.3;
            baseTy += u * 22;
          } else if (elapsed < 0.78) {
            const u = Math.sin(((elapsed - 0.42) / 0.36) * Math.PI);
            baseSx = 1 - u * 0.1;
            baseSy = 1 + u * 0.14;
            baseTy -= u * 16;
          } else {
            e.activeAction = null;
          }
        } else if (e.activeAction === "celebrate") {
          if (elapsed < 1.15) {
            const p = elapsed / 1.15;
            const hop = Math.abs(Math.sin(p * Math.PI * 2));
            baseTy -= hop * 36;
            baseRot += Math.sin(p * Math.PI * 4) * 14;
            extraTurn = Math.sin(p * Math.PI * 2) * 18;
            baseSx = 1 - hop * 0.09;
            baseSy = 1 + hop * 0.12;
          } else {
            e.activeAction = null;
          }
        }
      }

      const eyeCfg = PET_SHAPES[e.shapeKey].eye;
      const useFocusLook = e.focusTurn !== null && e.focusGazeY !== null && !e.dragging && !e.activeAction;
      if (useFocusLook) {
        // 低头俯看输入内容：身体微微前倾下探并随视线左右歪头
        baseTy += 9;
        baseSx += 0.025;
        baseSy -= 0.025;
        baseRot = e.focusTurn! * 0.34;
      }
      const sx = e.sx.step(baseSx, dt);
      const sy = e.sy.step(baseSy, dt);
      const tx = e.tx.step(baseTx, dt);
      const ty = e.ty.step(baseTy, dt);
      const rot = e.rot.step(baseRot, dt);
      const desiredTurn = useFocusLook ? e.focusTurn! : e.targetTurn + extraTurn;
      const desiredGazeY = useFocusLook ? e.focusGazeY! : e.targetGazeY + extraGazeY;
      const turn = e.turn.step(clamp(desiredTurn, -36, 36), dt);
      const gazeY = e.gazeY.step(clamp(desiredGazeY, -24, 38), dt);
      const eyeScale = e.eyeScale.step(eyeCfg.scale, dt);
      const eyeShiftY = e.eyeShiftY.step(eyeCfg.shiftY, dt);
      const shapeMoving = Math.abs(e.shapeMorph.x - 1) > 0.0005 || Math.abs(e.shapeMorph.v) > 0.0005;
      const exprMoving = Math.abs(e.exprMorph.x - 1) > 0.0005 || Math.abs(e.exprMorph.v) > 0.0005;
      e.exprMorph.step(1, dt);
      e.shapeMorph.step(1, dt);

      rigRef.current?.setAttribute(
        "transform",
        `translate(${(114.5 + tx).toFixed(2)} ${(114.5 + ty).toFixed(2)}) rotate(${rot.toFixed(2)}) scale(${sx.toFixed(3)} ${sy.toFixed(3)}) translate(-114.5 -114.5)`,
      );

      if (shapeMoving || lastShapeKey !== e.shapeKey) {
        const bodyD = shapeMoving ? smoothRing(currentShapeRing(), 0.95) : PET_SHAPES[e.shapeKey].pathD;
        bodyRef.current?.setAttribute("d", bodyD);
        clipRef.current?.setAttribute("d", bodyD);
        lastShapeKey = shapeMoving ? null : e.shapeKey;
      }

      if (e.glowEnabled && haloRef.current) {
        const pulseSpeed = 0.002 + stateCfg.glowPulse * 0.003;
        const haloScale = 0.96 + Math.sin(phaseNow * pulseSpeed) * 0.06;
        haloRef.current.setAttribute(
          "transform",
          `translate(${(114.5 + tx * 0.6).toFixed(2)} ${(114.5 + ty * 0.6).toFixed(2)}) scale(${haloScale.toFixed(3)}) translate(-114.5 -114.5)`,
        );
      }

      const expr = exprMoving ? currentExpr() : null;
      const staticExpr = PET_EXPRESSIONS[e.exprKey];
      const gap = expr ? expr.gap : staticExpr.gap;
      const offsetY = expr ? expr.offsetY : staticExpr.offsetY;
      const bs = blinkScale(now);
      const rad = (turn * Math.PI) / 180;
      const sphereR = 104;
      const sides = [-1, 1] as const;
      const eyeEls = [eye0Ref.current, eye1Ref.current] as const;
      const needEyePath = exprMoving || lastExprKey !== e.exprKey;
      const leftD = needEyePath ? (expr ? ringToPath(expr.left) : staticExpr.leftD) : null;
      const rightD = needEyePath ? (expr ? ringToPath(expr.right) : staticExpr.rightD) : null;
      if (needEyePath) lastExprKey = exprMoving ? null : e.exprKey;

      for (let i = 0; i < 2; i++) {
        const el = eyeEls[i];
        if (!el) continue;
        const baseLon = Math.asin(clamp((sides[i] * gap * eyeScale) / sphereR, -0.68, 0.68));
        const lon = baseLon + rad;
        const depth = Math.cos(lon);
        const perspective = clamp(depth / Math.max(Math.cos(baseLon), 0.1), 0.14, 1.32);
        const ex = 114.5 + sphereR * Math.sin(lon);
        const ey = 114.5 + (offsetY + gazeY) * eyeScale + eyeShiftY;
        // 俯仰透视：低头/抬头幅度大时按球面纬度轻微压扁眼高，立体感更自然
        const pitchCos = Math.cos(Math.asin(clamp(gazeY / sphereR, -0.55, 0.55)));
        const sxEye = perspective * eyeScale;
        const syEye = bs * pitchCos * eyeScale;
        const nextD = i === 0 ? leftD : rightD;
        if (nextD !== null) el.setAttribute("d", nextD);
        el.setAttribute("transform", `translate(${ex.toFixed(2)} ${ey.toFixed(2)}) scale(${sxEye.toFixed(3)} ${syEye.toFixed(3)})`);
        el.style.opacity = depth > 0.08 ? "1" : "0";
      }
    };

    const onPointer = (clientX: number, clientY: number) => {
      if (e.dragging) {
        const dx = clientX - e.dragStartX;
        const dy = clientY - e.dragStartY;
        const dist = Math.hypot(dx, dy);
        if (dist > 6) e.dragMoved = true;
        if (dist > 16 && !e.dragSurprised) {
          e.dragSurprised = true;
          setExpressionImmediate("surprised");
        }
        const vx = clientX - e.lastDragX;
        e.lastDragX = clientX;
        e.dragOffsetX = clamp(dx * 0.45, -54, 54);
        e.dragOffsetY = clamp(dy * 0.45, -44, 44);
        e.targetTilt = clamp(vx * 1.15 + dx * 0.1, -24, 24);
        e.targetTurn = clamp(dx * 0.24, -22, 22);
        e.targetGazeY = clamp(dy * 0.14, -12, 12);
        e.pointerInZone = true;
        e.lastPointerAt = performance.now();
        return;
      }

      if (!e.follow) return;
      const zone = followZoneRef.current?.current;
      if (zone) {
        const zRect = zone.getBoundingClientRect();
        if (!zRect.width || !zRect.height) return;
        const inside =
          clientX >= zRect.left &&
          clientX <= zRect.right &&
          clientY >= zRect.top &&
          clientY <= zRect.bottom;
        if (!inside) {
          if (e.pointerInZone) {
            e.pointerInZone = false;
            e.targetTurn = 0;
            e.targetGazeY = 0;
            e.targetTilt = 0;
          }
          return;
        }
        const rect = host.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = clientX - cx;
        const dy = clientY - cy;
        const spanX = Math.max(zRect.width * 0.52, rect.width * 2);
        const spanY = Math.max(zRect.height * 0.52, rect.height * 0.72);
        const nx = clamp(dx / spanX, -1, 1);
        const ny = clamp(dy / spanY, -1, 1);
        e.targetTurn = nx * 23;
        e.targetGazeY = ny * 13;
        e.targetTilt = nx * 5.5;
        e.pointerInZone = true;
        e.lastPointerAt = performance.now();
        return;
      }
      const rect = host.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      // 离开可视视口外较远时跳过视线追踪
      if (rect.bottom < -80 || rect.top > window.innerHeight + 80 || rect.right < -80 || rect.left > window.innerWidth + 80) return;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = clientX - cx;
      const dy = clientY - cy;
      const proxR = Math.max(rect.width * 5, 520);
      const dist = Math.hypot(dx, dy);
      if (dist <= proxR) {
        const nx = clamp(dx / proxR, -1, 1);
        const ny = clamp(dy / proxR, -1, 1);
        e.targetTurn = nx * 21;
        e.targetGazeY = ny * 12;
        e.targetTilt = nx * 4.8;
        e.pointerInZone = true;
        const now = performance.now();
        e.lastPointerAt = now;
        // 首页/关于页大球「撸一撸」轻抚手势：在球身上左右快速来回轻扫触发眯眼享受
        if (!reduced && e.ambient && e.interactive && clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
          const stepX = clientX - e.rubLastX;
          if (Math.abs(stepX) >= 8) {
            const dir = stepX > 0 ? 1 : -1;
            if (now - e.rubWindowStart > 900) {
              e.rubWindowStart = now;
              e.rubFlips = 0;
              e.rubDir = dir;
            } else if (e.rubDir && dir !== e.rubDir) {
              e.rubFlips += 1;
              e.rubDir = dir;
              if (e.rubFlips >= 3 && now >= e.rubCooldownAt) {
                e.rubFlips = 0;
                e.rubCooldownAt = now + 2400;
                e.sx.impulse(2.0);
                e.sy.impulse(-1.4);
                e.rot.impulse(dir * 2.8);
                flashExpression("happy", 1300);
              }
            }
            e.rubLastX = clientX;
          }
        }
      } else if (e.pointerInZone) {
        e.pointerInZone = false;
        e.targetTurn = 0;
        e.targetGazeY = 0;
        e.targetTilt = 0;
      }
    };

    const onDown = (ev: PointerEvent) => {
      if (!e.interactive || (ev.pointerType === "mouse" && ev.button !== 0)) return;
      e.sx.impulse(1.5);
      e.sy.impulse(-1.5);
      if (!e.draggable) {
        // 不可拖拽位（如置顶排序头像）：点按瞬间只给 Q 弹果冻反馈，不抢指针捕获
        e.sx.impulse(2.4);
        e.sy.impulse(-2.4);
        flashExpression("squeeze", 320);
        return;
      }
      e.dragging = true;
      e.dragMoved = false;
      e.dragSurprised = false;
      e.dragStartX = ev.clientX;
      e.dragStartY = ev.clientY;
      e.lastDragX = ev.clientX;
      host.classList.add("pet-dragging");
      host.setPointerCapture?.(ev.pointerId);
    };

    const onUp = () => {
      if (!e.dragging) return;
      const wasDrag = e.dragMoved;
      const wasSurprised = e.dragSurprised;
      e.dragging = false;
      e.dragSurprised = false;
      host.classList.remove("pet-dragging");
      e.dragOffsetX = 0;
      e.dragOffsetY = 0;
      e.targetTilt = 0;

      if (!wasDrag) {
        const now = performance.now();
        // 统一连击序列（无双击时间窗冲突）：每次点击自然递进表情与果冻动作
        e.pokeStreak = now < e.pokeResetAt ? e.pokeStreak + 1 : 1;
        e.pokeResetAt = now + 2400;
        if (e.pokeStreak === 1) {
          triggerAction("squish");
        } else if (e.pokeStreak === 2) {
          triggerAction("bounce");
        } else if (e.pokeStreak === 3) {
          triggerAction("peek");
          flashExpression(e.actionCycle % 2 === 0 ? "wink" : "shy", 1150);
          e.actionCycle++;
        } else if (e.pokeStreak === 4) {
          triggerAction("celebrate");
        } else {
          e.pokeStreak = 0;
          triggerAction("shake");
          flashExpression("surprised", 950);
        }
      } else {
        // 拖拽松手后拦截紧随的 click，避免误触外层按钮，并衔接柔和余韵表情
        e.suppressNextClick = true;
        window.setTimeout(() => { e.suppressNextClick = false; }, 120);
        e.sx.impulse(3.2);
        e.sy.impulse(-3.0);
        if (wasSurprised) {
          flashExpression(e.actionCycle % 2 === 0 ? "shy" : "wink", 750);
          e.actionCycle++;
        }
      }
    };

    const onClickCapture = (ev: MouseEvent) => {
      if (e.suppressNextClick) {
        e.suppressNextClick = false;
        ev.preventDefault();
        ev.stopPropagation();
      }
    };

    const unsubFrame = subscribePetFrame(onFrame);
    const unsubPointer = subscribePetPointer(onPointer);
    host.addEventListener("pointerdown", onDown);
    host.addEventListener("click", onClickCapture, true);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);

    return () => {
      unsubFrame();
      unsubPointer();
      if (e.flashTimer !== null) {
        window.clearTimeout(e.flashTimer);
        e.flashTimer = null;
      }
      host.removeEventListener("pointerdown", onDown);
      host.removeEventListener("click", onClickCapture, true);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  const initSpec = PET_SHAPES[shape];
  const initLook = state === "idle" ? ([defaultTurn, defaultGazeY] as const) : PET_STATES[state].lookBias;
  const initEyes = staticEyeTransforms(shape, PET_STATES[state].expression, initLook);

  return (
    <div
      ref={hostRef}
      className={`pet-host${interactive && draggable ? " pet-interactive" : ""}`}
    >
      <svg
        className={`pet-svg pet-live${isDarkBody ? " pet-obsidian" : ""}`}
        viewBox="-20 -20 269 269"
        aria-hidden="true"
      >
        <defs>
          <radialGradient id={haloGradId} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={rgba(glow, 0.34)} />
            <stop offset="62%" stopColor={rgba(glow, 0.12)} />
            <stop offset="100%" stopColor={rgba(glow, 0)} />
          </radialGradient>
          <clipPath id={clipId}>
            <path ref={clipRef} d={initSpec.pathD} />
          </clipPath>
        </defs>
        <circle
          ref={haloRef}
          className="pet-halo"
          cx="114.5"
          cy="114.5"
          r="142"
          fill={`url(#${haloGradId})`}
          style={{ opacity: glowEnabled ? 1 : 0 }}
        />
        <g ref={rigRef} className="pet-rig">
          <path ref={bodyRef} className="pet-body" d={initSpec.pathD} fill={body} />
          <g className="pet-eyes" clipPath={`url(#${clipId})`}>
            <path ref={eye0Ref} d={initEyes.leftD} fill={eye} transform={initEyes.leftT} />
            <path ref={eye1Ref} d={initEyes.rightD} fill={eye} transform={initEyes.rightT} />
          </g>
        </g>
      </svg>
    </div>
  );
}
