// 图表纯函数 · CSV 序列化层（BI 刀1）
// 只把聚合后的 ChartDatum[] 导出为 CSV 字符串，零 React / 零 DOM / 零 fetch。
//
// 后端语义同构说明：
//   apps/api/src/domain/csv.ts 不可跨 app import，本文件 1:1 复刻其 escapeCell
//   （csv.ts:84-91）与 buildCSV 的 BOM + CRLF 口径（csv.ts:93-97）并标注来源。

import type { ChartDatum } from "./chart-aggregate.js";

/**
 * 单个 CSV 单元格转义。
 * 1:1 同构 apps/api/src/domain/csv.ts:84-91（escapeCell）：
 *   1. 公式注入防护：以 =、+、-、@、Tab、CR 开头的单元格前置单引号，强制 Excel/LibreOffice 按文本处理；
 *      必须在引号包裹之前做，否则引号会破坏前导防护；
 *   2. 含逗号 / 双引号 / 换行的单元格用双引号包裹，内部双引号双写。
 */
function escapeCell(v: string): string {
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * 把图表聚合结果序列化为 CSV（含 BOM，CRLF 行分隔）。
 *
 * 列固定两列：
 *   第 1 列 = 维度桶标签（dimensionHeader 命名，通常取维度字段名）；
 *   第 2 列 = 聚合指标（metricHeader 命名，建议由调用层拼「字段名 + 聚合函数标签」）。
 *
 * 空值口径：value=null 的桶在指标列输出空字符串（不是 "null" / "0"），
 * 与后端「无可聚合结果 → 空单元格」保持一致；维度标签恒为非空（空值桶有 (空白) 文案）。
 */
export function chartDataToCsv(
  data: readonly ChartDatum[],
  dimensionHeader: string,
  metricHeader: string,
): string {
  const headerLine = [dimensionHeader, metricHeader].map(escapeCell).join(",");
  const bodyLines = data.map((d) => {
    const dimensionCell = escapeCell(d.label);
    const metricCell = escapeCell(d.value === null ? "" : String(d.value));
    return `${dimensionCell},${metricCell}`;
  });
  // BOM 让 Excel 正确识别 UTF-8 中文；行分隔固定 CRLF（RFC4180，同后端 buildCSV）。
  return "\uFEFF" + [headerLine, ...bodyLines].join("\r\n");
}
