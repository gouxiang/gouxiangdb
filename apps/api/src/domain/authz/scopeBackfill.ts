// apps/api/src/domain/authz/scopeBackfill.ts
// 通电前【存量全量投影】：把库里既有的 role_library_scope 行一次性展开进 auth_policies
//（reason='scope:role'），补上双写覆盖不到的存量缺口。
//
// 根因（已由真库坐实：本机 dev.db role_library_scope=203 行、auth_policies 里 scope:role=0 行）：
//   双写（scopeDoubleWrite.ts）只挂在【写路径】上——PUT /api/v1/org/library-scopes、
//   建库 seed、建表级联、字段结构变更——双写上线之前就已存在的 scope 行从未被投影过
//   （无迁移全量回填、无启动回填）。引擎通电瞬间只认 auth_policies 里有什么，
//   故不补这段存量就等于把用户配好的权限整体抹掉。
//
// 同源硬约束（ADR 明令禁止第二套映射规则，本文件不重新实现任何映射/比较）：
//   - 期望集与逐值比较全部复用 scopeProjectionReconcile.computeScopeProjectionReconcile
//     （其期望源为 scopeDoubleWrite.expectedScopePoliciesForRole，与 PUT/seed 主路径同一个）；
//   - 写入只走 scopeDoubleWrite.rebuildScopePoliciesTx（权威修复路径，内部只删 scope:role）；
//   - 本文件只做「差异分组 + 调权威修复 + 计数」。
//
// 边界：纯域，只依赖注入 client；不 import 全局 db / Hono / guards；不自行开事务
//（由调用方/测试包事务保证单次写事务）。

import type { AuthzClient } from "./types.js";
import { computeScopeProjectionReconcile } from "./scopeProjectionReconcile.js";
import { rebuildScopePoliciesTx } from "./scopeDoubleWrite.js";

/**
 * 超级管理员角色：授权只走硬短路，永不投影。与 scopeProjectionReconcile 同口径，
 * 本地常量避免 import org/roles 的 prisma 模块。
 */
const SUPER_ADMIN_ROLE_ID = "role_owner";

/** 运维存量投影的固定 operator（幂等投影维护，与运行时请求无关，不写审计）。 */
export const SCOPE_BACKFILL_OPERATOR = "system-scope-backfill";

/** 单角色的存量投影计划。expected 由恒等式推出：expected = stored - toDelete + toCreate。 */
export interface ScopeBackfillRolePlan {
  roleId: string;
  /** 该角色在 role_library_scope 的行数（可能为 0：管理员隐含覆盖不需要行）。 */
  scopeRows: number;
  /** 该角色现存 reason='scope:role' 的策略行数。 */
  stored: number;
  /** 该角色当前应有（期望）的投影行数。 */
  expected: number;
  /** 期望有、现存无（S1_MISSING）。 */
  toCreate: number;
  /** 节点都有但 actions/fieldMask 不等（S2/S3）。 */
  toUpdate: number;
  /** 现存有、期望无（S4_ORPHAN）。 */
  toDelete: number;
}

export interface ScopeBackfillPlan {
  roles: ScopeBackfillRolePlan[];
  totals: {
    scopeRows: number;
    stored: number;
    expected: number;
    toCreate: number;
    toUpdate: number;
    toDelete: number;
    /** 本次需要落地的变化总数（= toCreate + toUpdate + toDelete）；为 0 即已一致。 */
    changed: number;
  };
}

export interface ScopeBackfillApplyResult {
  created: number;
  updated: number;
  deleted: number;
  /** 被刻意跳过的变化数（硬短路角色，与对账口径一致，不投影）。 */
  skipped: number;
}

function countBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

function emptyTotals(): ScopeBackfillPlan["totals"] {
  return { scopeRows: 0, stored: 0, expected: 0, toCreate: 0, toUpdate: 0, toDelete: 0, changed: 0 };
}

