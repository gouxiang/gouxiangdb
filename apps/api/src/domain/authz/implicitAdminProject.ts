// apps/api/src/domain/authz/implicitAdminProject.ts
// 管理员（role_admin）对全部活库/活表的【隐含授权投影】。
// 从 scopeProjection.ts 拆出（单文件 ≤300 行硬门禁）；纯函数、零 IO。
//
// 逐字节对齐第二代 admin 口径：进所有库默认只读；管理权仍只来自 scope 行 canManage；
// 永不投影删库；subjectId=role_admin、reason=scope:role（与 scope 同源，便于对账）。
// 绝不生成 role_owner（超级管理员全权含删库，只走硬短路）。

import type { ResourceAction } from "@gx/shared-types";
import { KB_CONTENT_KEY, toActionString } from "@gx/shared-types";
import { nodeId } from "../nav/backfill.js";
import { parseConfig } from "./libraryScopeConfig.js";
import {
  buildFieldMask,
  type ProjectedPolicy,
} from "./scopeProjection.js";
import {
  ADMIN_ROLE_ID,
  actionsFromTableAccess,
  adminDtoFor,
  rowsFor,
  type ImplicitAdminInput,
} from "./implicitAdminShared.js";

export type { ImplicitAdminInput } from "./implicitAdminShared.js";

type FieldsConfig = Readonly<
  Record<string, Record<string, "editable" | "visible" | "hidden">>
>;

/** 直接构造一条 scope:role 投影（与 scopeProjection.scopePolicy 同形状，避免回调依赖）。 */
function policy(nodeIdValue: string, actions: readonly ResourceAction[]): ProjectedPolicy {
  return {
    nodeId: nodeIdValue,
    subjectType: "role",
    subjectId: ADMIN_ROLE_ID,
    actions: toActionString(actions),
    fieldMask: null, // I2：聚合位/管理位策略恒不带掩码
    reason: "scope:role",
  };
}

/** base 族投影：逐表（含 mask）+ base 节点管理位与两枚聚合位。 */
function projectBases(input: ImplicitAdminInput): ProjectedPolicy[] {
  const out: ProjectedPolicy[] = [];
  for (const { libraryId, shape } of input.bases) {
    const dto = adminDtoFor(rowsFor(input.adminScopeRows, "base", libraryId));
    let anyWritable = false;

    for (const tableId of shape.tableIds) {
      const ta = dto.tables["*"] ?? dto.tables[tableId]
        ?? { read: dto.visible, create: false, update: false, delete: false };
      const actions = actionsFromTableAccess(ta);
      if (dto.canManage) actions.push("manage_schema");
      // 逐值对齐 guards.ts:66 canEditData = canManage ‖ anyWritable。
      if (actions.includes("c") || actions.includes("u") || actions.includes("d")) anyWritable = true;
      if (actions.length === 0) continue;

      const adminRow = rowsFor(input.adminScopeRows, "base", libraryId)[0];
      const mask = buildFieldMask(
        tableId, shape.fieldIdsByTable.get(tableId) ?? [],
        parseConfig(adminRow?.config ?? "{}").fields as FieldsConfig,
      );
      const row = policy(nodeId("table", tableId), actions);
      out.push(mask ? { ...row, fieldMask: JSON.stringify(mask) } : row);
    }

    const libActs: ResourceAction[] = ["manage_share"]; // admin canShare 恒真
    libActs.push("enter"); // 管理员对全部活库隐含只读覆盖（F8 强制 visible=true）
    // edit_data：逐值对齐 legacy canEditData，未勾 canManage 的管理员不给。
    if (dto.canManage || anyWritable) libActs.push("edit_data");
    // manage_schema 同挂库节点：七守 requireCanManageSchema 按 base 节点判。
    if (dto.canManage) libActs.push("manage_table", "manage_schema");
    out.push(policy(nodeId("base", libraryId), libActs));
  }
  return out;
}

/** kb 族投影：content 动作 + 管理位 + enter + share_link 合并到单条 kb 节点（kb 不 emit edit_data §7.2-3）。 */
function projectKbs(input: ImplicitAdminInput): ProjectedPolicy[] {
  const out: ProjectedPolicy[] = [];
  for (const { libraryId } of input.kbs) {
    const dto = adminDtoFor(rowsFor(input.adminScopeRows, "kb", libraryId));
    const ta = dto.tables["*"] ?? dto.tables[KB_CONTENT_KEY]
      ?? { read: dto.visible, create: false, update: false, delete: false };
    const actions = actionsFromTableAccess(ta);
    actions.push("manage_share"); // admin canShare 恒真（总闸管理位）
    actions.push("enter");
    if (dto.canManage) actions.push("manage_table");
    // 建链位 share_link：canManage=1 或 canShare=1 投影。管理员 canShare 恒真，故 admin
    // 的 kb 节点必带 share_link（与普通角色 scope 投影 projectKb 同口径，二者分离于 manage_share）。
    if (dto.canManage || dto.canShare) actions.push("share_link");
    out.push(policy(nodeId("kb", libraryId), actions));
  }
  return out;
}

/** 管理员隐含投影入口：base 族 + kb 族。 */
export function projectImplicitAdmin(input: ImplicitAdminInput): ProjectedPolicy[] {
  return [...projectBases(input), ...projectKbs(input)];
}
