// 图表纯函数 · 数据提取与聚合层（BI 刀1）
// 无 React / 无 DOM / 无路由依赖，可在 vitest / Worker / Node 任意环境运行。
//
// 后端语义同构说明：
//   apps/api/src/domain/aggregate.ts 不可跨 app import，本文件在 web 内 1:1 复刻其
//   toNum / aggregate 口径并逐函数标注来源行；isEmptyValue 已上移到 @gx/shared-types
//   （packages/shared-types/src/filter.ts），这里直接复用单源，不再复刻第二份。

import type { AggFunc, FieldDTO, RecordDTO } from "@gx/shared-types";
import { isEmptyValue } from "@gx/shared-types";

// 字面对齐 apps/api/src/domain/group.ts 的 EMPTY_GROUP_KEY/EMPTY_GROUP_LABEL；该常量目前未提升到 shared-types，未来若提升应改为 import 单一真源。
export const CHART_EMPTY_KEY = "__empty__";

export const CHART_EMPTY_LABEL = "(空白)";

/** 数组型维度值（multiSelect 等）拼接分隔符：显示文案用顿号，与 cells/format.ts joinArray 一致。 */
const ARRAY_LABEL_SEP = "、 ";

/**
 * 数组型维度分桶 key 的内部拼接分隔符（不出现在 UI，仅用于稳定序列化）。
 * 取 US 控制符（Unit Separator, U+001F）：正常 option id / 业务文本不会包含，
 * 避免空串分隔造成 ["o1","o2"] 与 ["o1o","2"] 碰撞成同一桶。
 */
const ARRAY_KEY_SEP = "\u001F";

/**
 * 单元格空判定：直接复用 shared-types 单源 isEmptyValue。
 * 口径：null/undefined → 空；空字符串 → 空；空数组 → 空；无键对象 → 空；其余非空。
 * 注意字符串不做 trim（" " 非空），与后端 aggregate/filter 严格一致。
 */
export const isEmptyCell = isEmptyValue;

/**
 * 标量强转数字。
 * 1:1 同构 apps/api/src/domain/aggregate.ts:9-15（toNum）：
 *   - number：非有限值（NaN/Infinity）→ null
 *   - boolean：true→1 / false→0
 *   - null/undefined/空串 → null
 *   - 其余字符串：去掉逗号与空白后 Number()，非法 → null
 */
export function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** 单条记录在维度字段上的原始单元格值。 */
function dimensionCell(record: RecordDTO, fieldId: string): unknown {
  return record.fields[fieldId] ?? null;
}

/**
 * 维度分桶 key（稳定序列化字符串）。
 * - 空值统一落 CHART_EMPTY_KEY；
 * - 数组（multiSelect 等）：元素字符串化后排序再拼接，避免同一选项集合因记录内顺序不同裂成多桶；
 * - 标量：String(v)（number/boolean 也走字符串化，桶内比较与 Map 查找均为字符串语义）。
 */
export function dimensionKey(value: unknown): string {
  if (isEmptyCell(value)) return CHART_EMPTY_KEY;
  if (Array.isArray(value)) {
    const parts = value
      .map((v) => String(v ?? ""))
      .filter((s) => s !== "")
      .sort();
    // 非空数组但元素全为空（[""] / [null]）：语义上仍是空维度，并入 __empty__ 桶，
    // 不能让 join 出的空串另立一个 key 为 "" 的幽灵桶。
    if (parts.length === 0) return CHART_EMPTY_KEY;
    return parts.join(ARRAY_KEY_SEP);
  }
  return String(value);
}

/**
 * 维度分桶显示标签。
 * - 空值桶 → CHART_EMPTY_LABEL；
 * - singleSelect 标量 / multiSelect 数组：按 field.options 的 id→name 映射，查不到的 id 回落显示 id 本身；
 * - 其余类型：标量原样 String 化，数组按顿号连接。
 */
export function dimensionLabel(value: unknown, field: FieldDTO): string {
  if (isEmptyCell(value)) return CHART_EMPTY_LABEL;

  const optionName = (id: string): string => {
    const hit = field.options?.find((o) => o.id === id);
    return hit ? hit.name : id;
  };

  if (field.type === "singleSelect") {
    const id = String(value);
    return optionName(id);
  }
  if (field.type === "multiSelect" && Array.isArray(value)) {
    const names = (value as unknown[])
      .map((v) => (v === null || v === undefined ? "" : optionName(String(v))))
      .filter((s) => s !== "");
    // 与 dimensionKey 的幽灵桶守卫同口径：有效元素为空时按 (空白) 呈现。
    return names.length === 0 ? CHART_EMPTY_LABEL : names.join(ARRAY_LABEL_SEP);
  }
  if (Array.isArray(value)) {
    const parts = (value as unknown[])
      .map((v) => (v === null || v === undefined ? "" : String(v)))
      .filter((s) => s !== "");
    return parts.length === 0 ? CHART_EMPTY_LABEL : parts.join(ARRAY_LABEL_SEP);
  }
  return String(value);
}

