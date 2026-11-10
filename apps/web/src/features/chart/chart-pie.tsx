// 图表展示子件（BI 刀3）：饼图。
// 纯渲染：弧角 path 全部来自 lib/chart-geometry 的 pieGeometry，本文件不做聚合/取数。
// 单色纪律：不引多色板，用 accent 强调色 + 每片 opacity 坡道区分扇区，再叠一层 surface 描边分离相邻片。
// inline 只出现几何值与 opacity（opacity 非颜色，允许）；fill/stroke 一律 currentColor + gx token className。

import type { ChartDatum } from "./lib/chart-aggregate.js";
import { pieGeometry } from "./lib/chart-geometry.js";
import { VB_WIDTH, VB_HEIGHT, formatValue, truncateLabel } from "./chart-parts.js";

const CX = 220;
const CY = 170;
const RADIUS = 120;
const LEGEND_X = 400;
const LEGEND_TOP = 72;
const LEGEND_LINE = 28;
const SWATCH = 12;

// 单色下区分扇区的透明度坡道，按 index 循环取，避免引入第二色相。
const SLICE_OPACITY = [1, 0.72, 0.52, 0.36, 0.24];
const sliceOpacity = (index: number): number =>
  SLICE_OPACITY[index % SLICE_OPACITY.length] ?? 1;

export function PieChart({ data }: { data: ChartDatum[] }) {
  // total=0（全 0/null）时几何返回 []，但图例仍基于 data 逐桶列出，不空屏。
  const slices = pieGeometry(data, CX, CY, RADIUS);

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${VB_WIDTH} ${VB_HEIGHT}`} className="w-full" role="img" aria-label="饼图">
        {/* 第一遍：填充组，accent 色 + 各自透明度 */}
        <g className="text-gx-accent">
          {slices.map((s) => (
            <path
              key={`pie-fill-${s.index}`}
              d={s.path}
              fill="currentColor"
              opacity={sliceOpacity(s.index)}
            />
          ))}
        </g>

        {/* 第二遍：描边分离组，surface 色，fill=none 只勾边，把相邻扇区 visually 分开 */}
        <g className="text-gx-surface">
          {slices.map((s) => (
            <path
              key={`pie-stroke-${s.index}`}
              d={s.path}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            />
          ))}
        </g>

        {/* 右侧图例：null / 零值扇区角度为 0 不可见，但图例仍列出桶名与值 */}
        <g className="text-gx-text-secondary">
          {data.map((d, index) => {
            const y = LEGEND_TOP + index * LEGEND_LINE;
            return (
              <g key={`legend-${index}`} className="text-gx-11">
                <rect
                  x={LEGEND_X}
                  y={y - SWATCH}
                  width={SWATCH}
                  height={SWATCH}
                  rx={2}
                  fill="currentColor"
                  className="text-gx-accent"
                  opacity={sliceOpacity(index)}
                />
                <text x={LEGEND_X + SWATCH + 6} y={y} dominantBaseline="central" fill="currentColor">
                  {truncateLabel(d.label)}
                </text>
                <text
                  x={VB_WIDTH - 24}
                  y={y}
                  textAnchor="end"
                  dominantBaseline="central"
                  fill="currentColor"
                  className="text-gx-text-tertiary"
                >
                  {d.value === null ? "—" : formatValue(d.value)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
