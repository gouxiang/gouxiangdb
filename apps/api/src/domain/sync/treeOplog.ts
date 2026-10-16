// YN8 离线同步：工作区导航树（navnode）轨的 treeVersion 版本钟 + oplog 原语。
//
// 设计权威：docs/design/2026-10-node-mode/DESIGN-OFFLINE-SYNC.md
//   §19.1（nav op 词表：nav_create_group/nav_rename/nav_move/nav_reorder/nav_delete）、
//   §19.6（treeVersion＝工作区级结构版本，随被接受的 nav op 递增；path/depth 由服务端重算）、
//   §19.3-7（建表自动节点只由服务端 nav-reconcile 同事务派生，绝不经 nav op 双写）、
//   §20.1（注册表式扩展）、§20.4（主数据/版本/oplog 同事务原子）、§20.5（默认旁路、只增不毁）。
//
// 与 YN7 表结构钟（structureOplog.ts）的关系：
//   - 表结构钟是【每张表一行】table_schema:<tableId>；导航树是跨库的工作区级资源，不隶属任何 base，
//     故单立【每工作区一行】workspace_tree:<workspaceId>（本期单工作区恒 ws_default）。
//   - 两类钟同居 sync_entity_versions（id 前缀避 PK 碰撞、entityType 开放 String）→ 零迁移。
//   - 共用全局单调 sync_op_log.seq（allocateSyncSeqTx）→ 树 op 与 record/结构 op 同一条 pull 游标，
//     seq 不撞号不乱序；树 op 的 baseId 恒 null（订阅分片用独立 scopeType="workspace_tree"）。
//   - 树钟【永不置墓碑】：isDeleted 恒 false（与结构钟同）；分组删除是物理删，但树版本仍递增对账。
//
// 开关纪律（与 structureOplog.ts 逐字同构）：
//   - recordTreeOpTx 供【在线】导航写编排层（nodes 路由）调用：GX_SYNC_SERVER off 时第一行 return null，
//     不读不写任何 sync_* 表 → 默认安装导航写路径零额外 IO、零行为变化；
//   - writeTreeOpTx 供 push 回放专用（只在 /api/v1/sync on 后可达），内部不再读开关；
//   - 两者都只提供 *Tx 事务原语，必须在调用方导航写事务内、实体写成功后调用，登记失败随主事务整体
//     回滚（导航改了但树版本没推进 = 离线端永久错判树冲突，绝不可事后旁路补记）。

import { randomUUID } from "node:crypto";
import { prisma, type DbTx } from "../../db.js";
import { syncServerEnabled } from "../../configSync.js";
import { SyncVersionConflictError, SERVER_CLIENT_ID, allocateSyncSeqTx } from "./oplog.js";

/** 树版本钟行的 entityType（sync_entity_versions.entityType，开放 String，无需迁移）。 */
export const TREE_ENTITY_TYPE = "workspace_tree";

/** YN8 树 op 的实体族（sync_op_log.entityType）；MenuItem（menu_*）顺延，暂不登记。 */
export type TreeEntityType = "navnode";

/** 本期单工作区（与 oplog/outbox/nav 域的 WS_ID 同口径）。 */
export const TREE_WORKSPACE_ID = "ws_default";

/**
 * 树版本钟行主键：每工作区一行，加命名空间前缀避免与 record（id=recordId）、
 * 表结构钟（table_schema:<tableId>）版本行在同一 PK 命名空间碰撞。
 */
export function treeVersionRowId(workspaceId: string): string {
  return `${TREE_ENTITY_TYPE}:${workspaceId}`;
}

/** 事务外只读当前树版本（供回放前预检/冲突快照）；无版本行即 0（懒初始化，不回填）。 */
export async function readTreeVersion(workspaceId: string = TREE_WORKSPACE_ID): Promise<bigint> {
  const row = await prisma.syncEntityVersion.findUnique({
    where: { id: treeVersionRowId(workspaceId) },
    select: { version: true },
  });
  return row?.version ?? 0n;
}

/** 事务内读当前树版本（供同事务判定，避免事务外快照过期）。 */
export async function readTreeVersionTx(
  tx: DbTx,
  workspaceId: string = TREE_WORKSPACE_ID,
): Promise<bigint> {
  const row = await tx.syncEntityVersion.findUnique({
    where: { id: treeVersionRowId(workspaceId) },
    select: { version: true },
  });
  return row?.version ?? 0n;
}

