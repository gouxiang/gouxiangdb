// YN1 离线同步：服务端「在线写」版本切面 + 正向操作日志原语。
//
// 设计权威：docs/design/2026-10-node-mode/DESIGN-OFFLINE-SYNC.md
//   §4.1.1/§4.1.2（表结构）、§5.1（在领域写原语同事务挂接）、§8.5（一事务原子一致）、
//   §8.6（在线写也推进 per-entity version，否则离线 push 的 baseVersion 无从比较）、
//   §11/§20.4/§20.5（默认旁路、只增不毁、统一串行写队列、同事务登记）。
//
// 与 domain/search/outbox.ts 同形态（刻意区别于 recordChanges 的吞错旁路）：
//   - 只提供 *Tx 事务原语，必须在调用方既有业务写事务内、实体写成功后调用；
//   - 不自行开事务、不吞错；登记失败随主事务整体回滚（业务数据 / 版本 / oplog 原子一致，
//     绝不允许出现「记录改了、版本没推进 / oplog 缺一条」——那会让离线客户端永久错判冲突）。
//   - 回调内只用传入 tx，绝不再调 runWrite/withWriteTx（写队列并发度恒 1，会自死锁）。
//
// 开关纪律（§11.1、§20.5）：
//   - GX_SYNC_SERVER 非 on/true/1（出厂默认 off）时，recordSyncOpTx 第一行即 return null，
//     不读不写任何 sync_* 表，连 baseId 的表点查都不做 → 默认安装在线写路径零额外 IO、零行为变化。
//   - 开关在【调用时】读 env（非启动快照），与 /api/v1/sync 请求期闸门同一函数，进程内可切。
//
// seq / version 单调（§8.2/§8.3）：
//   - 一切业务写都在进程级串行写队列（withWriteTx，并发度恒 1）里，本原语又只在该事务内被调，
//     故「SELECT MAX(seq)+1 → insert」无并发插队；seq 为每节点独立全局单调序列，是 pull 游标。
//   - per-entity version 是服务端权威逻辑时钟（不用 wall clock 定生死），upsert 后 +1；
//     离线 push 冲突判定比较的就是它（§7.1）。
//
// 在线写身份：在线请求不是某个同步客户端发出的，clientId 用固定 SERVER_CLIENT_ID，
// clientOpId 由服务端造（srv- 前缀 + randomUUID），同样满足 sync_op_log.clientOpId 全局幂等唯一。

import { randomUUID } from "node:crypto";
import type { DbTx } from "../../db.js";
import { syncServerEnabled } from "../../configSync.js";
import type { FieldChange } from "../recordChanges/types.js";

/** 单工作区恒定（与 search/outbox 的 DEFAULT_WORKSPACE 同口径）。 */
export const SYNC_DEFAULT_WORKSPACE = "ws_default";
/** 在线（非同步客户端）写的来源标识；push 回放的来源是具体设备 clientId。 */
export const SERVER_CLIENT_ID = "__server__";

/** 同步跟踪的实体类型（开放词表，新模块向同步轨注册表登记，见 §20.1）。YN1 只落 record。 */
export type SyncEntityType = "record";
/** 操作词表（§4.1.1）。YN1 在线切面产生 create/update/delete；restore/patch/resolve 随后续阶段。 */
export type SyncOp = "create" | "update" | "delete" | "restore" | "patch" | "resolve";

export interface RecordSyncOpInput {
  entityType: SyncEntityType;
  entityId: string;
  /** 记录所属表；用于在同事务内点查出 baseId 作为订阅分片键。 */
  tableId: string;
  /**
   * 已知 baseId 时直接传入，跳过 table 点查。物理删表/整表恢复等路径在事务内已删/改 table，
   * 点查可能取不到，调用方可由删表前已加载的 t.baseId 显式传入。
   */
  baseId?: string | null;
  op: SyncOp;
  /** 服务端按当前 token 认定的真实 actor（不信任客户端自报）；null=系统写。 */
  actorId: string | null;
  /**
   * 字段级变更（create=全字段初始快照；update=仅被改字段；delete=[]）。
   * 复用 recordChanges 的同一份 diff，供 pull 下发与未来冲突弹窗字段对照（§5.2）。
   */
  changes?: FieldChange[];
}

