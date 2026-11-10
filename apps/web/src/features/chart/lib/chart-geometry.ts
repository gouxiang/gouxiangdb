// 图表纯函数 · SVG 几何层（BI 刀1）
// 只输出坐标 / 尺寸 / path d 字符串，零 DOM 触碰、零颜色、零 React。
// SVG 坐标系 y 轴向下：最大值映射到绘图区顶部（小 y），零值落在底边基线（大 y）。

import type { ChartDatum } from "./chart-aggregate.js";

/** 角度制 → 弧度制（饼图起始角等少量换算自带，不引外部工具）。 */
export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

const TWO_PI = Math.PI * 2;

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/**
 * 取数据中绝对值最大的指标值（忽略 null）。
 * 全 null / 空数组 → 0，作为几何层的退化基线（各 ratio 统一为 0，不做除零）。
 */
export function maxAbsoluteValue(data: readonly ChartDatum[]): number {
  let max = 0;
  for (const d of data) {
    if (d.value === null) continue;
    const a = Math.abs(d.value);
    if (a > max) max = a;
  }
  return max;
}

export interface BarRect {
  index: number;
  /** 左上角 x（SVG 坐标）。 */
  x: number;
  /** 左上角 y（SVG 坐标，越大越靠下）。 */
  y: number;
  barWidth: number;
  barHeight: number;
  /** 相对最大绝对值的高度比，已夹 0~1；null 值与零值均为 0。 */
  ratio: number;
}

/**
 * 纵向柱图几何。
 * - 绘图区 = [pad, width-pad] × [pad, height-pad]，柱条从底边基线向上生长；
 * - 每个桶均分一个 slot，柱宽取 slot 的 70%，居中留缝；
 * - 高度按 |value|/maxAbs 归一（负值在刀1 口径下与零同基线，差异留给刀3 图型扩展）；
 * - 空数据返回 []；maxAbs=0 时所有柱高度为 0，坐标仍合法。
 */
export function barGeometry(
  data: readonly ChartDatum[],
  width: number,
  height: number,
  pad = 0,
): BarRect[] {
  const n = data.length;
  if (n === 0) return [];

  const plotW = Math.max(0, width - pad * 2);
  const plotH = Math.max(0, height - pad * 2);
  const slot = plotW / n;
  const barWidth = slot * 0.7;
  const maxAbs = maxAbsoluteValue(data);
  const baselineY = height - pad;

  return data.map((d, index) => {
    const ratio = d.value === null || maxAbs === 0 ? 0 : clamp01(Math.abs(d.value) / maxAbs);
    const barHeight = ratio * plotH;
    return {
      index,
      x: pad + slot * index + (slot - barWidth) / 2,
      y: baselineY - barHeight,
      barWidth,
      barHeight,
      ratio,
    };
  });
}

export interface HorizontalBarRect {
  index: number;
  /** 左上角 x（恒为左基线 pad，条从基线向右生长）。 */
  x: number;
  /** 左上角 y（SVG 坐标，越大越靠下）。 */
  y: number;
  /** 条厚度（纵向），取纵向 slot 的 70%。 */
  barHeight: number;
  /** 条长度（横向）= ratio * plotW。 */
  barLength: number;
  /** 相对最大绝对值的长度比，已夹 0~1；null 值与零值均为 0。 */
  ratio: number;
}

/**
 * 横向条形图几何（barGeometry 的轴向互换版）。
 * - 绘图区 = [pad, width-pad] × [pad, height-pad]，每桶沿纵向均分一个 slot，条从左基线 x=pad 向右生长；
 * - barHeight 取 slot 的 70% 居中留缝；长度按 |value|/maxAbs 归一；
 * - 负值沿用刀1 口径：ratio 取绝对值、条一律向右夹在基线，不做负轴（与 barGeometry 一致）；
 * - 空数据返回 []；maxAbs=0 时所有条长度为 0，坐标仍合法。
 * 渲染层若需「左宽右窄」的非对称留白容纳类别名，应对结果整体平移而非改本函数签名，
 * 以保持与 barGeometry 同构的单 pad 对称契约。
 */
