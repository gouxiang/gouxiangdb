// 图表展示子件（BI 刀2）：最小纵向柱图。
// 纯渲染：几何全部来自 lib/chart-geometry 的 barGeometry，本文件不做任何聚合/取数。
// 颜色纪律：只用 gx-* token className + SVG currentColor；inline 不出现任何颜色，
// 仅由 barGeometry 给出 x/y/width/height 几何值。刀2 单序列统一强调色，多色板留刀3。

import type { ChartDatum } from "./lib/chart-aggregate.js";
import { barGeometry } from "./lib/chart-geometry.js";

// 固定 viewBox 坐标，靠 SVG 自适应缩放到容器宽度，避免量 DOM / 监听 resize。
// 四型图共用同一画布尺寸，切换图型时不跳动；各图型在文件内定义自己的绘图区内缩。
export const VB_WIDTH = 720;
export const VB_HEIGHT = 360;
export const PLOT_HEIGHT = 320;
export const PAD = 40;
// barGeometry(data, VB_WIDTH, PLOT_HEIGHT, PAD) 内部基线 = height - pad；
// 柱条底边（y + barHeight）落在这条线上，基线下方留 80px 给维度标签，不能误写成 PLOT_HEIGHT。
export const BASELINE_Y = PLOT_HEIGHT - PAD;
export const MAX_LABEL_CHARS = 6;

/** 数值标签格式化：整数原样，非整数最多保留 2 位小数；非有限值显式占位，杜绝 NaN。 */
export function formatValue(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return String(Number(v.toFixed(2)));
}

/** 维度标签截断：SVG <text> 无法 CSS 省略号，按字符数硬截断并加省略号。 */
export function truncateLabel(s: string): string {
  return s.length > MAX_LABEL_CHARS ? `${s.slice(0, MAX_LABEL_CHARS)}…` : s;
}

export function BarChart({ data }: { data: ChartDatum[] }) {
  const rects = barGeometry(data, VB_WIDTH, PLOT_HEIGHT, PAD);

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${VB_WIDTH} ${VB_HEIGHT}`} className="w-full" role="img" aria-label="柱图">
        {/* 零值基线：border token，currentColor 描边 */}
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

        {/* 柱条：accent token，currentColor 填充 */}
        <g className="text-gx-accent">
          {rects.map((r) => (
            <rect
              key={`bar-${r.index}`}
              x={r.x}
              y={r.y}
              width={r.barWidth}
              height={r.barHeight}
              rx={3}
              fill="currentColor"
            />
          ))}
        </g>

        {/* 柱顶数值 + 柱底维度标签（fill 走 currentColor，颜色由 gx 文本 token 提供） */}
        <g className="text-gx-text-secondary">
          {rects.map((r) => {
            const d = data[r.index];
            if (!d) return null;
            const cx = r.x + r.barWidth / 2;
            return (
              <text
                key={`value-${r.index}`}
                x={cx}
                y={r.y - 8}
                textAnchor="middle"
                fill="currentColor"
                className="text-gx-11"
              >
                {d.value === null ? "—" : formatValue(d.value)}
              </text>
            );
          })}
        </g>
        <g className="text-gx-text-tertiary">
          {rects.map((r) => {
            const d = data[r.index];
            if (!d) return null;
            const cx = r.x + r.barWidth / 2;
            return (
              <text
                key={`label-${r.index}`}
                x={cx}
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
