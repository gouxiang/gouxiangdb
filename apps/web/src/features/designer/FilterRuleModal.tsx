// apps/web/src/features/designer/FilterRuleModal.tsx
// 筛选规则弹窗：简易模式（顶层 OR、组内 AND）+ 高级模式（任意 AND/OR 嵌套树）
// 数据结构直接用 shared-types 的 FilterNode（and/or/condition），后端 evalFilter 原生支持，无需转换。
// 通过 createPortal 渲染到 body，规避抽屉 transform 破坏 fixed 定位。

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { clsx } from "clsx";
import type { FieldDTO, FilterNode, FilterCondition, FilterOp } from "@gx/shared-types";
import { operatorsForFieldType, FILTER_OP_LABEL, operatorNeedsValue, isTypeComparable } from "@gx/shared-types";
import { Button, Input, Select } from "../../components/ui";
import { Icon } from "../../components/icons";
import { FormField } from "../../components/form";
import FilterSummary from "./FilterSummary";

export interface FilterRuleModalProps {
  value: FilterNode | null;
  /** 对面表候选字段（被筛选的字段） */
  peerFields: FieldDTO[];
  /**
   * 本表字段（用于「匹配字段」值类型：目标表字段 = 本表某字段）。
   * 不传则不显示「匹配字段」切换（如纯对面表筛选）。
   */
  selfFields?: FieldDTO[];
  onClose: () => void;
  onConfirm: (node: FilterNode | null) => void;
}

// ---- 树工具 ----

function emptyCondition(fields: FieldDTO[]): FilterCondition {
  const f = fields[0];
  const op = f ? operatorsForFieldType(f.type)[0]?.id ?? "is" : "is";
  return { kind: "condition", fieldId: f?.id ?? "", op, value: "" };
}

function isGroup(n: FilterNode | null | undefined): n is Extract<FilterNode, { kind: "and" | "or" }> {
  return !!n && (n.kind === "and" || n.kind === "or");
}

/** 规范化：剔除空字段/空值条件，折叠空组、单子组；全空返回 null。
 *  selfFieldIds 非空时用于「匹配字段」模式校验 valueFieldId 有效。 */
function normalize(node: FilterNode | null, validFieldIds: Set<string>, selfFieldIds?: Set<string>): FilterNode | null {
  if (!node) return null;
  if (node.kind === "condition") {
    if (!node.fieldId || !validFieldIds.has(node.fieldId)) return null;
    if (operatorNeedsValue(node.op)) {
      if (node.valueType === "field") {
        if (!node.valueFieldId || !(selfFieldIds?.has(node.valueFieldId) ?? false)) return null;
      } else if (node.value.trim() === "") {
        return null;
      }
    }
    return node;
  }
  if (node.kind === "not") {
    const c = normalize(node.child, validFieldIds, selfFieldIds);
    return c ? { kind: "not", child: c } : null;
  }
  if (node.kind === "formula") {
    // 空公式 = 无筛选 -> 剔除；非空原样保留（字段引用合法性由后端求值侧 mask 收口）
    return node.expression.trim() === "" ? null : node;
  }
  // group
  const kids = node.children
    .map((c) => normalize(c, validFieldIds, selfFieldIds))
    .filter((c): c is FilterNode => c !== null);
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0]!;
  return { kind: node.kind, children: kids };
}

/** 深拷贝树（编辑态） */
function clone(n: FilterNode | null): FilterNode | null {
  return n ? (JSON.parse(JSON.stringify(n)) as FilterNode) : null;
}