/**
 * 对一桶单元格值执行聚合。
 * 语义 1:1 对齐 apps/api/src/domain/aggregate.ts:18-44（aggregate）：
 *   - count 系列不做数值强转，count 直接看入参长度；
 *   - percent 系列在 total=0 时返回 null（避免除零）；
 *   - sum/avg/min/max 先 toNum 过滤 null，无数值可聚合时返回 null。
 * 返回 null 表示该桶无可呈现的指标值（几何层据此跳过连线/占位）。
 */
export function computeMetric(func: AggFunc, values: unknown[]): number | null {
  const nums = values.map(toNum).filter((x): x is number => x !== null);
  const total = values.length;

  switch (func) {
    case "count":
      return total;
    case "countEmpty":
      return values.filter(isEmptyCell).length;
    case "countFilled":
      return values.filter((v) => !isEmptyCell(v)).length;
    case "percentEmpty":
      return total === 0 ? null : (values.filter(isEmptyCell).length / total) * 100;
    case "percentFilled":
      return total === 0 ? null : (values.filter((v) => !isEmptyCell(v)).length / total) * 100;
    case "sum":
      return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0);
    case "avg":
      return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length;
    case "min":
      return nums.length === 0 ? null : Math.min(...nums);
    case "max":
      return nums.length === 0 ? null : Math.max(...nums);
    default:
      return null;
  }
}

/** 单个维度桶的聚合结果（几何层 / CSV 层的统一输入）。 */
export interface ChartDatum {
  /** 稳定分桶 key（Map 查找用，含 CHART_EMPTY_KEY）。 */
  key: string;
  /** 桶显示标签（已做选项映射 / 空值文案）。 */
  label: string;
  /** 聚合指标；null = 该桶无可聚合数值（几何层跳过，CSV 留空单元格）。 */
  value: number | null;
  /** 桶内记录数（count 聚合的结果同时也存这里，供 tooltip / 表格视图复用）。 */
  count: number;
  /** 桶内全部记录 id，保持入参 records 的相对顺序。 */
  recordIds: string[];
}

export interface BuildChartDataInput {
  records: readonly RecordDTO[];
  /** 维度字段；null（未配置 / 在 schema 中已找不到）时返回空数组。 */
  dimensionField: FieldDTO | null;
  /** 指标字段；null 时仅 count 类聚合有意义，按整记录入参。 */
  metricFieldId: string | null;
  aggFunc: AggFunc;
}

interface BucketAcc {
  label: string;
  records: RecordDTO[];
}

/**
 * 把 records 按维度字段分桶并逐桶聚合。
 * - 维度字段缺失 → []（调用方负责渲染空态，本函数不造假桶）；
 * - 桶顺序 = 各 key 首次出现顺序（Map 保序），不做排序，把排序决策权留给视图层；
 * - metricFieldId=null 时计数类把整记录作为聚合入参（record 为非空对象，countFilled 恒等于桶大小）。
 */
export function buildChartData(input: BuildChartDataInput): ChartDatum[] {
  const { records, dimensionField, metricFieldId, aggFunc } = input;
  if (!dimensionField) return [];

  const buckets = new Map<string, BucketAcc>();
  for (const record of records) {
    const cell = dimensionCell(record, dimensionField.id);
    const key = dimensionKey(cell);
    const existing = buckets.get(key);
    if (existing) {
      existing.records.push(record);
    } else {
      buckets.set(key, { label: dimensionLabel(cell, dimensionField), records: [record] });
    }
  }

  const out: ChartDatum[] = [];
  for (const [key, acc] of buckets) {
    const metricValues = metricFieldId
      ? acc.records.map((r) => r.fields[metricFieldId] ?? null)
      : acc.records.map((r) => r as unknown);
    out.push({
      key,
      label: acc.label,
      value: computeMetric(aggFunc, metricValues),
      count: acc.records.length,
      recordIds: acc.records.map((r) => r.id),
    });
  }
  return out;
}
