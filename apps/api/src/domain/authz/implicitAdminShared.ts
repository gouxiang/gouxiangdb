// apps/api/src/domain/authz/implicitAdminShared.ts
// 管理员（role_admin）隐含投影的共用零件：入参形状、admin 覆盖、动作推导。
// 从 scopeProjection.ts 拆出（单文件 ≤300 行硬门禁）；纯函数、零 IO。
//
// 口径逐字对齐第二代 libraryPolicy.resolve 的管理员分支与 guards.permit，
// 由 implicitAdminBase.ts / implicitAdminKb.ts 两处投影复用，不重复各写一份。

import type { ResourceAction } from "@gx/shared-types";
import { synthesizeAccess } from "./scopeSynthesize.js";
import type { LiveSchemaShape, ScopeProjectionInput } from "./scopeProjection.js";

/** 系统管理员角色 id（org/roles.ts ADMIN_ROLE_ID，本地常量避免 import 其 prisma 模块）。 */
export const ADMIN_ROLE_ID = "role_admin";

export interface ImplicitAdminInput {
  bases: ReadonlyArray<{ libraryId: string; shape: LiveSchemaShape }>;
  kbs: ReadonlyArray<{ libraryId: string }>;
  /** role_admin 现有全部 scope 行（纯函数不查库，由调用方传入；缺省空数组）。 */
  adminScopeRows: ReadonlyArray<ScopeProjectionInput>;
}

/**
 * 由 scope 行合成 dto 并施加【第二代 admin 覆盖】：只强制 visible/canShare/canToggleShare，
 * 不强制 canManage，不给删库（libraryPolicy.resolve 的管理员分支逐字复现，F8）。
 */
export function adminDtoFor(
  rows: ReadonlyArray<ScopeProjectionInput>,
): ReturnType<typeof synthesizeAccess> {
  const dto = synthesizeAccess(
    rows.map((r) => ({
      canManage: r.canManage, visible: r.visible, canShare: r.canShare, config: r.config,
    })),
  );
  return { ...dto, visible: true, canToggleShare: true, canShare: true };
}

/** 从管理员全部 scope 行里筛出某个库的行（base/kb 分族）。 */
export const rowsFor = (
  adminScopeRows: ReadonlyArray<ScopeProjectionInput>,
  libraryKind: "base" | "kb", libraryId: string,
): ScopeProjectionInput[] =>
  adminScopeRows.filter(
    (r) => r.libraryKind === libraryKind && r.libraryId === libraryId,
  );

/** 由 tableAccessOf 语义（wildcard→精确→visible 默认）推出动作集，comment 跟随 c/u/d。 */
export function actionsFromTableAccess(ta: {
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
