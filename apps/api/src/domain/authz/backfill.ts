// M4/S2 旧三表 -> auth_policies 投影原语（reconcile --apply 与未来 S5 双写共用，禁止第二套规则）。
//
// 纯域数据访问：只依赖注入 client，不 import Hono/guards/config；不读旧三表做决策，
// 这里读旧表仅为【投影对账】（把旧权威行翻译成 auth_policies 物理投影），与迁移 SQL 同规则。
// 动作串一律经 shared-types resourceActionsForLegacyRole + toActionString 生成，
// 不在本文件写第二份角色->动作字面量（迁移 SQL 字面量由测试交叉断言）。

import { resourceActionsForLegacyRole, toActionString, type LegacyRoleFamily } from "@gx/shared-types";
import type { AuthzClient } from "./types.js";

export const LEGACY_REASONS = {
  member: "legacy:member",
  kbMember: "legacy:kb_member",
  acl: "legacy:acl",
} as const;

export type LegacyReason = (typeof LEGACY_REASONS)[keyof typeof LEGACY_REASONS];

const BASE_ROLES = ["owner", "creator", "editor", "commenter", "viewer"] as const;
const KB_ROLES = ["owner", "editor", "commenter", "viewer"] as const;
const DOC_ROLES = ["editor", "commenter", "viewer"] as const;

export function isKnownLegacyRole(family: LegacyRoleFamily, role: string): boolean {
  const table = family === "base" ? BASE_ROLES : family === "kb" ? KB_ROLES : DOC_ROLES;
  return (table as readonly string[]).includes(role);
}

/** 旧角色 -> 规范化动作串（迁移 SQL CASE 字面量的应用侧等价，唯一真源在 shared-types）。 */
export function legacyActionString(family: LegacyRoleFamily, role: string): string {
  return toActionString(resourceActionsForLegacyRole(family, role));
}

export interface LegacyRow {
  /** 旧表行 id（确定性策略 id 用）。 */
  oldId: string;
  nodeId: string;
  userId: string;
  role: string;
  reason: LegacyReason;
  family: LegacyRoleFamily;
}

function policyId(reason: LegacyReason, oldId: string): string {
  const suffix = reason === LEGACY_REASONS.member
    ? "member"
    : reason === LEGACY_REASONS.kbMember
      ? "kbmember"
      : "acl";
  return `pol_legacy_${suffix}_${oldId}`;
}

/**
 * 投影一条旧权威行：按唯一键 (nodeId,user,subjectId) upsert 一条 legacy 策略。
 * 已存在（可能是手工/v1 策略占用同键）则仅当该行是 legacy 投影时校正动作串并集，
 * 非 legacy 行不覆盖（v1 策略权威更高，冲突由 reconcile A3 报人工）。返是否发生写。
 */
export async function upsertByLegacyRow(
  client: AuthzClient,
  row: LegacyRow,
): Promise<{ id: string; written: "created" | "updated" | "skipped" }> {
  const id = policyId(row.reason, row.oldId);
  const wanted = legacyActionString(row.family, row.role);

  const existing = await client.authPolicy.findFirst({
    where: { nodeId: row.nodeId, subjectType: "user", subjectId: row.userId },
    select: { id: true, actions: true, reason: true },
  });

  if (!existing) {
    await client.authPolicy.create({
      data: {
        id,
        workspaceId: "ws_default",
        nodeId: row.nodeId,
        subjectType: "user",
        subjectId: row.userId,
        actions: wanted,
        reason: row.reason,
        createdBy: "legacy-backfill",
      },
    });
    return { id, written: "created" };
  }

  // 同键已有行：只在它是同源 legacy 投影时做动作【超集】收敛（等价旧"取较高角色"）。
  const isLegacy = existing.reason === row.reason || existing.id === id;
  if (!isLegacy) return { id: existing.id, written: "skipped" };

  const merged = unionActionStrings(existing.actions, wanted);
  if (merged === existing.actions) return { id: existing.id, written: "skipped" };
  await client.authPolicy.update({ where: { id: existing.id }, data: { actions: merged } });
  return { id: existing.id, written: "updated" }
}

