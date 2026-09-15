// M4/S5 旧三表写点 -> auth_policies 同事务投影双写（M3 裁决 9 纪律延伸）。
//
// 每个旧权威写点（members / kb_members / kb_doc_acls 的加/改/移除）在其所在 withWriteTx
// 事务内调用本文件原语，使 auth_policies 与旧表共生死：任一写失败整体回滚，绝不留半截。
//
// 规则与回填迁移 / reconcile / backfill.ts 完全同源（同一确定性策略 id 与角色映射），
// 这里不写第二份角色->动作字面量；nav 节点 id 经 nav/backfill.nodeId 派生（无循环依赖）。
// 纯域数据访问：只依赖注入 tx，不 import Hono/guards/config/db 单例。

import {
  LEGACY_REASONS,
  setLegacyByRowTx,
  deleteLegacyByIdTx,
  type LegacyReason,
} from "./backfill.js";
import { nodeId } from "../nav/backfill.js";
import type { AuthzClient } from "./types.js";

type Tx = AuthzClient;

/** base 成员（加/改角色）投影到 base 节点 user 策略行（reason=legacy:member）。 */
export async function syncBaseMemberTx(
  tx: Tx,
  input: { oldRowId: string; baseId: string; userId: string; role: string },
): Promise<void> {
  await setLegacyByRowTx(tx, {
    oldId: input.oldRowId,
    nodeId: nodeId("base", input.baseId),
    userId: input.userId,
    role: input.role,
    reason: LEGACY_REASONS.member,
    family: "base",
  });
}

/** kb 成员（加/改角色）投影到 kb 节点 user 策略行（reason=legacy:kb_member）。 */
export async function syncKbMemberTx(
  tx: Tx,
  input: { oldRowId: string; kbId: string; userId: string; role: string },
): Promise<void> {
  await setLegacyByRowTx(tx, {
    oldId: input.oldRowId,
    nodeId: nodeId("kb", input.kbId),
    userId: input.userId,
    role: input.role,
    reason: LEGACY_REASONS.kbMember,
    family: "kb",
  });
}

/**
 * 单文档 ACL（加/改角色）投影到 doc/canvas 节点 user 策略行（reason=legacy:acl）。
 * nav resourceType 取 kb_docs.kind（doc|canvas），与回填迁移 JOIN 口径一致。
 */
export async function syncDocAclTx(
  tx: Tx,
  input: { oldRowId: string; docId: string; userId: string; role: string },
): Promise<void> {
  const doc = await tx.kbDoc.findUnique({ where: { id: input.docId }, select: { kind: true } });
  if (!doc) return; // 实体缺失：不投影（与回填"活实体"过滤一致），旧表写本身仍受其外键约束
  const kind = doc.kind === "canvas" ? "canvas" : "doc";
  await setLegacyByRowTx(tx, {
    oldId: input.oldRowId,
    nodeId: nodeId(kind, input.docId),
    userId: input.userId,
    role: input.role,
    reason: LEGACY_REASONS.acl,
    family: "doc",
  });
}

/** 按来源与旧行 id 移除一条 legacy 投影（成员/ACL 物理移除同事务调用）。 */
export async function removeLegacyProjectionTx(
  tx: Tx,
  reason: LegacyReason,
  oldRowId: string,
): Promise<void> {
  await deleteLegacyByIdTx(tx, reason, oldRowId);
}

/**
 * 文档/画布永久删：清掉该 doc 节点上【全部】legacy:acl 投影（同一 doc 的多条 ACL 行共指一个
 * doc/canvas 节点）。仅删 legacy:acl 命名空间，不碰 v1 手工/角色/部门策略（节点级清扫由
 * purgeDocNodeTx 负责）。kind 取 kb_docs.kind（doc|canvas）。
 */
export async function removeDocAclProjectionsTx(
  tx: Tx,
  input: { docId: string; kind: string },
): Promise<number> {
  const kind = input.kind === "canvas" ? "canvas" : "doc";
  const nid = nodeId(kind, input.docId);
  const r = await tx.authPolicy.deleteMany({ where: { nodeId: nid, reason: LEGACY_REASONS.acl } });
  return r.count;
}

export { LEGACY_REASONS };
