// 表尾聚合行：按 view.config.aggregations 显示各字段聚合值，点击可切换聚合函数。

import { useState } from "react";
import { clsx } from "clsx";
import type { AggFunc, FieldDTO } from "@gx/shared-types";
import { AGG_FUNC_LABEL } from "@gx/shared-types";
import { Icon } from "../../components/icons";
import { Popover, MenuItem } from "../../components/ui";

// 不同字段类型支持的聚合函数
export function supportedAggFuncs(field: FieldDTO): AggFunc[] {
  const numeric = new Set([
    "number",
    "currency",
    "percent",
    "duration",
    "rating",
    "autoNumber",
    "count",
    "rollup",
  ]);
  const date = new Set(["date", "datetime", "createdTime", "lastModifiedTime"]);
  if (numeric.has(field.type)) {
    return ["sum", "avg", "min", "max", "count", "countEmpty", "countFilled", "percentEmpty", "percentFilled"];
  }
  if (date.has(field.type)) {
    return ["min", "max", "count"];
  }
  // 文本 / 选择 / 关联 / 附件：仅计数类
  return ["count", "countEmpty", "countFilled", "percentEmpty", "percentFilled"];
}

function fmtAgg(value: number | null): string {
  if (value == null) return "—";
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export interface AggregationBarProps {
  fields: FieldDTO[];
  config: Record<string, AggFunc | null>;
  values: Record<string, number | null> | null;
  widthOf: (field: FieldDTO) => number;
  rowHeaderWidth: number;
  primaryFieldId: string;
  onPick: (fieldId: string, func: AggFunc | null) => void;
  /**
   * S8：服务端 degraded 含 computedInMem 时，聚合为受限/降级口径。
   * 已配置聚合的单元格不再展示精确数值，改为「受限」标注，仍可点击改聚合函数；
   * 数据行本身不受影响（在调用方处理），这里只处理统计口径。
   */
  degraded?: boolean;
}

export function AggregationBar({
  fields,
  config,
  values,
  widthOf,
  rowHeaderWidth,
  primaryFieldId,
  onPick,
  degraded = false,
}: AggregationBarProps) {
  const [openField, setOpenField] = useState<string | null>(null);

  return (
    <tr className="bg-gx-bg">
      <td
        className="sticky left-0 z-20 border-b border-r border-gx-separator bg-gx-bg"
        style={{ width: rowHeaderWidth, minWidth: rowHeaderWidth }}
      >
        <div className="flex h-8 items-center px-2 text-gx-11 text-gx-text-hint">
          {degraded ? "聚合·受限" : "聚合"}
        </div>
      </td>
      {fields.map((field) => {
        const func = config[field.id] ?? null;
        const value = values?.[field.id] ?? null;
        const isPrimary = field.id === primaryFieldId;
        const funcs = supportedAggFuncs(field);
        return (
          <td
            key={field.id}
            className={clsx(
              "relative border-b border-r border-gx-separator",
              isPrimary && "sticky z-10 bg-gx-bg",
            )}
            style={{
              width: widthOf(field),
              minWidth: widthOf(field),
              ...(isPrimary ? { left: rowHeaderWidth } : {}),
            }}
          >
            <button
              type="button"
              className="flex h-8 w-full items-center justify-end gap-1 px-2.5 text-right text-gx-12 tabular-nums text-gx-text-secondary hover:bg-gx-row-hover"
              onClick={() => setOpenField((v) => (v === field.id ? null : field.id))}
            >
              {func ? (
                degraded ? (
                  <>
                    <span className="text-gx-text-hint">{AGG_FUNC_LABEL[func]}</span>
                    <span className="font-medium text-gx-text-hint">受限</span>
                  </>
                ) : (
                  <>
                    <span className="text-gx-text-hint">{AGG_FUNC_LABEL[func]}</span>
                    <span className="font-medium text-gx-text-primary">{fmtAgg(value)}</span>
                  </>
                )
              ) : (
                <Icon name="plus" size={12} className="text-gx-text-hint" />
              )}
            </button>
            {openField === field.id && (
              <Popover open onClose={() => setOpenField(null)} align="left" width={180} className="p-1">
                <div className="py-1">
                  {funcs.map((f) => (
                    <MenuItem
                      key={f}
                      label={AGG_FUNC_LABEL[f]}
                      active={func === f}
                      onClick={() => {
                        onPick(field.id, f);
                        setOpenField(null);
                      }}
                    />
                  ))}
                  {func && (
                    <button
                      type="button"
                      className="mt-1 w-full rounded-gx-sm border-t border-gx-separator px-3 py-1.5 text-left text-gx-13 text-gx-danger hover:bg-gx-danger-bg"
                      onClick={() => {
                        onPick(field.id, null);
                        setOpenField(null);
                      }}
                    >
                      清除聚合
                    </button>
                  )}
                </div>
              </Popover>
            )}
          </td>
        );
      })}
    </tr>
  );
}

export default AggregationBar;
