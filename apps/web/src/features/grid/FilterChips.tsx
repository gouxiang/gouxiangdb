// v6 #984 筛选条件 chips（底板 data-table.html .s-grp/.fchip/.fadd 819-835、993-1001）。
//
// 纯展示组件：chips 由 filter-chips.ts 派生，这里只负责渲染与回调，不碰筛选数据结构。
//   条件 chip：字段名（常规 ink-2） + 操作符（b 600 ink-1） + 值（常规） + 16 圆 ×（hover 灰）
//   条件组/排除 chip：整组一个标签，× = 整组删除
//   高级公式 chip：× = 清空全部筛选（clearAll）
//   末尾「+ 添加筛选」：打开筛选 Popover（onAdd）
// 结构：chips 区可裁切（min-w-0 overflow-hidden，不换行、不 overflow-x-auto 以免裁 Popover），
// fadd 在裁切区外、shrink-0 固定常驻。视觉字面值全部在 index.css，本组件零 hex。

import type { FilterChip as Chip } from "./filter-chips";

export interface FilterChipsProps {
  chips: Chip[];
  onRemove: (path: number[]) => void;
  onClearAll: () => void;
  onAdd: () => void;
}

export function FilterChips({ chips, onRemove, onClearAll, onAdd }: FilterChipsProps) {
  return (
    <>
      <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap">
        {chips.map((chip) => {
          const remove = () => (chip.clearAll ? onClearAll() : onRemove(chip.path));
          const label = `移除筛选条件：${chip.label}${chip.opLabel ? ` ${chip.opLabel}` : ""}${chip.valueText ? ` ${chip.valueText}` : ""}`;
          return (
            <span key={chip.key} className="gx-fchip" data-gx-filter-chip={chip.kind}>
              {chip.kind === "cond" ? (
                <>
                  <span>{chip.label}</span>
                  {chip.opLabel ? <b>{chip.opLabel}</b> : null}
                  {chip.valueText ? <span>{chip.valueText}</span> : null}
                </>
              ) : (
                <span>{chip.label}</span>
              )}
              <button
                type="button"
                className="gx-fchip-x"
                onClick={remove}
                title={chip.clearAll ? "清除全部筛选条件" : "移除该条件"}
                aria-label={label}
              >
                ×
              </button>
            </span>
          );
        })}
      </span>
      <button type="button" className="gx-fadd shrink-0" onClick={onAdd} data-gx-filter-add="">
        + 添加筛选
      </button>
    </>
  );
}

export default FilterChips;
