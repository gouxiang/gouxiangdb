// beta.2 S4c：失权擦除链路的【执行器】（消费 S4a 已算好的 PurgePlan，做第一次真写）。
// 设计权威：DESIGN-OFFLINE-SYNC §9.3 + 决策 D2。它只在【调用方已打开的写事务 tx】内执行一份计划，
// 自己绝不开事务、绝不发网络、绝不读 env、不读文件、不碰 Date.now/Math.random（时间只能由 opts.now
// 注入，缺省 new Date() 一次），不挂路由/开关/定时器。合入后本模块不被任何 src 生产代码 import
// （唯一引用方是其单测），生产运行路径零行为变化。
//
// 最高硬约束：不破坏真实数据，宁残留不误删。全部删除一律【软删】（置 deletedAt，绝不物理 DELETE），
// 结构（table/field/view）永不擦，未来重新授权后权威端重拉 restore 即可恢复。
//
// 与下行 delete 回放（replicaPullApply.ts:138-149）物理动作【同构】、同样裸写：
//   - record.update(Many) 置 deletedAt（+可选 updatedBy）、linkRow.updateMany 两端置 deletedAt、
//     deleteRecordsTx 撤检索 sidecar；
//   - 绝不可复用在线 softDeleteRecordTx/createRecordTx/updateRecordTx/restoreRecordTx —— 它们带
//     oplog/outbox/变更历史切面，会把「权限被收回的被动缓存擦除」误当成「用户主动删除」上行同步；
//   - 绝不写 oplog/local_outbox/record change/检索 enqueue；字段收敛只裸改 records.fields 字符串。
//
// 幂等：所有软删/抹 key 都先 findMany 取【此刻仍活】的行再写，重复执行计数归零、不重复刷墓碑；
// sidecar 撤除只喂本次真正从活→墓碑的记录。坏 fields JSON 宁残留：跳过该记录、绝不抛错、绝不写半成品。

import type { DbTx } from "../../db.js";
import type { PurgePlan, PurgeReason } from "./replicaPurgePlan.js";
import { deleteRecordsTx } from "../fieldIndex/sync.js";

/** 硬拒原因码：拒绝擦除一个纯本地（从未与权威端同步）的副本 base（D2 最后闸门）。 */
export const PURGE_LOCAL_ONLY_REFUSED = "PURGE_LOCAL_ONLY_REFUSED" as const;

/** 纯本地 base 擦除拒绝错误：必须响亮失败，让调用方事务整体回滚，绝不静默。 */
export class ReplicaPurgeRefusedError extends Error {
  readonly code = PURGE_LOCAL_ONLY_REFUSED;
  constructor(baseId: string) {
    super(`refuse to purge local-only replica base: ${baseId}`);
    this.name = "ReplicaPurgeRefusedError";
  }
}

export interface ApplyReplicaPurgeOptions {
  /** 注入单一时间戳（所有 deletedAt 共用），便于测试确定；缺省 new Date()。 */
  now?: Date;
  /** 给了才写 updatedBy；不给不要捏造用户，保持记录原 updatedBy。 */
  actorUserId?: string;
}

export interface PurgeApplyResult {
  baseId: string;
  triggered: boolean;
  reason: PurgeReason;
  /** 本次真正从活→墓碑的记录数。 */
  recordsSoftDeleted: number;
  /** 本次真正从活→墓碑的 link 数。 */
  linksSoftDeleted: number;
  /** 实际重写了 fields JSON 的保留记录条数。 */
  recordsRescoped: number;
  /** 实际从 fields 抹掉的 key 总数。 */
  fieldKeysStripped: number;
  /** 传给 deleteRecordsTx 的本次新软删记录数。 */
  sidecarRecordsWithdrawn: number;
  /** 坏 JSON 宁残留、整条跳过的记录 id（字典序去重）。 */
  recordsSkippedMalformedFields: string[];
}

function asPlainObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * 解析一条保留记录的 fields 为普通对象；非 string/空串/非法 JSON/null/数组一律回 null（宁残留）。
 */
function parseFieldsObject(rawFields: string | null): Record<string, unknown> | null {
  if (typeof rawFields !== "string" || rawFields.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawFields);
  } catch {
    return null;
  }
  return asPlainObject(parsed);
}

/** 零差集/no-op 的统一返回（硬拒 local_only 在调用者之前已单独抛错）。 */
function noopResult(plan: PurgePlan): PurgeApplyResult {
  return {
    baseId: plan.baseId,
    triggered: false,
    reason: plan.reason,
    recordsSoftDeleted: 0,
    linksSoftDeleted: 0,
    recordsRescoped: 0,
    fieldKeysStripped: 0,
    sidecarRecordsWithdrawn: 0,
    recordsSkippedMalformedFields: [],
  };
}

/**
 * 在调用方写事务内执行一份已算好的 PurgePlan（软删可逆、默认关、不接线）。
 * 顺序不可调：先硬拒纯本地 → 再 no-op → 记录软删 → link 软删 → 撤 sidecar → 字段收敛。
 */
