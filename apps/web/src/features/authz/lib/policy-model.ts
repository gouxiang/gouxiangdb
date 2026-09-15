// M4 权限面板纯函数模型：七动作矩阵、字段三态映射、整单 diff、409 影响面提取、
// legacyUnmappable 200 提示文案。全部无 DOM/React，便于零 jsdom 单测。
import type { ResourceAction } from "@gx/shared-types";
import type {
  FieldMaskDTO,
  InheritanceImpactDTO,
  LegacyUnmappableItemDTO,
  PolicyRowDTO,
  PolicySubjectType,
  PolicyUpsertDTO,
  PolicyDeleteDTO,
} from "@gx/shared-types";
import { ApiError } from "../../../api/client";
import type { NavKind } from "@gx/shared-types";

/** 七枚资源动作（字典序即规范串序）+ 中文标签/说明。 */
export const ACTION_META: ReadonlyArray<{
  action: ResourceAction;
  label: string;
  hint: string;
}> = [
  { action: "r", label: "查看", hint: "读取节点内容" },
  { action: "c", label: "新建", hint: "在节点下创建" },
  { action: "u", label: "编辑", hint: "修改节点内容" },
  { action: "d", label: "删除", hint: "删除节点" },
  { action: "comment", label: "评论", hint: "发表评论" },
  { action: "manage_share", label: "管理分享", hint: "授权与继承设置" },
  { action: "manage_schema", label: "管理结构", hint: "改表/库结构" },
];

/** 可勾 manage_schema 的节点 kind：仅 table/base；其余 kind 该动作置灰（后端 400 兜底）。 */
export function canAssignAction(action: ResourceAction, kind: NavKind | string): boolean {
  if (action === "manage_schema") return kind === "table" || kind === "base";
  return true;
}

/** 只有 doc/canvas 叶子可中断/恢复继承（其他 kind 后端 400 NODE_NOT_INHERITABLE）。 */
export function isInheritableKind(kind: NavKind | string): boolean {
  return kind === "doc" || kind === "canvas";
}

/** 勾选/取消一枚动作，保持字典序去重（与 toActionString 规范一致）。 */
export function toggleAction(
  actions: readonly ResourceAction[],
  action: ResourceAction,
  on: boolean,
): ResourceAction[] {
  const set = new Set(actions);
  if (on) set.add(action);
  else set.delete(action);
  const order: Record<ResourceAction, number> = {
    r: 0,
    c: 1,
    u: 2,
    d: 3,
    comment: 4,
    manage_share: 5,
    manage_schema: 6,
  };
  return [...set].sort((a, b) => order[a] - order[b]);
}

// ---------- 字段三态（仅 table 策略行） ----------

export type FieldState = "editable" | "readonly" | "hidden";

/**
 * 单个字段在某条策略 fieldMask 下的状态：
 *  - 定义了 allowFields 且不含该字段 = hidden（收窄可见）；
 *  - 在 readOnlyFields = readonly；
 *  - 其余 = editable（缺省 mask = 全量可编辑）。
 */
export function fieldStateForField(mask: FieldMaskDTO | null | undefined, fieldId: string): FieldState {
  if (mask?.allowFields && !mask.allowFields.includes(fieldId)) return "hidden";
  if (mask?.readOnlyFields?.includes(fieldId)) return "readonly";
  return "editable";
}

/**
 * 由"字段→三态"编辑结果反推最小 FieldMask：
 *  - allowFields = 所有可见字段（editable + readonly）；全部可见则省略 allowFields；
 *  - readOnlyFields = readonly 字段；无只读则省略；
 *  - 全部 editable（不裁剪）→ null（PUT 时下发 null 表示全量）。
 */
export function buildFieldMask(
  fields: readonly string[],
  stateOf: (id: string) => FieldState,
): FieldMaskDTO | null {
  const visible = fields.filter((f) => stateOf(f) !== "hidden");
  const readOnly = visible.filter((f) => stateOf(f) === "readonly");
  if (visible.length === fields.length && readOnly.length === 0) return null;
  const mask: FieldMaskDTO = {};
  if (visible.length !== fields.length) mask.allowFields = visible;
  if (readOnly.length) mask.readOnlyFields = readOnly;
  return mask;
}

