// beta.2 S2b：record 轨离线发件箱写切面（本机作为某节点离线副本时，本地直写的待发捕获）。
// 设计权威：docs/design/2026-10-node-mode/DESIGN-OFFLINE-SYNC.md §5.1（同事务登记、绝不吞错）、
// §5.2（payload 形状）、§5.3（clientOpId 身份/时钟）。
//
// 形态刻意与 oplog.recordSyncOpTx 对齐：
//   - 只提供 *Tx 事务原语，必须在调用方既有业务写事务内、实体写成功后调用；
//   - 不自行开事务、不 try/catch 吞错；local_outbox 写入失败随主事务整体回滚（业务数据 /
//     版本钟 / oplog / outbox 原子一致，绝不允许「记录改了、待发操作却丢了」——离线写一旦
//     静默丢失，副本将永久与服务端分叉）。
//   - 回调内只用传入 tx，禁止再调 runWrite/withWriteTx（写队列并发度恒 1，会自死锁）。
//
// 与服务端切面（recordSyncOpTx）的区别：
//   - 门控开关是 GX_OFFLINE_REPLICA（本机=副本）而非 GX_SYNC_SERVER（本机=服务端），两者独立；
//   - 身份用本地 clientId（默认 local-replica，安装实例 id 未来由壳注入）与 local-<uuid> 幂等键；
//   - 除推进本地 sync_entity_versions + 追加本地 sync_op_log（复用 writeSyncOpTx，使本地钟既反映
//     pull 拉到的服务端事实、又反映本机待发写）外，还往 local_outbox 落一条 pending 待发行。
//
// 回放安全：本原语只在 recordWrite 的【在线直写 else 分支】被调用；push/pull 回放走 if(sync)
// 分支，绝不经过这里，否则拉回来的服务端 op 会被再次塞进 outbox 形成回放循环。

import { randomUUID } from "node:crypto";
import type { DbTx } from "../../db.js";
import { offlineReplicaEnabled } from "../../configOfflineReplica.js";
import { writeSyncOpTx, type RecordSyncOpInput } from "./oplog.js";
import { writeStructureOpTx, schemaVersionRowId, type StructureOpInput } from "./structureOplog.js";

/** recordLocalReplicaTx 的本地副本身份（由调用方从 env 解析后传入，便于测试注入）。 */
export interface LocalReplicaCtx {
  nodeId: string;
  clientId: string;
}

export interface LocalReplicaRecord {
  clientOpId: string;
  /** 发起本次写时认定的写前基线版本（同时写入 local_outbox.baseVersion）。 */
  baseVersion: bigint;
}

/**
 * 在调用方写事务内：以本地副本身份推进版本钟 + 追加本地 oplog，并落一条 pending 的 local_outbox。
 *
 * 开关关闭（出厂默认）时第一行即返回 null，不读不写任何表（零额外 IO、行为零变化）。
 * 开启时任何 DB 异常原样抛出让主事务回滚（共生死，绝不吞错）。
 *
 * @returns 落库的 clientOpId（local-<uuid>，oplog 与 outbox 共用同一幂等键）与写前 baseVersion；
 *          开关关闭时为 null。调用方无需使用返回值（在线直写路径忽略即可）。
 */
