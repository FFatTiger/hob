// GrokBot 极简果冻宠物核心数据与数学引擎（前后端共用，零外部依赖）：
// 20 种 48 点无扭曲 Morph 单轮廓剪影 + 11 套官方高饱和色板 + 12 种居中参数化表情 + 10 种核心状态 + 阻尼谐振弹簧。
//
// Attribution: Adapted from zhulin025/LaoA-GrokBot (https://github.com/zhulin025/LaoA-GrokBot),
// licensed under the MIT License.

export type Point2 = [number, number];

export const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

export const ringToPath = (ring: readonly Point2[]): string =>
  "M" + ring.map((p) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join("L") + "Z";

/** 将闭合点环转为平滑 Catmull-Rom 三次贝塞尔 SVG 路径。 */
export const smoothRing = (ring: readonly Point2[], tension = 1): string => {
  if (ring.length < 3) return ringToPath(ring);
  const r = (v: number) => Math.round(v * 100) / 100;
  const n = ring.length;
  let d = `M${r(ring[0][0])},${r(ring[0][1])}`;
  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n];
    const cur = ring[i];
    const next = ring[(i + 1) % n];
    const after = ring[(i + 2) % n];
    const c1x = cur[0] + ((next[0] - prev[0]) / 6) * tension;
    const c1y = cur[1] + ((next[1] - prev[1]) / 6) * tension;
    const c2x = next[0] - ((after[0] - cur[0]) / 6) * tension;
    const c2y = next[1] - ((after[1] - cur[1]) / 6) * tension;
    d += `C${r(c1x)},${r(c1y)} ${r(c2x)},${r(c2y)} ${r(next[0])},${r(next[1])}`;
  }
  return d + "Z";
};

/** 帧率无关的阻尼谐振弹簧解算器。 */
export class Spring {
  x: number;
  v = 0;
  target: number;
  stiffness: number;
  damping: number;
  mass: number;

  constructor(value = 0, stiffness = 210, damping = 22, mass = 0.85) {
    this.x = value;
    this.target = value;
    this.stiffness = stiffness;
    this.damping = damping;
    this.mass = mass;
  }

  step(target: number, dt: number): number {
    this.target = target;
    let remaining = Math.min(dt, 0.06);
    while (remaining > 0) {
      const h = Math.min(remaining, 1 / 120);
      const a = (-this.stiffness * (this.x - target) - this.damping * this.v) / this.mass;
      this.v += a * h;
      this.x += this.v * h;
      remaining -= h;
    }
    if (!Number.isFinite(this.x) || !Number.isFinite(this.v)) {
      this.x = target;
      this.v = 0;
    }
    return this.x;
  }

  impulse(dv: number): void {
    this.v += dv;
  }

  snap(value: number): void {
    this.x = value;
    this.v = 0;
    this.target = value;
  }
}

/* ---------------- 几何点环采样（统一 48 点、顺时针、12 点钟对齐） ---------------- */

const CX = 114.5;
const CY = 114.5;
const RING_PTS = 48;

function alignRing(pts: Point2[], cx: number, cy: number): Point2[] {
  let area2 = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    area2 += (b[0] - a[0]) * (b[1] + a[1]);
  }
  const ordered = area2 > 0 ? pts.slice().reverse() : pts.slice();

  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < ordered.length; i++) {
    const angle = Math.atan2(ordered[i][1] - cy, ordered[i][0] - cx);
    let diff = angle - (-Math.PI / 2);
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) < bestDiff) {
      bestDiff = Math.abs(diff);
      bestIdx = i;
    }
  }
  return ordered.slice(bestIdx).concat(ordered.slice(0, bestIdx));
}

function resampleClosed(pts: Point2[], count = RING_PTS, autoCentroid = false): Point2[] {
  const n = pts.length;
  const cum = new Float64Array(n + 1);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    cum[i + 1] = total;
  }
  const out: Point2[] = [];
  let seg = 0;
  for (let i = 0; i < count; i++) {
    const target = (i / count) * total;
    while (seg < n - 1 && cum[seg + 1] < target) seg++;
    const a = pts[seg];
    const b = pts[(seg + 1) % n];
    const segLen = cum[seg + 1] - cum[seg] || 1;
    const t = (target - cum[seg]) / segLen;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  if (!autoCentroid) return alignRing(out, CX, CY);
  let sx = 0;
  let sy = 0;
  for (const p of out) {
    sx += p[0];
    sy += p[1];
  }
  return alignRing(out, sx / out.length, sy / out.length);
}

