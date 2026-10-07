// apps/web/src/features/designer/FilterSummary.tsx
// 筛选条件中文摘要：把 FilterNode 渲染成一行可读文本，展示在「编辑筛选规则」按钮下方。

import type { FieldDTO, FilterNode } from "@gx/shared-types";
import { FILTER_OP_LABEL, operatorNeedsValue } from "@gx/shared-types";

export function FilterSummary({ node, fields, selfFields }: { node: FilterNode | null; fields: FieldDTO[]; selfFields?: FieldDTO[] }) {
  if (!node) {
    return <div className="text-gx-11 text-gx-text-hint">未设置筛选条件（默认展示全部关联记录）</div>;
  }
  const fieldById = new Map(fields.map((f) => [f.id, f]));
  const selfById = new Map((selfFields ?? []).map((f) => [f.id, f]));
  const text = renderNode(node, fieldById, selfById, true);
  return (
    <div className="rounded-gx-sm bg-gx-bg px-2 py-1.5 text-gx-11 leading-relaxed text-gx-text-secondary">
      {text}
    </div>
  );
}

function fname(id: string, m: Map<string, FieldDTO>): string {
  return m.get(id)?.name ?? "（已删除字段）";
}

function renderNode(node: FilterNode, m: Map<string, FieldDTO>, sm: Map<string, FieldDTO>, top: boolean): string {
  switch (node.kind) {
    case "condition": {
      const label = FILTER_OP_LABEL[node.op] ?? node.op;
      const needsVal = operatorNeedsValue(node.op);
      if (!needsVal) return `${fname(node.fieldId, m)} ${label}`;
      if (node.valueType === "field") {
        const selfName = node.valueFieldId ? (sm.get(node.valueFieldId)?.name ?? "（本表字段已删除）") : "（未选字段）";
        return `${fname(node.fieldId, m)} ${label} [本表·${selfName}]`;
      }
      return `${fname(node.fieldId, m)} ${label} ${node.value || "…"}`;
    }
    case "not":
      return `非（${renderNode(node.child, m, sm, false)}）`;
    case "formula":
      // 公式谓词摘要：展示公式正文，空表达式注明无筛选
      return node.expression.trim() === "" ? "公式（无筛选）" : `公式：${node.expression}`;
    case "and":
    case "or": {
      const joiner = node.kind === "and" ? " 且 " : " 或 ";
      const parts = node.children.map((c) =>
        c.kind === "condition" ? renderNode(c, m, sm, false) : `（${renderNode(c, m, sm, false)}）`,
      );
      const text = parts.join(joiner);
      return top ? text : text;
    }
  }
}

export default FilterSummary;
