// 助手头像：Hob 的像素小火苗 + 颜色 + 道具，数据在 shared/sprites.ts；自画道具的数据跟着助手走。
import { spriteArt } from "../../shared/sprites.ts";
import type { CustomProp, SpriteId } from "../../shared/types.ts";

/** 同一行里连着的同色像素合成一个矩形，列表里几十个头像时少画很多节点。 */
function SpriteSvg({ art }: { art: ReturnType<typeof spriteArt> }) {
  const rects: { x: number; y: number; w: number; fill: string }[] = [];
  art.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const ch = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === ch) end++;
      if (ch !== "." && art.pal[ch]) rects.push({ x, y, w: end - x, fill: art.pal[ch] });
      x = end;
    }
  });
  return (
    <svg viewBox={`${art.offset[0]} ${art.offset[1]} 16 16`} shapeRendering="crispEdges" aria-hidden="true">
      {rects.map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.w + 0.02} height={1.02} fill={r.fill} />
      ))}
    </svg>
  );
}

/** 圆形头像。sprite 是 custom / custom:* 时传 prop（自画的画法）；没传或数据坏了画空手火苗。 */
export function Avatar({
  sprite,
  prop,
  size,
  title,
  onClick,
}: {
  sprite: SpriteId;
  prop?: CustomProp;
  size: number;
  title?: string;
  onClick?: () => void;
}) {
  const art = spriteArt(sprite, prop);
  return (
    <div className="av" title={title} onClick={onClick} style={{ width: size, height: size, background: art.bg }}>
      <SpriteSvg art={art} />
    </div>
  );
}