function sampleCubicLoop(segments: [number, number, number, number, number, number, number, number][], count = RING_PTS): Point2[] {
  const dense: Point2[] = [];
  const stepsPerSeg = 24;
  for (const [x0, y0, c1x, c1y, c2x, c2y, x1, y1] of segments) {
    for (let i = 0; i < stepsPerSeg; i++) {
      const t = i / stepsPerSeg;
      const mt = 1 - t;
      const mt2 = mt * mt;
      const t2 = t * t;
      dense.push([
        mt2 * mt * x0 + 3 * mt2 * t * c1x + 3 * mt * t2 * c2x + t2 * t * x1,
        mt2 * mt * y0 + 3 * mt2 * t * c1y + 3 * mt * t2 * c2y + t2 * t * y1,
      ]);
    }
  }
  return resampleClosed(dense, count);
}

function samplePolar(pointFn: (theta: number) => Point2, denseCount = 192): Point2[] {
  const dense: Point2[] = [];
  for (let i = 0; i < denseCount; i++) {
    const theta = (i / denseCount) * Math.PI * 2 - Math.PI / 2;
    dense.push(pointFn(theta));
  }
  return resampleClosed(dense, RING_PTS);
}

function raycastCircleUnion(lobes: [number, number, number][], ox = CX, oy = CY): Point2[] {
  return samplePolar((theta) => {
    const dx = Math.cos(theta);
    const dy = Math.sin(theta);
    let maxDist = 42;
    for (const [lx, ly, r] of lobes) {
      const rx = ox - lx;
      const ry = oy - ly;
      const b = rx * dx + ry * dy;
      const c = rx * rx + ry * ry - r * r;
      const disc = b * b - c;
      if (disc >= 0) {
        const d = -b + Math.sqrt(disc);
        if (d > maxDist) maxDist = d;
      }
    }
    return [ox + dx * maxDist, oy + dy * maxDist];
  });
}

function roundedPolygonRing(vertices: Point2[], cornerRadius: number, count = RING_PTS): Point2[] {
  const n = vertices.length;
  const dense: Point2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = vertices[(i - 1 + n) % n];
    const cur = vertices[i];
    const next = vertices[(i + 1) % n];
    const v1x = prev[0] - cur[0];
    const v1y = prev[1] - cur[1];
    const v2x = next[0] - cur[0];
    const v2y = next[1] - cur[1];
    const len1 = Math.hypot(v1x, v1y) || 1;
    const len2 = Math.hypot(v2x, v2y) || 1;
    const d = Math.min(cornerRadius, len1 * 0.48, len2 * 0.48);
    const p1: Point2 = [cur[0] + (v1x / len1) * d, cur[1] + (v1y / len1) * d];
    const p2: Point2 = [cur[0] + (v2x / len2) * d, cur[1] + (v2y / len2) * d];
    const arcSteps = 10;
    for (let s = 0; s <= arcSteps; s++) {
      const t = s / arcSteps;
      const mt = 1 - t;
      dense.push([
        mt * mt * p1[0] + 2 * mt * t * cur[0] + t * t * p2[0],
        mt * mt * p1[1] + 2 * mt * t * cur[1] + t * t * p2[1],
      ]);
    }
  }
  return resampleClosed(dense, count);
}

function buildRegularPolygon(sides: number, radius: number, startAngle: number, cx: number, cy: number, cornerRadius: number): Point2[] {
  const verts: Point2[] = [];
  for (let i = 0; i < sides; i++) {
    const a = startAngle + (i / sides) * Math.PI * 2;
    verts.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius]);
  }
  return roundedPolygonRing(verts, cornerRadius, RING_PTS);
}

/* ---------------- 11 套官方高饱和色板 ---------------- */

export interface PetColorSpec {
  name: string;
  body: string;
  eye: string;
  glow: string;
}

export const PET_COLORS = {
  black: { name: "纯黑", body: "#09090b", eye: "#ffffff", glow: "#7dd3fc" },
  cocoa: { name: "可可棕", body: "#9a6737", eye: "#ffffff", glow: "#d99b66" },
  red: { name: "活力红", body: "#ff3347", eye: "#ffffff", glow: "#ff6b7a" },
  orange: { name: "暖橙", body: "#ff6a00", eye: "#ffffff", glow: "#ff944d" },
  amber: { name: "琥珀黄", body: "#f59e0b", eye: "#ffffff", glow: "#fbbf24" },
  green: { name: "翠绿", body: "#08c77a", eye: "#ffffff", glow: "#34d399" },
  teal: { name: "湖蓝", body: "#08b9a9", eye: "#ffffff", glow: "#2dd4bf" },
  blue: { name: "经典蓝", body: "#2684ff", eye: "#ffffff", glow: "#60a5fa" },
  purple: { name: "梦幻紫", body: "#8656f6", eye: "#ffffff", glow: "#a78bfa" },
  pink: { name: "桃粉", body: "#ff2d8b", eye: "#ffffff", glow: "#f472b6" },
  gray: { name: "高级灰", body: "#919196", eye: "#ffffff", glow: "#cbd5e1" },
} as const satisfies Record<string, PetColorSpec>;