export function FilterRuleModal({ value, peerFields, selfFields, onClose, onConfirm }: FilterRuleModalProps) {
  const [mode, setMode] = useState<"simple" | "advanced">("simple");
  const [draft, setDraft] = useState<FilterNode | null>(() => clone(value));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setDraft(clone(value)); }, [value]);

  const validIds = new Set(peerFields.map((f) => f.id));
  const fieldById = new Map(peerFields.map((f) => [f.id, f]));
  const selfFieldsList = selfFields ?? [];

  const selfIds = new Set(selfFieldsList.map((f) => f.id));

  const confirm = () => {
    const norm = normalize(draft, validIds, selfIds);
    // 失效字段检测：草稿里若引用了不存在的字段，阻止确认
    const bad = findInvalidFields(draft, validIds, selfIds);
    if (bad > 0) {
      setError(`有条件引用了已不存在的字段，请删除或改选后再确认（共 ${bad} 处）`);
      return;
    }
    onConfirm(norm);
  };

  const copyAll = () => {
    if (!draft) return;
    const c = clone(draft);
    if (c && c.kind !== "condition") {
      setDraft({ kind: "or", children: [clone(draft)!, c] });
    } else if (c) {
      setDraft({ kind: "and", children: [clone(draft)!, c] });
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/25" onClick={onClose} />
      <div className="relative flex max-h-[88vh] w-full flex-col overflow-hidden rounded-gx-xl bg-gx-surface shadow-xl" style={{ maxWidth: 960 }}>
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-gx-separator px-5 py-3">
          <div className="flex items-center gap-2">
            <Icon name="filter" size={16} className="text-gx-accent" />
            <span className="text-gx-15 font-semibold text-gx-text-primary">筛选数据</span>
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-1 text-gx-text-hint hover:bg-gx-bg">
            <Icon name="close" size={16} />
          </button>
        </div>

        {/* 说明条 */}
        <div className="border-b border-gx-separator bg-gx-bg/50 px-5 py-2.5 text-gx-11 leading-relaxed text-gx-text-secondary">
          <div className="flex gap-1.5"><span className="text-gx-warning">•</span>当关联目标应用的表单字段时，在筛选中选择了表格子字段，则表格中只要有一行满足条件，该数据就会被筛选出来</div>
          <div className="flex gap-1.5"><span className="text-gx-warning">•</span>当关联目标应用的表格子字段时，对同一表格进行筛选，可筛选出符合条件的表格行数据</div>
        </div>

        {/* 模式切换 */}
        <div className="flex items-center justify-center gap-6 border-b border-gx-separator py-2.5">
          {([["simple", "简易模式"], ["advanced", "高级模式"]] as const).map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={clsx(
                "relative pb-1 text-gx-13 font-medium transition-colors",
                mode === m ? "text-gx-text-primary" : "text-gx-text-hint hover:text-gx-text-secondary",
              )}
            >
              {label}
              {mode === m && <span className="absolute -bottom-[5px] left-0 right-0 h-0.5 rounded bg-gx-accent" />}
            </button>
          ))}
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {peerFields.length === 0 ? (
            <div className="py-10 text-center text-gx-12 text-gx-text-hint">请先选择关联表，才能配置筛选条件</div>
          ) : mode === "simple" ? (
            <SimpleEditor draft={draft} setDraft={setDraft} fields={peerFields} fieldById={fieldById} selfFields={selfFieldsList} />
          ) : (
            <AdvancedEditor draft={draft} setDraft={setDraft} fields={peerFields} fieldById={fieldById} selfFields={selfFieldsList} depth={0} />
          )}
        </div>

        {error && <div className="px-5 pb-2 text-gx-12 text-gx-danger">{error}</div>}

        {/* 底部 */}
        <div className="flex items-center justify-between border-t border-gx-separator px-5 py-3">
          <button type="button" onClick={copyAll} disabled={!draft} className="inline-flex items-center gap-1.5 text-gx-12 text-gx-text-secondary hover:text-gx-accent disabled:opacity-40">
            <Icon name="copy" size={13} /> 复制
          </button>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>取消</Button>
            <Button size="sm" variant="primary" onClick={confirm}>确认</Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 找草稿中引用了已删除字段的条件数（含「匹配字段」的本表字段） */
function findInvalidFields(node: FilterNode | null, valid: Set<string>, selfValid?: Set<string>): number {
  if (!node) return 0;
  if (node.kind === "condition") {
    let bad = valid.has(node.fieldId) ? 0 : 1;
    if (bad === 0 && node.valueType === "field" && operatorNeedsValue(node.op)) {
      if (!node.valueFieldId || !(selfValid?.has(node.valueFieldId) ?? false)) bad = 1;
    }
    return bad;
  }
  if (node.kind === "not") return findInvalidFields(node.child, valid, selfValid);
  if (node.kind === "formula") return 0; // 公式引用字段不经本条件校验
  return node.children.reduce((s, c) => s + findInvalidFields(c, valid, selfValid), 0);
}

