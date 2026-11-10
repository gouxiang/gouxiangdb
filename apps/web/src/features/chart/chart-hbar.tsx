// 图表展示子件（BI 刀3）：横向条形图。
// 纯渲染：几何全部来自 lib/chart-geometry 的 horizontalBarGeometry，本文件不做聚合/取数。
// 颜色纪律：只用 gx-* token className + SVG currentColor；inline style 不出现，几何值全部来自计算。
//
// 非对称留白：horizontalBarGeometry 是与 barGeometry 同构的「单 pad 对称」契约，不接受左右不同 pad。
// 这里用 pad=0 在一块尺寸精确等于绘图区的虚拟画布上求几何，再整体平移到
// 「左 LABEL_GUTTER 放类别名 / 右 RIGHT_PAD 放数值」的位置，既不改纯函数签名，又拿到非对称留白。

import type { ChartDatum } from "./lib/chart-aggregate.js";
import { horizontalBarGeometry } from "./lib/chart-geometry.js";
import { VB_WIDTH, VB_HEIGHT, formatValue, truncateLabel } from "./chart-parts.js";

// 左基线位置：其外侧留给纵向类别标签（text-anchor=end）。
const LABEL_GUTTER = 120;
const RIGHT_PAD = 40;
const V_PAD = 40;
const PLOT_W = VB_WIDTH - LABEL_GUTTER - RIGHT_PAD;
const PLOT_H = VB_HEIGHT - V_PAD * 2;

export function HorizontalBarChart({ data }: { data: ChartDatum[] }) {
  // pad=0：条基线 x=0、最大长度恰好 PLOT_W，渲染时再平移 LABEL_GUTTER / V_PAD。
  const rects = horizontalBarGeometry(data, PLOT_W, PLOT_H, 0);
  const baselineX = LABEL_GUTTER;

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${VB_WIDTH} ${VB_HEIGHT}`}
        className="w-full"
        role="img"
        aria-label="条形图"
      >
        {/* 竖直零值基线：border token，currentColor 描边 */}
        <g className="text-gx-border">
          <line
            x1={baselineX}
            y1={V_PAD}
            x2={baselineX}
            y2={V_PAD + PLOT_H}
            stroke="currentColor"
            strokeWidth={1.5}
          />
        </g>

        {/* 条：accent token，currentColor 填充 */}
        <g className="text-gx-accent">
          {rects.map((r) => (
            <rect
              key={`hbar-${r.index}`}
              x={baselineX + r.x}
              y={V_PAD + r.y}
              width={r.barLength}
              height={r.barHeight}
              rx={3}
              fill="currentColor"
            />
          ))}
        </g>

        {/* 左侧类别标签：落在基线外侧，右对齐贴近基线 */}
        <g className="text-gx-text-tertiary">
          {rects.map((r) => {
            const d = data[r.index];
            if (!d) return null;
            const cy = V_PAD + r.y + r.barHeight / 2;
            return (
              <text
                key={`cat-${r.index}`}
                x={baselineX - 8}
                y={cy}
                textAnchor="end"
                dominantBaseline="central"
                fill="currentColor"
                className="text-gx-11"
              >
                {truncateLabel(d.label)}
              </text>
            );
          })}
        </g>

        {/* 条右端数值标签（null 显式占位，杜绝 NaN） */}
        <g className="text-gx-text-secondary">
          {rects.map((r) => {
            const d = data[r.index];
            if (!d) return null;
            const cy = V_PAD + r.y + r.barHeight / 2;
            return (
              <text
                key={`hval-${r.index}`}
                x={baselineX + r.barLength + 6}
                y={cy}
                textAnchor="start"
                dominantBaseline="central"
                fill="currentColor"
                className="text-gx-11"
              >
                {d.value === null ? "—" : formatValue(d.value)}
              </text>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
