// P1/S8a auth_policies 对账新增 S 段：第二代 role_library_scope -> reason='scope:role' 投影的
// 【只读逐值差异计算】。期望集唯一来自 expectedScopePoliciesForRole（普通角色 projectScopeRow /
// role_admin projectImplicitAdmin 覆盖全部活库），与 PUT/seed 主路径同源，不另写规则。
//
// 差异码：
//   S1_MISSING        期望有某 nodeId、现存无；
//   S2_ACTION_MISMATCH  nodeId 都有但 actions（normalizeActions 归一）不等；
//   S3_MASK_MISMATCH    actions 相同但 fieldMask（allowFields/readOnlyFields 集合，顺序无关）不等；
//   S4_ORPHAN           现存有、期望集无（多余 scope:role 投影）。
//
// 口径：现存行只按 reason='scope:role' 过滤，绝不把 legacy:* / policy:v1 / user 行计入。

import { normalizeActions, type FieldMask } from "@gx/shared-types";
import type { AuthzClient } from "./types.js";
import type { ReconcileDiff } from "./reconcile.js";
import { expectedScopePoliciesForRole } from "./scopeDoubleWrite.js";

/**
 * 超级管理员角色：授权只走硬短路，scope 行仅为台账，rebuild/replace 路径【整体跳过】
 * （rebuildScopePoliciesTx 对其 no-op）。S 段必须与该权威修复路径一致，故不审计它——
 * 否则建表物理路径（syncTableForAllScopesTx）落到 table 节点的 owner 行会在健康库上
 * 误报 S4，且无法经 replace 路径修复。本地常量，避免 import org/roles 的 prisma 模块。
 */
const SUPER_ADMIN_ROLE_ID = "role_owner";

interface StoredScopeRow {
  nodeId: string;
  actions: string;
  fieldMask: string | null;
}

/** fieldMask 解析为字段集合（allow/readOnly 各一个 Set）；坏 JSON 归为空集（坏行另由 C 类捕获）。 */
function maskKey(raw: string | null): string {
  if (!raw) return "allow:|readonly:";
  let parsed: FieldMask;
  try {
    parsed = JSON.parse(raw) as FieldMask;
  } catch {
    return "allow:|readonly:";
  }
  const allow = new Set((parsed.allowFields ?? []).filter((x) => typeof x === "string"));
  const readOnly = new Set((parsed.readOnlyFields ?? []).filter((x) => typeof x === "string"));
  const sortJoin = (s: Set<string>): string => [...s].sort().join(",");
  return `allow:${sortJoin(allow)}|readonly:${sortJoin(readOnly)}`;
}

function actionKey(actions: string): string {
  return normalizeActions(actions.split(",").map((s) => s.trim()).filter(Boolean)).sort().join(",");
}

/**
 * 计算单个角色的 S 段差异。expectedByNode / storedByNode 均以 nodeId 为键
 *（同节点同角色 scope:role 行物理上唯一，重复另由 C4 报）。
 */
async function diffRole(client: AuthzClient, roleId: string): Promise<ReconcileDiff[]> {
  const expected = await expectedScopePoliciesForRole(client, roleId);
  const expectedByNode = new Map(expected.map((p) => [p.nodeId, p]));

  const stored: StoredScopeRow[] = await client.authPolicy.findMany({
    where: { subjectType: "role", subjectId: roleId, reason: "scope:role" },
    select: { nodeId: true, actions: true, fieldMask: true },
  });
  const storedByNode = new Map(stored.map((p) => [p.nodeId, p]));

  const diffs: ReconcileDiff[] = [];
  const ref = (nodeId: string): string => `${roleId}|${nodeId}`;

  for (const [nodeId, want] of expectedByNode) {
    const got = storedByNode.get(nodeId);
    if (!got) {
      diffs.push({
        code: "S1_MISSING",
        message: `缺少 scope 投影：期望 actions=${want.actions}`,
        ref: ref(nodeId),
      });
      continue;
    }
    const wantActions = actionKey(want.actions);
    const gotActions = actionKey(got.actions);
    if (wantActions !== gotActions) {
      diffs.push({
        code: "S2_ACTION_MISMATCH",
        message: `动作不一致：期望 [${wantActions}]，实际 [${gotActions}]`,
        ref: ref(nodeId),
      });
      continue;
    }
    if (maskKey(want.fieldMask) !== maskKey(got.fieldMask)) {
      diffs.push({
        code: "S3_MASK_MISMATCH",
        message: `字段掩码不一致：期望 ${want.fieldMask ?? "null"}，实际 ${got.fieldMask ?? "null"}`,
        ref: ref(nodeId),
      });
    }
  }

  for (const [nodeId, got] of storedByNode) {
    if (expectedByNode.has(nodeId)) continue;
    diffs.push({
      code: "S4_ORPHAN",
      message: `多余 scope 投影：实际 actions=[${actionKey(got.actions)}]，期望无此节点`,
      ref: ref(nodeId),
    });
  }
  return diffs;
}

/**
 * 遍历全部【活角色】（deletedAt=null）计算 S 段。
 * 含 role_admin：期望覆盖全部活库（未配 scope 行库的隐含只读），漏投影即 S1。
 * role_owner 不审计（硬短路角色，见文件头说明）。
 */
export async function computeScopeProjectionReconcile(client: AuthzClient): Promise<ReconcileDiff[]> {
  const roles = await client.role.findMany({
    where: { deletedAt: null, id: { not: SUPER_ADMIN_ROLE_ID } },
    select: { id: true },
  });
  const out: ReconcileDiff[] = [];
  for (const { id } of roles) {
    out.push(...await diffRole(client, id));
  }
  return out;
}
