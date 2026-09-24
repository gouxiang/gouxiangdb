// apps/api/src/domain/authz/scopeProjection.ts
// P1 路线 (a) 核心：把一条 role_library_scope 行 + 活表/活字段清单【纯函数展开】为
// auth_policies 描述符。库可见逐表展开为 table 节点窄策略，字段收窄由 fieldMask 承载；
// 库管理位（manage_table/manage_share）挂库节点。与第二代 libraryPolicy 逐值等价（见对拍测试）。
//
// 边界：纯域、零 IO——不 import prisma / Hono / guards；不接线，不改任何现有生产码。
// 规则出处：P1 切片设计 §4.3–4.7、§5.1（定稿裁决 1/3）。

import type { FieldMask, ResourceAction } from "@gx/shared-types";
import { KB_CONTENT_KEY, toActionString } from "@gx/shared-types";
import { nodeId } from "../nav/backfill.js";
import { parseConfig } from "./libraryScopeConfig.js";
import { synthesizeAccess } from "./scopeSynthesize.js";

/** 系统管理员角色 id（org/roles.ts ADMIN_ROLE_ID，本地常量避免 import 其 prisma 模块）。 */
const ADMIN_ROLE_ID = "role_admin";

/** 一条 auth_policies 投影（actions/fieldMask 已序列化为存储串）。 */
export interface ProjectedPolicy {
  nodeId: string;
  subjectType: "role";
  subjectId: string;
  actions: string;
  fieldMask: string | null;
  reason: "scope:role";
}

/** scope 投影入参（对齐 role_library_scope 一行的形状）。 */
export interface ScopeProjectionInput {
  roleId: string;
  libraryKind: "base" | "kb";
  libraryId: string;
  canManage: number;
  visible: number;
  canShare: number;
  config: string;
}

/** 活 schema 形状（base：活表及每表活字段；kb：空，content 伪表挂 kb 节点）。 */
export interface LiveSchemaShape {
  tableIds: readonly string[];
  fieldIdsByTable: ReadonlyMap<string, readonly string[]>;
}

type FieldsConfig = Readonly<
  Record<string, Record<string, "editable" | "visible" | "hidden">>
>;

/**
 * 由 scope 字段配置物化单表单源 FieldMask。
 * 无显式 per-field 配置 -> null（宽放行）；否则按活字段全集解析，
 * 缺省档位 editable（对齐 fieldAccessOf），非活字段配置键一律忽略。
 */
export function buildFieldMask(
  tableId: string,
  liveFieldIds: readonly string[],
  fieldsConfig: FieldsConfig,
): FieldMask | null {
  const perField = fieldsConfig[tableId];
  if (!perField || Object.keys(perField).length === 0) return null;

  const allowFields: string[] = [];
  const readOnlyFields: string[] = [];
  for (const f of liveFieldIds) {
    const mode = perField[f] ?? "editable";
    if (mode === "hidden") continue;
    allowFields.push(f);
    if (mode === "visible") readOnlyFields.push(f);
  }
  // 显式配置存在即不得返回 null：allowFields 允许为空（全 hidden）。
  return { allowFields, readOnlyFields };
}

/**
 * 解析单个表（kb 用 content 伪表）的数据动作与结构管理位。
 * canManage=1：全权 + comment，manageSchema=true（不看逐表 config，§4.5）。
 * 否则 visible=1：只读基线 r + 逐表 create/update/delete 增量；comment 跟随 c/u/d（裁决 3）。
 * visible=0 && canManage=0：空集（逐表配置不能单独让表可见）。
 */
export function tableActions(
  input: ScopeProjectionInput,
  tableId: string,
): { actions: ResourceAction[]; manageSchema: boolean } {
  if (input.canManage === 1) {
    return { actions: ["r", "c", "u", "d", "comment"], manageSchema: true };
  }
  if (input.visible !== 1) return { actions: [], manageSchema: false };

  const cfg = parseConfig(input.config);
  const perTable = cfg.tables[tableId];
  const actions: ResourceAction[] = ["r"];
  if (perTable?.create) actions.push("c");
  if (perTable?.update) actions.push("u");
  if (perTable?.delete) actions.push("d");
  if (actions.includes("c") || actions.includes("u") || actions.includes("d")) {
    actions.push("comment");
  }
  return { actions, manageSchema: false };
}

/** 库节点管理位：canManage -> 表元数据+分享；否则显式 canShare -> 分享；纯只读 -> 空。 */
function libraryManageActions(input: ScopeProjectionInput): ResourceAction[] {
  if (input.canManage === 1) return ["manage_table", "manage_share"];
  if (input.canShare === 1) return ["manage_share"];
  return [];
}

function scopePolicy(
  nodeIdValue: string,
  roleId: string,
  actions: readonly ResourceAction[],
  fieldMask: FieldMask | null,
): ProjectedPolicy {
  return {
    nodeId: nodeIdValue,
    subjectType: "role",
    subjectId: roleId,
    actions: toActionString(actions),
    fieldMask: fieldMask ? JSON.stringify(fieldMask) : null,
    reason: "scope:role",
  };
}

/** base：逐表窄策略（含 manage_schema 与 fieldMask）+ 库节点管理位策略。 */
function projectBase(input: ScopeProjectionInput, shape: LiveSchemaShape): ProjectedPolicy[] {
  const cfg = parseConfig(input.config);
  const out: ProjectedPolicy[] = [];

  for (const tableId of shape.tableIds) {
    const { actions, manageSchema } = tableActions(input, tableId);
    if (actions.length === 0) continue;
    if (manageSchema) actions.push("manage_schema");
    const mask = buildFieldMask(
      tableId,
      shape.fieldIdsByTable.get(tableId) ?? [],
      cfg.fields as FieldsConfig,
    );
    out.push(scopePolicy(nodeId("table", tableId), input.roleId, actions, mask));
  }

  const libActs = libraryManageActions(input);
  if (libActs.length > 0) {
    out.push(scopePolicy(nodeId("base", input.libraryId), input.roleId, libActs, null));
  }
  return out;
}

