// apps/web/src/features/designer/FieldEditorSheet.tsx
// 字段编辑器：新建/编辑字段，覆盖 28 种字段类型与各自的配置项
// 所有写操作走 useGXMutations（createField/updateField），不自行 fetch

import { useEffect, useMemo, useState } from "react";
import { useFields, useGXMutations, useRelationTypes, useLookupTargets } from "../../api/hooks";
import type {
  FieldDTO,
  FieldIdT,
  FieldType,
  PermissionSet,
  SelectOption,
  TableDTO,
  FilterNode,
  FilterOp,
  TabConfig,
  DefaultConfig,
  NumberRule,
} from "@gx/shared-types";
import { isFilterMatchSourceType, isReferenceableType, rollupAggOptions } from "@gx/shared-types";
import { allowedDefaultSources, isNumberRuleEmpty } from "@gx/shared-types";
import { operatorsForFieldType, FILTER_OP_LABEL, operatorNeedsValue } from "@gx/shared-types";
import {
  Button,
  FieldIcon,
  Input,
  Modal,
  Select,
  Checkbox,
  toast,
} from "../../components/ui";
import { COLOR_PALETTE } from "../../components/ui";
import { Icon } from "../../components/icons";
import { Form, FormActions, FormField, FormRow, FormSection } from "../../components/form";
import { FilterRuleField } from "./FilterRuleModal";
import FormulaEditorModal from "./FormulaEditorModal";
import { DefaultValueEditor, sanitizeDefaultConfig } from "./DefaultValueEditor";
import { NumberRuleEditor } from "./NumberRuleEditor";

export interface FieldEditorSheetProps {
  open: boolean;
  tableId: string;
  baseId: string;
  field: FieldDTO | null;
  allFields: FieldDTO[];
  tables: TableDTO[];
  permissions: PermissionSet;
  onClose: () => void;
}

// 28 种字段类型分组
export const TYPE_GROUPS: { group: string; items: { type: FieldType; label: string }[] }[] = [
  {
    group: "基础",
    items: [
      { type: "singleLineText", label: "单行文本" },
      { type: "longText", label: "多行文本" },
      { type: "richText", label: "富文本" },
      { type: "number", label: "数字" },
      { type: "currency", label: "货币" },
      { type: "percent", label: "百分比" },
      { type: "duration", label: "时长" },
      { type: "date", label: "日期" },
      { type: "datetime", label: "日期时间" },
      { type: "checkbox", label: "复选框" },
      { type: "email", label: "邮箱" },
      { type: "url", label: "链接" },
      { type: "phone", label: "电话" },
      { type: "rating", label: "评分" },
      { type: "autoNumber", label: "自动编号" },
      { type: "json", label: "JSON" },
      { type: "attachment", label: "附件" },
    ],
  },
  {
    group: "选择",
    items: [
      { type: "singleSelect", label: "单选" },
      { type: "multiSelect", label: "多选" },
    ],
  },
  {
    group: "高级",
    items: [{ type: "links", label: "关联" }],
  },
  {
    group: "布局",
    items: [
      { type: "tabs", label: "选项卡分组" },
      { type: "subtable", label: "子表格" },
    ],
  },
  {
    group: "计算",
    items: [
      { type: "lookup", label: "查阅" },
      { type: "rollup", label: "聚合" },
      { type: "count", label: "计数" },
      { type: "formula", label: "公式" },
    ],
  },
  {
    group: "系统",
    items: [
      { type: "createdTime", label: "创建时间" },
      { type: "lastModifiedTime", label: "最后修改时间" },
      { type: "createdBy", label: "创建人" },
      { type: "lastModifiedBy", label: "最后修改人" },
    ],
  },
];

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