export async function applyReplicaPurgeTx(
  tx: DbTx,
  plan: PurgePlan,
  opts?: ApplyReplicaPurgeOptions,
): Promise<PurgeApplyResult> {
  const now = opts?.now ?? new Date();
  const actorUserId = opts?.actorUserId;

  // 1) 硬拒闸门（最先判，先于 triggered）：纯本地 base 永不被清，抛错令调用方事务整体回滚。
  if (plan.reason === "skipped_local_only") {
    throw new ReplicaPurgeRefusedError(plan.baseId);
  }

  // 2) 无差集（identical_authz_version / empty / ok 但零差集）：不做任何写。
  if (!plan.triggered) {
    return noopResult(plan);
  }

  // 3) 记录软删：只软删计划集中【此刻仍活】的记录，保证幂等计数精确。
  const liveRecords = plan.removedRecordIds.length
    ? await tx.record.findMany({
      where: { id: { in: plan.removedRecordIds }, deletedAt: null },
      select: { id: true },
    })
    : [];
  const liveRecordIds = liveRecords.map((r) => r.id);
  if (liveRecordIds.length > 0) {
    await tx.record.updateMany({
      where: { id: { in: liveRecordIds }, deletedAt: null },
      data: {
        deletedAt: now,
        // 给了 actor 才落 updatedBy；不给保持原值，绝不捏造系统用户。
        ...(actorUserId ? { updatedBy: actorUserId } : {}),
      },
    });
  }

  // 4) link 软删：同理只刷计划集中仍活的 link（link 无 updatedBy，不写）。
  const liveLinks = plan.affectedLinkRowIds.length
    ? await tx.linkRow.findMany({
      where: { id: { in: plan.affectedLinkRowIds }, deletedAt: null },
      select: { id: true },
    })
    : [];
  const liveLinkIds = liveLinks.map((l) => l.id);
  if (liveLinkIds.length > 0) {
    await tx.linkRow.updateMany({
      where: { id: { in: liveLinkIds }, deletedAt: null },
      data: { deletedAt: now },
    });
  }

  // 5) 撤检索 sidecar：只喂本次新软删记录（与 pull apply delete 同构；内部按 flag/raw 自跳过、幂等）。
  await deleteRecordsTx(tx, liveRecordIds);

  // 6) 字段抹 key（仅对仍保留的活记录）。按 recordId 聚合（S4a 每记录一条，这里兜底多条合并处理一次）。
  const rescopeByRecord = new Map<string, { tableId: string; fieldIds: Set<string> }>();
  for (const tablePurge of plan.tables) {
    for (const rf of tablePurge.rescopedFields) {
      let entry = rescopeByRecord.get(rf.recordId);
      if (!entry) {
        entry = { tableId: rf.tableId, fieldIds: new Set<string>() };
        rescopeByRecord.set(rf.recordId, entry);
      }
      for (const f of rf.fieldIds) entry.fieldIds.add(f);
    }
  }

  let recordsRescoped = 0;
  let fieldKeysStripped = 0;
  const malformed: string[] = [];

  if (rescopeByRecord.size > 0) {
    const recordIds = [...rescopeByRecord.keys()];
    // 一次 findMany（仍活记录），建 id→row map，无 N+1。
    const rows = await tx.record.findMany({
      where: { id: { in: recordIds }, deletedAt: null },
      select: { id: true, tableId: true, fields: true },
    });
    const rowMap = new Map(rows.map((r) => [r.id, r]));
    const liveRemoved = new Set(liveRecordIds);
    const updateData = (fields: string) =>
      actorUserId ? { fields, updatedBy: actorUserId } : { fields };

    for (const [recordId, target] of rescopeByRecord) {
      const row = rowMap.get(recordId);
      // 行不存在 / 已墓碑 / 跨表错配 / 属本次整擦记录（防御，findMany 已排除）→ 跳过，不计坏 JSON、不写。
      if (!row || liveRemoved.has(row.id) || row.tableId !== target.tableId) continue;

      const obj = parseFieldsObject(row.fields);
      if (obj === null) {
        // 宁残留：坏 JSON 整条跳过，不抛错、不写半成品。
        malformed.push(recordId);
        continue;
      }

      let stripped = 0;
      for (const key of target.fieldIds) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          delete obj[key];
          stripped += 1;
        }
      }
      // 物理上一个 key 都没删掉（计划要求的键不在）→ 不写、不计；至少删 1 个才回写。
      if (stripped > 0) {
        await tx.record.update({
          where: { id: recordId },
          data: updateData(JSON.stringify(obj)),
        });
        recordsRescoped += 1;
        fieldKeysStripped += stripped;
      }
    }
  }

  // 7/8) 结构/物理删除/oplog/outbox/变更历史/检索 enqueue 一律不碰；出参全 JSON 可序列化。
  return {
    baseId: plan.baseId,
    triggered: true,
    reason: plan.reason,
    recordsSoftDeleted: liveRecordIds.length,
    linksSoftDeleted: liveLinkIds.length,
    recordsRescoped,
    fieldKeysStripped,
    sidecarRecordsWithdrawn: liveRecordIds.length,
    recordsSkippedMalformedFields: [...new Set(malformed)].sort(),
  };
}