/**
 * kb：content 数据动作与库管理位合并到【单条 kb 节点策略】；
 * kb 本期不做 content 字段 mask，manage_schema 不挂 kb。
 */
function projectKb(input: ScopeProjectionInput): ProjectedPolicy[] {
  const { actions: contentActions } = tableActions(input, KB_CONTENT_KEY);
  const libActs = libraryManageActions(input);
  const merged = [...contentActions, ...libActs];
  if (merged.length === 0) return [];
  return [scopePolicy(nodeId("kb", input.libraryId), input.roleId, merged, null)];
}

/**
 * 把一条 scope 行展开为期望的 auth_policies 投影集（纯函数，无 IO）。
 * base：每表一条 + 库节点至多一条；kb：至多一条 kb 节点策略。
 */
export function projectScopeRow(
  row: ScopeProjectionInput,
  shape: LiveSchemaShape,
): ProjectedPolicy[] {
  return row.libraryKind === "kb" ? projectKb(row) : projectBase(row, shape);
}

// ---------- P1/S4：管理员隐含投影 ----------

export interface ImplicitAdminInput {
  bases: ReadonlyArray<{ libraryId: string; shape: LiveSchemaShape }>;
  kbs: ReadonlyArray<{ libraryId: string }>;
  /** role_admin 现有全部 scope 行（纯函数不查库，由调用方传入；缺省空数组）。 */
  adminScopeRows: ReadonlyArray<ScopeProjectionInput>;
}

/**
 * 由 scope 行合成 dto 并施加【第二代 admin 覆盖】：只强制 visible/canShare/canToggleShare，
 * 不强制 canManage，不给删库（libraryPolicy.resolve 的管理员分支逐字复现）。
 */
function adminDtoFor(
  rows: ReadonlyArray<ScopeProjectionInput>,
): ReturnType<typeof synthesizeAccess> {
  const dto = synthesizeAccess(
    rows.map((r) => ({
      canManage: r.canManage, visible: r.visible, canShare: r.canShare, config: r.config,
    })),
  );
  return { ...dto, visible: true, canToggleShare: true, canShare: true };
}

const rowsFor = (
  adminScopeRows: ReadonlyArray<ScopeProjectionInput>,
  libraryKind: "base" | "kb", libraryId: string,
): ScopeProjectionInput[] =>
  adminScopeRows.filter(
    (r) => r.libraryKind === libraryKind && r.libraryId === libraryId,
  );

/** 由 tableAccessOf 语义（wildcard→精确→visible 默认）推出动作集，comment 跟随 c/u/d。 */
function actionsFromTableAccess(ta: {
  read: boolean; create: boolean; update: boolean; delete: boolean;
}): ResourceAction[] {
  const actions: ResourceAction[] = [];
  if (ta.read) actions.push("r");
  if (ta.create) actions.push("c");
  if (ta.update) actions.push("u");
  if (ta.delete) actions.push("d");
  if (ta.create || ta.update || ta.delete) actions.push("comment");
  return actions;
}

/**
 * 管理员（role_admin）对全部活库/活表的隐含授权投影，逐字节对齐第二代 admin 口径：
 * 进所有库默认只读；管理权仍只来自其 scope 行 canManage；永不投影删库。
 * subjectId=role_admin、reason=scope:role（与 scope 同源，便于 replaceScopePoliciesTx 对账）。
 * 绝不生成 role_owner（超级管理员全权含删库，只走硬短路）。
 */
export function projectImplicitAdmin(input: ImplicitAdminInput): ProjectedPolicy[] {
  const out: ProjectedPolicy[] = [];

  for (const { libraryId, shape } of input.bases) {
    const dto = adminDtoFor(rowsFor(input.adminScopeRows, "base", libraryId));
    for (const tableId of shape.tableIds) {
      const ta = dto.tables["*"] ?? dto.tables[tableId]
        ?? { read: dto.visible, create: false, update: false, delete: false };
      const actions = actionsFromTableAccess(ta);
      if (dto.canManage) actions.push("manage_schema");
      if (actions.length === 0) continue;
      const adminRow = rowsFor(input.adminScopeRows, "base", libraryId)[0];
      const mask = buildFieldMask(
        tableId, shape.fieldIdsByTable.get(tableId) ?? [],
        parseConfig(adminRow?.config ?? "{}").fields as FieldsConfig,
      );
      out.push(scopePolicy(nodeId("table", tableId), ADMIN_ROLE_ID, actions, mask));
    }
    const libActs: ResourceAction[] = ["manage_share"]; // admin canShare 恒真
    if (dto.canManage) libActs.push("manage_table");
    out.push(scopePolicy(nodeId("base", libraryId), ADMIN_ROLE_ID, libActs, null));
  }

  for (const { libraryId } of input.kbs) {
    const dto = adminDtoFor(rowsFor(input.adminScopeRows, "kb", libraryId));
    const ta = dto.tables["*"] ?? dto.tables[KB_CONTENT_KEY]
      ?? { read: dto.visible, create: false, update: false, delete: false };
    const actions = actionsFromTableAccess(ta);
    actions.push("manage_share"); // admin canShare 恒真
    if (dto.canManage) actions.push("manage_table");
    out.push(scopePolicy(nodeId("kb", libraryId), ADMIN_ROLE_ID, actions, null));
  }

  return out;
}
