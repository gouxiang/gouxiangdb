// apps/web/src/features/detail/FieldSettingsPanel.tsx
// 右侧字段设置面板：从 FieldEditorSheet 抽取的通用字段配置 UI
// 用于表单设计器右侧，也可单独使用。

import { useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import { useFields, useGXMutations, useLookupTargets, useRelationTypes } from "../../api/hooks";
import type {
  FieldDTO,
  FieldIdT,
  FieldType,
  FieldWidthPct,
  FilterNode,
  PermissionSet,
  SelectOption,
  TableDTO,
  TabConfig,
  DefaultConfig,
  NumberRule,
} from "@gx/shared-types";
import { FIELD_TYPE_LABEL, allowedDefaultSources, isFilterMatchSourceType, isNumberRuleEmpty, isReferenceableType, rollupAggOptions } from "@gx/shared-types";
import { Button, Checkbox, FieldIcon, Input, Select, toast } from "../../components/ui";
import { COLOR_PALETTE } from "../../components/ui";
import { Icon } from "../../components/icons";
import { draftFromField, isDirty, type FieldDraft } from "../designer/field-editor-dirty";
// 字段名称长度上限与 FieldEditorSheet 同源（后端 Zod 也是 80，超限 400 too_big）
import { FIELD_NAME_MAX } from "../designer/FieldEditorSheet";
import { Form, FormActions, FormField, FormRow, FormSection } from "../../components/form";
import { FilterRuleField } from "../designer/FilterRuleModal";
import FormulaEditorModal from "../designer/FormulaEditorModal";
import { DefaultValueEditor } from "../designer/DefaultValueEditor";
import { sanitizeDefaultConfig } from "../designer/DefaultValueEditor";
import { NumberRuleEditor } from "../designer/NumberRuleEditor";

export interface FieldSettingsPanelProps {
  field: FieldDTO | null;
  allFields: FieldDTO[];
  tables: TableDTO[];
  tableId: string;
  baseId: string;
  permissions: PermissionSet;
  /** 当前字段在设计器中的宽度占比 */
  widthPct?: FieldWidthPct;
  onWidthChange?: (w: FieldWidthPct) => void;
  /** 当前字段在设计器中是否隐藏 */
  hidden?: boolean;
  onHiddenChange?: (hidden: boolean) => void;
}

const RELATION_DESC: Record<string, string> = {
  mm: "多对多：本表一条记录可关联目标表多条记录，目标表也会显示反向关联。",
  hm: "一对多：本表一条记录可关联目标表多条记录。反向为多对一（目标表字段为单值）。",
  bt: "多对一：本表多条记录关联目标表一条记录。反向为一对多（目标表字段为多值）。",
};

const SYSTEM_DESC: Record<string, string> = {
  createdTime: "系统自动记录记录创建时间，不可手动配置。",
  lastModifiedTime: "系统自动记录最后修改时间，不可手动配置。",
  createdBy: "系统自动记录创建人，不可手动配置。",
  lastModifiedBy: "系统自动记录最后修改人，不可手动配置。",
};

const WIDTH_OPTIONS: FieldWidthPct[] = [25, 50, 75, 100];

export function FieldSettingsPanel({
  field,
  allFields,
  tables,
  tableId,
  // baseId 预留
  permissions,
  widthPct,
  onWidthChange,
  hidden,
  onHiddenChange,
}: FieldSettingsPanelProps) {
  const m = useGXMutations();
  const relationTypesQ = useRelationTypes();
  const relationTypes = relationTypesQ.data ?? [];

  const [name, setName] = useState("");
  const [type, setType] = useState<FieldType>("singleLineText");
  const [options, setOptions] = useState<SelectOption[]>([]);
  const [precision, setPrecision] = useState(0);
  const [dateDefaultNow, setDateDefaultNow] = useState(false);
  const [relTableId, setRelTableId] = useState("");
  const [relKind, setRelKind] = useState<"mm" | "hm" | "bt">("mm");
  const [displayFieldId, setDisplayFieldId] = useState("");
  const [linkFieldId, setLinkFieldId] = useState("");
  const [subFieldId, setSubFieldId] = useState("");
  const [rollupFn, setRollupFn] = useState<"sum" | "avg" | "min" | "max" | "count">("sum");
  const [formula, setFormula] = useState("");
  const [recordFilter, setRecordFilter] = useState<FilterNode | null>(null);
  // 默认内容三态
  const [defaultConfig, setDefaultConfig] = useState<DefaultConfig | null>(null);
  // 自动编号规则
  const [numberRule, setNumberRule] = useState<NumberRule | null>(null);
  const [tabs, setTabs] = useState<TabConfig[]>([]);
  const [displayedFieldIds, setDisplayedFieldIds] = useState<FieldIdT[]>([]);
  const [visibleFieldIds, setVisibleFieldIds] = useState<FieldIdT[]>([]);
  // 公式编辑器弹窗
  const [formulaModalOpen, setFormulaModalOpen] = useState(false);
  const [helpText, setHelpText] = useState("");
  const [required, setRequired] = useState(false);
  const [unique, setUnique] = useState(false);
  const [maxLength, setMaxLength] = useState<number | null>(null);

  useEffect(() => {
    setName(field?.name ?? "");
    setType(field?.type ?? "singleLineText");
    setOptions(field?.options ?? []);
    setPrecision(field?.precision ?? 0);
    setDateDefaultNow((field as { defaultNow?: boolean } | null)?.defaultNow ?? false);
    setRelTableId(field?.relatedTableId ?? "");
    setRelKind((field?.relationKind as "mm" | "hm" | "bt") ?? "mm");
    setDisplayFieldId(field?.linkDisplayFieldId ?? "");
    setLinkFieldId(field?.linkFieldId ?? "");
    setSubFieldId(field?.lookupFieldId ?? "");
    setRollupFn(field?.rollupFunction ?? "sum");
    setFormula(field?.formula ?? "");
    setRecordFilter((field as { recordFilter?: FilterNode | null } | null)?.recordFilter ?? null);
    setDefaultConfig((field as { defaultConfig?: DefaultConfig | null } | null)?.defaultConfig ?? null);
    setNumberRule((field as { numberRule?: NumberRule | null } | null)?.numberRule ?? null);
    setTabs((field as { tabsConfig?: TabConfig[] | null } | null)?.tabsConfig ?? []);
    setDisplayedFieldIds((field as { displayedFieldIds?: FieldIdT[] | null } | null)?.displayedFieldIds ?? []);
    setVisibleFieldIds((field as { visibleFieldIds?: FieldIdT[] | null } | null)?.visibleFieldIds ?? []);
    // 提示对应后端 description（旧代码误读 helpText，导致提示永不回显）
    setHelpText(field?.description ?? "");
    setRequired((field as { required?: boolean } | null)?.required ?? false);
    setUnique((field as { unique?: boolean } | null)?.unique ?? false);
    setMaxLength((field as { maxLength?: number | null } | null)?.maxLength ?? null);
  }, [field?.id]);

  const targetFieldsQ = useFields(relTableId || null);
  // 关联显示字段/筛选：排除 tabs/subtable 纯容器，不可被引用
  const targetFields = (targetFieldsQ.data ?? []).filter((f) => isReferenceableType(f.type));
  // 公式可引用字段：排除纯容器 tabs；保留 links/subtable（跨表取数函数需要引用它们）
  const formulaFields = allFields.filter((f) => f.type !== "tabs");
  // 「匹配字段」值来源：本表物理可比较标量字段（排除容器/计算/系统/附件/JSON）
  const selfMatchFields = allFields.filter((f) => isFilterMatchSourceType(f.type));
  const linkFields = allFields.filter((f) => f.type === "links");
  const subFieldsQ = useLookupTargets(linkFieldId || null);
  const subFields = (subFieldsQ.data ?? []).filter((f) => isReferenceableType(f.type));

  const reverseName = useMemo(() => {
    const rt = relationTypes.find((r) => r.id === relKind);
    return rt?.reverse ?? "";
  }, [relKind, relationTypes]);

  const cycleColor = (idx: number) => {
    setOptions((prev) => {
      const copy = [...prev];
      const cur = copy[idx]!;
      const ci = COLOR_PALETTE.indexOf(cur.color);
      const next = COLOR_PALETTE[(ci + 1) % COLOR_PALETTE.length]!;
      copy[idx] = { ...cur, color: next };
      return copy;
    });
  };
  useEffect(() => {
    if (type === "tabs" && tabs.length === 0) {
      setTabs([{ id: `tab_${Date.now()}`, name: "基本信息", fieldIds: [] }]);
    }
  }, [type]);
  const addOption = () =>
    setOptions((prev) => [...prev, { id: `opt_${Date.now()}_${prev.length}`, name: "新选项", color: COLOR_PALETTE[prev.length % COLOR_PALETTE.length]! }]);
  const removeOption = (i: number) => setOptions((prev) => prev.filter((_, j) => j !== i));

  const isSystem = ["createdTime", "lastModifiedTime", "createdBy", "lastModifiedBy"].includes(type);
  const isRelated = type === "links";
  const isSubtable = type === "subtable";
  // 关联已建立双向配对（linkFieldId 指向反向字段）后，关联表/关系类型不可再改：
  // 改表会导致反向字段与 link_row 仍指旧表而数据断链。需改表请删除重建。
  const isLinkLocked = (isRelated || isSubtable) && !!field?.linkFieldId;
  const isLookupLike = type === "lookup" || type === "rollup" || type === "count";
  // 名称超长：新建时 maxLength 已拦住，只有改存量长名（>80，后端本就会 400）才可能命中
  const nameTooLong = name.length > FIELD_NAME_MAX;
  const canSave = permissions.canManageSchema && !!name.trim() && field != null && !nameTooLong;
  // 与 FieldEditorSheet 同源的脏检查投影（F-01 收口）：本面板可额外编辑提示/必填/唯一/长度
  const collectDraft = (): FieldDraft => ({
    name,
    type,
    options,
    precision,
    defaultNow: dateDefaultNow,
    relTableId: relTableId || null,
    relKind,
    displayFieldId: displayFieldId || null,
    linkFieldId: linkFieldId || null,
    subFieldId: subFieldId || null,
    rollupFn,
    formula,
    recordFilter,
    defaultConfig,
    numberRule,
    tabs,
    displayedFieldIds,
    visibleFieldIds,
    description: helpText,
    required,
    unique,
    maxLength,
  });

  const buildPayload = (): Record<string, unknown> => {
    const data: Record<string, unknown> = { name: name.trim(), type };
    // id 类字段空值统一发 null（清空），避免空串落库或 undefined 被跳过
    const idOrNull = (v: string): string | null => (v && v.trim() ? v : null);
    // 通用属性（后端 createSchema/updateSchema 支持 required/unique/description/maxLength）
    data.required = required;
    data.unique = unique;
    // 提示 = description：总是发送，空串用于清空（旧逻辑仅在非空时发送，导致提示无法清除）
    data.description = helpText.trim();
    if (type === "singleLineText") data.maxLength = maxLength;
    if (["singleSelect", "multiSelect"].includes(type)) data.options = options;
    if (["number", "currency", "percent", "duration"].includes(type)) data.precision = precision;
    if (type === "date" || type === "datetime") data.defaultNow = dateDefaultNow;
    if (isRelated) {
      data.relatedTableId = idOrNull(relTableId);
      data.relationKind = relKind;
      data.linkDisplayFieldId = idOrNull(displayFieldId);
      data.recordFilter = recordFilter ?? null;
    }
    if (isLookupLike) {
      data.linkFieldId = idOrNull(linkFieldId);
      if (type === "lookup" || type === "rollup") data.lookupFieldId = idOrNull(subFieldId);
      if (type === "rollup" || type === "count") data.rollupFunction = type === "count" ? "count" : rollupFn;
      data.recordFilter = recordFilter ?? null;
    }
    if (type === "formula") data.formula = formula;
    // tabs 的 tabsConfig 由表单设计器画布所见即所得地维护并在保存布局时统一落库，
    // 右栏不再发送，避免用陈旧的字段初始值覆盖画布上的选项卡/字段归属改动。
    if (type === "subtable") {
      // 子表格关系固定为一对多（hm），隐藏关系类型选择
      data.relatedTableId = idOrNull(relTableId);
      data.relationKind = "hm";
      data.linkDisplayFieldId = idOrNull(displayFieldId);
      data.displayedFieldIds = displayedFieldIds;
      data.visibleFieldIds = visibleFieldIds;
      data.recordFilter = recordFilter ?? null;
    }
    // 默认内容：仅支持的类型发送（null 表示清空）
    if (allowedDefaultSources(type).length > 0) {
      data.defaultConfig = sanitizeDefaultConfig(type, defaultConfig);
    }
    if (type === "autoNumber") {
      data.numberRule = numberRule && !isNumberRuleEmpty(numberRule) ? numberRule : null;
    }
    return data;
  };

  const handleSave = async () => {
    if (!canSave || !field) return;
    // F-01 同源守卫：没做任何修改时不再发 no-op PATCH 并提示「已保存字段设置」。
    // 与 FieldEditorSheet 同一口径（成功必须有可见变化），复用同一份脏判定。
    if (!isDirty(collectDraft(), draftFromField(field))) {
      toast("没有修改，无需保存", "info");
      return;
    }
    try {
      await m.updateField.mutateAsync({
        fieldId: field.id,
        data: buildPayload(),
        tableId,
      });
      toast("已保存字段设置", "success");
    } catch (err) {
      toast((err as Error).message || "保存失败", "error");
    }
  };

  if (!field) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
        <Icon name="form" size={26} className="text-gx-text-hint" />
        <span className="text-gx-13 text-gx-text-secondary">在表单中选择一个字段</span>
        <span className="text-gx-11 text-gx-text-hint">即可在此编辑字段属性</span>
      </div>
    );
  }

  // 选项卡分组：纯视觉容器，无字段值、无字段名/必填/默认值/宽度等属性。
  // 它唯一的「设置」就是选项卡列表，而那部分在中间画布上所见即所得地操作。
  if (field.type === "tabs") {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-gx-separator px-4 py-3">
          <div className="flex items-center gap-2">
            <FieldIcon type="tabs" size={16} />
            <span className="text-gx-14 font-semibold text-gx-text-primary">{FIELD_TYPE_LABEL.tabs}</span>
          </div>
          <div className="mt-0.5 truncate text-gx-11 text-gx-text-secondary">纯视觉容器 · 无字段值</div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <div className="flex flex-col gap-2 rounded-gx-lg bg-gx-bg px-3 py-2.5 text-gx-12 text-gx-text-secondary">
            <div className="font-medium text-gx-text-primary">选项卡分组</div>
            <p className="leading-relaxed text-gx-11 text-gx-text-hint">
              这是一个纯视觉容器（类似分组），本身不存数据、不需要字段名，也不能被关联、公式、查阅或聚合引用。
            </p>
            <p className="leading-relaxed text-gx-11 text-gx-text-hint">
              选项卡的添加、重命名、删除，以及把字段拖入各选项卡并排列多列布局，请直接在中间画布上所见即所得地操作。
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-gx-separator px-4 py-3">
        <div className="flex items-center gap-2">
          <FieldIcon type={type} size={16} />
          <span className="text-gx-14 font-semibold text-gx-text-primary">{FIELD_TYPE_LABEL[type]}</span>
        </div>
        <div className="mt-0.5 truncate text-gx-11 text-gx-text-secondary">{field.name}</div>
      </div>

      {/* 阶段 2：页面/面板表单走统一骨架 —— 12 栅格 + gap 12 + 控件 34 + 错误行 16px 预留 */}
      <Form variant="page" padding={false} className="flex-1 overflow-y-auto px-4 py-4">
        {/* 基本属性 */}
        <FormSection title="基本属性">
          <FormRow>
            <FormField
              label="标题"
              required={!isSystem}
              help={isSystem ? SYSTEM_DESC[type] : undefined}
              error={nameTooLong ? `字段名称最多 ${FIELD_NAME_MAX} 个字符，请精简后再保存` : undefined}
              labelExtra={
                <span className={nameTooLong ? "!text-gx-danger" : undefined}>
                  {name.length}/{FIELD_NAME_MAX}
                </span>
              }
            >
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={FIELD_NAME_MAX}
                placeholder="字段标题"
                disabled={isSystem}
              />
            </FormField>
          </FormRow>

          <FormRow>
            <FormField label="提示" help="显示在字段下方的填写指引">
              <Input value={helpText} onChange={(e) => setHelpText(e.target.value)} placeholder="填写提示信息" />
            </FormField>
          </FormRow>

          {!isSystem && (
            <>
              <FormRow>
                <FormField label="校验规则" control="auto">
                  <div className="flex flex-col gap-2">
                    <Checkbox checked={required} onChange={setRequired} label="这是个必填项" />
                    <Checkbox checked={unique} onChange={setUnique} label="不允许重复" />
                  </div>
                </FormField>
              </FormRow>
              {type === "singleLineText" && (
                <FormRow cols={2}>
                  <FormField label="限制字数" span={6} help="留空表示不限制">
                    <Input
                      type="number"
                      min={0}
                      value={maxLength ?? ""}
                      onChange={(e) => setMaxLength(e.target.value === "" ? null : Math.max(0, Number(e.target.value)))}
                      placeholder="不限制"
                    />
                  </FormField>
                </FormRow>
              )}
            </>
          )}
        </FormSection>

        {!isSystem && (
          <FormSection title="字段设置">
            {(["singleSelect", "multiSelect"].includes(type)) && (
              <FormRow>
                <FormField label="选项" control="auto" help="选项顺序即为下拉与胶囊的展示顺序">
                  <div className="flex flex-col gap-1.5">
                    {options.map((o, i) => (
                      <div key={o.id} className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => cycleColor(i)}
                          className="h-6 w-6 flex-shrink-0 rounded-full border border-gx-border"
                          style={{ backgroundColor: o.color }}
                          title="点击切换颜色"
                        />
                        <Input value={o.name} onChange={(e) => setOptions((p) => p.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                        {/* 图标统一走 icons.tsx，不用字符符号（emoji）当功能图标 */}
                        <button type="button" onClick={() => removeOption(i)} className="rounded-gx-sm p-0.5 text-gx-text-hint hover:bg-gx-bg hover:text-gx-danger" title="删除选项">
                          <Icon name="close" size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <Button variant="ghost" size="sm" icon="plus" onClick={addOption} className="mt-2 self-start">添加选项</Button>
                </FormField>
              </FormRow>
            )}

            {(["number", "currency", "percent", "duration"].includes(type)) && (
              <FormRow cols={2}>
                <FormField label="小数精度" span={6} help="取值范围 0~8">
                  <Input type="number" min={0} max={8} value={precision} onChange={(e) => setPrecision(Math.max(0, Math.min(8, Number(e.target.value) || 0)))} />
                </FormField>
              </FormRow>
            )}

            {(type === "date" || type === "datetime") && (
              <FormRow>
                <FormField label="当前时间" control="auto">
                  <Checkbox checked={dateDefaultNow} onChange={setDateDefaultNow} label="新建记录时默认填入当前时间" />
                  <p className="mt-1 text-gx-11 text-gx-text-hint">
                    与下方「默认内容」里的固定日期互斥：勾选后以当前时间为准，固定日期不会生效。
                  </p>
                </FormField>
              </FormRow>
            )}

            {isRelated && (
              <>
                <FormRow>
                  <FormField
                    label="关联到表"
                    help={
                      isLinkLocked
                        ? "关联已建立，目标表不可更改；如需改表请删除该字段后重建。"
                        : undefined
                    }
                  >
                    <Select value={relTableId} onChange={(e) => { setRelTableId(e.target.value); setDisplayFieldId(""); }} disabled={isLinkLocked} options={[{ value: "", label: "请选择目标表" }, ...tables.filter((t) => t.id !== tableId).map((t) => ({ value: t.id, label: t.name }))]} />
                  </FormField>
                </FormRow>
                <FormRow>
                  <FormField label="关系类型" help={RELATION_DESC[relKind]}>
                    <Select value={relKind} onChange={(e) => setRelKind(e.target.value as "mm" | "hm" | "bt")} disabled={isLinkLocked} options={relationTypes.map((r) => ({ value: r.id, label: r.name }))} />
                  </FormField>
                </FormRow>
                <FormRow>
                  <FormField label="显示字段（胶囊标题）">
                    <Select value={displayFieldId} onChange={(e) => setDisplayFieldId(e.target.value)} options={[{ value: "", label: "默认（主字段）" }, ...targetFields.map((f) => ({ value: f.id, label: f.name }))]} disabled={!relTableId} />
                  </FormField>
                </FormRow>
                <FormRow>
                  <FilterRuleField label="关联筛选条件（可选）" value={recordFilter} peerFields={targetFields as FieldDTO[]} selfFields={selfMatchFields as FieldDTO[]} onChange={setRecordFilter} />
                </FormRow>
              </>
            )}

            {isLookupLike && (
              <>
                <FormRow>
                  <FormField label="本表的关联字段">
                    <Select value={linkFieldId} onChange={(e) => { setLinkFieldId(e.target.value); setSubFieldId(""); }} options={[{ value: "", label: "请选择关联字段" }, ...linkFields.map((f) => ({ value: f.id, label: f.name }))]} />
                  </FormField>
                </FormRow>
                {(type === "lookup" || type === "rollup") && (
                  <FormRow>
                    <FormField label={type === "lookup" ? "查阅子字段" : "聚合子字段"}>
                      <Select value={subFieldId} onChange={(e) => setSubFieldId(e.target.value)} disabled={!linkFieldId} options={[{ value: "", label: linkFieldId ? "请选择子字段" : "请先选择关联字段" }, ...subFields.map((f) => ({ value: f.id, label: f.name }))]} />
                    </FormField>
                  </FormRow>
                )}
                {type === "rollup" && (
                  <FormRow>
                    <FormField label="聚合函数" help="求和/平均值仅支持数值类字段；最小/最大支持数值与日期类；计数适用任意类型。">
                      <Select
                        value={rollupFn}
                        onChange={(e) => setRollupFn(e.target.value as "sum" | "avg" | "min" | "max" | "count")}
                        options={rollupAggOptions(subFields.find((f) => f.id === subFieldId)?.type)}
                      />
                    </FormField>
                  </FormRow>
                )}
                <FormRow>
                  <FilterRuleField label="子集筛选条件（可选）" value={recordFilter} peerFields={subFields as FieldDTO[]} selfFields={selfMatchFields as FieldDTO[]} onChange={setRecordFilter} />
                </FormRow>
              </>
            )}

            {type === "formula" && (
              <FormRow>
                <FormField label="公式" control="auto">
                  <button
                    type="button"
                    onClick={() => setFormulaModalOpen(true)}
                    className="flex w-full items-center justify-center gap-1.5 rounded-gx-lg bg-gx-bg px-3 py-2.5 text-gx-14 font-medium text-gx-accent transition-colors hover:bg-gx-accent-bg"
                  >
                    <Icon name="formula" size={14} />
                    {formula.trim() ? "编辑公式" : "设置公式"}
                  </button>
                  <div className="mt-1.5 rounded-gx-lg bg-gx-bg px-3 py-2 text-gx-12 text-gx-text-secondary">
                    {formula.trim() ? (
                      <code className="break-all font-mono">{formula}</code>
                    ) : (
                      <span className="text-gx-text-hint">未设置公式</span>
                    )}
                  </div>
                  {formulaModalOpen && (
                    <FormulaEditorModal
                      value={formula}
                      fields={formulaFields}
                      onClose={() => setFormulaModalOpen(false)}
                      onConfirm={(f) => { setFormula(f); setFormulaModalOpen(false); }}
                    />
                  )}
                </FormField>
              </FormRow>
            )}

            {isSubtable && (
              <>
                <FormRow>
                  <FormField
                    label="关联到表"
                    help={
                      isLinkLocked
                        ? "子表格已建立，目标表不可更改；如需改表请删除该字段后重建。"
                        : undefined
                    }
                  >
                    <Select value={relTableId} onChange={(e) => { setRelTableId(e.target.value); setDisplayFieldId(""); setDisplayedFieldIds([]); }} disabled={isLinkLocked} options={[{ value: "", label: "请选择目标表" }, ...tables.filter((t) => t.id !== tableId).map((t) => ({ value: t.id, label: t.name }))]} />
                  </FormField>
                </FormRow>
                <FormRow>
                  <FormField label="关系类型">
                    <div className="rounded-gx-sm bg-gx-bg px-2.5 py-1.5 text-gx-12 text-gx-text-secondary">
                      一对多（固定）：一条主数据拥有多条子表行，多个子表行归属同一条主数据。
                    </div>
                  </FormField>
                </FormRow>
                <FormRow>
                  <FormField label="记录标题字段">
                    <Select value={displayFieldId} onChange={(e) => setDisplayFieldId(e.target.value)} options={[{ value: "", label: "默认（对面表主字段）" }, ...targetFields.map((f) => ({ value: f.id, label: f.name }))]} disabled={!relTableId} />
                  </FormField>
                </FormRow>
                <FormRow>
                  <FormField label="子表格显示字段（内嵌表格列，多选）" control="auto">
                    <div className="grid grid-cols-2 gap-1.5">
                      {targetFields.map((f) => {
                        const checked = displayedFieldIds.includes(f.id);
                        return (
                          <label key={f.id} className="flex cursor-pointer items-center gap-1.5 rounded-gx-sm border border-gx-border bg-gx-surface px-2 py-1.5 text-gx-12 hover:bg-gx-bg">
                            <input type="checkbox" checked={checked} onChange={() => setDisplayedFieldIds((prev) => checked ? prev.filter((x) => x !== f.id) : [...prev, f.id])} />
                            <FieldIcon type={f.type} size={12} />
                            <span className="truncate">{f.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  </FormField>
                </FormRow>
                <FormRow>
                  <FormField label="选择弹窗可见字段（「选择数据」弹窗列，多选）" control="auto" help="仅作用于「选择数据」弹窗展示的列；公式引用子表格字段不受显示/可见字段限制。">
                    <div className="grid grid-cols-2 gap-1.5">
                      {targetFields.map((f) => {
                        const checked = visibleFieldIds.includes(f.id);
                        return (
                          <label key={f.id} className="flex cursor-pointer items-center gap-1.5 rounded-gx-sm border border-gx-border bg-gx-surface px-2 py-1.5 text-gx-12 hover:bg-gx-bg">
                            <input type="checkbox" checked={checked} onChange={() => setVisibleFieldIds((prev) => checked ? prev.filter((x) => x !== f.id) : [...prev, f.id])} />
                            <FieldIcon type={f.type} size={12} />
                            <span className="truncate">{f.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  </FormField>
                </FormRow>
                <FormRow>
                  <FilterRuleField label="子集筛选条件（可选）" value={recordFilter} peerFields={targetFields as FieldDTO[]} selfFields={selfMatchFields as FieldDTO[]} onChange={setRecordFilter} />
                </FormRow>
              </>
            )}

          </FormSection>
        )}

        {type === "autoNumber" && (
          <FormSection title="编号规则">
            <FormRow>
              <FormField label="编号规则" control="auto">
                <NumberRuleEditor value={numberRule} onChange={setNumberRule} selfFields={selfMatchFields as FieldDTO[]} />
              </FormField>
            </FormRow>
          </FormSection>
        )}

        {/* 默认内容（三态：自定义 / 关联已有数据 / 公式计算） */}
        {!isSystem && allowedDefaultSources(type).length > 0 && (
          <FormSection title="默认内容">
            <FormRow>
              <FormField label="默认内容" control="auto">
                <DefaultValueEditor
                  fieldType={type}
                  value={defaultConfig}
                  onChange={setDefaultConfig}
                  selfFields={formulaFields as FieldDTO[]}
                  tables={tables}
                  subtableTargetTableId={isSubtable ? relTableId : null}
                />
              </FormField>
            </FormRow>
          </FormSection>
        )}

        {/* 字段布局 */}
        <FormSection title="字段布局">
          <FormRow>
            <FormField label="字段占比（%）" control="auto" help="字段在表单中的排列与显隐，直接在中间画布上拖拽 / 移除即可。">
              <div className="flex gap-1">
                {WIDTH_OPTIONS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    disabled={!onWidthChange}
                    onClick={() => onWidthChange?.(w)}
                    className={clsx(
                      "flex-1 rounded-gx-sm py-1 text-gx-12 transition-colors",
                      widthPct === w ? "bg-gx-accent text-white" : "border border-gx-border bg-gx-surface text-gx-text-secondary hover:bg-gx-bg",
                    )}
                  >
                    {w}
                  </button>
                ))}
              </div>
            </FormField>
          </FormRow>
        </FormSection>
      </Form>

      <div className="border-t border-gx-separator px-4 py-3">
        <FormActions
          align="left"
          submitText="保存字段设置"
          onSubmit={handleSave}
          submitDisabled={!canSave}
          submitDisabledReason={
            !field
              ? "请先在画布中选择一个字段"
              : !permissions.canManageSchema
                ? "无表结构管理权限"
                : !name.trim()
                  ? "请先填写字段标题"
                  : nameTooLong
                    ? `字段名称最多 ${FIELD_NAME_MAX} 个字符`
                    : undefined
          }
        />
      </div>
    </div>
  );
}