export type PetColorId = keyof typeof PET_COLORS;
export const PET_COLOR_IDS = Object.keys(PET_COLORS) as PetColorId[];

/* ---------------- 20 种 Morph 单轮廓剪影（5 × 4） ---------------- */

export interface PetShapeSpec {
  label: string;
  /** 建助手时给模型参考的推荐职责 */
  hint: string;
  defaultColor: PetColorId;
  tilt: number;
  eye: { scale: number; shiftY: number };
  ring: Point2[];
  /** 预计算平滑贝塞尔路径：静态列表头像零计算开销 */
  pathD: string;
}

function shapeDef(
  label: string,
  hint: string,
  defaultColor: PetColorId,
  tilt: number,
  eye: { scale: number; shiftY: number },
  ring: Point2[],
): PetShapeSpec {
  return { label, hint, defaultColor, tilt, eye, ring, pathD: smoothRing(ring, 0.95) };
}

export const PET_SHAPES = {
  sphere: shapeDef(
    "圆球",
    "主助手/通用",
    "black",
    0,
    { scale: 1.0, shiftY: 0 },
    samplePolar((t) => [CX + 104 * Math.cos(t), CY + 104 * Math.sin(t)]),
  ),
  cloud: shapeDef(
    "云朵",
    "资讯/搜索/云服务",
    "blue",
    -5,
    { scale: 0.9, shiftY: 6 },
    raycastCircleUnion([
      [112, 76, 48],
      [154, 86, 42],
      [169, 128, 43],
      [120, 150, 46],
      [68, 144, 44],
      [66, 98, 44],
      [114.5, 116, 56],
    ]),
  ),
  square: shapeDef(
    "圆角方",
    "日程/规划/效率",
    "purple",
    -22,
    { scale: 0.94, shiftY: 4 },
    roundedPolygonRing([[24, 24], [205, 24], [205, 205], [24, 205]], 38),
  ),
  sparkle: shapeDef(
    "四角星",
    "灵感/创意/AI",
    "orange",
    -8,
    { scale: 0.84, shiftY: 0 },
    samplePolar((t) => {
      const a = t + Math.PI / 2;
      const r = 86 + 21 * Math.cos(4 * a) + 3 * Math.cos(8 * a);
      return [CX + r * Math.cos(t), CY + r * Math.sin(t)];
    }),
  ),
  clover: shapeDef(
    "四叶草",
    "运气/生活/习惯",
    "green",
    -16,
    { scale: 0.88, shiftY: 0 },
    raycastCircleUnion([
      [CX - 38, CY - 38, 57],
      [CX + 38, CY - 38, 57],
      [CX + 38, CY + 38, 57],
      [CX - 38, CY + 38, 57],
      [CX, CY, 52],
    ]),
  ),
  heart: shapeDef(
    "胖爱心",
    "陪伴/情感/社交",
    "pink",
    -10,
    { scale: 0.88, shiftY: -2 },
    sampleCubicLoop([
      [114.5, 58, 134, 24, 184, 22, 206, 62],
      [206, 62, 222, 98, 194, 152, 132, 196],
      [132, 196, 120, 205, 109, 205, 97, 196],
      [97, 196, 35, 152, 7, 98, 23, 62],
      [23, 62, 45, 22, 95, 24, 114.5, 58],
    ]),
  ),
  starFlower: shapeDef(
    "花朵云",
    "艺术/音乐/设计",
    "pink",
    -8,
    { scale: 0.86, shiftY: 4 },
    (() => {
      const lobes: [number, number, number][] = [[CX, CY, 62]];
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 - Math.PI / 2;
        lobes.push([CX + Math.cos(a) * 53, CY + Math.sin(a) * 53, 45]);
      }
      return raycastCircleUnion(lobes);
    })(),
  ),
  teardrop: shapeDef(
    "水滴",
    "天气/运动/饮水",
    "teal",
    -14,
    { scale: 0.88, shiftY: 16 },
    samplePolar((t) => {
      const c = Math.cos(t);
      const s = Math.sin(t);
      const belly = Math.pow(clamp((s + 1) * 0.5 + 0.13, 0.13, 1.13), 0.55);
      return [CX + 92 * c * belly, 118 + 100 * s];
    }),
  ),
  tablet: shapeDef(
    "圆胶囊",
    "写作/文档/读书",
    "purple",
    -14,
    { scale: 0.9, shiftY: 2 },
    roundedPolygonRing([[10, 44], [219, 44], [219, 185], [10, 185]], 70),
  ),
  wedge: shapeDef(
    "圆角三角",
    "视频/游戏/剪辑",
    "red",
    -16,
    { scale: 0.88, shiftY: 16 },
    buildRegularPolygon(3, 136, -Math.PI / 2, CX, 136, 52),
  ),
  house: shapeDef(
    "小房子",
    "家/NAS/智能家居",
    "teal",
    -18,
    { scale: 0.88, shiftY: 16 },
    roundedPolygonRing([[114.5, 16], [204, 86], [194, 206], [35, 206], [25, 86]], 30),
  ),
  star6: shapeDef(
    "六角星",
    "科研/数学/分析",
    "blue",
    -10,
    { scale: 0.84, shiftY: 2 },
    samplePolar((t) => {
      const a = t + Math.PI / 2;
      const r = 86 + 18 * Math.cos(6 * a) + 2.5 * Math.cos(12 * a);
      return [CX + r * Math.cos(t), CY + r * Math.sin(t)];
    }),
  ),
  hex: shapeDef(
    "圆角六边形",
    "代码/服务器/运维",
    "gray",
    -18,
    { scale: 0.92, shiftY: 2 },
    buildRegularPolygon(6, 108, -Math.PI / 2, CX, CY, 32),
  ),
  star5: shapeDef(
    "软五角星",
    "收藏/精选/评测",
    "amber",
    -10,
    { scale: 0.84, shiftY: 5 },
    samplePolar((t) => {
      const a = t + Math.PI / 2;
      const r = 86 + 22 * Math.cos(5 * a) + 3 * Math.cos(10 * a);
      return [CX + r * Math.cos(t), 120 + r * Math.sin(t)];
    }),
  ),
  cat: shapeDef(
    "猫耳团子",
    "宠物/日常/萌系",
    "purple",
    -6,
    { scale: 0.92, shiftY: 12 },
    sampleCubicLoop([
      [86, 54, 104, 50, 125, 50, 143, 54],
      [143, 54, 159, 30, 177, 15, 191, 25],
      [191, 25, 205, 35, 206, 64, 204, 94],
      [204, 94, 215, 138, 196, 208, 114.5, 212],
      [114.5, 212, 33, 208, 14, 138, 25, 94],
      [25, 94, 23, 64, 24, 35, 38, 25],
      [38, 25, 52, 15, 70, 30, 86, 54],
    ]),
  ),
  bear: shapeDef(
    "熊耳团子",
    "饮食/烹饪/管家",
    "cocoa",
    -6,
    { scale: 0.9, shiftY: 14 },
    raycastCircleUnion(
      [
        [114.5, 128, 86],
        [96, 136, 74],
        [133, 136, 74],
        [56, 56, 36],
        [173, 56, 36],
      ],
      114.5,
      124,
    ),
  ),
  ghost: shapeDef(
    "小幽灵",
    "安全/隐私/调试",
    "gray",
    -6,
    { scale: 0.9, shiftY: -6 },
    sampleCubicLoop([
      [114.5, 18, 172, 18, 202, 58, 202, 118],
      [202, 118, 202, 152, 204, 178, 192, 194],
      [192, 194, 180, 208, 164, 204, 152, 186],
      [152, 186, 140, 208, 89, 208, 77, 186],
      [77, 186, 65, 204, 49, 208, 37, 194],
      [37, 194, 25, 178, 27, 152, 27, 118],
      [27, 118, 27, 58, 57, 18, 114.5, 18],
    ]),
  ),
  gem: shapeDef(
    "圆角宝石",
    "财务/记账/股票",
    "amber",
    -10,
    { scale: 0.88, shiftY: -4 },
    roundedPolygonRing([[68, 26], [161, 26], [210, 86], [114.5, 208], [19, 86]], 28),
  ),
  leaf: shapeDef(
    "小树叶",
    "健康/植物/环保",
    "green",
    0,
    { scale: 0.88, shiftY: 4 },
    sampleCubicLoop([
      [174, 34, 214, 72, 210, 152, 146, 192],
      [146, 192, 108, 214, 62, 208, 44, 186],
      [44, 186, 20, 156, 26, 86, 78, 44],
      [78, 44, 112, 18, 156, 18, 174, 34],
    ]),
  ),
  bean: shapeDef(
    "胖豆子",
    "旅行/出行/咖啡",
    "cocoa",
    -10,
    { scale: 0.9, shiftY: 10 },
    sampleCubicLoop([
      [114.5, 58, 144, 58, 160, 40, 186, 56],
      [186, 56, 218, 76, 218, 146, 178, 178],
      [178, 178, 142, 204, 87, 204, 51, 178],
      [51, 178, 11, 146, 11, 76, 43, 56],
      [43, 56, 69, 40, 85, 58, 114.5, 58],
    ]),
  ),
} as const satisfies Record<string, PetShapeSpec>;

