// 图表展示子件（BI 刀3）：折线图。
// 纯渲染：几何全部来自 lib/chart-geometry 的 lineGeometry，本文件不做聚合/取数。
// 颜色纪律：只用 gx-* token className + SVG currentColor；inline 不出现颜色。
//
// 断线契约（关键）：lineGeometry 会跳过 value=null 的桶（不出点），但保留其在全量下标里的
// index 间距。渲染层必须按「相邻点 index 是否连续」拆成多个 <polyline>——index 断档说明中间
// 隔着 null 桶，禁止用一条 polyline 把断点两侧直连（那会捏造出不存在的趋势）。

import type { ChartDatum } from "./lib/chart-aggregate.js";
import { lineGeometry } from "./lib/chart-geometry.js";
import type { LinePoint } from "./lib/chart-geometry.js";
import {
  VB_WIDTH,
  VB_HEIGHT,
  PLOT_HEIGHT,
  PAD,
  BASELINE_Y,
  formatValue,
  truncateLabel,
} from "./chart-parts.js";

const DOT_R = 3.5;

/** 按原始下标连续性把有效点切成多段；index 差 >1（中间隔 null 桶）即另起一段。 */
function toSegments(points: readonly LinePoint[]): LinePoint[][] {
  const segments: LinePoint[][] = [];
  for (const p of points) {
    const last = segments[segments.length - 1];
    if (last && p.index === last[last.length - 1]!.index + 1) {
      last.push(p);
    } else {
      segments.push([p]);
    }
  }
  return segments;
}

export function LineChart({ data }: { data: ChartDatum[] }) {
  const points = lineGeometry(data, VB_WIDTH, PLOT_HEIGHT, PAD);
  const segments = toSegments(points);

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${VB_WIDTH} ${VB_HEIGHT}`}
        className="w-full"
        role="img"
        aria-label="折线图"
      >
        {/* 零值基线 */}
        <g className="text-gx-border">
          <line
            x1={PAD}
            y1={BASELINE_Y}
            x2={VB_WIDTH - PAD}
            y2={BASELINE_Y}
            stroke="currentColor"
            strokeWidth={1.5}
          />
        </g>

        {/* 折线段：单点段不成线，只在下方圆点表达；段内点天然连续，无跨 null 连线 */}
        <g className="text-gx-accent">
          {segments
            .filter((seg) => seg.length >= 2)
            .map((seg, si) => (
              <polyline
                key={`seg-${si}`}
                points={seg.map((p) => `${p.x},${p.y}`).join(" ")}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
        </g>

        {/* 数据点圆点（所有有效点，含孤立单点段） */}
        <g className="text-gx-accent">
          {points.map((p) => (
            <circle key={`dot-${p.index}`} cx={p.x} cy={p.y} r={DOT_R} fill="currentColor" />
          ))}
        </g>

        {/* 点上数值 */}
        <g className="text-gx-text-secondary">
          {points.map((p) => (
            <text
              key={`lval-${p.index}`}
              x={p.x}
              y={p.y - 10}
              textAnchor="middle"
              fill="currentColor"
              className="text-gx-11"
            >
              {formatValue(p.value)}
            </text>
          ))}
        </g>

        {/* 点下维度标签（x 仍按全量下标均分，null 桶位置不产标签因为没有对应有效点） */}
        <g className="text-gx-text-tertiary">
          {points.map((p) => {
            const d = data[p.index];
            if (!d) return null;
            return (
              <text
                key={`llab-${p.index}`}
                x={p.x}
                y={BASELINE_Y + 20}
                textAnchor="middle"
                fill="currentColor"
                className="text-gx-11"
              >
                {truncateLabel(d.label)}
              </text>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