/** 把字段按 TYPE_GROUPS 分桶，供 FieldEditorSheet 顶部 Select 显示。布局字段单独标"仅详情显示"。 */
function buildFieldGroups(fields: FieldDTO[]) {
  const groups: { label: string; options: { value: string; label: string }[] }[] = [];
  for (const grp of TYPE_GROUPS) {
    const types = new Set(grp.items.map((it) => it.type));
    const matched = fields.filter((f) => types.has(f.type));
    if (matched.length === 0) continue;
    groups.push({
      label: grp.group === "布局" ? "布局（仅详情显示）" : grp.group,
      options: matched.map((f) => ({
        value: f.id,
        label: f.isReverse ? `${f.name}（反向）` : f.name,
      })),
    });
  }
  return groups;
}

function FieldEditorSheet({
  open,
  tableId,
  baseId,
  field,
  allFields,
  tables,
  permissions,
  onClose,
}: FieldEditorSheetProps) {
  const m = useGXMutations();
  const relationTypesQ = useRelationTypes();
  const relationTypes = relationTypesQ.data ?? [];

  // 内部 state：让用户能在编辑器内切换「新建」↔「编辑现有字段（含 tabs/subtable）」
  const [managedFieldId, setManagedFieldId] = useState<string | null>(field?.id ?? null);
  // 同步外部 prop 变化（比如父组件重新打开编辑器切换了目标字段）
  useEffect(() => {
    setManagedFieldId(field?.id ?? null);
  }, [field?.id, open]);

  const managedField = managedFieldId == null ? null : allFields.find((f) => f.id === managedFieldId) ?? null;

  const [name, setName] = useState("");
  const [type, setType] = useState<FieldType>("singleLineText");

  // 选择类
  const [options, setOptions] = useState<SelectOption[]>([]);
  // 数字类
  const [precision, setPrecision] = useState(0);
  const [dateDefaultNow, setDateDefaultNow] = useState(false);
  // 关联
  const [relTableId, setRelTableId] = useState("");
  const [relKind, setRelKind] = useState<"mm" | "hm" | "bt">("mm");
  const [displayFieldId, setDisplayFieldId] = useState("");
  // 查阅/聚合/计数 用的关联字段与子字段
  const [linkFieldId, setLinkFieldId] = useState("");
  const [subFieldId, setSubFieldId] = useState("");
  const [rollupFn, setRollupFn] = useState<"sum" | "avg" | "min" | "max" | "count">("sum");
  // 公式
  const [formula, setFormula] = useState("");
  // 子集筛选条件（传给 recordFilter）
  const [recordFilter, setRecordFilter] = useState<FilterNode | null>(null);
  // 默认内容三态（static/lookup/formula）
  const [defaultConfig, setDefaultConfig] = useState<DefaultConfig | null>(null);
  // 自动编号规则
  const [numberRule, setNumberRule] = useState<NumberRule | null>(null);

  // tabs 配置（仅 type=tabs 提交）
  const [tabs, setTabs] = useState<TabConfig[]>([]);

  // subtable 显示字段列表（多选对面表字段）
  const [displayedFieldIds, setDisplayedFieldIds] = useState<FieldIdT[]>([]);
  // subtable「选择数据」弹窗可见字段（与 displayedFieldIds 独立）
  const [visibleFieldIds, setVisibleFieldIds] = useState<FieldIdT[]>([]);
  const [formulaModalOpen, setFormulaModalOpen] = useState(false);

  const isNew = managedField === null;

  // 打开 / 切换字段 时初始化表单。
  // 依赖必须是「字段 id + open」而非 managedField 对象本身：managedField 由 allFields.find()
  // 得到，编辑 links/subtable/lookup/rollup 等类型会触发关联表字段 / lookup-targets 等额外请求，
  // 请求返回后 react-query 产生新数组、managedField 引用随之变化，旧依赖会导致本 effect 重跑，
  // 把用户正在输入的字段名重置回服务端旧值（表现为「某些类型字段名无法输入/保存」）。
  useEffect(() => {
    if (!open) return;
    const f = managedFieldId == null ? null : allFields.find((x) => x.id === managedFieldId) ?? null;
    setName(f?.name ?? "");
    setType(f?.type ?? "singleLineText");
    setOptions(f?.options ?? []);
    setPrecision(f?.precision ?? 0);
    setDateDefaultNow((f as { defaultNow?: boolean } | null)?.defaultNow ?? false);
    setRelTableId(f?.relatedTableId ?? "");
    setRelKind((f?.relationKind as "mm" | "hm" | "bt") ?? "mm");
    setDisplayFieldId(f?.linkDisplayFieldId ?? "");
    setLinkFieldId(f?.linkFieldId ?? "");
    setSubFieldId(f?.lookupFieldId ?? "");
    setRollupFn(f?.rollupFunction ?? "sum");
    setFormula(f?.formula ?? "");
    setRecordFilter((f as { recordFilter?: FilterNode | null } | null)?.recordFilter ?? null);
    setDefaultConfig((f as { defaultConfig?: DefaultConfig | null } | null)?.defaultConfig ?? null);
    setNumberRule((f as { numberRule?: NumberRule | null } | null)?.numberRule ?? null);
    setTabs((f as { tabsConfig?: TabConfig[] | null } | null)?.tabsConfig ?? []);
    setDisplayedFieldIds((f as { displayedFieldIds?: FieldIdT[] | null } | null)?.displayedFieldIds ?? []);
    setVisibleFieldIds((f as { visibleFieldIds?: FieldIdT[] | null } | null)?.visibleFieldIds ?? []);
    // 仅在「打开编辑器」或「切换目标字段（id 变化，含切到新建 null）」时回填，
    // 不随 allFields 数据刷新而重置用户正在编辑的内容。
  }, [open, managedFieldId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 关联表的目标字段（用于显示字段选择）——排除 tabs/subtable 纯容器，不可作为显示/引用字段
  const targetFieldsQ = useFields(relTableId || null);
  const targetFields = (targetFieldsQ.data ?? []).filter((f) => isReferenceableType(f.type));
  // 公式可引用字段：排除 tabs 容器，保留 links/subtable（跨表取数函数需引用）
  const formulaFields = allFields.filter((f) => f.type !== "tabs");
  // 「匹配字段」值来源：本表物理可比较标量字段（排除容器/计算/系统/附件/JSON）
  const selfMatchFields = allFields.filter((f) => isFilterMatchSourceType(f.type));

  // 本表 link 字段（查阅/聚合/计数用）
  const linkFields = allFields.filter((f) => f.type === "links");
  const subFieldsQ = useLookupTargets(linkFieldId || null);
  // 查阅/聚合子字段同样排除容器字段
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
  // tabs 类型切换：当用户从其他类型切到 tabs 且未配置时，自动 seed 一个空 tab 便于编辑
  useEffect(() => {
    if (type === "tabs" && tabs.length === 0) {
      setTabs([{ id: `tab_${Date.now()}`, name: "基本信息", fieldIds: [] }]);
    }
  }, [type]); // eslint-disable-line react-hooks/exhaustive-deps
  const addOption = () =>
    setOptions((prev) => [...prev, { id: `opt_${Date.now()}_${prev.length}`, name: "新选项", color: COLOR_PALETTE[prev.length % COLOR_PALETTE.length]! }]);
  const removeOption = (i: number) => setOptions((prev) => prev.filter((_, j) => j !== i));

  const canSave = permissions.canManageSchema && !!name.trim();
  const isSystem = ["createdTime", "lastModifiedTime", "createdBy", "lastModifiedBy"].includes(type);
  const isRelated = type === "links";
  const isSubtable = type === "subtable";
  // 已建立双向配对后锁定关联表/关系类型（改表会断链），与 FieldSettingsPanel 一致
  const isLinkLocked = (isRelated || isSubtable) && !!managedField?.linkFieldId;
  const isLookupLike = type === "lookup" || type === "rollup" || type === "count";
  // 「字段配置」分区是否有内容：没有任何类型专属配置项时不渲染空分区（避免只留一个空标题）
  const hasTypeConfig =
    ["singleSelect", "multiSelect"].includes(type) ||
    ["number", "currency", "percent", "duration"].includes(type) ||
    type === "date" ||
    type === "datetime" ||
    type === "autoNumber" ||
    isRelated ||
    isLookupLike ||
    type === "formula" ||
    isSubtable ||
    type === "tabs" ||
    allowedDefaultSources(type).length > 0;

  const buildPayload = (): Record<string, unknown> => {
    const data: Record<string, unknown> = { name: name.trim(), type };
    // id 类字段：空串/未选统一发 null（用于清空），避免空串落库或 undefined 被后端跳过导致清不掉
    const idOrNull = (v: string): string | null => (v && v.trim() ? v : null);
    if (["singleSelect", "multiSelect"].includes(type)) data.options = options;
    if (["number", "currency", "percent", "duration"].includes(type)) data.precision = precision;
    if (type === "date" || type === "datetime") data.defaultNow = dateDefaultNow;
    if (isRelated) {
      data.relationKind = relKind;
      data.linkDisplayFieldId = idOrNull(displayFieldId);
      // 关联已建立配对后不改目标表（后端也会拒绝），仅首次设置时传
      if (!isLinkLocked) data.relatedTableId = idOrNull(relTableId);
      // 关联字段级筛选：始终发送（null 表示清空），否则删除全部条件后旧筛选仍残留
      data.recordFilter = recordFilter ?? null;
    }
    if (isSubtable) {
      // 子表格关系固定为一对多（hm：一条主数据拥有多条子行），隐藏关系类型选择
      data.relationKind = "hm";
      data.linkDisplayFieldId = idOrNull(displayFieldId);
      data.displayedFieldIds = displayedFieldIds;
      data.visibleFieldIds = visibleFieldIds;
      if (!isLinkLocked) data.relatedTableId = idOrNull(relTableId);
      data.recordFilter = recordFilter ?? null;
    }
    if (isLookupLike) {
      data.linkFieldId = idOrNull(linkFieldId);
      if (type === "lookup" || type === "rollup") data.lookupFieldId = idOrNull(subFieldId);
      if (type === "rollup" || type === "count") data.rollupFunction = type === "count" ? "count" : rollupFn;
      // 子集筛选：始终发送（null 表示清空）
      data.recordFilter = recordFilter ?? null;
    }
    if (type === "formula") data.formula = formula;
    if (type === "tabs") data.tabsConfig = tabs;
    // 默认内容：仅支持的类型发送（null 表示清空）；自动编号发编号规则
    if (allowedDefaultSources(type).length > 0) {
      data.defaultConfig = sanitizeDefaultConfig(type, defaultConfig);
    }
    if (type === "autoNumber") {
      data.numberRule = numberRule && !isNumberRuleEmpty(numberRule) ? numberRule : null;
    }
    return data;
  };

  const handleSave = async () => {
    if (!canSave || isSystem) return;
    try {
      if (isNew) {
        await m.createField.mutateAsync({ tableId, data: buildPayload(), viewId: undefined });
      } else {
        await m.updateField.mutateAsync({
          fieldId: managedField!.id,
          data: buildPayload(),
          tableId,
        });
      }
      toast("已保存字段", "success");
      onClose();
    } catch (err) {
      toast((err as Error).message || "保存失败", "error");
    }
  };

  return (
    <Modal
      open={open}
      title={isNew ? "新建字段" : "编辑字段"}
      onClose={onClose}
      width={520}
      footer={
        <FormActions
          align="right"
          submitText="保存"
          onSubmit={handleSave}
          submitDisabled={!canSave || isSystem}
          submitDisabledReason={
            isSystem
              ? "系统字段由平台自动维护，不可编辑"
              : !permissions.canManageSchema
                ? "无表结构管理权限"
                : !name.trim()
                  ? "请先填写字段名称"
                  : undefined
          }
          onCancel={onClose}
          leading={
            !permissions.canManageSchema ? (
              <span className="text-gx-12 text-gx-text-hint">无表结构管理权限</span>
            ) : undefined
          }
        />
      }
    >
      {/* 阶段 2：弹窗/抽屉表单走统一骨架 —— 12 栅格 + gap 12 + 控件 34 + 错误行 16px 预留 */}
      <Form variant="modal" padding={false}>
        <FormSection title="基本信息">
          {/* 字段切换：让用户能切到任意字段进行编辑（含 tabs/subtable 等不在 grid 显示的布局字段） */}
          <FormRow>
            <FormField label={`字段 ${isNew ? "（新建模式）" : "（编辑模式）"}`}>
              <Select
                value={managedFieldId ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  setManagedFieldId(v === "" ? null : v);
                }}
                groups={[
                  { label: "操作", options: [{ value: "", label: "+ 新建字段" }] },
                  ...buildFieldGroups(allFields),
                ]}
                className="font-normal"
              />
            </FormField>
          </FormRow>

          <FormRow>
            <FormField label="字段名称" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：任务名称" />
            </FormField>
          </FormRow>

          {/* 类型选择（仅新建可选） */}
          {isNew ? (
            <FormRow>
              <FormField label="字段类型" control="auto">
                <div className="flex flex-col gap-2 pt-0.5">
                  {TYPE_GROUPS.map((grp) => (
                    <div key={grp.group}>
                      <div className="mb-1 text-gx-11 text-gx-text-tertiary">{grp.group}</div>
                      <div className="grid grid-cols-3 gap-1.5">
                        {grp.items.map((it) => (
                          <button
                            key={it.type}
                            type="button"
                            onClick={() => setType(it.type)}
                            className={
                              "flex items-center gap-1.5 rounded-gx-lg border px-2 py-1.5 text-gx-12 transition-colors " +
                              (type === it.type
                                ? "border-gx-accent bg-gx-accent-bg text-gx-accent"
                                : "border-gx-border bg-gx-surface text-gx-text-primary hover:bg-gx-bg")
                            }
                          >
                            <FieldIcon type={it.type} size={13} />
                            <span className="truncate">{it.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </FormField>
            </FormRow>
          ) : (
            <FormRow>
              <FormField
                label="字段类型"
                help={isSystem ? SYSTEM_DESC[type] : "编辑模式下不可更改类型"}
              >
                <div className="flex items-center gap-2 rounded-gx-lg bg-gx-bg px-2 py-1.5 text-gx-12 text-gx-text-secondary">
                  <FieldIcon type={type} size={14} />
                  类型：{type}（编辑模式下不可更改类型）
                </div>
              </FormField>
            </FormRow>
          )}
        </FormSection>

        {hasTypeConfig && (
          <FormSection title="字段配置">
            {/* 单选/多选 选项 */}
            {["singleSelect", "multiSelect"].includes(type) && (
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
                  <Button variant="ghost" size="sm" icon="plus" onClick={addOption} className="self-start">
                    添加选项
                  </Button>
                </FormField>
              </FormRow>
            )}

            {/* 数字精度 */}
            {["number", "currency", "percent", "duration"].includes(type) && (
              <FormRow cols={2}>
                <FormField label="小数精度" span={6} help="取值范围 0~8，影响展示与导出的小数位数">
                  <Input
                    type="number"
                    min={0}
                    max={8}
                    value={precision}
                    onChange={(e) => setPrecision(Math.max(0, Math.min(8, Number(e.target.value) || 0)))}
                  />
                </FormField>
              </FormRow>
            )}

            {/* 日期默认当前时间 */}
            {(type === "date" || type === "datetime") && (
              <FormRow>
                <FormField label="默认值" control="auto">
                  <Checkbox checked={dateDefaultNow} onChange={setDateDefaultNow} label="新建记录时默认填入当前时间" />
                </FormField>
              </FormRow>
            )}

            {/* 自动编号规则 */}
            {type === "autoNumber" && (
              <FormRow>
                <FormField label="编号规则" control="auto">
                  <NumberRuleEditor value={numberRule} onChange={setNumberRule} selfFields={selfMatchFields as FieldDTO[]} />
                </FormField>
              </FormRow>
            )}

            {/* 默认内容（三态：自定义 / 关联已有数据 / 公式计算） */}
            {allowedDefaultSources(type).length > 0 && (
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
            )}

            {/* 关联字段 */}
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
                    <Select
                      value={relTableId}
                      disabled={isLinkLocked}
                      onChange={(e) => {
                        setRelTableId(e.target.value);
                        setDisplayFieldId("");
                      }}
                      options={[
                        { value: "", label: "请选择目标表" },
                        ...tables.filter((t) => t.id !== tableId).map((t) => ({ value: t.id, label: t.name })),
                      ]}
                    />
                  </FormField>
                </FormRow>
                <FormRow>
                  <FormField label="关系类型" help={RELATION_DESC[relKind]} labelExtra={`反向：${reverseName || "—"}`}>
                    <Select
                      value={relKind}
                      disabled={isLinkLocked}
                      onChange={(e) => setRelKind(e.target.value as "mm" | "hm" | "bt")}
                      options={relationTypes.map((r) => ({ value: r.id, label: r.name }))}
                    />
                  </FormField>
                </FormRow>
                <FormRow>
                  <FormField label="显示字段（胶囊标题）" help="未指定时取目标表主字段">
                    <Select
                      value={displayFieldId}
                      onChange={(e) => setDisplayFieldId(e.target.value)}
                      options={[
                        { value: "", label: "默认（主字段）" },
                        ...targetFields.map((f) => ({ value: f.id, label: f.name })),
                      ]}
                      disabled={!relTableId}
                    />
                  </FormField>
                </FormRow>
                <div className="rounded-gx-sm bg-gx-bg px-2 py-1 text-gx-11 text-gx-text-hint">
                  系统将自动在目标表创建反向关联字段
                </div>

                {/* 关联字段级筛选（v2）：选择记录时按对面表的字段条件筛候选 */}
                <FormRow>
                  <FilterRuleField
                    label="关联筛选条件（可选）"
                    value={recordFilter}
                    peerFields={targetFields as FieldDTO[]}
                    selfFields={selfMatchFields as FieldDTO[]}
                    onChange={setRecordFilter}
                  />
                </FormRow>
              </>
            )}

            {/* 查阅/聚合/计数 */}
            {isLookupLike && (
              <>
                <FormRow>
                  <FormField label="本表的关联字段">
                    <Select
                      value={linkFieldId}
                      onChange={(e) => {
                        setLinkFieldId(e.target.value);
                        setSubFieldId("");
                      }}
                      options={[
                        { value: "", label: "请选择关联字段" },
                        ...linkFields.map((f) => ({ value: f.id, label: f.name })),
                      ]}
                    />
                  </FormField>
                </FormRow>

                {(type === "lookup" || type === "rollup") && (
                  <FormRow>
                    <FormField label={type === "lookup" ? "查阅子字段" : "聚合子字段"}>
                      <Select
                        value={subFieldId}
                        onChange={(e) => setSubFieldId(e.target.value)}
                        disabled={!linkFieldId}
                        options={[
                          { value: "", label: linkFieldId ? "请选择子字段" : "请先选择关联字段" },
                          ...subFields.map((f) => ({ value: f.id, label: f.name })),
                        ]}
                      />
                    </FormField>
                  </FormRow>
                )}

                {type === "rollup" && (
                  <FormRow>
                    <FormField label="聚合函数" help="求和/平均值仅支持数值类字段；最小/最大支持数值与日期类；计数适用于任意类型。">
                      <Select
                        value={rollupFn}
                        onChange={(e) => setRollupFn(e.target.value as "sum" | "avg" | "min" | "max" | "count")}
                        options={rollupAggOptions(subFields.find((f) => f.id === subFieldId)?.type)}
                      />
                    </FormField>
                  </FormRow>
                )}

                {/* 子集筛选条件：仅当已选关联字段且可见子字段时显示 */}
                <FormRow>
                  <FilterRuleField
                    label="子集筛选条件（可选）"
                    value={recordFilter}
                    peerFields={subFields as FieldDTO[]}
                    selfFields={selfMatchFields as FieldDTO[]}
                    onChange={setRecordFilter}
                  />
                </FormRow>
              </>
            )}

            {/* 公式 */}
            {type === "formula" && (
              <FormRow>
                <FormField label="公式" control="auto">
                  <button
                    type="button"
                    onClick={() => setFormulaModalOpen(true)}
                    className="flex w-full items-center justify-center gap-1.5 rounded-gx-lg bg-gx-bg px-3 py-2.5 text-gx-14 font-medium text-gx-accent transition-colors hover:bg-gx-accent-bg"
                  >
                    <Icon name="formula" size={14} /> {formula.trim() ? "编辑公式" : "设置公式"}
                  </button>
                  <div className="mt-1.5 rounded-gx-lg bg-gx-bg px-3 py-2 text-gx-12 text-gx-text-secondary">
                    {formula.trim() ? <code className="break-all font-mono">{formula}</code> : <span className="text-gx-text-hint">未设置公式</span>}
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

            {/* 子表格字段 */}
            {type === "subtable" && (
              <div className="rounded-gx-lg border border-gx-border bg-gx-bg/40 p-3">
                <p className="mb-3 text-gx-12 text-gx-text-hint">
                  子表格字段在详情页以一张内嵌网格呈现对面表符合条件的记录。关联目标表、显示字段、筛选条件均在此配置；详情页点击「添加」按钮从对面表选记录代入。
                </p>
                <div className="flex flex-col gap-4">
                  <FormRow>
                    <FormField
                      label="关联到表"
                      help={
                        isLinkLocked
                          ? "子表格已建立，目标表不可更改；如需改表请删除该字段后重建。"
                          : undefined
                      }
                    >
                      <Select
                        value={relTableId}
                        disabled={isLinkLocked}
                        onChange={(e) => {
                          setRelTableId(e.target.value);
                          setDisplayFieldId("");
                          setDisplayedFieldIds([]);
                        }}
                        options={[
                          { value: "", label: "请选择目标表" },
                          ...tables.filter((t) => t.id !== tableId).map((t) => ({ value: t.id, label: t.name })),
                        ]}
                      />
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
                    <FormField label="记录标题字段（详情视图胶囊标题）">
                      <Select
                        value={displayFieldId}
                        onChange={(e) => setDisplayFieldId(e.target.value)}
                        options={[
                          { value: "", label: "默认（对面表主字段）" },
                          ...targetFields.map((f) => ({ value: f.id, label: f.name })),
                        ]}
                        disabled={!relTableId}
                      />
                    </FormField>
                  </FormRow>
                  <FormRow>
                    <FormField label="子表格显示字段（多选）" control="auto" help="未选时子表格默认显示对面表主字段列。">
                      <div className="grid grid-cols-2 gap-1.5">
                        {targetFields.map((f) => {
                          const checked = displayedFieldIds.includes(f.id);
                          return (
                            <label key={f.id} className="flex cursor-pointer items-center gap-1.5 rounded-gx-sm border border-gx-border bg-gx-surface px-2 py-1.5 text-gx-12 hover:bg-gx-bg">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => {
                                  setDisplayedFieldIds((prev) => checked ? prev.filter((x) => x !== f.id) : [...prev, f.id]);
                                }}
                              />
                              <FieldIcon type={f.type} size={12} />
                              <span className="truncate">{f.name}</span>
                            </label>
                          );
                        })}
                      </div>
                    </FormField>
                  </FormRow>
                  <FormRow>
                    <FormField label="选择弹窗可见字段（多选）" control="auto" help="仅作用于「选择数据」弹窗展示列；公式引用子表格字段不受显示/可见字段限制。">
                      <div className="grid grid-cols-2 gap-1.5">
                        {targetFields.map((f) => {
                          const checked = visibleFieldIds.includes(f.id);
                          return (
                            <label key={f.id} className="flex cursor-pointer items-center gap-1.5 rounded-gx-sm border border-gx-border bg-gx-surface px-2 py-1.5 text-gx-12 hover:bg-gx-bg">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => {
                                  setVisibleFieldIds((prev) => checked ? prev.filter((x) => x !== f.id) : [...prev, f.id]);
                                }}
                              />
                              <FieldIcon type={f.type} size={12} />
                              <span className="truncate">{f.name}</span>
                            </label>
                          );
                        })}
                      </div>
                    </FormField>
                  </FormRow>
                  <FormRow>
                    <FilterRuleField
                      label="子集筛选条件（可选）"
                      value={recordFilter}
                      peerFields={targetFields as FieldDTO[]}
                      selfFields={selfMatchFields as FieldDTO[]}
                      onChange={setRecordFilter}
                    />
                  </FormRow>
                </div>
              </div>
            )}

            {/* tabs 选项卡分组 */}
            {type === "tabs" && (
              <FormRow>
                <FormField
                  label="选项卡列表"
                  control="auto"
                  help="每个 tab 下的具体字段分配在「字段布局编辑器」里完成。这里只配置 tab 名称和顺序。"
                >
                  {tabs.length === 0 && (
                    <div className="rounded-gx-sm border border-dashed border-gx-border py-3 text-center text-gx-12 text-gx-text-hint">
                      还没有 tab，点击下方「添加 tab」开始
                    </div>
                  )}
                  <div className="flex flex-col gap-2">
                    {tabs.map((tab, i) => (
                      <div key={tab.id} className="flex items-center gap-2 rounded-gx-sm border border-gx-border bg-gx-surface px-2 py-1.5">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gx-bg text-gx-11 text-gx-text-tertiary">{i + 1}</span>
                        <Input
                          value={tab.name}
                          onChange={(e) =>
                            setTabs((prev) => prev.map((t, j) => (j === i ? { ...t, name: e.target.value } : t)))
                          }
                          placeholder={`Tab ${i + 1} 名称`}
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setTabs((prev) => prev.map((t, j) => (j === i ? { ...t, name: "" } : t)))
                          }
                          className="rounded-gx-sm px-2 text-gx-11 text-gx-text-hint hover:bg-gx-bg hover:text-gx-text-primary"
                          title="清空名称"
                        >
                          清空
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setTabs((prev) => prev.filter((_, j) => j !== i))
                          }
                          className="rounded-full p-1 text-gx-text-hint hover:bg-gx-bg hover:text-gx-danger"
                          title="删除 tab"
                        >
                          <Icon name="close" size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="plus"
                    className="mt-2 self-start"
                    onClick={() =>
                      setTabs((prev) => [
                        ...prev,
                        { id: `tab_${Date.now()}_${prev.length}_${Math.random().toString(36).slice(2, 6)}`, name: `Tab ${prev.length + 1}`, fieldIds: [] },
                      ])
                    }
                  >
                    添加 tab
                  </Button>
                </FormField>
              </FormRow>
            )}
          </FormSection>
        )}
      </Form>
    </Modal>
  );
}

export default FieldEditorSheet;
export { FieldEditorSheet };
