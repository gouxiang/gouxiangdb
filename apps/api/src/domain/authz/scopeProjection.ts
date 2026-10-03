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
import { WILDCARD_TABLE } from "./scopeSynthesize.js";

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
  // 通配优先 -> 精确 -> 缺省，逐字对齐第二代 tableAccessOf（libraryPolicy.ts:68-73）。
  // 不补这一格会让「配了 tables['*'] 的行」在通电后被判成只有 r：legacy 侧该角色对库内
  // 【每张】表都持 c/u/d，投影侧一份写权都不给 -> OVERDENY；库节点 edit_data 也会因
  // anyTableWritable 恒 false 算错。本机 203 条 scope 行实测 0 条通配配置，属潜伏缺口而
  // 非在发缺陷，但结构上是真缺口，翻闸前必须堵（见 ADR-0056）。
  const perTable = cfg.tables[WILDCARD_TABLE] ?? cfg.tables[tableId];
  const actions: ResourceAction[] = ["r"];
  if (perTable?.create) actions.push("c");
  if (perTable?.update) actions.push("u");
  if (perTable?.delete) actions.push("d");
  if (actions.includes("c") || actions.includes("u") || actions.includes("d")) {
    actions.push("comment");
  }
  return { actions, manageSchema: false };
}

/**
 * 库节点管理位：canManage -> 结构+表元数据+分享；否则显式 canShare -> 分享；纯只读 -> 空。
 *
 * manage_schema 必须落在【库节点】（与逐表那份并存，不互斥），三处既有事实同指一处：
 *   1) 七守 requireCanManageSchema 在 on 态按【base 节点】判 manage_schema（guards.ts:186，
 *      ref = { resourceType: "base" }）——只挂 table 节点会让库管理员被 OVERDENY 403；
 *   2) 第一代回填把 manage_schema 授在 base 节点（shared-types BASE_ROLE_ACTIONS
 *      owner/creator 档位串含 manage_schema，落点即 base 节点）；
 *   3) MCP 权限端口口径：manage_schema = 建表（base 节点）+ 字段/视图（table 节点）。
 * 不会越权放大：仅当 canManage=1 才补，而第二代 perm.canManageSchema 恒等于 access.canManage
 * （库级，guards.ts:69），库管理员本就持全部表的结构权；库级只读成员（canManage=0）不补。
 *
 * withSchema 仅 base 传 true：kb 节点挂 manage_schema 既无对应守卫、也过不了 kind-动作校验
 * （policyAdmin §4.1：manage_schema 仅 table/base 有意义），且第一代 kb 档位串不含它。
 */
/**
 * 库级准入位 `enter`：恒等于第二代 `access.visible`（ADR-0056 §4）。
 * 派生自库的 visible/canManage 两个位，**不遍历库内表**——故零表库照样 emit，
 * 这正是「判定层实时跑活表并集」做不到的事（空集会被判 deny）。
 * 管理员由 adminDtoFor 强制 visible=true 后同样命中本函数（F8 硬规则）。
 */
function enterAction(input: ScopeProjectionInput | { visible: number; canManage: number }): ResourceAction[] {
  return input.visible === 1 || input.canManage === 1 ? ["enter"] : [];
}

/** 活表里是否存在任一被授予写动作（c/u/d）的表。 */
function anyTableWritable(
  input: ScopeProjectionInput,
  tableIds: readonly string[],
): boolean {
  return tableIds.some((tid) => {
    const { actions } = tableActions(input, tid);
    return actions.includes("c") || actions.includes("u") || actions.includes("d");
  });
}

/**
 * 库级聚合位（ADR-0056 §4）：
 *   - `enter`     库级准入，恒等于 legacy `access.visible`；
 *   - `edit_data` 库内活表可写并集，恒等于 legacy `perm.canEditData`（= canManage ‖ 任一活表可写，
 *                 见 guards.ts:66）。
 *
 * 为什么不直接在库节点上给 r/u：这俩不是 r/c/u，故结构上进不了 fieldMask 的能力并集
 * （fieldMask.ts:85/226 只看 r/c/u），不会淹没收窄；且与 visible-scope 判的是同一枚位，
 * 不产生守卫↔探针分叉。见 AUTHZ-ENGINE-ON-LIBRARY-SEMANTICS.md §3.4。
 */
function libraryDataActions(input: ScopeProjectionInput, shape: LiveSchemaShape): ResourceAction[] {
  const out: ResourceAction[] = [...enterAction(input)];
  if (input.canManage === 1 || anyTableWritable(input, shape.tableIds)) out.push("edit_data");
  return out;
}

function libraryManageActions(input: ScopeProjectionInput, withSchema: boolean): ResourceAction[] {
  if (input.canManage === 1) {
    return withSchema ? ["manage_schema", "manage_table", "manage_share"] : ["manage_table", "manage_share"];
  }
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

  // 库节点 = 管理位 + 两枚聚合位（ADR-0056 §9.2-②）。零表库也 emit：enter 不依赖表。
  const libActs = [...libraryManageActions(input, true), ...libraryDataActions(input, shape)];
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
  const libActs = libraryManageActions(input, false);
  // kb 只追加 enter，不 emit edit_data（§7.2-3：kb 的内容写关在 content 档位上）。
  const merged = [...contentActions, ...libActs, ...enterAction(input)];
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
