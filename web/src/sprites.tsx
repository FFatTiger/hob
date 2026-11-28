// 助手头像：GrokBot 极简矢量果冻宠物（20 种 48 点可 Morph 剪影 + 11 色官方色板 + 自定义 HEX）。
// 双模渲染：小列表项/缩略图走零开销静态 SVG，首页/顶栏/右栏/思考态/换装台启用共享 60fps 阻尼弹簧活体引擎。
// Attribution: Adapted from zhulin025/LaoA-GrokBot (https://github.com/zhulin025/LaoA-GrokBot), MIT License.
import { useRef, type RefObject } from "react";
import { t } from "../../shared/i18n.ts";
import { resolvePet, type PetActionId, type PetExpressionId, type PetStateId } from "../../shared/pet.ts";
import type { CustomProp, SpriteId } from "../../shared/types.ts";
import { LivePet, StaticPet } from "./pet/PetAvatar.tsx";

export type AvatarMark = "busy" | "ask" | "stuck" | "done";
const MARK_LABEL: Record<AvatarMark, string> = { busy: "正在工作", ask: "等你确认", stuck: "受阻", done: "已完成，未读" };

function inferState(motion?: "think" | "work" | "home" | "peek", mark?: AvatarMark, explicit?: PetStateId): PetStateId {
  if (explicit) return explicit;
  if (motion === "think") return "thinking";
  if (motion === "work") return "listening";
  if (motion === "peek") return "curious";
  if (mark === "ask") return "curious";
  if (mark === "stuck") return "sad";
  if (mark === "done") return "happy";
  if (mark === "busy") return "thinking";
  return "idle";
}

function inferStaticExpression(mark?: AvatarMark, explicit?: PetStateId): PetExpressionId {
  if (explicit) {
    if (explicit === "thinking") return "thinking";
    if (explicit === "curious") return "curious";
    if (explicit === "happy") return "happy";
    if (explicit === "sad") return "sad";
    if (explicit === "sleeping") return "sleeping";
    if (explicit === "surprised") return "surprised";
    if (explicit === "shy") return "shy";
    if (explicit === "excited") return "excited";
    if (explicit === "listening") return "listening";
    return "neutral";
  }
  if (mark === "ask") return "curious";
  if (mark === "stuck") return "sad";
  if (mark === "done") return "happy";
  if (mark === "busy") return "thinking";
  return "neutral";
}

/**
 * 统一助手宠物头像组件（兼容原有 prop / motion / slot 参数，旧像素头像 ID 自动映射到果冻宠物造型）。
 */
export function Avatar({
  sprite,
  prop: _prop,
  size,
  title,
  onClick,
  motion,
  mark,
  free,
  slot: _slot,
  live,
  petState,
  interactive,
  draggable,
  follow,
  followZone,
  defaultLook,
  focusLook,
  glow,
  morphBounce,
  ambient,
  action,
  actionSeq,
}: {
  sprite: SpriteId;
  prop?: CustomProp;
  size: number;
  title?: string;
  onClick?: () => void;
  motion?: "think" | "work" | "home" | "peek";
  /** 右下角状态符号：busy 正在工作、ask 等你确认、stuck 受阻、done 完成未读 */
  mark?: AvatarMark;
  free?: boolean;
  /** 保留以兼容上游调用方 */
  slot?: number;
  /** 显式启用 60fps 活体物理宠物模式 */
  live?: boolean;
  /** 活体情绪状态（idle / listening / thinking / happy / excited / surprised / curious / shy / sad / sleeping） */
  petState?: PetStateId;
  /** 允许点击戳一下与双击触发动作 */
  interactive?: boolean;
  /** 允许拖拽拉扯弹性回弹（默认与 interactive 一致） */
  draggable?: boolean;
  /** 是否开启 3D 球面鼠标视线跟随 */
  follow?: boolean;
  /** 限定鼠标跟随的触发区域（如列表行框），鼠标移入框内时跟随，移出后回正 */
  followZone?: RefObject<HTMLElement | null>;
  /** 待机默认视线偏置 [turnDeg, gazeY]，如 [11, -7] 表示向右上方瞟 */
  defaultLook?: readonly [number, number];
  /** 主动注视目标 [turnDeg, gazeY]（如低头追看输入框打字内容），优先级高于状态偏置与鼠标滞留 */
  focusLook?: readonly [number, number];
  /** 是否开启情绪柔光晕 */
  glow?: boolean;
  /** 切换造型或颜色时自动播放 Q 弹 Morph 回弹 */
  morphBounce?: boolean;
  /** 主球空闲微剧场与轻抚手势（仅用于首页大球） */
  ambient?: boolean;
  /** 外部触发的一次性弹簧动作 */
  action?: PetActionId;
  actionSeq?: number;
}) {
  const lastMark = useRef(mark);
  if (mark) lastMark.current = mark;
  const displayedMark = mark ?? lastMark.current;
  const pet = resolvePet(sprite);
  const useLive = live ?? (motion === "home" || motion === "think" || motion === "work");
  const resolvedState = inferState(motion, mark, petState);
  const resolvedExpr = inferStaticExpression(mark, petState);
  const alive = !free && (mark === "busy" || motion === "think" || motion === "work");
  const allowInteractive = interactive ?? (motion === "home");
  const allowDraggable = draggable ?? allowInteractive;
  const allowFollow = follow ?? useLive;
  const allowGlow = glow ?? (motion === "think" || motion === "work");

  return (
    <div
      className={`av av-pet${free ? " av-free" : ""}${useLive ? " av-live" : ""}${alive ? " av-alive" : ""} av-marked`}
      title={title}
      onClick={onClick}
      style={{ "--av-size": `${size}px`, "--av-bg": "transparent", "--pet-glow": pet.glow } as React.CSSProperties}
    >
      {useLive ? (
        <LivePet
          shape={pet.shape}
          body={pet.body}
          eye={pet.eye}
          glow={pet.glow}
          isDarkBody={pet.isDarkBody}
          state={resolvedState}
          interactive={allowInteractive}
          draggable={allowDraggable}
          follow={allowFollow}
          followZone={followZone}
          defaultLook={defaultLook}
          focusLook={focusLook}
          glowEnabled={allowGlow}
          morphBounce={morphBounce}
          ambient={ambient}
          action={action}
          actionSeq={actionSeq}
        />
      ) : (
        <StaticPet
          shape={pet.shape}
          body={pet.body}
          eye={pet.eye}
          isDarkBody={pet.isDarkBody}
          expression={resolvedExpr}
          defaultLook={defaultLook}
        />
      )}
      <span
        className={`av-mark${mark ? " present" : ""}${displayedMark ? ` ${displayedMark}` : ""}`}
        aria-label={mark ? t(MARK_LABEL[mark]) : undefined}
        aria-hidden={!mark}
      >
        <span key={displayedMark} className="av-mark-icon">
          {displayedMark === "busy" ? (
            <svg viewBox="0 0 13 5">
              <circle className="av-dot" cx="2.5" cy="2.5" r="1.5" />
              <circle className="av-dot" cx="6.5" cy="2.5" r="1.5" />
              <circle className="av-dot" cx="10.5" cy="2.5" r="1.5" />
            </svg>
          ) : displayedMark === "done" ? (
            <svg viewBox="0 0 16 16" fill="none">
              <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : displayedMark === "ask" ? "?" : displayedMark === "stuck" ? "!" : null}
        </span>
      </span>
    </div>
  );
}
