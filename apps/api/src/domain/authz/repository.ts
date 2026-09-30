// M4/S1 auth_policies 定数读取 + CRUD *Tx 原语（S5 策略管理复用）。
//
// 纯域：只依赖注入 client 查 auth_policies，不 import Hono/guards，不查 members/kb_members/
// kb_doc_acls（影子旧决策由适配层传入，引擎不读旧三表——权威单一边界）。
// 动作包含判定在内存（解析 actions 串），不用 SQL LIKE，避免转义与前缀误命中。

import {
  parseActionString,
  parseRowConditions,
  type FieldMask,
  type ResourceAction,
  type RowConditions,
} from "@gx/shared-types";
import type { AuthzClient, ResolvedSubject, ScopedPolicy } from "./types.js";

const POLICY_SELECT = {
  id: true,
  nodeId: true,
  subjectType: true,
  subjectId: true,
  actions: true,
  fieldMask: true,
  conditions: true,
} as const;

type PolicyRow = {
  id: string;
  nodeId: string;
  subjectType: string;
  subjectId: string;
  actions: string;
  fieldMask: string | null;
  conditions: string | null;
};

/**
 * 解析行级条件存储串：空 -> null（宽）；坏 JSON/结构 -> shared-types PolicyValidationError
 * 自然冒泡（on 态 fail-closed，调用方不吞）。
 */
function parseRowConditionsForPolicy(raw: string | null): RowConditions | null {
  if (!raw) return null;
  return parseRowConditions(raw);
}

function parseFieldMask(raw: string | null): FieldMask | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as FieldMask;
    return null;
  } catch {
    return null;
  }
}

/**
 * 三源 OR 一条 SQL 取给定节点集上对主体可见的候选 allow 策略：
 *   user 直接授予 / role（effectiveOrgRoles 已展开，roleId IN）/
 *   dept（subject.deptAncestorIds = 用户各部门 path 切段闭包，祖先部门授予一并取回）。
 * dept 源取回后在内存按 path 前缀精确判定（防止"祖先 id 恰好同名段"式误命中，
 * 同 M2 effectiveRoleRows 的闭包口径）。节点集 = 自身 + cutoff 内祖先（通常 ≤ 6），
 * nodeId IN 一次取回，与部门深度/兼岗数无关。
 */
export async function policiesOnNodesTx(
  client: AuthzClient,
  nodeIds: readonly string[],
  subject: ResolvedSubject,
): Promise<ScopedPolicy[]> {
  if (nodeIds.length === 0) return [];
  const rows = await client.authPolicy.findMany({
    where: {
      nodeId: { in: [...nodeIds] },
      OR: [
        { subjectType: "user", subjectId: subject.userId },
        ...(subject.roleIds.length
          ? [{ subjectType: "role", subjectId: { in: subject.roleIds } }]
          : []),
        ...(subject.deptAncestorIds.length
          ? [{ subjectType: "dept", subjectId: { in: subject.deptAncestorIds } }]
          : []),
      ],
    },
    select: POLICY_SELECT,
  });

  const out: ScopedPolicy[] = [];
  for (const row of rows as PolicyRow[]) {
    const st = row.subjectType;
    if (st !== "user" && st !== "role" && st !== "dept") continue;
    // dept 源：被授部门必须落在用户任一活部门的祖先闭包内（含本部门）。
    if (st === "dept" && !deptPolicyMatches(row.subjectId, subject)) continue;
    out.push({
      id: row.id,
      nodeId: row.nodeId,
      subjectType: st,
      subjectId: row.subjectId,
      actions: parseActionString(row.actions) as ResourceAction[],
      fieldMask: parseFieldMask(row.fieldMask),
      rowConditions: parseRowConditionsForPolicy(row.conditions),
      viaAncestor: false, // 由 engine 按决策节点 vs 策略节点标注
    });
  }
  return out;
}

/** dept 源命中：被授部门 id 出现在用户任一活部门 path 的切段闭包中（同部门或其祖先）。 */
function deptPolicyMatches(grantedDeptId: string, subject: ResolvedSubject): boolean {
  return subject.departments.some((d) =>
    d.path.split("/").filter(Boolean).includes(grantedDeptId),
  );
}