export interface TreeOpInput {
  /** 恒 "navnode"（menu_* 顺延后再扩）。 */
  entityType: TreeEntityType;
  /** 该 op 直接作用的导航节点 id（分组 navgrp_* / 资源节点 nav_*）；集合级 reorder 取父分组 id。 */
  entityId: string;
  /** nav op 词表（§19.1）。 */
  op: string;
  /** 服务端按当前 token 认定的真实 actor；null=系统写。 */
  actorId: string | null;
  /**
   * 结构化 op 内容（nodeId/from/to/name/strategy/orderedIds 等），随 oplog 落库供其它端 pull 重放。
   * 只含导航结构元数据（节点 id/父子/排序/名称），不含任何记录行/文档正文明文。
   */
  payload: Record<string, unknown>;
}

export interface TreeOpResult {
  seq: bigint;
  newVersion: bigint;
  clientOpId: string;
}

export interface TreeReplayIdentity {
  clientId: string;
  clientOpId: string;
  clientBaseVersion: bigint;
  expectedBaseVersion?: bigint;
  result?: "accepted" | "resolved";
  conflictOf?: string | null;
}

/**
 * push 回放记账：分配全局 seq、把工作区 treeVersion +1（不置墓碑）、追加 oplog（baseId 恒 null）。
 * expectedBaseVersion 给定时必须等于当前 treeVersion，否则抛 SyncVersionConflictError【不落任何写】
 * （由外层 catch 后另开事务记 sync_incoming=conflict，进树冲突人工裁决，§19.6）。
 */
export async function writeTreeOpTx(
  tx: DbTx,
  input: TreeOpInput,
  identity: TreeReplayIdentity,
  workspaceId: string = TREE_WORKSPACE_ID,
): Promise<TreeOpResult> {
  const rowId = treeVersionRowId(workspaceId);
  const seq = await allocateSyncSeqTx(tx);

  const existing = await tx.syncEntityVersion.findUnique({ where: { id: rowId } });
  const baseVersion = existing?.version ?? 0n;
  if (identity.expectedBaseVersion !== undefined && identity.expectedBaseVersion !== baseVersion) {
    // 树版本分叉：不推进、不落 oplog，交外层落 tree conflict（§19.6 同节点/同兄弟冲突人工选）。
    throw new SyncVersionConflictError(baseVersion, false);
  }
  const newVersion = baseVersion + 1n;

  // 树版本行只随 nav op 递增，isDeleted 恒 false（分组物理删也不删钟）。baseId 列对工作区钟无归属，置 null。
  await tx.syncEntityVersion.upsert({
    where: { id: rowId },
    create: {
      id: rowId,
      entityType: TREE_ENTITY_TYPE,
      baseId: null,
      version: newVersion,
      lastSeq: seq,
      isDeleted: false,
      deletedBy: null,
    },
    update: {
      baseId: null,
      version: newVersion,
      lastSeq: seq,
      isDeleted: false,
      deletedBy: null,
    },
  });

  await tx.syncOpLog.create({
    data: {
      seq,
      workspaceId,
      baseId: null,
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
        workspaceId,
        ...input.payload,
      }),
      result: identity.result ?? "accepted",
      conflictOf: identity.conflictOf ?? null,
    },
  });

  return { seq, newVersion, clientOpId: identity.clientOpId };
}

/**
 * 在线导航写切面：服务端自身即权威，不做乐观锁断言，用 SERVER_CLIENT_ID + srv- 幂等键登记，
 * 把工作区 treeVersion +1。GX_SYNC_SERVER off 时第一行返回 null（零 IO、零行为变化，§20.5）。
 *
 * 注意：只挂在【用户手动】导航写（建组/改名/移动/重排/删组）；建表派生的自动节点经
 * syncNavFromEntitiesTx 内部 bump 旧 int navVersion，但【不】记树 op（§19.3-7，自动节点不是事件、
 * 禁止双写；离线端的自动节点由其本地回放 create_table 时同一 reconcile 机制派生）。
 */
export async function recordTreeOpTx(
  tx: DbTx,
  input: TreeOpInput,
  workspaceId: string = TREE_WORKSPACE_ID,
): Promise<TreeOpResult | null> {
  if (!syncServerEnabled()) return null;

  const existing = await tx.syncEntityVersion.findUnique({
    where: { id: treeVersionRowId(workspaceId) },
    select: { version: true },
  });
  return await writeTreeOpTx(
    tx,
    input,
    {
      clientId: SERVER_CLIENT_ID,
      clientOpId: `srv-${randomUUID()}`,
      clientBaseVersion: existing?.version ?? 0n,
    },
    workspaceId,
  );
}
