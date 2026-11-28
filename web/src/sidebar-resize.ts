export const SIDE_WIDTH_DEFAULT = 296;
export const SIDE_WIDTH_MIN = 248;
export const SIDE_WIDTH_MAX = 380;
export const SIDE_WIDTH_STEP = 16;

export function clampSideWidth(width: number): number {
  return Math.round(Math.min(SIDE_WIDTH_MAX, Math.max(SIDE_WIDTH_MIN, width)));
}

/** 键盘调整左栏宽度：返回新宽度、null（恢复默认），或 undefined（不处理该按键）。 */
export function sideWidthForKey(current: number | undefined, key: string): number | null | undefined {
  const base = current ?? SIDE_WIDTH_DEFAULT;
  if (key === "ArrowLeft") return clampSideWidth(base - SIDE_WIDTH_STEP);
  if (key === "ArrowRight") return clampSideWidth(base + SIDE_WIDTH_STEP);
  if (key === "Home" || key === "Enter") return null;
  return undefined;
}