export type PetShapeId = keyof typeof PET_SHAPES;
export const PET_SHAPE_IDS = Object.keys(PET_SHAPES) as PetShapeId[];

/* ---------------- 12 种居中参数化 48 点表情 ---------------- */

function makePillEye({
  rx = 10.5,
  ry = 23.5,
  power = 2.5,
  topCut = 0,
  bottomCut = 0,
  topSlope = 0,
  cheekArch = 0,
  tiltDeg = 0,
  shiftY = 0,
} = {}): Point2[] {
  const rad = (tiltDeg * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);
  const dense: Point2[] = [];
  const steps = 128;
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2 - Math.PI / 2;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    const x = Math.sign(ct) * Math.pow(Math.abs(ct), 2 / power) * rx;
    let y = Math.sign(st) * Math.pow(Math.abs(st), 2 / power) * ry;
    const nx = rx > 0 ? x / rx : 0;
    if (topCut > 0) {
      const lidY = -ry + topCut * 2 * ry + topSlope * nx * ry * 0.45;
      if (y < lidY) y = lidY + (y - lidY) * 0.08;
    }
    if (bottomCut > 0 || cheekArch > 0) {
      const arch = cheekArch * (1 - nx * nx) * ry * 0.45;
      const botY = ry - bottomCut * 2 * ry - arch;
      if (y > botY) y = botY + (y - botY) * 0.08;
    }
    dense.push([x * cosR - y * sinR, x * sinR + y * cosR + shiftY]);
  }
  return resampleClosed(dense, RING_PTS, true);
}