// ---- 条件行 ----

function ConditionRow({
  cond,
  fields,
  fieldById,
  selfFields,
  onChange,
  onRemove,
}: {
  cond: FilterCondition;
  fields: FieldDTO[];
  fieldById: Map<string, FieldDTO>;
  selfFields: FieldDTO[];
  onChange: (c: FilterCondition) => void;
  onRemove: () => void;
}) {
  const f = fieldById.get(cond.fieldId);
  const invalid = !f;
  const ops = f ? operatorsForFieldType(f.type) : operatorsForFieldType("singleLineText");
  const needVal = operatorNeedsValue(cond.op);

  // 值控件：单选/多选用选项下拉，其余文本输入
  const isSelect = f && (f.type === "singleSelect" || f.type === "multiSelect");
  const selectOptions = f?.options ?? [];

  // 「匹配字段」模式：本表字段必须与对面字段类型同组才可比较（文本对文本、数字对数字…）
  const comparableSelf = f ? selfFields.filter((s) => isTypeComparable(f.type, s.type)) : [];
  const canMatchField = comparableSelf.length > 0;
  const isFieldMode = cond.valueType === "field" && canMatchField;
  const selfInvalid = isFieldMode && !comparableSelf.some((s) => s.id === cond.valueFieldId);

  return (
    <div className={clsx("flex flex-wrap items-center gap-1.5", (invalid || selfInvalid) && "rounded-gx-sm bg-gx-danger-bg/40 px-1.5 py-1")}>
      <Select
        value={cond.fieldId}
        onChange={(e) => {
          const nf = fieldById.get(e.target.value);
          const op = nf ? operatorsForFieldType(nf.type)[0]?.id ?? "is" : "is";
          // 切换被筛选字段时重置值与值类型
          onChange({ ...cond, fieldId: e.target.value, op, value: "", valueType: "literal", valueFieldId: undefined });
        }}
        options={fields.map((x) => ({ value: x.id, label: x.name }))}
        className="min-w-[140px] flex-1"
      />
      <Select
        value={cond.op}
        onChange={(e) => onChange({ ...cond, op: e.target.value as FilterOp, value: operatorNeedsValue(e.target.value as FilterOp) ? cond.value : "" })}
        options={ops.map((o) => ({ value: o.id, label: FILTER_OP_LABEL[o.id] ?? o.label }))}
        className="w-28 flex-shrink-0"
      />
      {needVal && (
        canMatchField ? (
          <>
            <div className="flex flex-shrink-0 overflow-hidden rounded-gx-sm border border-gx-border">
              <button
                type="button"
                onClick={() => onChange({ ...cond, valueType: "literal" })}
                className={clsx("px-2 py-1 text-gx-11", !isFieldMode ? "bg-gx-accent text-white" : "bg-gx-surface text-gx-text-secondary hover:bg-gx-bg")}
              >
                自定义
              </button>
              <button
                type="button"
                onClick={() => onChange({ ...cond, valueType: "field" })}
                className={clsx("px-2 py-1 text-gx-11", isFieldMode ? "bg-gx-accent text-white" : "bg-gx-surface text-gx-text-secondary hover:bg-gx-bg")}
              >
                匹配字段
              </button>
            </div>
            {isFieldMode ? (
              <Select
                value={cond.valueFieldId ?? ""}
                onChange={(e) => onChange({ ...cond, valueType: "field", valueFieldId: e.target.value })}
                options={[
                  { value: "", label: "选择本表同类型字段" },
                  ...comparableSelf.map((s) => ({ value: s.id, label: s.name })),
                ]}
                className="min-w-[130px] flex-1"
              />
            ) : isSelect ? (
              <Select
                value={cond.value}
                onChange={(e) => onChange({ ...cond, valueType: "literal", value: e.target.value })}
                options={[{ value: "", label: "请选择" }, ...selectOptions.map((o) => ({ value: o.name, label: o.name }))]}
                className="min-w-[120px] flex-1"
              />
            ) : (
              <Input
                value={cond.value}
                onChange={(e) => onChange({ ...cond, valueType: "literal", value: e.target.value })}
                placeholder={valuePlaceholder(f?.type)}
                className="min-w-[120px] flex-1"
              />
            )}
          </>
        ) : isSelect ? (
          <Select
            value={cond.value}
            onChange={(e) => onChange({ ...cond, value: e.target.value })}
            options={[{ value: "", label: "请选择" }, ...selectOptions.map((o) => ({ value: o.name, label: o.name }))]}
            className="min-w-[120px] flex-1"
          />
        ) : (
          <Input
            value={cond.value}
            onChange={(e) => onChange({ ...cond, value: e.target.value })}
            placeholder={valuePlaceholder(f?.type)}
            className="min-w-[120px] flex-1"
          />
        )
      )}
      {invalid && <span className="text-gx-11 text-gx-danger">字段已删除</span>}
      {selfInvalid && <span className="text-gx-11 text-gx-danger">匹配字段已删除</span>}
      <button type="button" onClick={onRemove} className="flex-shrink-0 rounded-full p-1 text-gx-text-hint hover:bg-gx-danger-bg hover:text-gx-danger" title="删除条件">
        <Icon name="trash" size={13} />
      </button>
    </div>
  );
}

