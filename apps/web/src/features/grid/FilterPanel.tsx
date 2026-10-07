// 筛选面板：简易模式（and/or 条件组）与高级模式（公式返回布尔），实时写出（防抖 400ms）。
//
// 模式不额外存储，由根节点推导：value?.kind === "formula" 即高级模式，否则简易模式。
// 切换模式经确认弹窗保护（不做树 ↔ 公式自动转换，避免语义误读）。
// 子部件：filterParts.tsx（简易）、filterAdvanced.tsx（高级）。

import { useEffect, useRef, useState } from "react";
import type { FieldDTO, FilterNode } from "@gx/shared-types";
import { SegmentedControl } from "../../components/ui";
import { confirmAction } from "../../components/feedback";
import { SimpleModeEditor } from "./filterParts";
import { AdvancedModeEditor, formulaNode } from "./filterAdvanced";

export interface FilterPanelProps {
  fields: FieldDTO[];
  value: FilterNode | null;
  filteredTotal: number;
  onChange: (next: FilterNode | null) => void;
}

type FilterMode = "simple" | "advanced";

/** 模式由根节点推导：formula 节点即高级模式；不额外存 mode 字段。 */
function deriveMode(node: FilterNode | null): FilterMode {
  return node?.kind === "formula" ? "advanced" : "simple";
}

export function FilterPanel({ fields, value, filteredTotal, onChange }: FilterPanelProps) {
  // 本地副本 + 防抖写入
  const [local, setLocal] = useState<FilterNode | null>(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocal(value);
  }, [value]);

  const commit = (next: FilterNode | null) => {
    setLocal(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(next), 400);
  };

  const mode = deriveMode(local);

  // 切换模式：确认后丢弃原模式内容（不做树 ↔ 公式自动转换）。
  const switchMode = async (next: FilterMode) => {
    if (next === mode) return;
    const hasContent = mode === "advanced"
      ? (local && local.kind === "formula" ? local.expression.trim() : "") !== ""
      : local !== null;
    if (hasContent) {
      const ok = await confirmAction({
        title: next === "advanced" ? "切换到高级模式？" : "切换到简易模式？",
        confirmText: "切换并清空现有条件",
        description:
          next === "advanced"
            ? "当前简易条件不会转换为公式，切换后需重新编写公式。"
            : "当前公式不会转换为条件组，切换后需重新设置条件。",
        level: 2,
      });
      if (!ok) return;
    }
    // 高级模式起始为空公式节点（编辑器处于可输入态、无筛选）；简易模式为 null（空组即无筛选）
    commit(next === "advanced" ? formulaNode("") : null);
  };

  return (
    <div className="flex w-80 flex-col gap-2 p-3">
      <div className="flex items-center justify-between">
        <span className="text-gx-13 font-semibold text-gx-text-primary">筛选条件</span>
        <span className="text-gx-11 text-gx-text-hint">匹配 {filteredTotal} 条</span>
      </div>

      <SegmentedControl<FilterMode>
        value={mode}
        size="sm"
        onChange={(m) => void switchMode(m)}
        options={[
          { value: "simple", label: "简易模式" },
          { value: "advanced", label: "高级模式" },
        ]}
      />

      {mode === "simple" ? (
        <SimpleModeEditor fields={fields} node={local} onChange={commit} />
      ) : (
        <AdvancedModeEditor fields={fields} node={local} onChange={commit} />
      )}
    </div>
  );
}

export default FilterPanel;
