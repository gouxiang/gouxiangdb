// beta.2 S3-runtime：定时同步引擎用到的【只读取数 + push 回写】短事务原语。
// 与 replicaPullState/replicaPushState 同纪律：回调内只用传入 tx、不发网络、异常原样抛出。
// 读原语也由编排器经 withWriteTx 调用（与 replica.pull.readBase 同款，读也走串行队列，避免与
// 正在 apply 的写事务打架）；本文件不建表、不迁移，只读 replica_state / users / role_assignments。

import type { DbTx } from "../../db.js";

/** status 端点与 reconcile 轮要用到的一行副本状态（与 ReplicaState 列对齐）。 */
export interface SubscribedBaseRow {
  remoteBaseId: string;
  localBaseId: string;
  snapshotDone: boolean;
  pullCursorSeq: bigint;
  subscribed: boolean;
  authzVersion: string | null;
  lastPulledAt: Date | null;
  lastPushedAt: Date | null;
}

/**
 * 列出本地已有副本状态行的 base（replica_state.findMany），按 remoteBaseId 升序保稳定处理顺序。
 * 用于：① reconcile 只对账本地确实订阅/引导过的 base（纯本地 base 无行、天然不入列，
 * 省一次无意义的 visibility 请求）；② status 端点 bases 计数。
 */
export async function listSubscribedBasesTx(tx: DbTx, nodeId: string): Promise<SubscribedBaseRow[]> {
  const rows = await tx.replicaState.findMany({
    where: { nodeId },
    orderBy: { remoteBaseId: "asc" },
  });
  return rows.map((r) => ({
    remoteBaseId: r.remoteBaseId,
    localBaseId: r.localBaseId,
    snapshotDone: r.snapshotDone,
    pullCursorSeq: r.pullCursorSeq,
    subscribed: r.subscribed,
    authzVersion: r.authzVersion,
    lastPulledAt: r.lastPulledAt,
    lastPushedAt: r.lastPushedAt,
  }));
}

/**
 * 取本地库「最早的 ACTIVE role_owner 用户」id 作为下行回放的属主（PullDeps.ownerUserId）。
 * 口径：role_assignments(roleId='role_owner', subjectType='user') 的主体里，users.status='ACTIVE'
 * 且 users.createdAt 最早者；并列按 user.id 保序。无任何合格 owner 返回 null（引擎记 lastError、
 * 本轮不拉不推，绝不匿名落数据）。
 */
export async function findEarliestOwnerUserIdTx(tx: DbTx): Promise<string | null> {
  const grants = await tx.roleAssignment.findMany({
    where: { roleId: "role_owner", subjectType: "user" },
    select: { subjectId: true },
  });
  if (grants.length === 0) return null;
  const user = await tx.user.findFirst({
    where: { id: { in: grants.map((g) => g.subjectId) }, status: "ACTIVE" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  return user?.id ?? null;
}

/**
 * push 一个 base 桶成功后回写：lastPushedAt=now、subscribed=true。
 * 用 updateMany 只更新已存在的 replica_state 行（pull/bootstrap 已建行）；绝不为「只推未拉」
 * 的 base 凭空 upsert 半成品状态行（那会让后续 readBaseState 误判为已快照副本）。
 */
export async function markBasePushedTx(
  tx: DbTx,
  args: { nodeId: string; remoteBaseId: string; now: Date },
): Promise<void> {
  await tx.replicaState.updateMany({
    where: { nodeId: args.nodeId, remoteBaseId: args.remoteBaseId },
    data: { lastPushedAt: args.now, subscribed: true },
  });
}
