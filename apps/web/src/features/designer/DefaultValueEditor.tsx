// apps/web/src/features/designer/DefaultValueEditor.tsx
// 字段「默认内容」配置（三种来源）：
//   static  —— 自定义固定值，创建时填入，之后不回填
//   lookup  —— 关联已有数据（静态抓取）：选关联数据表 + 筛选（支持匹配字段）+ 取值字段，唯一命中才填
//   formula —— 公式计算（静态）：仅本表标量字段，编辑期本表依赖字段变化时重算
// 设计语言：全宽大下拉纵向堆叠 + 虚线「设置…」入口 + 浅底主色按钮（对齐参考截图）。
// 字段类型支持哪些来源由 shared-types 的 allowedDefaultSources 决定。

import { useMemo, useState } from "react";
import type { FieldDTO, TableDTO, DefaultConfig, DefaultSourceKind, FieldType } from "@gx/shared-types";
import {
  allowedDefaultSources,
  isFilterMatchSourceType,
  isReferenceableType,
  isTypeAssignable,
  isTypeComparable,
  fieldTypeGroup,
  checkSubtableCompatibility,
  FIELD_GROUP_LABEL,
  FIELD_TYPE_LABEL,
} from "@gx/shared-types";
import { useFields } from "../../api/hooks";
import { Input } from "../../components/ui";
import { DropdownSelect, DashedSetupButton, SoftActionButton } from "../../components/settings-controls";
import { FilterRuleField } from "./FilterRuleModal";
import FormulaEditorModal from "./FormulaEditorModal";

export interface DefaultValueEditorProps {
  /** 正在配置的字段类型 */
  fieldType: FieldType;
  value: DefaultConfig | null;
  onChange: (cfg: DefaultConfig | null) => void;
  /** 本表全部字段（用于 lookup 匹配字段 / formula 引用） */
  selfFields: FieldDTO[];
  /** 全部表（选数据源表）；不含本表也允许（模板表常是别的表） */
  tables: TableDTO[];
  /** 子表格默认关联的目标表 id（subtable 类型时数据源表默认锁定它，仍允许选模板表） */
  subtableTargetTableId?: string | null;
}

const SOURCE_LABEL: Record<DefaultSourceKind, string> = {
  static: "自定义",
  lookup: "关联已有数据",
  formula: "通过公式计算",
};

const SOURCE_HINT: Record<DefaultSourceKind, string> = {
  static: "新建记录时按预设值填入，用户可修改；仅创建时生效，之后不回填。",
  lookup: "按筛选条件从关联数据表取唯一匹配记录的值填入；仅当筛选中「匹配字段」对应的本表字段变化时重新获取，匹配 0 条或多条时不填。",
  formula: "用法同公式字段，但仅在编辑状态下、本表参与计算的字段变化时重算；手动修改的内容予以保留。",
};

/** 按字段类型校验默认内容配置：不支持的来源 / 残缺配置一律清空，避免脏配置落库 */
export function sanitizeDefaultConfig(type: FieldType, cfg: DefaultConfig | null): DefaultConfig | null {
  if (!cfg) return null;
  const allowed = allowedDefaultSources(type);
  if (!allowed.includes(cfg.mode)) return null;
  if (cfg.mode === "static") {
    if (cfg.value === undefined || cfg.value === null || cfg.value === "") return null;
    return cfg;
  }
  if (cfg.mode === "lookup") {
    if (!cfg.sourceTableId) return null;
    return cfg;
  }
  if (!cfg.formula || !cfg.formula.trim()) return null;
  return cfg;
}

const NONE = "__none__";