function makeArcEye({ width = 28, archHeight = 13, thickness = 8.2, flip = false, shiftY = 0 } = {}): Point2[] {
  const halfW = width / 2;
  const halfT = thickness / 2;
  const sign = flip ? 1 : -1;
  const samples = 24;
  const centerPts: Point2[] = [];
  for (let i = 0; i <= samples; i++) {
    const u = i / samples;
    centerPts.push([-halfW + u * width, sign * Math.sin(u * Math.PI) * archHeight + shiftY - sign * (archHeight * 0.35)]);
  }
  const upper: Point2[] = [];
  const lower: Point2[] = [];
  for (let i = 0; i <= samples; i++) {
    const prev = centerPts[Math.max(0, i - 1)];
    const next = centerPts[Math.min(samples, i + 1)];
    const tx = next[0] - prev[0];
    const ty = next[1] - prev[1];
    const len = Math.hypot(tx, ty) || 1;
    const nx = ty / len;
    const ny = -tx / len;
    const r = halfT * (0.72 + 0.28 * Math.sin((i / samples) * Math.PI));
    upper.push([centerPts[i][0] + nx * r, centerPts[i][1] + ny * r]);
    lower.push([centerPts[i][0] - nx * r, centerPts[i][1] - ny * r]);
  }
  const capR = halfT * 0.72;
  const rightCap: Point2[] = [];
  const rEnd = centerPts[samples];
  const rPrev = centerPts[samples - 1];
  const rAng = Math.atan2(rEnd[1] - rPrev[1], rEnd[0] - rPrev[0]);
  for (let k = 1; k <= 5; k++) {
    const a = rAng - Math.PI / 2 + (k / 6) * Math.PI;
    rightCap.push([rEnd[0] + Math.cos(a) * capR, rEnd[1] + Math.sin(a) * capR]);
  }
  const leftCap: Point2[] = [];
  const lEnd = centerPts[0];
  const lNext = centerPts[1];
  const lAng = Math.atan2(lEnd[1] - lNext[1], lEnd[0] - lNext[0]);
  for (let k = 1; k <= 5; k++) {
    const a = lAng - Math.PI / 2 + (k / 6) * Math.PI;
    leftCap.push([lEnd[0] + Math.cos(a) * capR, lEnd[1] + Math.sin(a) * capR]);
  }
  return resampleClosed([...upper, ...rightCap, ...lower.reverse(), ...leftCap], RING_PTS, true);
}