export async function recordLocalReplicaTx(
  tx: DbTx,
  input: RecordSyncOpInput,
  ctx: LocalReplicaCtx,
): Promise<LocalReplicaRecord | null> {
  // 副本门：默认 off 零行为、零 IO（连下面的点查都不做）。
  if (!offlineReplicaEnabled()) return null;

  // 写前 per-entity 版本：既作为本地 oplog 的 clientBaseVersion，也作为 outbox.baseVersion。
  const pre = await tx.syncEntityVersion.findUnique({
    where: { id: input.entityId },
    select: { version: true },
  });
  const preVersion = pre?.version ?? 0n;

  // 订阅分片键：显式传入优先；否则在本函数内单点查 table.baseId，并把结果并入传给
  // writeSyncOpTx 的 input，使其不再重复点查（不改 oplog.ts）。
  let baseId: string | null;
  let opInput: RecordSyncOpInput = input;
  if (input.baseId !== undefined) {
    baseId = input.baseId;
  } else {
    const table = await tx.table.findUnique({
      where: { id: input.tableId },
      select: { baseId: true },
    });
    baseId = table?.baseId ?? null;
    opInput = { ...input, baseId };
  }

  // 贯穿 oplog 与 outbox 的同一幂等键（local- 前缀，区别于服务端 srv- 与远端设备 clientOpId）。
  const clientOpId = `local-${randomUUID()}`;

  // 以本地副本身份推进本地版本钟 + 追加本地 sync_op_log（与 pull 回放同一原语）。
  await writeSyncOpTx(
    tx,
    opInput,
    { clientId: ctx.clientId, clientOpId, clientBaseVersion: preVersion },
  );

  // 待发行：payload 与 oplog 同构；S3 推送引擎再把 changes 映射成服务端 push 的 fields/changed。
  // status/attempts 用 schema 默认（pending / 0），不显式传。
  await tx.localOutbox.create({
    data: {
      clientOpId,
      nodeId: ctx.nodeId,
      baseId,
      entityType: input.entityType,
      entityId: input.entityId,
      op: input.op,
      payload: JSON.stringify({
        op: input.op,
        entityType: input.entityType,
        tableId: input.tableId,
        changes: input.changes ?? [],
      }),
      baseVersion: preVersion,
    },
  });

  return { clientOpId, baseVersion: preVersion };
}

/**
 * S2c：结构轨（table / field / view）在线直写的离线发件箱切面。
 *
 * 挂接位置是各元数据【编排 wrapper】（tableService/fieldService/viewService），与在线切面
 * recordStructureOpTx 并排；push 结构回放走 structureRegistry → *Tx 原语层（物理上不经过
 * wrapper），故天然不会回到这里——绝不可挂到 *Tx 原语层（在线/回放共用，挂上即回放循环）。
 *
 * 与 record 切面同纪律：默认关首行返回 null；同事务推进该表 table_schema 钟 + 追加本地 oplog
 * （复用 writeStructureOpTx，在线直写不传 expectedBaseVersion），并落一条 pending local_outbox；
 * 任何异常原样抛出随主事务回滚，只用 tx、不再入写队列。
 */
export async function recordLocalStructureReplicaTx(
  tx: DbTx,
  input: StructureOpInput,
  ctx: LocalReplicaCtx,
): Promise<LocalReplicaRecord | null> {
  // 副本门：默认 off 零行为、零 IO。
  if (!offlineReplicaEnabled()) return null;

  // 写前该表结构版本：既是本地 oplog 的 clientBaseVersion，也是 outbox.baseVersion。
  const pre = await tx.syncEntityVersion.findUnique({
    where: { id: schemaVersionRowId(input.tableId) },
    select: { version: true },
  });
  const preVersion = pre?.version ?? 0n;

  const clientOpId = `local-${randomUUID()}`;

  // 以本地副本身份推进 table_schema 钟 + 追加本地结构 oplog（不做乐观锁断言）。
  await writeStructureOpTx(
    tx,
    input,
    { clientId: ctx.clientId, clientOpId, clientBaseVersion: preVersion },
  );

  // 待发行：payload 与 structureOplog 落库形状同构（{op,entityType,tableId,...payload}）。
  await tx.localOutbox.create({
    data: {
      clientOpId,
      nodeId: ctx.nodeId,
      baseId: input.baseId,
      entityType: input.entityType,
      entityId: input.entityId,
      op: input.op,
      payload: JSON.stringify({
        op: input.op,
        entityType: input.entityType,
        tableId: input.tableId,
        ...input.payload,
      }),
      baseVersion: preVersion,
    },
  });

  return { clientOpId, baseVersion: preVersion };
}
