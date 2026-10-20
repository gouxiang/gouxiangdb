// beta.2 S4d：失权对账的【authzVersion 单调记账原语】（DB 副作用边界）。
// 设计权威：docs/design/2026-10-node-mode/DESIGN-OFFLINE-SYNC.md §9.3（重连发现 authzVersion
// 变化 → 受限重快照）、§9.5（审计）、决策 D2（纯本地 base 永不擦）。
//
// 只动 replica_state.authzVersion【一列】：与 pull advanceBaseTx 共用同一列，语义为单调 max——
// 乱序/重放/旧快照绝不把版本钟改小；绝不碰 pullCursorSeq / snapshotDone / subscribed /
// lastPulledAt / lastPushedAt / encrypted（那些列由下行/上行泵各自负责）。
//
// 与 replicaPullState 同纪律：只在调用方已打开的写事务 tx 内执行，自身绝不开事务、不发网络、
// 不读 env/文件、不碰 Date.now/Math.random；异常原样抛出，不吞错。
// 与 pull advanceBaseTx 的关键差异：对账阶段【绝不 upsert 建行】——无 (nodeId,remoteBaseId) 行
// 意味着该 base 是纯本地 base（外层 reconcileVisibilityTx 在读状态步即已跳过），此原语再守一次：
// 无行只回报 advanced:false，绝不 create（绝不能让一次对账凭空把用户纯本地库登记成远端副本）。

import type { DbTx } from "../../db.js";

export interface ReconcileAuthzInput {
  nodeId: string;
  remoteBaseId: string;
  /** 服务端 VisibilityReport.authzVersion（数字）；存库统一 String() 序列化。 */
  authzVersion: number;
}

export interface AdvanceReconcileAuthzResult {
  /** 本次是否实际把列改成了更大的值。 */
  advanced: boolean;
  /** 改动前的列值（无行为 null；脏值原样回报字符串）。 */
  from: string | null;
  /** 本次【有效】版本：前进了为新值，未前进为既有值（无行时回调用方传入的 String(server)）。 */
  to: string;
}

/** 非负整数字符串判定（与 shouldReconcileAuthz 同口径，不 trim 之外的宽松）。 */
function isNonNegativeIntegerString(v: string): boolean {
  return /^\d+$/.test(v.trim());
}

/**
 * 单调推进某副本 base 的 authzVersion（只写这一列）。
 *  - 现有 null / 非数字脏值 → 视为从不可用状态前进，写入 String(server)；
 *  - 现有为数字且 >= server → 不写（乱序/重放不放行回退），advanced:false，to 回现有值；
 *  - 无行 → 不 create，advanced:false，from:null，to:String(server)。
 */
export async function advanceReconcileAuthzTx(
  tx: DbTx,
  input: ReconcileAuthzInput,
): Promise<AdvanceReconcileAuthzResult> {
  const target = String(input.authzVersion);

  const prior = await tx.replicaState.findUnique({
    where: { nodeId_remoteBaseId: { nodeId: input.nodeId, remoteBaseId: input.remoteBaseId } },
    select: { authzVersion: true },
  });

  // 无行：纯本地 base（外层已拦），绝不 upsert 建行。
  if (prior === null) {
    return { advanced: false, from: null, to: target };
  }

  const from = prior.authzVersion;

  // null / 非数字脏值：保守前进到服务端权威版本（避免下轮重复全量对比，也不因脏值漏擦）。
  if (from === null || !isNonNegativeIntegerString(from)) {
    await tx.replicaState.update({
      where: { nodeId_remoteBaseId: { nodeId: input.nodeId, remoteBaseId: input.remoteBaseId } },
      data: { authzVersion: target },
    });
    return { advanced: true, from, to: target };
  }

  // 数字对数字：严格大于才前进；相等/更小一律不写（单调 max，永不回退）。
  if (BigInt(target) > BigInt(from.trim())) {
    await tx.replicaState.update({
      where: { nodeId_remoteBaseId: { nodeId: input.nodeId, remoteBaseId: input.remoteBaseId } },
      data: { authzVersion: target },
    });
    return { advanced: true, from, to: target };
  }

  // to 回报列里的既有原值（含可能的空白），不做归一化改写。
  return { advanced: false, from, to: from };
}
