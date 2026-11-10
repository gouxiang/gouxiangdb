// 图表分发件（BI 刀3）：按持久化的 chartType 渲染对应图型，ChartView 只依赖这一个入口。
// 纯渲染 + 零取数；未知/未来新增的图型安全兜底到柱图，避免 switch 漏配导致整视图白屏。

import type { ChartType } from "@gx/shared-types";
import type { ChartDatum } from "./lib/chart-aggregate.js";
import { BarChart } from "./chart-parts.js";
import { HorizontalBarChart } from "./chart-hbar.js";
import { LineChart } from "./chart-line.js";
import { PieChart } from "./chart-pie.js";

export function ChartFigure({ type, data }: { type: ChartType; data: ChartDatum[] }) {
  switch (type) {
    case "horizontalBar":
      return <HorizontalBarChart data={data} />;
    case "line":
      return <LineChart data={data} />;
    case "pie":
      return <PieChart data={data} />;
    case "bar":
    default:
      return <BarChart data={data} />;
  }
}