/**
 * 只读计划：当前库离「存量全部投影」还差多少。
 * 差异来源唯一 = computeScopeProjectionReconcile（S 段），不另算一遍期望、不另写比较规则。
 * 幂等：已一致时 totals.changed=0 且 roles 里各项差异计数全 0（连跑第二次即 no changes）。
 */
export async function planScopeBackfill(client: AuthzClient): Promise<ScopeBackfillPlan> {
  const diffs = await computeScopeProjectionReconcile(client);

  interface Bucket { toCreate: number; toUpdate: number; toDelete: number }
  const byRole = new Map<string, Bucket>();
  for (const d of diffs) {
    const roleId = d.ref?.split("|")[0];
    if (!roleId) continue;
    const cur = byRole.get(roleId) ?? { toCreate: 0, toUpdate: 0, toDelete: 0 };
    if (d.code === "S1_MISSING") cur.toCreate += 1;
    else if (d.code === "S2_ACTION_MISMATCH" || d.code === "S3_MASK_MISMATCH") cur.toUpdate += 1;
    else if (d.code === "S4_ORPHAN") cur.toDelete += 1;
    byRole.set(roleId, cur);
  }

  const storedByRole = countBy(
    await client.authPolicy.findMany({
      where: { subjectType: "role", reason: "scope:role" },
      select: { subjectId: true },
    }),
    (r) => r.subjectId,
  );
  const scopeRowsByRole = countBy(
    await client.roleLibraryScope.findMany({ select: { roleId: true } }),
    (r) => r.roleId,
  );

  const roleIds = new Set<string>([...byRole.keys(), ...storedByRole.keys(), ...scopeRowsByRole.keys()]);
  const roles: ScopeBackfillRolePlan[] = [];
  const totals = emptyTotals();

  for (const roleId of [...roleIds].sort()) {
    const d = byRole.get(roleId) ?? { toCreate: 0, toUpdate: 0, toDelete: 0 };
    const stored = storedByRole.get(roleId) ?? 0;
    const expected = stored - d.toDelete + d.toCreate;
    const scopeRows = scopeRowsByRole.get(roleId) ?? 0;
    roles.push({ roleId, scopeRows, stored, expected, ...d });

    totals.scopeRows += scopeRows;
    totals.stored += stored;
    totals.expected += expected;
    totals.toCreate += d.toCreate;
    totals.toUpdate += d.toUpdate;
    totals.toDelete += d.toDelete;
  }
  totals.changed = totals.toCreate + totals.toUpdate + totals.toDelete;
  return { roles, totals };
}

/**
 * 单事务应用存量投影：只对【有差异的角色】调权威修复路径 rebuildScopePoliciesTx。
 * 计划为空（changed=0）时零写——这就是幂等的落点：第二次跑不产生任何写。
 *
 * role_owner 永不投影（硬短路，对账亦不审计），其差异计入 skipped 而非写入。
 * 调用方负责把本函数放进单个写事务（scripts 用 prisma.$transaction；运行时尚未接线）。
 */
export async function applyScopeBackfill(
  client: AuthzClient,
  plan?: ScopeBackfillPlan,
  operator: string = SCOPE_BACKFILL_OPERATOR,
): Promise<ScopeBackfillApplyResult> {
  const p = plan ?? await planScopeBackfill(client);
  let created = 0;
  let updated = 0;
  let deleted = 0;
  let skipped = 0;

  for (const r of p.roles) {
    const changed = r.toCreate + r.toUpdate + r.toDelete;
    if (changed === 0) continue;
    if (r.roleId === SUPER_ADMIN_ROLE_ID) {
      skipped += changed;
      continue;
    }
    // 权威修复路径：整角色精确替换（内部只删 reason='scope:role'，绝不碰 legacy:* / policy:v1）。
    const savedRows = await client.roleLibraryScope.findMany({ where: { roleId: r.roleId } });
    await rebuildScopePoliciesTx(client, r.roleId, savedRows, operator);
    created += r.toCreate;
    updated += r.toUpdate;
    deleted += r.toDelete;
  }

  return { created, updated, deleted, skipped };
}
