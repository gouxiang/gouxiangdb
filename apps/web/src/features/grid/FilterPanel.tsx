// 筛选面板：and/or 条件组 + 条件行，实时写入 view.config.filters（防抖 400ms）。
// 支持一层嵌套分组。匹配数由 AggregationBar/状态栏的 data.filteredTotal 展示。

import { useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import type { FieldDTO, FilterNode, FilterCondition, FilterGroup, FilterOp } from "@gx/shared-types";
import { operatorsForFieldType, operatorNeedsValue, isFilterMatchSourceType, isTypeComparable } from "@gx/shared-types";
import { Icon } from "../../components/icons";
import { Select, Button, Input } from "../../components/ui";

export interface FilterPanelProps {
  fields: FieldDTO[];
  value: FilterNode | null;
  filteredTotal: number;
  onChange: (next: FilterNode | null) => void;
}

function emptyCondition(field: FieldDTO): FilterCondition {
  const ops = operatorsForFieldType(field.type);
  return { kind: "condition", fieldId: field.id, op: ops[0].id, value: "" };
}

function emptyGroup(): FilterGroup {
  return { kind: "and", children: [] };
}

// 值输入控件（按字段类型）
function ValueInput({ field, op, value, onChange }: { field: FieldDTO; op: FilterOp; value: string; onChange: (v: string) => void }) {
  if (!operatorNeedsValue(op)) return null;
  if (field.type === "singleSelect" && field.options) {
    return (
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        options={[{ value: "", label: "选择…" }, ...field.options.map((o) => ({ value: o.id, label: o.name }))]}
      />
    );
  }
  // 多选单元格存 option.id 数组（见 MultiSelectEditor），筛选值必须同样用 id，
  // 否则按选项名称输入永远匹配不到（arrayContainsAny 按元素严格相等比较）。
  if (field.type === "multiSelect" && field.options) {
    return (
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        options={[{ value: "", label: "选择…" }, ...field.options.map((o) => ({ value: o.id, label: o.name }))]}
      />
    );
  }
  if (["number", "currency", "percent", "duration", "rating"].includes(field.type)) {
    return <Input type="number" value={value} onChange={(e) => onChange(e.target.value)} placeholder="数值" />;
  }
  if (field.type === "date" || field.type === "datetime" || field.type === "createdTime" || field.type === "lastModifiedTime") {
    return <Input type="date" value={value} onChange={(e) => onChange(e.target.value)} />;
  }
  return <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="值" />;
}

// 「匹配字段」值控件：选择同表另一字段（两字段值比较）
function FieldValueInput({ selfFields, valueFieldId, onChange }: { selfFields: FieldDTO[]; valueFieldId: string; onChange: (id: string) => void }) {
  return (
    <Select
      value={valueFieldId}
      onChange={(e) => onChange(e.target.value)}
      options={[{ value: "", label: "选择比较字段…" }, ...selfFields.map((f) => ({ value: f.id, label: f.name }))]}
    />
  );
}

/** 人相关系统字段：createdBy / lastModifiedBy（currentUser 仅对这些字段可选）。 */
function isPersonFieldType(type: string): boolean {
  return type === "createdBy" || type === "lastModifiedBy";
}

// 「当前用户」值控件：不可编辑的提示（实际 userId 由后端按登录态注入）。
function CurrentUserValue() {
  return (
    <div className="flex items-center gap-1.5 rounded-gx-sm border border-gx-border bg-gx-surface px-2 py-1.5 text-gx-12 text-gx-text-secondary">
      <Icon name="user" size={13} />
      <span>当前登录用户</span>
    </div>
  );
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

  const root: FilterGroup = (local as FilterGroup) ?? emptyGroup();

  const updateRoot = (g: FilterGroup) => commit(g.children.length > 0 || g.kind !== "and" ? g : null);

  const updateChild = (idx: number, child: FilterNode) => {
    const children = root.children.map((c, i) => (i === idx ? child : c));
    updateRoot({ ...root, children });
  };
  const removeChild = (idx: number) => {
    const children = root.children.filter((_, i) => i !== idx);
    updateRoot({ ...root, children });
  };
  const addCondition = () => {
    const f = fields[0];
    if (!f) return;
    updateRoot({ ...root, children: [...root.children, emptyCondition(f)] });
  };
  const addGroup = () => {
    updateRoot({ ...root, children: [...root.children, emptyGroup()] });
  };

  const toggleKind = () => updateRoot({ ...root, kind: root.kind === "and" ? "or" : "and" });

  return (
    <div className="flex w-80 flex-col gap-2 p-3">
      <div className="flex items-center justify-between">
        <span className="text-gx-13 font-semibold text-gx-text-primary">筛选条件</span>
        <span className="text-gx-11 text-gx-text-hint">匹配 {filteredTotal} 条</span>
      </div>

      {root.children.length === 0 ? (
        <div className="rounded-gx-lg border border-dashed border-gx-border py-6 text-center text-gx-12 text-gx-text-hint">
          暂无筛选条件
        </div>
      ) : (
        <GroupEditor
          group={root}
          fields={fields}
          depth={0}
          onToggleKind={toggleKind}
          onUpdateChild={updateChild}
          onRemoveChild={removeChild}
        />
      )}

      <div className="flex gap-2">
        <Button size="sm" icon="plus" onClick={addCondition}>
          添加条件
        </Button>
        <Button size="sm" icon="plus" onClick={addGroup}>
          添加条件组
        </Button>
        {local && (
          <Button size="sm" variant="ghost" onClick={() => commit(null)}>
            清空
          </Button>
        )}
      </div>
    </div>
  );
}

function GroupEditor({
  group,
  fields,
  depth,
  onToggleKind,
  onUpdateChild,
  onRemoveChild,
}: {
  group: FilterGroup;
  fields: FieldDTO[];
  depth: number;
  onToggleKind: () => void;
  onUpdateChild: (idx: number, child: FilterNode) => void;
  onRemoveChild: (idx: number) => void;
}) {
  return (
    <div className={clsx("rounded-gx-lg border border-gx-border p-2", depth > 0 && "bg-gx-bg")}>
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          className="rounded-gx-sm bg-gx-accent-bg px-2 py-0.5 text-gx-11 font-medium text-gx-accent"
          onClick={onToggleKind}
        >
          {group.kind === "and" ? "且 (AND)" : "或 (OR)"}
        </button>
      </div>
      <div className="flex flex-col gap-2">
        {group.children.map((child, idx) =>
          child.kind === "condition" ? (
            <ConditionRow
              key={idx}
              cond={child}
              fields={fields}
              onChange={(c) => onUpdateChild(idx, c)}
              onRemove={() => onRemoveChild(idx)}
            />
          ) : child.kind === "and" || child.kind === "or" ? (
            <GroupEditor
              key={idx}
              group={child}
              fields={fields}
              depth={depth + 1}
              onToggleKind={onToggleKind}
              onUpdateChild={onUpdateChild}
              onRemoveChild={onRemoveChild}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}

function ConditionRow({
  cond,
  fields,
  onChange,
  onRemove,
}: {
  cond: FilterCondition;
  fields: FieldDTO[];
  onChange: (c: FilterCondition) => void;
  onRemove: () => void;
}) {
  const field = fields.find((f) => f.id === cond.fieldId) ?? fields[0];
  const ops = operatorsForFieldType(field.type);
  // 同表可作为「匹配字段」来源的字段：物理标量 且 与当前字段类型同组（文本对文本、数字对数字…）
  const selfFields = fields.filter((f) => isFilterMatchSourceType(f.type) && isTypeComparable(field.type, f.type));
  const isFieldMode = cond.valueType === "field";
  const isDynamicMode = cond.valueType === "dynamic";
  const personField = isPersonFieldType(field.type);
  const needVal = operatorNeedsValue(cond.op);

  const setField = (fieldId: string) => {
    const f = fields.find((x) => x.id === fieldId);
    if (f) {
      const fresh = emptyCondition(f);
      onChange(fresh);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-gx-sm border border-gx-separator p-2">
      <div className="flex items-center gap-1.5">
        <Select
          value={cond.fieldId}
          onChange={(e) => setField(e.target.value)}
          options={fields.map((f) => ({ value: f.id, label: f.name }))}
        />
        <button type="button" className="rounded p-1 text-gx-text-hint hover:text-gx-danger" onClick={onRemove}>
          <Icon name="close" size={13} />
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        <Select
          value={cond.op}
          onChange={(e) => onChange({ ...cond, op: e.target.value as FilterOp })}
          options={ops.map((o) => ({ value: o.id, label: o.label }))}
        />
        {needVal && (selfFields.length > 0 || personField) && (
          <div className="flex overflow-hidden rounded-gx-sm border border-gx-border self-start">
            <button
              type="button"
              onClick={() => onChange({ ...cond, valueType: "literal" })}
              className={clsx("px-2 py-1 text-gx-11", !isFieldMode && !isDynamicMode ? "bg-gx-accent text-white" : "bg-gx-surface text-gx-text-secondary hover:bg-gx-bg")}
            >
              自定义
            </button>
            {selfFields.length > 0 && (
              <button
                type="button"
                onClick={() => onChange({ ...cond, valueType: "field" })}
                className={clsx("px-2 py-1 text-gx-11", isFieldMode ? "bg-gx-accent text-white" : "bg-gx-surface text-gx-text-secondary hover:bg-gx-bg")}
              >
                匹配字段
              </button>
            )}
            {personField && (
              <button
                type="button"
                onClick={() => onChange({ ...cond, valueType: "dynamic", dynamicValue: "currentUser" })}
                className={clsx("px-2 py-1 text-gx-11", isDynamicMode ? "bg-gx-accent text-white" : "bg-gx-surface text-gx-text-secondary hover:bg-gx-bg")}
              >
                当前用户
              </button>
            )}
          </div>
        )}
        {needVal && (isDynamicMode && personField ? (
          <CurrentUserValue />
        ) : isFieldMode && selfFields.length > 0 ? (
          <FieldValueInput
            selfFields={selfFields}
            valueFieldId={cond.valueFieldId ?? ""}
            onChange={(id) => onChange({ ...cond, valueType: "field", valueFieldId: id })}
          />
        ) : (
          <ValueInput
            field={field}
            op={cond.op}
            value={cond.value}
            onChange={(v) => onChange({ ...cond, valueType: "literal", value: v })}
          />
        ))}
      </div>
    </div>
  );
}

export default FilterPanel;
