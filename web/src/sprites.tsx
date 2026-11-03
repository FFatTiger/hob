// 助手头像：Hob 的像素小火苗 + 颜色 + 道具，数据在 shared/sprites.ts；自画道具的数据跟着助手走。
import { spriteArt, spriteEyes } from "../../shared/sprites.ts";
import type { CustomProp, SpriteId } from "../../shared/types.ts";

/** 同一行里连着的同色像素合成一个矩形，列表里几十个头像时少画很多节点。 */
function SpritePixels({ art }: { art: ReturnType<typeof spriteArt> }) {
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
    <>
      {rects.map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.w + 0.02} height={1.02} fill={r.fill} />
      ))}
    </>
  );
}

/** 圆形头像。sprite 是 custom / custom:* 时传 prop（自画的画法）；没传或数据坏了画空手火苗。 */
export function Avatar({
  sprite,
  prop,
  size,
  title,
  onClick,
  motion,
  busyDot,
}: {
  sprite: SpriteId;
  prop?: CustomProp;
  size: number;
  title?: string;
  onClick?: () => void;
  motion?: "think" | "work" | "home";
  busyDot?: boolean;
}) {
  const art = spriteArt(sprite, prop);
  // 动起来时眼睛单独一层：外层管看的方向，内层管眨眼，两个 transform 互不覆盖
  const split = motion ? spriteEyes(art) : undefined;
  // 同一个助手在各处一样，不同助手错开起点
  const eyeDelay = motion ? `${-([...sprite].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 9973, 7) % 4000) / 1000}s` : undefined;
  return (
    <div className={`av${motion ? ` av-motion av-${motion}` : ""}${busyDot ? " av-busy" : ""}`} title={title} onClick={onClick} style={{ width: size, height: size, "--av-bg": art.bg } as React.CSSProperties}>
      <svg viewBox={`${art.offset[0]} ${art.offset[1]} 16 16`} shapeRendering="crispEdges" aria-hidden="true" style={eyeDelay ? ({ "--eye-delay": eyeDelay } as React.CSSProperties) : undefined}>
        {split ? (
          <>
            <SpritePixels art={{ ...art, rows: split.body }} />
            <g className="av-eyes">
              <g className="av-blink">
                {split.eyes.map(([x, y]) => (
                  <rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill={art.pal.e} />
                ))}
              </g>
            </g>
          </>
        ) : (
          <SpritePixels art={art} />
        )}
      </svg>
    </div>
  );
}
