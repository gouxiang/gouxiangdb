// apps/web/src/features/grid/filterAdvanced.tsx
// FilterPanel 高级模式：以公式作为布尔谓词。复用 FormulaBuilder（compact）并可打开
// 完整公式编辑器 FormulaEditorModal。布尔校验采用「前端语法校验 + 后端 fail-closed」：
// 前端只拦截语法/引用/括号/函数元数错误，不做返回类型判定（web 无公式解析器）；
// 后端 safeEvaluateFormula 后严格 asBool，数值/字符串/异常一律不放行。

import { useMemo, useState } from "react";
import type { FieldDTO, FilterNode } from "@gx/shared-types";
import FormulaBuilder from "../designer/FormulaBuilder";
import FormulaEditorModal, { validateFormula } from "../designer/FormulaEditorModal";
import { Button } from "../../components/ui";
import { Icon } from "../../components/icons";

export function formulaNode(expression: string): FilterNode {
  return { kind: "formula", expression };
}

/** 从根节点取高级模式表达式（非 formula 节点返回空串）。 */
export function formulaExpression(node: FilterNode | null): string {
  return node && node.kind === "formula" ? node.expression : "";
}

export function AdvancedModeEditor({
  fields,
  node,
  onChange,
}: {
  fields: FieldDTO[];
  node: FilterNode | null;
  onChange: (next: FilterNode | null) => void;
}) {
  const expression = formulaExpression(node);
  const [editorOpen, setEditorOpen] = useState(false);
  // 语法校验：仅语法层，不含布尔返回类型（类型安全由后端 fail-closed 收口）。
  const errors = useMemo(() => validateFormula(expression, fields), [expression, fields]);
  const isBlank = expression.trim() === "";

  return (
    <div className="flex flex-col gap-2">
      {/* 显著布尔提示 */}
      <div className="flex items-start gap-2 rounded-gx-lg border border-gx-accent/30 bg-gx-accent-bg px-2.5 py-2">
        <Icon name="formula" size={14} className="mt-0.5 shrink-0 text-gx-accent" />
        <div className="text-gx-12 leading-5 text-gx-text-secondary">
          公式必须返回布尔值（真 / 假）。真 = 该记录通过筛选，假 = 被排除。
          示例：<code className="font-mono text-gx-accent">{"{状态} = \"已完成\" && {数量} > 0"}</code>。
          {isBlank && <span className="block text-gx-text-hint">未填写公式时不施加筛选，显示全部记录。</span>}
        </div>
      </div>

      <FormulaBuilder
        compact
        value={expression}
        fields={fields}
        onChange={(next) => onChange(formulaNode(next))}
      />

      {errors.length > 0 ? (
        <div className="rounded-gx-sm bg-gx-danger-bg px-2 py-1.5 text-gx-11 leading-5 text-gx-danger">
          {errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      ) : (
        <div className="text-gx-11 text-gx-text-hint">
          语法校验通过。公式结果若非布尔值，后端将按未命中处理。
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" icon="formula" onClick={() => setEditorOpen(true)}>
          打开完整公式编辑器
        </Button>
      </div>

      {/* currentUser 如实告知 */}
      <div className="rounded-gx-sm bg-gx-bg px-2 py-1.5 text-gx-11 leading-5 text-gx-text-hint">
        公式没有内置「当前用户」变量。需要按当前用户筛选时，请在简易模式对人员字段使用「当前用户」。
      </div>

      {editorOpen && (
        <FormulaEditorModal
          value={expression}
          fields={fields}
          onClose={() => setEditorOpen(false)}
          onConfirm={(formula) => {
            onChange(formulaNode(formula));
            setEditorOpen(false);
          }}
        />
      )}
    </div>
  );
}
