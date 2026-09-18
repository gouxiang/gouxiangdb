// apps/web/src/features/designer/RecordFilterBuilder.tsx
// 子集筛选条件 UI（Rollup / Lookup / Count 字段用）
// 仅支持一个 AND 拼接的条件列表（FilterGroup-and）

import { useEffect, useMemo, useState } from "react";
import type { FieldDTO, FilterNode, FilterOp, FilterCondition } from "@gx/shared-types";
import { operatorsForFieldType, FILTER_OP_LABEL, operatorNeedsValue } from "@gx/shared-types";
import { Input, Select, Button } from "../../components/ui";
import { Icon } from "../../components/icons";

export interface RecordFilterBuilderProps {
  value: FilterNode | null;
  /** 对面表字段列表（Rollup/Count 用的 linkField 指向的 related 表字段） */
  peerFields: FieldDTO[];
  onChange: (v: FilterNode | null) => void;
}

function conditions(node: FilterNode | null | undefined): FilterCondition[] {
  if (!node) return [];
  if (node.kind === "condition") return [node];
  if (node.kind === "and") return node.children.flatMap(conditions);
  return [];
}

function toAndGroup(c: FilterCondition[]): FilterNode | null {
  if (c.length === 0) return null;
  if (c.length === 1) return c[0]!;
  return { kind: "and", children: c };
}

export function RecordFilterBuilder({ value, peerFields, onChange }: RecordFilterBuilderProps) {
  // 编辑期间用扁平列表（多条件用 AND 拼接）
  const [list, setList] = useState<FilterCondition[]>(() => conditions(value));

  useEffect(() => {
    setList(conditions(value));
  }, [value]);

  const update = (next: FilterCondition[]) => {
    setList(next);
    onChange(toAndGroup(next));
  };

  const add = () =>
    update([...list, { kind: "condition", fieldId: peerFields[0]?.id ?? "", op: "is", value: "" }]);

  const remove = (i: number) => update(list.filter((_, j) => j !== i));

  const setOne = (i: number, patch: Partial<FilterCondition>) =>
    update(list.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  if (peerFields.length === 0) {
    return (
      <div className="text-gx-11 text-gx-text-hint">先选择本表的关联字段，才能配置对面表的子集筛选</div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {list.length === 0 && (
        <div className="text-gx-11 text-gx-text-hint">满足以下所有条件的对面记录才会被聚合 / 查阅</div>
      )}

      {list.map((c, i) => {
        const f = peerFields.find((x) => x.id === c.fieldId);
        const ops = f ? operatorsForFieldType(f.type) : operatorsForFieldType("singleLineText");
        const needVal = operatorNeedsValue(c.op);
        return (
          <div key={i} className="flex items-center gap-1.5">
            <Select
              value={c.fieldId}
              onChange={(e) => setOne(i, { fieldId: e.target.value, op: "is", value: "" })}
              options={peerFields.map((x) => ({ value: x.id, label: x.name }))}
              className="min-w-0 flex-shrink"
            />
            <Select
              value={c.op}
              onChange={(e) => setOne(i, { op: e.target.value as FilterOp })}
              options={ops.map((o) => ({ value: o.id, label: FILTER_OP_LABEL[o.id] ?? o.label }))}
              className="flex-shrink-0"
            />
            {needVal && (
              <Input
                value={c.value}
                onChange={(e) => setOne(i, { value: e.target.value })}
                placeholder="值"
                className="min-w-0 flex-1"
              />
            )}
            <button
              type="button"
              onClick={() => remove(i)}
              className="flex-shrink-0 px-1 text-gx-text-hint hover:text-gx-danger"
              title="删除条件"
            >
              {/* 统一用 icons.tsx 的 close 图标，不用字符符号当功能图标 */}
              <Icon name="close" size={13} />
            </button>
          </div>
        );
      })}

      <Button variant="ghost" size="sm" icon="plus" onClick={add} className="self-start">
        添加条件
      </Button>

      <div className="text-gx-11 text-gx-text-hint">多条件之间是「全部满足（AND）」关系</div>
    </div>
  );
}

export default RecordFilterBuilder;