function makeChevronEye({ width = 20, height = 24, thickness = 7.6, pointingRight = true } = {}): Point2[] {
  const dir = pointingRight ? 1 : -1;
  const hw = width / 2;
  const hh = height / 2;
  const halfT = thickness / 2;
  const p0: Point2 = [-dir * hw, -hh];
  const p1: Point2 = [dir * hw * 0.85, 0];
  const p2: Point2 = [-dir * hw, hh];
  const spine: Point2[] = [];
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    spine.push([mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0], mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1]]);
  }
  const sideA: Point2[] = [];
  const sideB: Point2[] = [];
  for (let i = 0; i <= steps; i++) {
    const prev = spine[Math.max(0, i - 1)];
    const next = spine[Math.min(steps, i + 1)];
    const tx = next[0] - prev[0];
    const ty = next[1] - prev[1];
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len;
    const ny = tx / len;
    const r = halfT * (0.85 + 0.15 * Math.sin((i / steps) * Math.PI));
    sideA.push([spine[i][0] + nx * r, spine[i][1] + ny * r]);
    sideB.push([spine[i][0] - nx * r, spine[i][1] - ny * r]);
  }
  return resampleClosed([...sideA, ...sideB.reverse()], RING_PTS, true);
}

export interface PetExpressionSpec {
  left: Point2[];
  right: Point2[];
  leftD: string;
  rightD: string;
  gap: number;
  offsetY: number;
}

function exprDef(left: Point2[], right: Point2[], gap: number, offsetY: number): PetExpressionSpec {
  return { left, right, leftD: ringToPath(left), rightD: ringToPath(right), gap, offsetY };
}

export const PET_EXPRESSIONS = {
  neutral: exprDef(makePillEye({ rx: 10.5, ry: 24, power: 2.6 }), makePillEye({ rx: 10.5, ry: 24, power: 2.6 }), 22, -2),
  listening: exprDef(makePillEye({ rx: 12.5, ry: 25.5, power: 2.2 }), makePillEye({ rx: 12.5, ry: 25.5, power: 2.2 }), 23, -2),
  thinking: exprDef(
    makePillEye({ rx: 11.5, ry: 21.5, power: 2.4, topCut: 0.44, bottomCut: 0.18, topSlope: 0.55, tiltDeg: 6 }),
    makePillEye({ rx: 11.5, ry: 23, power: 2.4, topCut: 0.22, bottomCut: 0.1, topSlope: -0.25 }),
    24,
    -5,
  ),
  happy: exprDef(makeArcEye({ width: 29, archHeight: 13.5, thickness: 8.6, flip: false }), makeArcEye({ width: 29, archHeight: 13.5, thickness: 8.6, flip: false }), 25, -1),
  wink: exprDef(
    makeArcEye({ width: 29, archHeight: 13.5, thickness: 8.6, flip: false }),
    makePillEye({ rx: 12.5, ry: 25.5, power: 2.3, cheekArch: 0.25 }),
    25,
    -1,
  ),
  excited: exprDef(makePillEye({ rx: 13.5, ry: 28, power: 2.3, cheekArch: 0.35 }), makePillEye({ rx: 13.5, ry: 28, power: 2.3, cheekArch: 0.35 }), 25, -3),
  surprised: exprDef(makePillEye({ rx: 16.5, ry: 20.5, power: 2.0 }), makePillEye({ rx: 16.5, ry: 20.5, power: 2.0 }), 27, -2),
  curious: exprDef(makePillEye({ rx: 8.8, ry: 14.5, power: 2.2, shiftY: 3 }), makePillEye({ rx: 14.5, ry: 28.5, power: 2.3, shiftY: -2.5 }), 25, -2),
  shy: exprDef(makePillEye({ rx: 13.5, ry: 16.5, power: 2.2, bottomCut: 0.34, cheekArch: 0.65, tiltDeg: -10 }), makePillEye({ rx: 13.5, ry: 16.5, power: 2.2, bottomCut: 0.34, cheekArch: 0.65, tiltDeg: 10 }), 23, 5),
  sad: exprDef(makePillEye({ rx: 11, ry: 21, power: 2.4, topCut: 0.34, topSlope: -1.0, tiltDeg: -12 }), makePillEye({ rx: 11, ry: 21, power: 2.4, topCut: 0.34, topSlope: 1.0, tiltDeg: 12 }), 24, 5),
  sleeping: exprDef(makeArcEye({ width: 27, archHeight: 10.5, thickness: 7.4, flip: true }), makeArcEye({ width: 27, archHeight: 10.5, thickness: 7.4, flip: true }), 24, 5),
  squeeze: exprDef(makeChevronEye({ width: 19, height: 22, thickness: 7.6, pointingRight: true }), makeChevronEye({ width: 19, height: 22, thickness: 7.6, pointingRight: false }), 24, 0),
} as const satisfies Record<string, PetExpressionSpec>;

