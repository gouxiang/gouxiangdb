// apps/api/src/domain/recordChanges/store.ts
// 记录变更历史的**写侧**原语（照 domain/search/outbox.ts 的 enqueueChangeEventTx 形态）。
//
// 四条铁律：
//   1. 只用传入的 `tx`——挂在调用方主写事务内，与主写共生死（主写回滚则本行一并回滚）。
//      回调内绝不再调 runWrite/withWriteTx（写队列并发度恒 1，会自死锁）。
//   2. **真旁路：本文件的任何异常都不得阻断业务写**。日志是观测通道，不是业务的一部分；
//      「日志侧出错 → 保存记录 500」是绝不能接受的事——项目硬约束是"不得对已产生的真实
//      数据造成破坏性影响"，业务写被旁路组件拖死正是要防的那种情形。故下面每个导出的
//      事务原语都把开关判断之后的整个函数体包进 try/catch，捕获后只 console.warn 一次
//      （模块级 warned 标志防刷屏）然后 return，绝不把异常抛回主事务。
//      代价是"这条没记"（可接受、可观测）；收益是"记录照样存下来"（不可妥协）。
//   3. 开关关闭时（GX_RECORD_CHANGES 显式 off）**完全不写表、零额外 IO**，
//      连 actorName 的用户查询都不做。开关默认开启，见 configRecordChanges.ts。
//   4. 时间列交给 Prisma 落（@default(now())），**不用 SQL 批量 INSERT**：
//      SQLite 的 CURRENT_TIMESTAMP 与 Prisma 写入的毫秒串格式不同，混写会破坏倒序排序。

import type { DbTx } from "../../db.js";
import { recordChangesEnabled } from "../../configRecordChanges.js";
import type { FieldChange, RecordChangeOp } from "./types.js";

/** 旁路失败只提示一次：日志写挂了要让人看见，但不能每次记录写都刷一行。 */
let warned = false;

function warnBypass(where: string, err: unknown): void {
  if (warned) return;
  warned = true;
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.warn(`[recordChanges] ${where} 失败已旁路（业务写不受影响，后续同类告警不再重复）：${msg}`);
}

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
 *
 * 开关关闭时静默返回（不抛错、不写库）；写入过程中任何异常一律吞掉并只告警一次——
 * 历史是旁路观测通道，绝不允许它把主写事务拖成 500。
 */
export async function appendRecordChangeTx(tx: DbTx, input: AppendRecordChangeInput): Promise<void> {
  if (!recordChangesEnabled()) return;
  try {
    // actorName 落快照：改名后历史条目仍显示当时的名字（不是"现在的名字"）。
    // 一次主键点查。查不到（userId 不在 users 表，如播种/系统身份）留 null。
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
  } catch (err) {
    warnBypass("appendRecordChangeTx", err);
  }
}

/** 物理删记录时清掉它的全部历史（无物理外键，不清会留悬挂行）。清不干净也不阻断物理删。 */
export async function purgeRecordChangesTx(tx: DbTx, recordIds: readonly string[]): Promise<void> {
  if (recordIds.length === 0) return;
  try {
    await tx.recordChange.deleteMany({ where: { recordId: { in: [...recordIds] } } });
  } catch (err) {
    warnBypass("purgeRecordChangesTx", err);
  }
}

/** 物理删表时按 tableId 清掉该表全部历史。同上：清理失败不阻断删表。 */
export async function purgeTableRecordChangesTx(tx: DbTx, tableId: string): Promise<void> {
  try {
    await tx.recordChange.deleteMany({ where: { tableId } });
  } catch (err) {
    warnBypass("purgeTableRecordChangesTx", err);
  }
}
