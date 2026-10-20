// beta.2 S3b-3b：下行同步泵的【短事务游标状态原语】（DB 副作用边界）。
// 设计权威：DESIGN-OFFLINE-SYNC.md §6（订阅/基线/游标）、§8.3（seq keyset，游标单调 max 防乱序回退）。
//
// 与 replicaPushState 同纪律：每个函数都是一个独立短事务体（由编排器经 withWriteTx 入串行写队列调用）：
//   - 回调内只用传入 tx，绝不再入写队列/再开事务（并发度 1 自死锁），不 import 全局 prisma；
//   - 不发网络（HTTP 严格在事务外）；异常原样抛出，不吞错。
//
// 两条游标各装一张表（不可混用）：
//   - per-base：replica_state（nodeId+remoteBaseId 唯一）；保 id 直插故 localBaseId===remoteBaseId。
//   - 工作区树：replica_tree_state（nodeId+scopeId 唯一，scopeId 默认 ws_default；树不是 base 从属资源）。

import type { DbTx } from "../../db.js";

/** 编排器判定「空副本 / 取 after 起点」所需的 per-base 游标状态（读不触网）。 */
export interface BaseCursorState {
  localBaseId: string;
  pullCursorSeq: bigint;
  snapshotDone: boolean;
  subscribed: boolean;
  authzVersion: string | null;
}

/** 工作区树游标状态。 */
export interface TreeCursorState {
  scopeId: string;
  pullCursorSeq: bigint;
  snapshotDone: boolean;
  treeVersion: string;
  authzVersion: string | null;
}

export interface AdvanceBaseInput {
  nodeId: string;
  remoteBaseId: string;
  /** 本页已让副本看到的最大 seq（PullPage.nextCursor）；与旧值取 max，乱序/重放绝不回退。 */
  cursorSeq: bigint;
  /** 服务端 workspaces.policyVersion（数字）；存字符串，与导入门面同口径。 */
  authzVersion: number;
  now: Date;
}

/**
 * 推进 per-base 游标（一页一调，与该页 apply 同一短事务）。
 * 防御性 upsert：首次增量（理论上 bootstrap 已建行）也能自愈——create 记为已快照、不订阅。
 */
export async function advanceBaseTx(tx: DbTx, input: AdvanceBaseInput): Promise<void> {
  const prior = await tx.replicaState.findUnique({
    where: { nodeId_remoteBaseId: { nodeId: input.nodeId, remoteBaseId: input.remoteBaseId } },
    select: { pullCursorSeq: true },
  });
  const nextSeq = prior && prior.pullCursorSeq > input.cursorSeq ? prior.pullCursorSeq : input.cursorSeq;
  await tx.replicaState.upsert({
    where: { nodeId_remoteBaseId: { nodeId: input.nodeId, remoteBaseId: input.remoteBaseId } },
    create: {
      nodeId: input.nodeId,
      remoteBaseId: input.remoteBaseId,
      // 保 id 直插：本地承载 baseId===远端 baseId，无需 sync_id_map。
      localBaseId: input.remoteBaseId,
      pullCursorSeq: nextSeq,
      snapshotDone: true,
      subscribed: false,
      lastPulledAt: input.now,
      authzVersion: String(input.authzVersion),
      encrypted: false,
    },
    update: {
      pullCursorSeq: nextSeq,
      lastPulledAt: input.now,
      authzVersion: String(input.authzVersion),
    },
  });
}

/** 读 per-base 游标状态；无行返回 null（编排器据此判定必须先 bootstrap 引导）。 */
export async function readBaseStateTx(tx: DbTx, nodeId: string, remoteBaseId: string): Promise<BaseCursorState | null> {
  const row = await tx.replicaState.findUnique({
    where: { nodeId_remoteBaseId: { nodeId, remoteBaseId } },
  });
  if (!row) return null;
  return {
    localBaseId: row.localBaseId,
    pullCursorSeq: row.pullCursorSeq,
    snapshotDone: row.snapshotDone,
    subscribed: row.subscribed,
    authzVersion: row.authzVersion,
  };
}

export interface AdvanceTreeInput {
  nodeId: string;
  scopeId?: string;
  cursorSeq: bigint;
  /** 本页服务端树钟（TreePullPage.treeVersion 数字串）；仅当新值有效（非空、>"0"）才覆盖。 */
  treeVersion: string;
  authzVersion: number;
  now: Date;
}

/** 推进工作区树游标（树订阅即视为无需基线快照，snapshotDone 恒 true）。 */
export async function advanceTreeTx(tx: DbTx, input: AdvanceTreeInput): Promise<void> {
  const scopeId = input.scopeId ?? "ws_default";
  const prior = await tx.replicaTreeState.findUnique({
    where: { nodeId_scopeId: { nodeId: input.nodeId, scopeId } },
    select: { pullCursorSeq: true, treeVersion: true },
  });
  const nextSeq = prior && prior.pullCursorSeq > input.cursorSeq ? prior.pullCursorSeq : input.cursorSeq;
  // treeVersion 仅单调采纳有效新钟：空/非数字串/"0" 不覆盖既有值（防坏页把本地钟抹回 0）。
  const parsedTv = Number.parseInt(input.treeVersion, 10);
  const tvOk = Number.isInteger(parsedTv) && parsedTv > 0;
  const nextTreeVersion = prior?.treeVersion && (!tvOk || BigInt(parsedTv) < BigInt(prior.treeVersion || "0"))
    ? prior.treeVersion
    : tvOk ? String(parsedTv) : (prior?.treeVersion ?? "0");

  await tx.replicaTreeState.upsert({
    where: { nodeId_scopeId: { nodeId: input.nodeId, scopeId } },
    create: {
      nodeId: input.nodeId,
      scopeId,
      pullCursorSeq: nextSeq,
      snapshotDone: true,
      treeVersion: nextTreeVersion,
      authzVersion: String(input.authzVersion),
      lastPulledAt: input.now,
    },
    update: {
      pullCursorSeq: nextSeq,
      snapshotDone: true,
      treeVersion: nextTreeVersion,
      authzVersion: String(input.authzVersion),
      lastPulledAt: input.now,
    },
  });
}

/** 读工作区树游标状态；无行返回 null（编排器从 after=0n 开始拉全树增量）。 */
export async function readTreeStateTx(tx: DbTx, nodeId: string, scopeId: string = "ws_default"): Promise<TreeCursorState | null> {
  const row = await tx.replicaTreeState.findUnique({
    where: { nodeId_scopeId: { nodeId, scopeId } },
  });
  if (!row) return null;
  return {
    scopeId: row.scopeId,
    pullCursorSeq: row.pullCursorSeq,
    snapshotDone: row.snapshotDone,
    treeVersion: row.treeVersion,
    authzVersion: row.authzVersion,
  };
}