export interface RecordSyncOpResult {
  seq: bigint;
  newVersion: bigint;
  clientOpId: string;
}

/**
 * 在调用方事务内：推进 sync_entity_versions 并追加一条 sync_op_log（在线写版本切面）。
 *
 * 开关关闭时直接返回 null（不读不写）。开启时任何 DB 异常原样抛出让主事务回滚（共生死）。
 */
export async function recordSyncOpTx(
  tx: DbTx,
  input: RecordSyncOpInput,
): Promise<RecordSyncOpResult | null> {
  // 总门：默认 off 零行为、零额外 IO（连下面的点查都不做）。
  if (!syncServerEnabled()) return null;

  // 订阅分片键：显式传入优先（物理删表等点查不到 table 的场景）；否则同事务点查 table.baseId。
  let baseId: string | null;
  if (input.baseId !== undefined) {
    baseId = input.baseId;
  } else {
    const table = await tx.table.findUnique({
      where: { id: input.tableId },
      select: { baseId: true },
    });
    baseId = table?.baseId ?? null;
  }

  // 1) 全局单调 seq：串行写队列内 MAX+1 无并发竞争。seq 从 1 起（0 保留给「尚未有任何操作」的游标）。
  const maxRows = await tx.$queryRawUnsafe<Array<{ m: bigint | null }>>(
    `SELECT MAX("seq") AS m FROM "sync_op_log"`,
  );
  const seq = (maxRows[0]?.m ?? 0n) + 1n;

  // 2) per-entity 权威版本 upsert（= entityId 1:1），version+1、记墓碑与 lastSeq。
  const existing = await tx.syncEntityVersion.findUnique({ where: { id: input.entityId } });
  const baseVersion = existing?.version ?? 0n;
  const newVersion = baseVersion + 1n;
  const isDeleted = input.op === "delete";
  await tx.syncEntityVersion.upsert({
    where: { id: input.entityId },
    create: {
      id: input.entityId,
      entityType: input.entityType,
      baseId,
      version: newVersion,
      lastSeq: seq,
      isDeleted,
      deletedBy: isDeleted ? input.actorId : null,
    },
    update: {
      baseId,
      version: newVersion,
      lastSeq: seq,
      isDeleted,
      deletedBy: isDeleted ? input.actorId : null,
    },
  });

  // 3) 追加正向 oplog（pull 的事实源）。在线写由服务端造幂等键。
  const clientOpId = `srv-${randomUUID()}`;
  const payload = JSON.stringify({
    op: input.op,
    entityType: input.entityType,
    tableId: input.tableId,
    changes: input.changes ?? [],
  });
  await tx.syncOpLog.create({
    data: {
      seq,
      workspaceId: SYNC_DEFAULT_WORKSPACE,
      baseId,
      entityType: input.entityType,
      entityId: input.entityId,
      op: input.op,
      actorId: input.actorId,
      clientId: SERVER_CLIENT_ID,
      clientOpId,
      baseVersion,
      newVersion,
      payload,
      result: "accepted",
    },
  });

  return { seq, newVersion, clientOpId };
}

/**
 * 批量登记（同一事务内多实体，如批量软删/批量更新/整表恢复/整表物理删级联）。
 * 逐条调用单实体原语：各自分配连续 seq、各自推进 per-entity version；返回逐条结果。
 * 开关 off 时每条都在第一行返回 null（零写），结果数组全为 null。
 */
export async function recordSyncOpsTx(
  tx: DbTx,
  inputs: readonly RecordSyncOpInput[],
): Promise<(RecordSyncOpResult | null)[]> {
  const out: (RecordSyncOpResult | null)[] = [];
  for (const input of inputs) {
    out.push(await recordSyncOpTx(tx, input));
  }
  return out;
}