export type PetExpressionId = keyof typeof PET_EXPRESSIONS;

export interface PetStateSpec {
  expression: PetExpressionId;
  blink: [number, number] | null;
  glowPulse: number;
  motion: string;
  lookBias: [number, number];
}

export const PET_STATES = {
  idle: { expression: "neutral", blink: [3400, 6800], glowPulse: 0.25, motion: "breathe", lookBias: [0, 0] },
  listening: { expression: "listening", blink: [2800, 5600], glowPulse: 0.45, motion: "listen", lookBias: [4, -2] },
  thinking: { expression: "thinking", blink: [3200, 6200], glowPulse: 0.7, motion: "think", lookBias: [10, -7] },
  happy: { expression: "happy", blink: null, glowPulse: 0.65, motion: "happy", lookBias: [0, -2] },
  excited: { expression: "excited", blink: [2200, 4200], glowPulse: 0.85, motion: "excited", lookBias: [0, -3] },
  surprised: { expression: "surprised", blink: [2600, 5000], glowPulse: 0.75, motion: "pop", lookBias: [0, -2] },
  curious: { expression: "curious", blink: [2600, 5200], glowPulse: 0.5, motion: "curious", lookBias: [6, -2] },
  shy: { expression: "shy", blink: [2400, 4800], glowPulse: 0.4, motion: "shy", lookBias: [-6, 5] },
  sad: { expression: "sad", blink: [3800, 7400], glowPulse: 0.15, motion: "sad", lookBias: [0, 7] },
  sleeping: { expression: "sleeping", blink: null, glowPulse: 0.12, motion: "sleep", lookBias: [0, 5] },
} as const satisfies Record<string, PetStateSpec>;

export type PetStateId = keyof typeof PET_STATES;
export type PetActionId = "bounce" | "shake" | "peek" | "pinch" | "squish" | "celebrate";

/* ---------------- 旧像素 ID → 新宠物造型无痛语义映射 ---------------- */

const SHAPE_ALIASES: Record<string, PetShapeId> = {
  blob: "sphere",
  squircle: "square",
  drop: "teardrop",
  capsule: "tablet",
  triangle: "wedge",
};

/** 所有历史 Hob 像素道具 ID 的语义映射（主助手 hob 默认经典纯黑圆球）。 */
const LEGACY_PROP_TO_PET: Record<string, { shape: PetShapeId; color: PetColorId }> = {
  hob: { shape: "sphere", color: "black" },
  page: { shape: "tablet", color: "purple" },
  server: { shape: "hex", color: "gray" },
  bird: { shape: "cloud", color: "blue" },
  house: { shape: "house", color: "teal" },
  coin: { shape: "gem", color: "amber" },
  book: { shape: "tablet", color: "red" },
  leaf: { shape: "leaf", color: "green" },
  wifi: { shape: "sparkle", color: "teal" },
  calendar: { shape: "square", color: "purple" },
  chef: { shape: "bear", color: "cocoa" },
  chart: { shape: "gem", color: "blue" },
  bag: { shape: "bean", color: "blue" },
  paw: { shape: "cat", color: "purple" },
  note: { shape: "starFlower", color: "pink" },
  code: { shape: "hex", color: "blue" },
  mail: { shape: "tablet", color: "teal" },
  camera: { shape: "square", color: "pink" },
  bulb: { shape: "sparkle", color: "amber" },
  heart: { shape: "heart", color: "pink" },
  star: { shape: "star5", color: "amber" },
  cloud: { shape: "cloud", color: "blue" },
  shield: { shape: "ghost", color: "gray" },
  gear: { shape: "hex", color: "gray" },
  coffee: { shape: "bean", color: "cocoa" },
  music: { shape: "starFlower", color: "pink" },
  custom: { shape: "sparkle", color: "orange" },
};

