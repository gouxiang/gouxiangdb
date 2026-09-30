// M4/S5 节点策略整单写事务编排：校验 -> 单事务（before 快照 / upsert+delete / 旧三表反向映射 /
// bump policyVersion）-> 返回 after 快照与 legacyUnmappable 明细。
//
// 单事务铁律（M3 裁决 9 延伸）：策略写、旧三表反写、版本号在同一 withWriteTx 内共生死；
// 反向映射任一旧表写失败 -> 策略写整体回滚（双向故障注入据此证明）。
// 纯域：只依赖注入 client/withWriteTx，不 import Hono。审计 diff 数据回传由路由落盘。

import { withWriteTx, prisma } from "../../db.js";
import {
  legacyRoleForActionString,
  legacyTargetForNode,
  loadTargetNode,
  parsePolicyBatch,
  unmappableReason,
  validateBatch,
  type PolicyDeleteInput,
  type PolicyUpsertInput,
} from "./policyAdmin.js";
import { upsertPolicyTx, deletePolicyTx } from "./repository.js";
import type { AuthzClient, AuthzNode } from "./types.js";

export interface LegacyUnmappableItem {
  subjectType: string;
  subjectId: string;
  reasons: string[];
}

interface PolicySnapshot {
  subjectType: string;
  subjectId: string;
  actions: string;
  fieldMask: string | null;
  reason: string | null;
}

export interface ApplyPolicyBatchResult {
  node: { id: string; kind: string; resourceType: string | null; resourceId: string | null; name: string };
  policyVersion: number;
  upserted: number;
  deleted: number;
  legacyUnmappable: LegacyUnmappableItem[];
  before: PolicySnapshot[];
  after: PolicySnapshot[];
}

async function snapshotKeys(
  tx: AuthzClient,
  nodeId: string,
  items: Array<{ subjectType: string; subjectId: string }>,
): Promise<PolicySnapshot[]> {
  const out: PolicySnapshot[] = [];
  for (const it of items) {
    const row = await tx.authPolicy.findFirst({
      where: { nodeId, subjectType: it.subjectType as "user" | "dept" | "role", subjectId: it.subjectId },
      select: { subjectType: true, subjectId: true, actions: true, fieldMask: true, reason: true },
    });
    if (row) out.push(row);
  }
  return out;
}

/** 反向写旧三表（仅可映射档）；upsert 到精确角色，delete 移除对应旧行。 */
async function reverseWriteLegacyTx(
  tx: AuthzClient,
  node: AuthzNode,
  upserts: Array<{ input: PolicyUpsertInput; actionString: string }>,
  deletes: PolicyDeleteInput[],
): Promise<void> {
  const target = legacyTargetForNode(node);

  for (const u of upserts) {
    if (u.input.subjectType !== "user" || !target) continue;
    const role = legacyRoleForActionString(target.family, u.actionString);
    if (!role) continue; // 不可映射：已由 unmappable 收集，旧表不动
    const userId = u.input.subjectId;
    const rid = node.resourceId!;
    if (target.table === "member") {
      await tx.member.upsert({
        where: { baseId_userId: { baseId: rid, userId } },
        update: { role },
        create: { baseId: rid, userId, role },
      });
    } else if (target.table === "kbMember") {
      await tx.kbMember.upsert({
        where: { kbId_userId: { kbId: rid, userId } },
        update: { role },
        create: { kbId: rid, userId, role },
      });
    } else {
      await tx.kbDocAcl.upsert({
        where: { docId_userId: { docId: rid, userId } },
        update: { role },
        create: { docId: rid, userId, role },
      });
    }
  }

  for (const d of deletes) {
    if (d.subjectType !== "user" || !target) continue;
    const userId = d.subjectId;
    const rid = node.resourceId!;
    if (target.table === "member") {
      await tx.member.deleteMany({ where: { baseId: rid, userId } });
    } else if (target.table === "kbMember") {
      await tx.kbMember.deleteMany({ where: { kbId: rid, userId } });
    } else {
      await tx.kbDocAcl.deleteMany({ where: { docId: rid, userId } });
    }
  }
}

/**
 * 应用节点策略整单写。actorId 落 createdBy。reason 固定 policy:v1（与 legacy:* 投影区分，
 * 回滚 down SQL 与对账据此识别手工策略）。
 */
export async function applyPolicyBatch(
  nodeId: string,
  body: unknown,
  actorId: string,
): Promise<ApplyPolicyBatchResult> {
  // 节点存在性在事务外先 fail-fast（404 早返回，避免无谓开事务）；语义存在性在事务内复核防 TOCTOU。
  await loadTargetNode(prisma, nodeId);
  const { upserts, deletes } = parsePolicyBatch(body);

  return await withWriteTx("authz.policy.batch", async (tx) => {
    const txNode = await loadTargetNode(tx, nodeId);
    const { normalized } = await validateBatch(tx, txNode, upserts, deletes);

    const allKeys = [
      ...upserts.map((u) => ({ subjectType: u.subjectType, subjectId: u.subjectId })),
      ...deletes.map((d) => ({ subjectType: d.subjectType, subjectId: d.subjectId })),
    ];
    const before = await snapshotKeys(tx, nodeId, allKeys);

    let upserted = 0;
    for (const [i, u] of upserts.entries()) {
      await upsertPolicyTx(tx, {
        nodeId,
        subjectType: u.subjectType,
        subjectId: u.subjectId,
        actions: normalized[i]!,
        fieldMask: u.fieldMask ? JSON.stringify(u.fieldMask) : null,
        conditions: u.conditions ? JSON.stringify(u.conditions) : null,
        reason: "policy:v1",
        createdBy: actorId,
      });
      upserted++;
    }
    let deleted = 0;
    for (const d of deletes) {
      const r = await deletePolicyTx(tx, { nodeId, subjectType: d.subjectType, subjectId: d.subjectId });
      if (r.deleted) deleted++;
    }

    // 旧三表反向映射（可映射档）；不可映射档收集明细但不阻断。
    await reverseWriteLegacyTx(
      tx,
      txNode,
      upserts.map((u, i) => ({ input: u, actionString: normalized[i]! })),
      deletes,
    );

    const legacyUnmappable: LegacyUnmappableItem[] = [];
    for (const [i, u] of upserts.entries()) {
      const reason = unmappableReason(txNode, u, normalized[i]!);
      if (reason) {
        const existing = legacyUnmappable.find((x) => x.subjectType === u.subjectType && x.subjectId === u.subjectId);
        if (existing) existing.reasons.push(reason);
        else legacyUnmappable.push({ subjectType: u.subjectType, subjectId: u.subjectId, reasons: [reason] });
      }
    }

    const ws = await tx.workspace.update({
      where: { id: "ws_default" },
      data: { policyVersion: { increment: 1 } },
      select: { policyVersion: true },
    });
    const after = await snapshotKeys(tx, nodeId, allKeys);

    return {
      node: {
        id: txNode.id,
        kind: txNode.kind,
        resourceType: txNode.resourceType,
        resourceId: txNode.resourceId,
        name: txNode.name,
      },
      policyVersion: ws.policyVersion,
      upserted,
      deleted,
      legacyUnmappable,
      before,
      after,
    };
  });
}
