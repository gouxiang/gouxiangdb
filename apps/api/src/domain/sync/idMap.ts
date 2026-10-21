// beta.2 S3-runtime：远端主键 ↔ 本地主键映射（sync_id_map）的【短事务原语】。
// 设计权威：docs/design/2026-0000-node-mode/DESIGN-OFFLINE-SYNC.md（离线 id 会合）。
//
// 背景：默认保 cuid 时服务端保留客户端实体 id（localEntityId===remoteEntityId），多数路径无需映射；
// 但一旦服务端在 replay 时重写实体 id（WirePushResult.entityId 与本地不同），后续 incoming 引用、
// 关联表回放就需要一张「本地 id ↔ 权威 id」对照表兜底。SyncIdMap 表已由 S2a 只增迁移建好，
// 本文件是其首个应用层读写边界。
//
// 纪律（与 replicaPushState.ts 同）：
//   - 每个函数只用传入 tx（DbTx），绝不在回调内再入写队列（并发度 1 自死锁）；
//   - 不发网络；异常原样抛出，由编排器在 withWriteTx 内提交 / 在外层 catch。
//   - 全部幂等：重放同一 clientOpId 不产生第二行、不报错（clientOpId @unique）。

import type { DbTx } from "../../db.js";

/** 一条 id 映射的身份键（对应 SyncIdMap 的复合唯一 [nodeId, entityType, localEntityId]）。 */
export interface IdMapKey {
  nodeId: string;
  entityType: string;
  localEntityId: string;
}

/** put：本地 create op 产生时预登记一行（此时服务端尚未接受，remoteEntityId 可空）。 */
export async function putIdMapTx(
  tx: DbTx,
  args: IdMapKey & { clientOpId: string; remoteEntityId?: string | null },
): Promise<void> {
  const remote = args.remoteEntityId?.trim() ? args.remoteEntityId : null;
  await tx.syncIdMap.upsert({
    where: { clientOpId: args.clientOpId },
    create: {
      nodeId: args.nodeId,
      entityType: args.entityType,
      localEntityId: args.localEntityId,
      clientOpId: args.clientOpId,
      remoteEntityId: remote,
    },
    // 重复登记同一 op：仅在本次确实带了非空权威 id 时回填，绝不用空值清掉既有映射。
    update: remote ? { remoteEntityId: remote } : {},
  });
}

/**
 * bind：推送 accepted 且服务端在回执里回了权威实体 id 时回填。
 * 采用 upsert 而非 update——create op 发出时尚无切面预登记 sync_id_map（S2 只登记 local_outbox），
 * 故 ack 时该行可能不存在：用 outbox row 上的 nodeId/entityType/entityId 就地补建，保证 id 会合链路
 * 不依赖「未来的 create 切面预登记」即可完整闭环。同一 clientOpId 重放只更新、不建行。
 */
export async function bindRemoteIdTx(
  tx: DbTx,
  args: IdMapKey & { clientOpId: string; remoteEntityId: string },
): Promise<void> {
  const remote = args.remoteEntityId.trim();
  if (!remote) return; // 空串等同「无权威 id」，不绑定、不覆盖。
  await tx.syncIdMap.upsert({
    where: { clientOpId: args.clientOpId },
    create: {
      nodeId: args.nodeId,
      entityType: args.entityType,
      localEntityId: args.localEntityId,
      clientOpId: args.clientOpId,
      remoteEntityId: remote,
    },
    update: { remoteEntityId: remote },
  });
}

/**
 * resolve：权威 id → 本地 id 反查（供未来 incoming op / 关联引用翻译），走 remoteEntityId 索引。
 * 找不到（默认保 cuid 时 localEntityId===remoteEntityId 仍会命中本行；非本地创建实体则无行）
 * 返回 null，调用方按「权威 id 即本地 id」兜底。
 */
export async function resolveLocalIdTx(
  tx: DbTx,
  args: { nodeId: string; entityType: string; remoteEntityId: string },
): Promise<string | null> {
  const row = await tx.syncIdMap.findFirst({
    where: {
      nodeId: args.nodeId,
      entityType: args.entityType,
      remoteEntityId: args.remoteEntityId,
    },
    select: { localEntityId: true },
  });
  return row?.localEntityId ?? null;
}