// ---------- 整单 diff（direct 编辑行 → upserts/deletes） ----------

export interface EditableRow {
  subjectType: PolicySubjectType;
  subjectId: string;
  actions: ResourceAction[];
  fieldMask: FieldMaskDTO | null;
  /** 原始行（新增行为 null）。 */
  original: PolicyRowDTO | null;
  /** 被移除（保存时转 delete）。 */
  removed?: boolean;
}

/** 从 direct[] 初始化可编辑行。 */
export function toEditableRows(direct: readonly PolicyRowDTO[]): EditableRow[] {
  return direct.map((r) => ({
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    actions: [...r.actions],
    fieldMask: r.fieldMask ? { ...r.fieldMask } : null,
    original: r,
  }));
}

/**
 * 生成整单 PUT 载荷：
 *  - upserts：新增行，或 actions/fieldMask 相对原值变化的行；actions 为空视为删除；
 *  - deletes：标记 removed，或动作被清空且原本存在的行；
 * 无任何变化返回 null（调用方不发空单，后端要求至少一项）。
 */
export function buildPolicyWrite(rows: readonly EditableRow[]): {
  upserts?: PolicyUpsertDTO[];
  deletes?: PolicyDeleteDTO[];
} | null {
  const upserts: PolicyUpsertDTO[] = [];
  const deletes: PolicyDeleteDTO[] = [];

  for (const row of rows) {
    const key = { subjectType: row.subjectType, subjectId: row.subjectId };
    if (row.removed) {
      if (row.original) deletes.push(key);
      continue;
    }
    if (row.actions.length === 0) {
      if (row.original) deletes.push(key);
      // 新增行且无动作：忽略（不成单）
      continue;
    }
    const changed =
      !row.original ||
      JSON.stringify([...row.actions].sort()) !== JSON.stringify([...row.original.actions].sort()) ||
      JSON.stringify(row.fieldMask ?? null) !== JSON.stringify(row.original.fieldMask ?? null);
    if (changed) {
      upserts.push({
        ...key,
        actions: row.actions,
        ...(row.fieldMask ? { fieldMask: row.fieldMask } : { fieldMask: null }),
      });
    }
  }

  if (upserts.length === 0 && deletes.length === 0) return null;
  return {
    ...(upserts.length ? { upserts } : {}),
    ...(deletes.length ? { deletes } : {}),
  };
}

// ---------- 409 INHERITANCE_CONFIRM_REQUIRED 影响面提取 ----------

interface InheritanceConfirmBody {
  error?: string;
  code?: string;
  impact?: InheritanceImpactDTO;
}

/** 仅在 409 + code 严格命中且带 impact 时返回，供弹同一确认 Modal 后原样重放。 */
export function extractInheritanceImpact(e: unknown): InheritanceImpactDTO | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const body = e.body as InheritanceConfirmBody;
  if (body?.code !== "INHERITANCE_CONFIRM_REQUIRED" || !body.impact) return null;
  return body.impact;
}

// ---------- legacyUnmappable（200 成功提示，非错误） ----------

const SUBJECT_LABEL: Record<PolicySubjectType, string> = {
  user: "成员",
  dept: "部门",
  role: "角色",
};

/** 把不可反写旧三表的授权明细转成具体的轻提示行（不弹错误框、不回滚）。 */
export function formatLegacyUnmappable(items: readonly LegacyUnmappableItemDTO[]): string[] {
  return items.map(
    (it) =>
      `${SUBJECT_LABEL[it.subjectType] ?? it.subjectType} ${it.subjectId} 的部分授权仅在企业权限引擎生效` +
      (it.reasons.length ? `（${it.reasons.join("、")}）` : ""),
  );
}

/** 悬挂主体（subjectName=null）展示名。 */
export function subjectDisplay(name: string | null): string {
  return name ?? "已删除主体";
}