export function DefaultValueEditor({
  fieldType,
  value,
  onChange,
  selfFields,
  tables,
  subtableTargetTableId,
}: DefaultValueEditorProps) {
  const sources = allowedDefaultSources(fieldType);
  const [formulaOpen, setFormulaOpen] = useState(false);

  // lookup 配置
  const lookup = value?.mode === "lookup" ? value : null;
  const sourceTableId = lookup?.sourceTableId ?? (subtableTargetTableId ?? "") ?? "";
  const sourceFieldsQ = useFields(sources.includes("lookup") && (value?.mode === "lookup") && sourceTableId ? sourceTableId : null);
  const sourceFields = (sourceFieldsQ.data ?? []).filter((f) => isReferenceableType(f.type));

  // 子表格整表抓取：不选单值字段；需要数据源表↔实际目标表结构兼容
  const isSubtable = fieldType === "subtable";

  // 取值字段候选：与宿主字段同类型组（禁止子表格关联文本字段这类跨类型 bug），按组分 optgroup
  const assignableFields = useMemo(
    () => sourceFields.filter((f) => isTypeAssignable(fieldType, f.type)),
    [sourceFields, fieldType],
  );
  const valueFieldGroups = useMemo(() => buildGroupedOptions(assignableFields), [assignableFields]);

  // 子表格：抓取目标表（subtable 实际关联表）字段，做结构兼容性预览
  const targetFieldsQ = useFields(isSubtable && subtableTargetTableId ? subtableTargetTableId : null);
  const targetFields = targetFieldsQ.data ?? [];
  const subtableCompat = useMemo(() => {
    if (!isSubtable || !sourceTableId) return null;
    if (sourceTableId === subtableTargetTableId) {
      return { ok: true as const, note: "数据源表与子表格目标表相同：新建记录时直接关联模板表的全部行（不会复制或删除模板数据）。" };
    }
    if (!subtableTargetTableId) return { ok: false as const, note: "子表格尚未选择关联的数据表。" };
    const compat = checkSubtableCompatibility(
      sourceFields.map((f) => ({ name: f.name, type: f.type })),
      targetFields.map((f) => ({ name: f.name, type: f.type })),
    );
    if (!compat.ok) {
      return { ok: false as const, note: "数据源表与目标表没有任何同名且类型一致的字段，无法抓取。请在目标表建立与模板表同名的字段。" };
    }
    const mm = compat.typeMismatch.length
      ? `；以下同名字段类型不一致将被忽略：${compat.typeMismatch.slice(0, 3).map((x) => `「${x.name}」`).join("、")}`
      : "";
    return { ok: true as const, note: `将按 ${compat.compatible.length} 个同名同类型字段抓取数据，克隆到目标表成为可维护的业务数据${mm}。` };
  }, [isSubtable, sourceTableId, subtableTargetTableId, sourceFields, targetFields]);

  // 「匹配字段」候选：本表物理可比较标量字段（ConditionRow 内再按对面字段类型二次过滤）
  const selfMatchFields = selfFields.filter((f) => isFilterMatchSourceType(f.type));

  if (sources.length === 0) return null;

  const sourceOptions = [
    { value: NONE, label: "不使用默认值" },
    ...sources.map((k) => ({ value: k, label: SOURCE_LABEL[k] })),
  ];

  const setMode = (kind: string) => {
    if (kind === NONE) {
      onChange(null);
      return;
    }
    if (kind === "static") onChange({ mode: "static", value: "" });
    else if (kind === "lookup") {
      onChange({
        mode: "lookup",
        sourceTableId: sourceTableId as never,
        filter: null,
        valueFieldId: null,
      });
    } else if (kind === "formula") {
      onChange({ mode: "formula", formula: "" });
    }
  };

  // 公式可引用字段：本表标量/物理字段（排除 tabs 容器；后端仅取标量值）
  const formulaFields = selfFields.filter((f) => f.type !== "tabs");

  return (
    <div className="flex flex-col gap-2.5">
      {/* 来源选择：全宽大下拉 */}
      <DropdownSelect
        value={value ? value.mode : NONE}
        options={sourceOptions}
        onChange={setMode}
        placeholder="请选择默认内容来源"
      />

      {value === null && (
        <p className="text-gx-11 text-gx-text-hint">新建记录时该字段不预填内容。</p>
      )}

      {value?.mode === "static" && (
        <div className="flex flex-col gap-1.5">
          <StaticValueInput fieldType={fieldType} value={value.value} onChange={(v) => onChange({ mode: "static", value: v })} />
          <p className="text-gx-11 text-gx-text-hint">{SOURCE_HINT.static}</p>
        </div>
      )}

      {value?.mode === "lookup" && (
        <div className="flex flex-col gap-2.5">
          {/* 关联数据表 */}
          <DropdownSelect
            value={sourceTableId}
            placeholder="选择关联数据表"
            options={tables.map((t) => ({ value: t.id, label: t.name }))}
            onChange={(tid) => onChange({ ...value, sourceTableId: tid as never, filter: null, valueFieldId: null })}
          />

          {sourceTableId && (
            <>
              {isSubtable ? (
                /* 子表格整表抓取：不选单值字段，只选数据源表 + 结构兼容提示 */
                <div
                  className={
                    "rounded-gx-lg px-3 py-2 text-gx-12 leading-relaxed " +
                    (subtableCompat && !subtableCompat.ok ? "bg-gx-danger-bg text-gx-danger" : "bg-gx-bg text-gx-text-secondary")
                  }
                >
                  {subtableCompat?.note ?? "将从数据源表整表抓取行到子表格。"}
                </div>
              ) : (
                /* 标量字段抓取：取值字段必须与宿主字段同类型组 */
                <>
                  <DropdownSelect
                    value={(value.valueFieldId as string) ?? ""}
                    placeholder="选择取值字段（需与当前字段类型一致）"
                    groups={[
                      { label: "默认", options: [{ value: "", label: "关联表主显示字段" }] },
                      ...valueFieldGroups,
                    ]}
                    onChange={(fid) => onChange({ ...value, valueFieldId: (fid || null) as never })}
                  />
                  {assignableFields.length === 0 && (
                    <p className="text-gx-11 text-gx-danger">
                      数据源表中没有与当前字段（{FIELD_TYPE_LABEL[fieldType]}）类型一致的字段，无法取值；请更换数据源表或改用其他默认来源。
                    </p>
                  )}
                </>
              )}

              {/* 筛选条件：虚线入口 / 已配置浅底按钮 */}
              <FilterRuleField
                variant="block"
                label="筛选数据"
                title={isSubtable ? "可选：仅抓取满足条件的模板行；不设置则抓取整表" : "仅取唯一匹配记录的值；0 条或多条匹配时不填"}
                value={value.filter}
                peerFields={sourceFields as FieldDTO[]}
                selfFields={selfMatchFields as FieldDTO[]}
                onChange={(n) => onChange({ ...value, filter: n })}
              />
            </>
          )}
          <p className="text-gx-11 leading-relaxed text-gx-text-hint">{SOURCE_HINT.lookup}</p>
        </div>
      )}

      {value?.mode === "formula" && (
        <div className="flex flex-col gap-2">
          {value.formula.trim() ? (
            <>
              <SoftActionButton icon="formula" label="编辑公式计算" onClick={() => setFormulaOpen(true)} />
              <div className="rounded-gx-lg bg-gx-bg px-3 py-2">
                <code className="break-all font-mono text-gx-12 text-gx-text-secondary">{value.formula}</code>
              </div>
            </>
          ) : (
            <DashedSetupButton icon="formula" label="设置通过公式计算" onClick={() => setFormulaOpen(true)} />
          )}
          <p className="text-gx-11 leading-relaxed text-gx-text-hint">{SOURCE_HINT.formula}</p>
          {formulaOpen && (
            <FormulaEditorModal
              value={value.formula}
              fields={formulaFields}
              onClose={() => setFormulaOpen(false)}
              onConfirm={(f) => { onChange({ mode: "formula", formula: f }); setFormulaOpen(false); }}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** static 模式的值输入：按字段类型给合适控件（布尔用勾选、数值用数字框、其余文本）；onChange 回传已转型的原始值 */
function StaticValueInput({ fieldType, value, onChange }: { fieldType: FieldType; value: unknown; onChange: (v: unknown) => void }) {
  const NUMERIC = ["number", "currency", "percent", "duration", "rating"];
  if (fieldType === "checkbox") {
    const checked = value === true || value === "true";
    return (
      <label className="inline-flex items-center gap-2 py-1 text-gx-13 text-gx-text-primary">
        <input
          type="checkbox"
          className="h-4 w-4 accent-gx-accent"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        {checked ? "默认勾选" : "默认不勾选"}
      </label>
    );
  }
  if (NUMERIC.includes(fieldType)) {
    const str = value == null ? "" : String(value);
    return (
      <Input
        type="number"
        value={str}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        placeholder="预设数值"
        className="h-10"
      />
    );
  }
  const str = value == null ? "" : String(value);
  if (fieldType === "singleSelect") {
    return <Input value={str} onChange={(e) => onChange(e.target.value)} placeholder="预设选项名称（需与选项一致）" className="h-10" />;
  }
  return <Input value={str} onChange={(e) => onChange(e.target.value)} placeholder="请输入默认内容" className="h-10" />;
}

/** 把字段列表按类型分组，生成 DropdownSelect 的 groups（值为字段 id） */
function buildGroupedOptions(fields: FieldDTO[]): { label: string; options: { value: string; label: string }[] }[] {
  const byGroup = new Map<string, FieldDTO[]>();
  for (const f of fields) {
    const g = fieldTypeGroup(f.type);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(f);
  }
  const order = ["text", "number", "date", "bool", "select", "link", "attachment"];
  return order
    .filter((g) => byGroup.has(g))
    .map((g) => ({
      label: FIELD_GROUP_LABEL[g as keyof typeof FIELD_GROUP_LABEL],
      options: (byGroup.get(g) ?? []).map((f) => ({ value: f.id, label: f.name })),
    }));
}

export default DefaultValueEditor;