export function horizontalBarGeometry(
  data: readonly ChartDatum[],
  width: number,
  height: number,
  pad = 0,
): HorizontalBarRect[] {
  const n = data.length;
  if (n === 0) return [];

  const plotW = Math.max(0, width - pad * 2);
  const plotH = Math.max(0, height - pad * 2);
  const slot = plotH / n;
  const barHeight = slot * 0.7;
  const maxAbs = maxAbsoluteValue(data);

  return data.map((d, index) => {
    const ratio = d.value === null || maxAbs === 0 ? 0 : clamp01(Math.abs(d.value) / maxAbs);
    const barLength = ratio * plotW;
    return {
      index,
      x: pad,
      y: pad + slot * index + (slot - barHeight) / 2,
      barHeight,
      barLength,
      ratio,
    };
  });
}

export interface PieSlice {
  index: number;
  /** 起始弧度（-90° 起，顺时针）。 */
  startAngle: number;
  /** 结束弧度。 */
  endAngle: number;
  /** SVG arc path d 字符串：M 圆心 L 起点 A 圆弧 L 回圆心。 */
  path: string;
}

function arcPoint(cx: number, cy: number, r: number, angle: number): { x: number; y: number } {
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

/**
 * 饼图几何。
 * - 角度按各片 |value| 占总和比例分配（null 跳过；饼图不表达负值，负号不参与角度）；
 * - 总和为 0 / 无有效数据 → []；
 * - 从正上方（-90°）顺时针排布，末片终点强制收敛到起点 +2π，规避浮点漂移导致的缺口；
 * - 大弧标志 largeArc 按片角是否超过 π 取值。
 */
export function pieGeometry(
  data: readonly ChartDatum[],
  cx: number,
  cy: number,
  r: number,
): PieSlice[] {
  const weights = data.map((d) => (d.value === null ? 0 : Math.abs(d.value)));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total === 0) return [];

  const start0 = degToRad(-90);
  let cursor = start0;

  return data.map((d, index) => {
    const weight = weights[index] ?? 0;
    const startAngle = cursor;
    const isLast = index === data.length - 1;
    const endAngle = isLast ? start0 + TWO_PI : cursor + (weight / total) * TWO_PI;
    cursor = endAngle;

    const p1 = arcPoint(cx, cy, r, startAngle);
    const p2 = arcPoint(cx, cy, r, endAngle);
    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
    const path = [
      `M ${cx} ${cy}`,
      `L ${p1.x} ${p1.y}`,
      `A ${r} ${r} 0 ${largeArc} 1 ${p2.x} ${p2.y}`,
      "Z",
    ].join(" ");

    return { index, startAngle, endAngle, path };
  });
}

export interface LinePoint {
  /** 对应原数据下标（null 点不出点，但 x 仍按全量下标均分，保留时间轴间距）。 */
  index: number;
  x: number;
  y: number;
  value: number;
}

/**
 * 折线图几何。
 * - x 按全量桶数在绘图区均分（单桶时落在绘图区水平中点）；
 * - y 以底边为零基线，value/maxAbs 夹 0~1 后向上映射，负值夹到基线（刀1 口径）；
 * - value 为 null 的桶不产出点，渲染层据此自然断线，不做跨 null 连线。
 */
export function lineGeometry(
  data: readonly ChartDatum[],
  width: number,
  height: number,
  pad = 0,
): LinePoint[] {
  const n = data.length;
  if (n === 0) return [];

  const plotW = Math.max(0, width - pad * 2);
  const plotH = Math.max(0, height - pad * 2);
  const maxAbs = maxAbsoluteValue(data);
  const baselineY = height - pad;

  const points: LinePoint[] = [];
  for (let i = 0; i < n; i += 1) {
    const d = data[i];
    if (!d || d.value === null) continue;
    const x = n === 1 ? pad + plotW / 2 : pad + (plotW * i) / (n - 1);
    const ratio = maxAbs === 0 ? 0 : clamp01(d.value / maxAbs);
    const y = baselineY - ratio * plotH;
    points.push({ index: i, x, y, value: d.value });
  }
  return points;
}
