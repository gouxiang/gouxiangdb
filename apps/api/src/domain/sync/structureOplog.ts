// YN7 离线同步：表结构（table / field / view）元数据轨的版本钟 + oplog 原语。
//
// 设计权威：docs/design/2026-10-node-mode/DESIGN-OFFLINE-SYNC.md
//   §19.1（元数据 op 词表）、§19.2（每表一行 table_schema 结构版本，每接受一条结构 op +1；
//   数据 op 的 baseSchemaVersion 依赖门）、§19.3（结构冲突，检测即人工裁决）、§8.6（在线结构写
//   也必须推进结构版本，否则离线 push 的 baseSchemaVersion 无从比较）、§20.1（注册表式扩展）、
//   §20.4（主数据/版本/oplog 同事务原子）、§20.5（默认旁路、只增不毁）。
//
// 与 record 轨（oplog.ts）的关系：
//   - 共用同一条全局单调 sync_op_log.seq（经 allocateSyncSeqTx 取号）→ pull 游标不分裂、不乱序；
//   - 但版本钟【不复用】record 的 per-entity 行：结构版本是「每张表一个」的 schemaVersion，
//     落在 sync_entity_versions 里一行 entityType='table_schema'，行 id 加命名空间前缀
//     "table_schema:<tableId>"（避免与 record 版本行 id=recordId 在同一 PK 命名空间内碰撞）；
//   - 结构版本行【永不置墓碑】：删表是软删（table.deletedAt），结构版本仍随 delete_table/
//     restore_table 递增，恢复后离线端能继续对账；记录墓碑语义只属于 record 轨。
//
// 开关纪律（同 oplog.ts）：
//   - recordStructureOpTx 供【在线】结构写编排层调用：GX_SYNC_SERVER off 时第一行 return null，
//     不读不写任何 sync_* 表 → 默认安装结构写路径零额外 IO、零行为变化；
//   - writeStructureOpTx 供 push 回放专用（只在 /api/v1/sync on 后可达），内部不再读开关；
//   - 两者都只提供 *Tx 事务原语，必须在调用方结构写事务内、实体写成功后调用，登记失败随主事务
//     整体回滚（结构改了但版本没推进 = 离线端永久错判结构冲突，绝不可事后旁路补记）。

import { prisma, type DbTx } from "../../db.js";
import { syncServerEnabled } from "../../configSync.js";
import { SyncVersionConflictError, SERVER_CLIENT_ID, allocateSyncSeqTx } from "./oplog.js";
import { randomUUID } from "node:crypto";

/** 结构版本钟行的 entityType（sync_entity_versions.entityType，开放 String，无需迁移）。 */
export const SCHEMA_ENTITY_TYPE = "table_schema";

/** YN7 结构 op 的实体族（sync_op_log.entityType）；导航 navnode/menuitem 随 YN8 登记。 */
export type StructureEntityType = "table" | "field" | "view";

/**
 * 结构版本钟行主键：每表一行，加命名空间前缀避免与 record 版本行（id=recordId）PK 碰撞。
 * 概念上即 §19.2 的 (entityType='table_schema', entityId=tableId)。
 */
export function schemaVersionRowId(tableId: string): string {
  return `${SCHEMA_ENTITY_TYPE}:${tableId}`;
}

/** 事务外只读当前结构版本（供回放前的预检/快照）；无版本行即 0（懒初始化，不回填）。 */
export async function readSchemaVersion(tableId: string): Promise<bigint> {
  const row = await prisma.syncEntityVersion.findUnique({
    where: { id: schemaVersionRowId(tableId) },
    select: { version: true },
  });
  return row?.version ?? 0n;
}

/** 事务内读当前结构版本（供同事务判定，避免事务外快照过期）。 */
export async function readSchemaVersionTx(tx: DbTx, tableId: string): Promise<bigint> {
  const row = await tx.syncEntityVersion.findUnique({
    where: { id: schemaVersionRowId(tableId) },
    select: { version: true },
  });
  return row?.version ?? 0n;
}