function valuePlaceholder(type?: string): string {
  switch (type) {
    case "number": case "currency": case "percent": case "duration": case "rating": return "输入数值";
    case "date": case "datetime": return "日期，如 2026-09-05";
    default: return "请输入";
  }
}

// ---- 简易模式：顶层 OR 组，每个 OR 块是一个 AND 组 ----

function SimpleEditor({
  draft,
  setDraft,
  fields,
  fieldById,
  selfFields,
}: {
  draft: FilterNode | null;
  setDraft: (n: FilterNode | null) => void;
  fields: FieldDTO[];
  fieldById: Map<string, FieldDTO>;
  selfFields: FieldDTO[];
}) {
  // 把任意树规整成「顶层 OR，children 为 AND 组/单条件」的简易形态
  const orGroups: FilterNode[][] = (() => {
    if (!draft) return [];
    if (draft.kind === "or") {
      return draft.children.map((c) => (c.kind === "and" ? c.children : [c]));
    }
    if (draft.kind === "and") return [draft.children];
    return [[draft]];
  })();

  const commit = (groups: FilterNode[][]) => {
    const validGroups = groups.map((g) => g.filter(Boolean)).filter((g) => g.length > 0);
    if (validGroups.length === 0) { setDraft(null); return; }
    const children: FilterNode[] = validGroups.map((g) => (g.length === 1 ? g[0]! : { kind: "and" as const, children: g }));
    setDraft(children.length === 1 ? children[0]! : { kind: "or", children });
  };

  const addAndCondition = (gi: number) => {
    const next = orGroups.map((g) => [...g]);
    (next[gi] ?? next[0])!.push(emptyCondition(fields));
    commit(next);
  };
  const addOrGroup = () => {
    commit([...orGroups, [emptyCondition(fields)]]);
  };
  const removeGroup = (gi: number) => commit(orGroups.filter((_, i) => i !== gi));
  const updateCond = (gi: number, ci: number, c: FilterCondition) => {
    const next = orGroups.map((g) => [...g]);
    next[gi]![ci] = c;
    commit(next);
  };
  const removeCond = (gi: number, ci: number) => {
    const next = orGroups.map((g) => [...g]);
    next[gi] = next[gi]!.filter((_, i) => i !== ci);
    commit(next);
  };

  if (orGroups.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <div className="text-gx-12 text-gx-text-hint">尚未设置筛选条件</div>
        <Button variant="primary" size="sm" icon="plus" onClick={addOrGroup}>添加筛选条件</Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {orGroups.map((group, gi) => (
        <div key={gi}>
          {gi > 0 && <div className="my-2 flex items-center gap-2 pl-2 text-gx-12 font-medium text-gx-text-secondary">
            <span className="rounded bg-gx-bg px-1.5 py-0.5">或</span> 满足以下任一条件组
          </div>}
          <div className="rounded-gx-lg border border-gx-border bg-gx-bg/30 p-3">
            <div className="flex flex-col gap-2">
              {group.map((c, ci) => c.kind === "condition" ? (
                <ConditionRow
                  key={ci}
                  cond={c}
                  fields={fields}
                  fieldById={fieldById}
                  selfFields={selfFields}
                  onChange={(nc) => updateCond(gi, ci, nc)}
                  onRemove={() => removeCond(gi, ci)}
                />
              ) : (
                <div key={ci} className="rounded-gx-sm bg-gx-accent-bg/40 px-2 py-1 text-gx-11 text-gx-accent">
                  嵌套条件请在高级模式编辑
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button type="button" onClick={() => addAndCondition(gi)} className="inline-flex items-center gap-1 rounded-gx-sm border border-dashed border-gx-border px-2.5 py-1 text-gx-12 text-gx-text-secondary hover:border-gx-accent hover:text-gx-accent">
                <Icon name="plus" size={12} /> 且条件
              </button>
              {orGroups.length > 1 && (
                <button type="button" onClick={() => removeGroup(gi)} className="inline-flex items-center gap-1 rounded-gx-sm px-2 py-1 text-gx-12 text-gx-text-hint hover:text-gx-danger">
                  <Icon name="trash" size={12} /> 删除该组
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
      <button type="button" onClick={addOrGroup} className="self-start rounded-gx-sm border border-dashed border-gx-border px-3 py-1.5 text-gx-12 text-gx-text-secondary hover:border-gx-accent hover:text-gx-accent">
        + 或条件（新增一组条件，组间为「或」）
      </button>
    </div>
  );
}

// ---- 高级模式：任意嵌套树 ----

function AdvancedEditor({
  draft,
  setDraft,
  fields,
  fieldById,
  selfFields,
  depth,
}: {
  draft: FilterNode | null;
  setDraft: (n: FilterNode | null) => void;
  fields: FieldDTO[];
  fieldById: Map<string, FieldDTO>;
  selfFields: FieldDTO[];
  depth: number;
}) {
  const root: FilterNode = draft ?? { kind: "and", children: [] };

  if (root.kind === "condition") {
    return (
      <div className="rounded-gx-lg border border-gx-border p-3">
        <ConditionRow cond={root} fields={fields} fieldById={fieldById} selfFields={selfFields}
          onChange={(c) => setDraft(c)} onRemove={() => setDraft(null)} />
      </div>
    );
  }

  if (root.kind === "not") {
    return (
      <div className="rounded-gx-lg border border-gx-border bg-gx-bg/30 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-gx-12 font-medium text-gx-text-secondary">非（NOT）</span>
          <button type="button" onClick={() => setDraft(null)} className="text-gx-text-hint hover:text-gx-danger"><Icon name="trash" size={13} /></button>
        </div>
        <AdvancedEditor draft={root.child} setDraft={(n) => setDraft(n ? { kind: "not", child: n } : null)} fields={fields} fieldById={fieldById} selfFields={selfFields} depth={depth + 1} />
      </div>
    );
  }

  if (root.kind === "formula") {
    // 本编辑器不直接编辑公式谓词：公式经筛选面板的高级模式维护
    return (
      <div className="rounded-gx-lg border border-gx-border bg-gx-bg/30 p-3 text-gx-12 leading-5 text-gx-text-secondary">
        高级公式筛选：<code className="font-mono">{root.expression || "（空）"}</code>。
        请在筛选面板的「高级模式」中修改公式。
      </div>
    );
  }

  // group
  const toggleKind = () => setDraft({ ...root, kind: root.kind === "and" ? "or" : "and" } as FilterNode);
  const updateChild = (i: number, n: FilterNode | null) => {
    const children = root.children.map((c, j) => (j === i ? n : c)).filter((c): c is FilterNode => c !== null);
    setDraft({ kind: root.kind, children });
  };
  const addCondition = () => setDraft({ kind: root.kind, children: [...root.children, emptyCondition(fields)] });
  const addGroup = () => setDraft({ kind: root.kind, children: [...root.children, { kind: root.kind === "and" ? "or" : "and", children: [emptyCondition(fields)] }] });

  return (
    <div className={clsx("rounded-gx-lg border p-3", depth === 0 ? "border-gx-border bg-gx-bg/30" : "border-gx-border bg-gx-surface")} style={{ marginLeft: depth > 0 ? 12 : 0 }}>
      <div className="mb-2 flex items-center gap-2">
        <button type="button" onClick={toggleKind} className="inline-flex items-center gap-1 rounded-gx-sm bg-gx-accent px-2 py-0.5 text-gx-12 font-semibold text-white">
          {root.kind === "and" ? "且 AND" : "或 OR"} <Icon name="edit" size={11} />
        </button>
        <span className="text-gx-11 text-gx-text-hint">{root.kind === "and" ? "所有条件都满足" : "任一条件满足"}</span>
      </div>
      <div className="flex flex-col gap-2">
        {root.children.length === 0 && <div className="text-gx-11 text-gx-text-hint">空分组 — 添加条件或子分组</div>}
        {root.children.map((child, i) => (
          <AdvancedEditor key={i} draft={child} setDraft={(n) => updateChild(i, n)} fields={fields} fieldById={fieldById} selfFields={selfFields} depth={depth + 1} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={addCondition} className="inline-flex items-center gap-1 rounded-gx-sm border border-dashed border-gx-border px-2.5 py-1 text-gx-12 text-gx-text-secondary hover:border-gx-accent hover:text-gx-accent">
          <Icon name="plus" size={12} /> 条件
        </button>
        <button type="button" onClick={addGroup} className="inline-flex items-center gap-1 rounded-gx-sm border border-dashed border-gx-border px-2.5 py-1 text-gx-12 text-gx-text-secondary hover:border-gx-accent hover:text-gx-accent">
          <Icon name="plus" size={12} /> 条件分组
        </button>
      </div>
    </div>
  );
}

export default FilterRuleModal;

/**
 * 筛选规则配置字段。
 * - variant="inline"（默认）：小标题 + 行内小按钮 + 摘要（旧布局，供紧凑处使用）
 * - variant="block"：大标题（带问号提示）+ 虚线「设置筛选条件」（未配置）/ 浅底「编辑筛选条件」（已配置）+ 摘要
 * 供字段设置面板 / 字段编辑抽屉 / 默认内容 lookup 复用。
 */
export function FilterRuleField({
  label,
  title,
  value,
  peerFields,
  selfFields,
  onChange,
  variant = "inline",
}: {
  label: string;
  /** 标题旁问号提示文案（block 变体显示问号图标） */
  title?: string;
  value: FilterNode | null;
  peerFields: FieldDTO[];
  /** 本表字段，用于「匹配字段」值类型；不传则不显示该切换 */
  selfFields?: FieldDTO[];
  onChange: (v: FilterNode | null) => void;
  variant?: "inline" | "block";
}) {
  const [open, setOpen] = useState(false);
  const configured = !!value;

  const modal = open && (
    <FilterRuleModal
      value={value}
      peerFields={peerFields}
      selfFields={selfFields}
      onClose={() => setOpen(false)}
      onConfirm={(n) => { onChange(n); setOpen(false); }}
    />
  );

  // 两种变体共用同一套字段骨架（标签上置 + 控件区 + 16px 错误预留行），只是按钮文案/样式与摘要时机不同。
  const control = (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className={
        "flex w-full items-center justify-center gap-1.5 rounded-gx-lg px-3 py-2.5 text-gx-14 transition-colors " +
        (configured
          ? "bg-gx-bg font-medium text-gx-accent hover:bg-gx-accent-bg"
          : "border border-dashed border-gx-border-strong bg-gx-surface text-gx-text-secondary hover:border-gx-accent hover:bg-gx-accent-bg/40 hover:text-gx-accent")
      }
    >
      <Icon name="filter" size={14} />
      {configured ? "编辑筛选条件" : "设置筛选条件"}
    </button>
  );

  const helpIcon = title ? (
    <span title={title} className="inline-flex items-center">
      <Icon name="help" size={13} className="cursor-help text-gx-text-hint" />
    </span>
  ) : undefined;

  if (variant === "block") {
    return (
      <FormField label={label} control="auto" labelExtra={helpIcon}>
        {control}
        {configured && <FilterSummary node={value} fields={peerFields} selfFields={selfFields} />}
        {modal}
      </FormField>
    );
  }

  return (
    <FormField label={label} control="auto" labelExtra={helpIcon}>
      {control}
      <FilterSummary node={value} fields={peerFields} selfFields={selfFields} />
      {modal}
    </FormField>
  );
}