/**
 * S4 scope 批量：取工作区内对该主体三源可见的【全部】候选策略（不带 nodeId IN——scope 客体
 * 可达万节点，IN 列表会超 SQLite 999 变量上限）。与 policiesOnNodesTx 同一三源 OR 与 dept
 * 内存闭包判定，动作不在 SQL 过滤（内存判，与 decide 一致）。调用方按活节点/kind/动作在内存收敛。
 */
export async function policiesForSubjectTx(
  client: AuthzClient,
  subject: ResolvedSubject,
  workspaceId = "ws_default",
): Promise<ScopedPolicy[]> {
  const rows = await client.authPolicy.findMany({
    where: {
      workspaceId,
      OR: [
        { subjectType: "user", subjectId: subject.userId },
        ...(subject.roleIds.length
          ? [{ subjectType: "role", subjectId: { in: subject.roleIds } }]
          : []),
        ...(subject.deptAncestorIds.length
          ? [{ subjectType: "dept", subjectId: { in: subject.deptAncestorIds } }]
          : []),
      ],
    },
    select: POLICY_SELECT,
  });

  const out: ScopedPolicy[] = [];
  for (const row of rows as PolicyRow[]) {
    const st = row.subjectType;
    if (st !== "user" && st !== "role" && st !== "dept") continue;
    if (st === "dept" && !deptPolicyMatches(row.subjectId, subject)) continue;
    out.push({
      id: row.id,
      nodeId: row.nodeId,
      subjectType: st,
      subjectId: row.subjectId,
      actions: parseActionString(row.actions) as ResourceAction[],
      fieldMask: parseFieldMask(row.fieldMask),
      rowConditions: parseRowConditionsForPolicy(row.conditions),
      viaAncestor: false,
    });
  }
  return out;
}

// ---- S5 CRUD 原语（S1 先落，无调用方；动作规范化在 service 层，这里只持久化） ----

export interface PolicyUpsertInput {
  nodeId: string;
  subjectType: "user" | "dept" | "role";
  subjectId: string;
  /** 已规范化的存储串（字典序逗号分隔）。 */
  actions: string;
  fieldMask?: string | null;
  /** 行级条件存储串；undefined＝不改，null＝显式清空。 */
  conditions?: string | null;
  reason?: string | null;
  createdBy: string;
  workspaceId?: string;
}

/** 按 (nodeId,subjectType,subjectId) 唯一键 upsert 一条策略（同事务原语）。 */
export async function upsertPolicyTx(
  client: AuthzClient,
  input: PolicyUpsertInput,
): Promise<{ id: string; created: boolean }> {
  const existing = await client.authPolicy.findFirst({
    where: { nodeId: input.nodeId, subjectType: input.subjectType, subjectId: input.subjectId },
    select: { id: true },
  });
  if (existing) {
    await client.authPolicy.update({
      where: { id: existing.id },
      data: {
        actions: input.actions,
        ...(input.fieldMask !== undefined ? { fieldMask: input.fieldMask } : {}),
        ...(input.conditions !== undefined ? { conditions: input.conditions } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
    });
    return { id: existing.id, created: false };
  }
  const created = await client.authPolicy.create({
    data: {
      workspaceId: input.workspaceId ?? "ws_default",
      nodeId: input.nodeId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      actions: input.actions,
      fieldMask: input.fieldMask ?? null,
      conditions: input.conditions ?? null,
      reason: input.reason ?? null,
      createdBy: input.createdBy,
    },
    select: { id: true },
  });
  return { id: created.id, created: true };
}

/** 删除一条策略（不存在为幂等 no-op）。 */
export async function deletePolicyTx(
  client: AuthzClient,
  key: { nodeId: string; subjectType: "user" | "dept" | "role"; subjectId: string },
): Promise<{ deleted: boolean }> {
  const result = await client.authPolicy.deleteMany({ where: key });
  return { deleted: result.count > 0 };
}