const LEGACY_COLOR_MAP: Record<string, PetColorId> = {
  slate: "gray",
  "minimal-dark": "black",
  "classic-blue": "blue",
  sakura: "pink",
  violet: "purple",
  mint: "green",
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isPetColorId(color: string): color is PetColorId {
  return Object.hasOwn(PET_COLORS, color);
}

export function isHexColor(color: string): boolean {
  return HEX_COLOR.test(color);
}

export function normalizePetColor(color: string): string | undefined {
  if (isPetColorId(color)) return color;
  if (Object.hasOwn(LEGACY_COLOR_MAP, color)) return LEGACY_COLOR_MAP[color];
  if (isHexColor(color)) return color.toLowerCase();
  return undefined;
}

export interface ParsedPet {
  shape: PetShapeId;
  /** 预设颜色 ID 或自定义 #rrggbb */
  color: string;
}

/** 仅解析新宠物造型编码（20 种造型 / 别名 + 11 色 / #rrggbb）。 */
export function parsePetDirect(sprite: string): ParsedPet | undefined {
  if (!sprite) return undefined;
  const parts = sprite.split(":");
  if (parts.length > 2) return undefined;
  const [rawShape, rawColor] = parts;
  const shape: PetShapeId | undefined = Object.hasOwn(PET_SHAPES, rawShape)
    ? (rawShape as PetShapeId)
    : Object.hasOwn(SHAPE_ALIASES, rawShape)
      ? SHAPE_ALIASES[rawShape]
      : undefined;
  if (!shape) return undefined;
  if (rawColor === undefined) return { shape, color: PET_SHAPES[shape].defaultColor };
  const color = normalizePetColor(rawColor);
  if (!color) return undefined;
  return { shape, color };
}

/** 解析任意头像字符串（同时支持新宠物编码与老像素道具 ID），永不抛错。 */
export function resolvePet(sprite: string): {
  shape: PetShapeId;
  color: string;
  body: string;
  eye: string;
  glow: string;
  /** 低亮度本体色（如纯黑）：深色模式下加一层细腻微光描边防止融进黑底 */
  isDarkBody: boolean;
} {
  const direct = parsePetDirect(sprite);
  let shape: PetShapeId;
  let color: string;
  if (direct) {
    shape = direct.shape;
    color = direct.color;
  } else {
    const parts = (sprite || "").split(":");
    const legacy = parts.length <= 2 && Object.hasOwn(LEGACY_PROP_TO_PET, parts[0]) ? LEGACY_PROP_TO_PET[parts[0]] : undefined;
    shape = legacy?.shape ?? "sphere";
    const mappedColor = parts[1] ? normalizePetColor(parts[1]) : undefined;
    color = mappedColor ?? legacy?.color ?? "gray";
  }

  const preset = isPetColorId(color) ? PET_COLORS[color] : undefined;
  const body = preset ? preset.body : isHexColor(color) ? color : PET_COLORS.gray.body;
  const eye = preset ? preset.eye : contrastEyeColor(body);
  const glow = preset ? preset.glow : body;
  return { shape, color, body, eye, glow, isDarkBody: relativeLuminance(body) < 0.08 };
}

/** 组回规范的新宠物 sprite 字符串。 */
export function petSpriteId(shape: PetShapeId, color: string): string {
  const clean = normalizePetColor(color) ?? PET_SHAPES[shape].defaultColor;
  return clean === PET_SHAPES[shape].defaultColor ? shape : `${shape}:${clean}`;
}

/** 新建助手避撞色：同造型已存在时顺延换一个未用颜色（纯黑保留给主助手）。 */
export function distinctPetSprite(sprite: string | undefined, taken: string[]): string {
  const used = new Set(taken.map((item) => {
    const r = resolvePet(item);
    return `${r.shape}:${r.color}`;
  }));
  if (sprite === undefined) {
    const colors = PET_COLOR_IDS.filter(color => color !== "black");
    const presets = PET_SHAPE_IDS.flatMap(shape => colors.map(color => `${shape}:${color}`));
    const free = presets.filter(preset => !used.has(preset));
    const choices = free.length ? free : presets;
    return choices[Math.floor(Math.random() * choices.length)];
  }
  const direct = parsePetDirect(sprite);
  if (!direct) return sprite;
  if (!used.has(`${direct.shape}:${direct.color}`)) return petSpriteId(direct.shape, direct.color);
  const free = PET_COLOR_IDS.find((c) => c !== "black" && !used.has(`${direct.shape}:${c}`));
  return free ? petSpriteId(direct.shape, free) : petSpriteId(direct.shape, direct.color);
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "").trim();
  if (clean.length === 6) {
    return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)];
  }
  return [9, 9, 11];
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 自定义浅色本体（如纯白/浅黄）自动配深色眼睛，保证清晰对比。 */
function contrastEyeColor(bodyHex: string): string {
  return relativeLuminance(bodyHex) > 0.62 ? "#141418" : "#ffffff";
}