/** 两动作串并集后重规范化（字典序）；非包含关系也安全（纯并集，旧角色档之间实为包含关系）。 */
function unionActionStrings(a: string, b: string): string {
  return toActionString([...a.split(",").map((s) => s.trim()).filter(Boolean),
    ...b.split(",").map((s) => s.trim()).filter(Boolean)]);
}

/**
 * S5 双写专用：把一条旧权威行【精确覆盖】为其当前角色映射串（非并集）。
 * 与 upsertByLegacyRow 的差别：成员改角色（owner->viewer）必须同步【收窄】投影，
 * 若用并集会残留高档动作。一个 (node,user) 只可能由一张旧表的唯一行投影
 * （members->base / kb_members->kb / kb_doc_acls->doc），无真多源碰撞，故精确 SET 正确。
 * 已存在非同源 v1 手工策略占用同键时不覆盖（v1 权威更高），返回 skipped。
 */
export async function setLegacyByRowTx(
  client: AuthzClient,
  row: LegacyRow,
): Promise<{ id: string; written: "created" | "updated" | "skipped" }> {
  const id = policyId(row.reason, row.oldId);
  const wanted = legacyActionString(row.family, row.role);

  const existing = await client.authPolicy.findFirst({
    where: { nodeId: row.nodeId, subjectType: "user", subjectId: row.userId },
    select: { id: true, actions: true, reason: true },
  });

  if (!existing) {
    await client.authPolicy.create({
      data: {
        id,
        workspaceId: "ws_default",
        nodeId: row.nodeId,
        subjectType: "user",
        subjectId: row.userId,
        actions: wanted,
        reason: row.reason,
        createdBy: "legacy-backfill",
      },
    });
    return { id, written: "created" };
  }

  const isLegacy = existing.reason === row.reason || existing.id === id;
  if (!isLegacy) return { id: existing.id, written: "skipped" };
  if (existing.actions === wanted) return { id: existing.id, written: "skipped" };
  await client.authPolicy.update({ where: { id: existing.id }, data: { actions: wanted } });
  return { id: existing.id, written: "updated" };
}

/**
 * 批量投影（单事务）：逐条 upsertByLegacyRow，返回 created/updated/skipped 计数。
 * 超大客户分批由调用方切片（M4 计划 §5.3：脚本层 5000/批，迁移 SQL 单条）。
 */
export async function upsertLegacyRowsTx(
  client: AuthzClient,
  rows: readonly LegacyRow[],
): Promise<{ created: number; updated: number; skipped: number }> {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const r = await upsertByLegacyRow(client, row);
    if (r.written === "created") created++;
    else if (r.written === "updated") updated++;
    else skipped++;
  }
  return { created, updated, skipped };
}

/** 删除悬挂 legacy 投影（B1：旧表行已不存在）。按 (nodeId,user,reason) 定位。 */
export async function deleteLegacyProjectionTx(
  client: AuthzClient,
  key: { policyId: string },
): Promise<boolean> {
  const r = await client.authPolicy.deleteMany({ where: { id: key.policyId } });
  return r.count > 0;
}

/**
 * S5 双写：按 (reason, 旧表行 id) 确定性策略 id 删除投影（成员/ACL 移除同事务调用）。
 * 仅删 legacy 命名空间的行，绝不触碰 id 形态不同的 v1 手工策略（pol_*_v1_*）。
 */
export async function deleteLegacyByIdTx(
  client: AuthzClient,
  reason: LegacyReason,
  oldId: string,
): Promise<boolean> {
  const r = await client.authPolicy.deleteMany({ where: { id: policyId(reason, oldId) } });
  return r.count > 0;
}
