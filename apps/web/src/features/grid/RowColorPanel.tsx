// 行颜色配置面板：三种模式（无 / 按选择字段着色 / 按条件着色）。
// 写入 view.config.rowColor，由 GridView 根据规则给行加左边框颜色。

import { useState } from "react";
import type { FieldDTO, RowColorConfig, RowColorCondition, RowColorMode } from "@gx/shared-types";
import { operatorsForFieldType, FILTER_OP_LABEL } from "@gx/shared-types";
import { Icon } from "../../components/icons";
import { FieldIcon, Select, SegmentedControl, Button, ColorPicker } from "../../components/ui";

export interface RowColorPanelProps {
  fields: FieldDTO[];
  value: RowColorConfig;
  onChange: (next: RowColorConfig) => void;
}

/** 行颜色条件可依据的字段：grid 中有标量值的字段（排除容器/子表格/附件） */
function colorConditionFields(fields: FieldDTO[]): FieldDTO[] {
  return fields.filter((f) => f.type !== "tabs" && f.type !== "subtable" && f.type !== "attachment");
}

function newCondition(fields: FieldDTO[]): RowColorCondition {
  const usable = colorConditionFields(fields);
  const f = usable[0];
  return { id: `rc-${Date.now()}`, fieldId: f?.id ?? "", op: "is", value: "", color: "#D3F0E4" };
}

export function RowColorPanel({ fields, value, onChange }: RowColorPanelProps) {
  const [draft, setDraft] = useState<RowColorCondition | null>(null);

  const setMode = (mode: RowColorMode) => {
    if (mode === "bySelect") {
      const sel = fields.find((f) => f.type === "singleSelect");
      onChange({ mode, fieldId: sel?.id, conditions: [] });
    } else if (mode === "byCondition") {
      onChange({ mode, conditions: value.conditions.length ? value.conditions : [newCondition(fields)] });
    } else {
      onChange({ mode: "none", conditions: [] });
    }
  };

  const selectFields = fields.filter((f) => f.type === "singleSelect");

  return (
    <div className="flex w-80 flex-col gap-3 p-3">
      <span className="text-gx-13 font-semibold text-gx-text-primary">行颜色</span>

      <SegmentedControl<RowColorMode>
        value={value.mode}
        onChange={setMode}
        options={[
          { value: "none", label: "无" },
          { value: "bySelect", label: "按选择" },
          { value: "byCondition", label: "按条件" },
        ]}
      />

      {value.mode === "bySelect" && (
        <div className="flex flex-col gap-1.5">
          <span className="text-gx-12 text-gx-text-secondary">着色字段（按选项颜色）</span>
          <Select
            value={value.fieldId ?? ""}
            onChange={(e) => onChange({ ...value, fieldId: e.target.value })}
            options={[
              { value: "", label: "选择字段…" },
              ...selectFields.map((f) => ({ value: f.id, label: f.name })),
            ]}
          />
        </div>
      )}

      {value.mode === "byCondition" && (
        <div className="flex flex-col gap-2">
          {value.conditions.map((c) => (
            <ConditionRow
              key={c.id}
              cond={c}
              fields={fields}
              onChange={(next) =>
                onChange({ ...value, conditions: value.conditions.map((x) => (x.id === c.id ? next : x)) })
              }
              onRemove={() =>
                onChange({ ...value, conditions: value.conditions.filter((x) => x.id !== c.id) })
              }
            />
          ))}
          <Button
            size="sm"
            icon="plus"
            variant="ghost"
            onClick={() => onChange({ ...value, conditions: [...value.conditions, newCondition(fields)] })}
          >
            添加条件
          </Button>
        </div>
      )}
    </div>
  );
}

function ConditionRow({
  cond,
  fields,
  onChange,
  onRemove,
}: {
  cond: RowColorCondition;
  fields: FieldDTO[];
  onChange: (c: RowColorCondition) => void;
  onRemove: () => void;
}) {
  const usable = colorConditionFields(fields);
  const field = usable.find((f) => f.id === cond.fieldId) ?? usable[0];
  // 操作符按字段类型给出（与筛选一致），避免对文本用大小于、对日期用包含等无意义组合
  const ops = field
    ? operatorsForFieldType(field.type).map((o) => ({ value: o.id, label: FILTER_OP_LABEL[o.id] ?? o.label }))
    : [{ value: "is", label: "是" }];
  const needsValue = !["isEmpty", "isNotEmpty", "checked", "unchecked"].includes(cond.op);
  const optionVals = field?.type === "singleSelect" && field.options
    ? field.options.map((o) => ({ value: o.id, label: o.name }))
    : [];

  return (
    <div className="flex flex-col gap-1.5 rounded-gx-md border border-gx-separator p-2">
      <div className="flex items-center gap-1.5">
        <FieldIcon type={field?.type ?? "field"} size={13} />
        <Select
          value={cond.fieldId}
          onChange={(e) => {
            const nf = usable.find((x) => x.id === e.target.value);
            const op = nf ? operatorsForFieldType(nf.type)[0]?.id ?? "is" : "is";
            onChange({ ...cond, fieldId: e.target.value, op, value: "" });
          }}
          options={usable.map((f) => ({ value: f.id, label: f.name }))}
        />
        <button type="button" className="rounded p-1 text-gx-text-hint hover:text-gx-danger" onClick={onRemove}>
          <Icon name="close" size={13} />
        </button>
      </div>
      <div className="flex items-center gap-1.5">
        <Select value={cond.op} onChange={(e) => onChange({ ...cond, op: e.target.value })} options={ops} />
        {needsValue &&
          (optionVals.length ? (
            <Select value={cond.value} onChange={(e) => onChange({ ...cond, value: e.target.value })} options={optionVals} />
          ) : (
            <input
              value={cond.value}
              onChange={(e) => onChange({ ...cond, value: e.target.value })}
              className="h-8 flex-1 rounded-gx-md border border-gx-border bg-gx-surface px-2 text-gx-13"
              placeholder="值"
            />
          ))}
        <ColorPicker value={cond.color} onChange={(c) => onChange({ ...cond, color: c })} />
      </div>
    </div>
  );
}

export default RowColorPanel;