export interface StructureOpInput {
  /** 该结构 op 直接作用的实体族与实体 id（tableId / fieldId / viewId）。 */
  entityType: StructureEntityType;
  entityId: string;
  /** 所属表：结构版本钟的键，也是 oplog 的订阅分片依据（baseId 由它在 pull 侧按 base 过滤）。 */
  tableId: string;
  baseId: string;
  /** 结构 op 词表（§19.1）：create_table/rename_table/delete_table/add_field/alter_field/...。 */
  op: string;
  /** 服务端按当前 token 认定的真实 actor；null=系统写。 */
  actorId: string | null;
  /**
   * 结构化 op 内容（建表初始字段、改字段 changed 子集、视图配置等），随 oplog 落库供 pull 重放。
   * 结构元数据本身按 manage_schema 权限可见，不含记录行明文。
   */
  payload: Record<string, unknown>;
}

export interface StructureOpResult {
  seq: bigint;
  newVersion: bigint;
  clientOpId: string;
}

/**
 * push 回放记账：以【客户端身份 + 客户端 baseSchemaVersion】登记一条结构 op，并做结构乐观锁断言。
 * - expectedBaseVersion 给定时必须等于该表当前 schemaVersion，否则抛 SyncVersionConflictError
 *   【不落任何写】（由外层 catch 后另开事务记 sync_incoming=conflict，进结构冲突人工裁决，§19.3）；
 * - 同事务分配全局 seq、把该表 schemaVersion +1（不置墓碑）、追加 oplog。
 */
export interface StructureReplayIdentity {
  clientId: string;
  clientOpId: string;
  clientBaseVersion: bigint;
  expectedBaseVersion?: bigint;
  result?: "accepted" | "resolved";
  conflictOf?: string | null;
}

export async function writeStructureOpTx(
  tx: DbTx,
  input: StructureOpInput,
  identity: StructureReplayIdentity,
): Promise<StructureOpResult> {
  const rowId = schemaVersionRowId(input.tableId);
  const seq = await allocateSyncSeqTx(tx);

  const existing = await tx.syncEntityVersion.findUnique({ where: { id: rowId } });
  const baseVersion = existing?.version ?? 0n;
  if (identity.expectedBaseVersion !== undefined && identity.expectedBaseVersion !== baseVersion) {
    // 结构版本分叉：不推进、不落 oplog，交外层落 structure conflict（§19.3）。
    throw new SyncVersionConflictError(baseVersion, false);
  }
  const newVersion = baseVersion + 1n;

  // 结构版本行只随结构 op 递增，isDeleted 恒 false（删表不删钟，restore 继续对账）。
  await tx.syncEntityVersion.upsert({
    where: { id: rowId },
    create: {
      id: rowId,
      entityType: SCHEMA_ENTITY_TYPE,
      baseId: input.baseId,
      version: newVersion,
      lastSeq: seq,
      isDeleted: false,
      deletedBy: null,
    },
    update: {
      baseId: input.baseId,
      version: newVersion,
      lastSeq: seq,
      isDeleted: false,
      deletedBy: null,
    },
  });

  await tx.syncOpLog.create({
    data: {
      seq,
      workspaceId: "ws_default",
      baseId: input.baseId,
      entityType: input.entityType,
      entityId: input.entityId,
      op: input.op,
      actorId: input.actorId,
      clientId: identity.clientId,
      clientOpId: identity.clientOpId,
      baseVersion: identity.clientBaseVersion,
      newVersion,
      payload: JSON.stringify({
        op: input.op,
        entityType: input.entityType,
        tableId: input.tableId,
        ...input.payload,
      }),
      result: identity.result ?? "accepted",
      conflictOf: identity.conflictOf ?? null,
    },
  });

  return { seq, newVersion, clientOpId: identity.clientOpId };
}

/**
 * 在线结构写切面：服务端自身即权威，不做乐观锁断言，用 SERVER_CLIENT_ID + srv- 幂等键登记，
 * 把该表 schemaVersion +1。GX_SYNC_SERVER off 时第一行返回 null（零 IO、零行为变化，§20.5）。
 */
export async function recordStructureOpTx(
  tx: DbTx,
  input: StructureOpInput,
): Promise<StructureOpResult | null> {
  if (!syncServerEnabled()) return null;

  const existing = await tx.syncEntityVersion.findUnique({
    where: { id: schemaVersionRowId(input.tableId) },
    select: { version: true },
  });
  return await writeStructureOpTx(
    tx,
    input,
    {
      clientId: SERVER_CLIENT_ID,
      clientOpId: `srv-${randomUUID()}`,
      clientBaseVersion: existing?.version ?? 0n,
    },
  );
}
