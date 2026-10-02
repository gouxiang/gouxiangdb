// apps/api/src/domain/recordChanges/store.ts
// 记录变更历史的**写侧**原语（照 domain/search/outbox.ts 的 enqueueChangeEventTx 形态）。
//
// 三条铁律：
//   1. 只用传入的 `tx`——必须挂在调用方主写事务内，与主写共生死（主写回滚则本行一并回滚）。
//      回调内绝不再调 runWrite/withWriteTx（写队列并发度恒 1，会自死锁）。
//   2. 开关关闭时（GX_RECORD_CHANGES 未显式 "on"）**完全不写表、零额外 IO**，
//      连 actorName 的用户查询都不做——默认 off 才敢挂在每次记录写的高频路径上。
//   3. 时间列交给 Prisma 落（@default(now())），**不用 SQL 批量 INSERT**：
//      SQLite 的 CURRENT_TIMESTAMP 与 Prisma 写入的毫秒串格式不同，混写会破坏倒序排序。

import type { DbTx } from "../../db.js";
import { recordChangesEnabled } from "../../configRecordChanges.js";
import type { FieldChange, RecordChangeOp } from "./types.js";

export interface AppendRecordChangeInput {
  tableId: string;
  recordId: string;
  op: RecordChangeOp;
  /** null = 系统写（读侧不回填空串，前端显示「系统」）。 */
  actorId: string | null;
  /** 字段级前后值；delete/restore 恒传 []。 */
  changes: FieldChange[];
}

/**
 * 在调用方事务内追加一条变更历史。
 * 开关关闭时静默返回（不抛错、不写库），异常（如 tx 已回滚）原样抛出让主事务失败。
 */
export async function appendRecordChangeTx(tx: DbTx, input: AppendRecordChangeInput): Promise<void> {
  if (!recordChangesEnabled()) return;

  // actorName 落快照：改名后历史条目仍显示当时的名字（不是"现在的名字"）。
  // 一次主键点查，仅开关打开时发生。查不到（userId 不在 users 表，如播种/系统身份）留 null。
  let actorName: string | null = null;
  if (input.actorId) {
    const u = await tx.user.findUnique({
      where: { id: input.actorId },
      select: { displayName: true },
    });
    actorName = u?.displayName ?? null;
  }

  await tx.recordChange.create({
    data: {
      tableId: input.tableId,
      recordId: input.recordId,
      op: input.op,
      actorId: input.actorId,
      actorName,
      changes: JSON.stringify(input.changes),
    },
  });
}

/** 物理删记录时清掉它的全部历史（无物理外键，不清会留悬挂行）。 */
export async function purgeRecordChangesTx(tx: DbTx, recordIds: readonly string[]): Promise<void> {
  if (recordIds.length === 0) return;
  await tx.recordChange.deleteMany({ where: { recordId: { in: [...recordIds] } } });
}

/** 物理删表时按 tableId 清掉该表全部历史。 */
export async function purgeTableRecordChangesTx(tx: DbTx, tableId: string): Promise<void> {
  await tx.recordChange.deleteMany({ where: { tableId } });
}
