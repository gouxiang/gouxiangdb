// apps/api/src/domain/fieldIndex/sync.ts
// M1/S4 sidecar（record_field_index）同事务写维护。
//
// 铁律：
//   1) 所有函数在【调用方已开启的交互事务】内执行，只接收 tx，绝不自行开事务/入写队列
//      （S1：事务回调体内再入队会自死锁）；调用点把它放在 record JSON 写之后、提交之前。
//   2) 只写不读业务结果——sidecar 是派生冗余，S6 前没有任何读路径查它；
//      linkRow 变化不进 sidecar（links/subtable 已被 policy 排除）。
//   3) GX_M1_SIDECAR 默认常开，=off 旁路；内存 fake prisma 无 $executeRawUnsafe 时
//      自动跳过（路由 mock 单测不受影响）。维护异常是否阻断主业务由 safeSync 决定。

import type { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import type { DbTx } from "../../db.js";
import { buildExpectedRows, type ExpectedSidecarRow } from "./policy.js";

/** sync 所需的最小事务能力（Prisma DbTx/全局 client 满足；内存 mock 通常缺 raw 方法）。 */
export interface SidecarTx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $executeRawUnsafe: (query: string, ...values: any[]) => Promise<any>;
  record: {
    findMany: DbTx["record"]["findMany"];
  };
  field: {
    findMany: DbTx["field"]["findMany"];
  };
  table: {
    findUnique: DbTx["table"]["findUnique"];
  };
}

type SidecarRow = ExpectedSidecarRow;

/** 开关：GX_M1_SIDECAR=off 旁路（停写维护）；未设置/on 均常开（写维护常开，只写不读）。 */
export function resolveSidecarEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GX_M1_SIDECAR !== "off";
}

/** 该 tx 是否具备 raw 写能力（内存 fake prisma 无 $executeRawUnsafe → 跳过维护）。 */
function supportsRaw(tx: unknown): tx is SidecarTx {
  return (
    typeof tx === "object" &&
    tx !== null &&
    typeof (tx as SidecarTx).$executeRawUnsafe === "function" &&
    typeof (tx as SidecarTx).record?.findMany === "function" &&
    typeof (tx as SidecarTx).field?.findMany === "function" &&
    typeof (tx as SidecarTx).table?.findUnique === "function"
  );
}

/** 读该表字段 + 主字段，把给定记录抽成扁平 sidecar 行（复用 policy 单一事实源）。 */
async function collectRows(tx: SidecarTx, tableId: string, recordIds: string[]): Promise<SidecarRow[]> {
  const [fieldRows, records, table] = await Promise.all([
    tx.field.findMany({ where: { tableId, deletedAt: null }, select: { id: true, type: true } }) as Promise<
      { id: string; type: string }[]
    >,
    tx.record.findMany({
      where: { id: { in: recordIds }, deletedAt: null },
      select: { id: true, tableId: true, fields: true },
    }) as Promise<{ id: string; tableId: string; fields: string }[]>,
    tx.table.findUnique({ where: { id: tableId }, select: { primaryFieldId: true } }),
  ]);
  return buildExpectedRows({
    fieldsMeta: fieldRows,
    primaryFieldId: table?.primaryFieldId ?? "",
    records,
  });
}

async function deleteByRecords(tx: SidecarTx, recordIds: string[]): Promise<void> {
  const placeholders = recordIds.map(() => "?").join(",");
  await tx.$executeRawUnsafe(
    `DELETE FROM record_field_index WHERE "recordId" IN (${placeholders})`,
    ...recordIds,
  );
}

async function insertRows(tx: SidecarTx, rows: SidecarRow[]): Promise<void> {
  // 分批，避免单条 SQL 占位符过多（保守每批 200 行 × 7 参 = 1400）。
  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const placeholders = slice.map(() => "(?,?,?,?,?,?,?)").join(",");
    const params: (string | number | null)[] = [];
    for (const r of slice) {
      params.push(r.recordId, r.tableId, r.fieldId, r.valueText, r.valueNum, r.isNull, r.ord);
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO record_field_index ("recordId","tableId","fieldId","valueText","valueNum","isNull","ord") VALUES ${placeholders}`,
      ...params,
    );
  }
}

/** 先按 recordId 幂等删旧，再按最新 fields 批量插新（整个在调用方事务内，仅重建仍活记录）。 */
export async function syncRecordsTx(tx: unknown, tableId: string, recordIds: string[]): Promise<void> {
  if (!resolveSidecarEnabled() || recordIds.length === 0 || !supportsRaw(tx)) return;
  const rows = await collectRows(tx, tableId, recordIds);
  await deleteByRecords(tx, recordIds);
  await insertRows(tx, rows);
}

/** 软删记录时撤掉其 sidecar 行（物理删由 FK ON DELETE CASCADE 兜底，交互事务形态）。 */
export async function deleteRecordsTx(tx: unknown, recordIds: string[]): Promise<void> {
  if (!resolveSidecarEnabled() || recordIds.length === 0 || !supportsRaw(tx)) return;
  await deleteByRecords(tx as SidecarTx, recordIds);
}

/**
 * 数组批量事务形态（prisma.$transaction([...])）的 sidecar 删除语句。
 * Prisma 的 $executeRawUnsafe 返回惰性 PrismaPromise，放入语句数组即随该批事务提交。
 * 与 records.ts 的 record.softDelete/bulkSoftDelete 批语句原子提交。
 */
export function deleteRecordsStatement(recordIds: string[]): Prisma.PrismaPromise<unknown> | null {
  if (!resolveSidecarEnabled() || recordIds.length === 0) return null;
  const placeholders = recordIds.map(() => "?").join(",");
  return prisma.$executeRawUnsafe(
    `DELETE FROM record_field_index WHERE "recordId" IN (${placeholders})`,
    ...recordIds,
  );
}

/** 清空表（table.clear）数组事务形态：按 tableId 撤掉该表全部 sidecar 行。 */
export function deleteTableStatement(tableId: string): Prisma.PrismaPromise<unknown> | null {
  if (!resolveSidecarEnabled()) return null;
  return prisma.$executeRawUnsafe(
    `DELETE FROM record_field_index WHERE "tableId" = ?`,
    tableId,
  );
}

/**
 * 整表重建：对该表【全部活记录】幂等重建 sidecar（先按 tableId 清空再插）。
 * 用于表复制（duplicate 到新表）与 backfill/check 场景；调用方可传 tx 或全局 client。
 */
export async function rebuildTableTx(tx: unknown, tableId: string): Promise<void> {
  if (!resolveSidecarEnabled() || !supportsRaw(tx)) return;
  const live = (await tx.record.findMany({
    where: { tableId, deletedAt: null },
    select: { id: true },
  })) as { id: string }[];
  if (live.length === 0) {
    // 即便无活记录也要清掉可能残留的该表 sidecar 行。
    await tx.$executeRawUnsafe(`DELETE FROM record_field_index WHERE "tableId" = ?`, tableId);
    return;
  }
  const rows = await collectRows(tx, tableId, live.map((r) => r.id));
  await tx.$executeRawUnsafe(`DELETE FROM record_field_index WHERE "tableId" = ?`, tableId);
  await insertRows(tx, rows);
}

/** 恢复记录：按恢复后的 fields 重建（collectRows 只取仍活记录）。 */
export async function restoreRecordsTx(tx: unknown, tableId: string, recordIds: string[]): Promise<void> {
  await syncRecordsTx(tx, tableId, recordIds);
}
