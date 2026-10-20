// beta.2 S3b-2：空副本「引导基线」一次性保 id 落库（replica bootstrap import）。
// 设计权威：DESIGN-OFFLINE-SYNC.md §6（初次快照）、§8.4（保 cuid 免重映射）、
// §9.4（副本独立库/本地属主）、§11（默认旁路、只增不毁）。
//
// 把 S3b-1 的 ReplicaBootstrapPage 在【单个 withWriteTx 串行写事务】内原样保 cuid 直插进本地
// 空库 6 张业务表（bases/tables/fields/views/records/link_rows），建本地 owner 成员与库级管理员
// 视野，重建 nav/fieldIndex 派生物，最后写一行 replica_state 记账游标。
//
// 关键语义：
//   - 保 id：页内 cuid 原样落库，localBaseId===remoteBaseId===page.baseId，无需 sync_id_map；
//     属主不导入远端 createdBy/member，统一重映射为本地 ownerUserId。
//   - 幂等/重入：六张表一律逐行 upsert（by 主键 id，update:{} 不覆盖活数据）。注意 Prisma 的
//     SQLite 连接器【不支持】createMany.skipDuplicates，故 records/links 也逐行 upsert，不用批插。
//     首导目标为空副本、主键不冲突；任何重复【引导】都在写任何数据前被事务体开头的
//     replica_state.snapshotDone 守门整体短路返回 alreadyBootstrapped（增量归 S3b-3 pull）。
//   - 物理 FK：Table→Base、Field/View/Record→Table、LinkRow→Record(×2)、Member→Base/User 均真，
//     故顺序严格 base→member→tables→fields/views→records→links。仅 Field.linkFieldId/
//     reverseFieldId、Table.primaryFieldId 无 FK，可一次性原样直写（无须反向占位三步）。
//   - 下行快照不是本地编辑：绝不写 local_outbox/sync_op_log/sync_entity_versions/sync_id_map
//     （写 outbox 会在回推造重复 op）；不订阅（subscribed:false）、不发网络。
//   - 默认关：GX_OFFLINE_REPLICA 非 on/true/1 时门面首行零查零写返回 ran:false。

import { type DbTx, withWriteTx } from "../../db.js";
import { offlineReplicaEnabled, offlineNodeId } from "../../configOfflineReplica.js";
import { syncNavFromEntitiesTx } from "../nav/sync.js";
import { rebuildTableTx } from "../fieldIndex/sync.js";
import { syncBaseMemberTx } from "../authz/projection.js";
import { seedAdminScopeTx } from "../authz/libraryScopeSeed.js";
import type { BootstrapField, ReplicaBootstrapPage } from "./bootstrap.js";

export interface ImportReplicaCtx {
  /** 本地副本属主：必须是本地库真实存在的 User（members 有 FK→users）。 */
  ownerUserId: string;
  /** 副本节点 id；缺省 offlineNodeId()（"local"）。 */
  nodeId?: string;
  /** 记账时间戳；缺省 new Date()，测试可注入。 */
  now?: Date;
}

export interface ImportReplicaCounts {
  tables: number;
  fields: number;
  views: number;
  records: number;
  links: number;
}

export interface ImportReplicaResult {
  ran: boolean; // off 守门为 false
  baseId: string;
  localBaseId: string; // 保 id 直插：恒等于 baseId/remoteBaseId
  anchorSeq: string;
  counts: ImportReplicaCounts;
  alreadyBootstrapped: boolean;
}

type ImportTxResult = Omit<ImportReplicaResult, "ran">;
type RequiredCtx = Required<ImportReplicaCtx>;

function emptyCounts(): ImportReplicaCounts {
  return { tables: 0, fields: 0, views: 0, records: 0, links: 0 };
}

/** 结构性校验：坏页在写任何数据前早抛（anchorSeq 须可解析为 BigInt）。 */
function validatePage(page: ReplicaBootstrapPage): void {
  if (page.kind !== "replica-bootstrap") {
    throw new Error(`非法引导页：kind=${String(page.kind)}，应为 replica-bootstrap`);
  }
  if (!page.base || page.base.id !== page.baseId) {
    throw new Error("非法引导页：base.id 与 baseId 不一致");
  }
  try {
    BigInt(page.anchorSeq);
  } catch {
    throw new Error(`非法引导页：anchorSeq 不是非负整数字符串：${String(page.anchorSeq)}`);
  }
}

/** Field 列白名单映射（26 个业务列原样透传；不设 deletedAt——页内全活；字段无 createdBy/createdAt）。 */
function fieldCreateInput(f: BootstrapField) {
  return {
    id: f.id,
    tableId: f.tableId,
    name: f.name,
    type: f.type,
    description: f.description,
    order: f.order,
    required: f.required,
    unique: f.unique,
    options: f.options,
    maxLength: f.maxLength,
    defaultNow: f.defaultNow,
    precision: f.precision,
    recordFilter: f.recordFilter,
    linkFieldId: f.linkFieldId,
    relatedTableId: f.relatedTableId,
    relationKind: f.relationKind,
    isReverse: f.isReverse,
    reverseFieldId: f.reverseFieldId,
    linkDisplayFieldId: f.linkDisplayFieldId,
    lookupFieldId: f.lookupFieldId,
    rollupFunction: f.rollupFunction,
    formula: f.formula,
    tabsConfig: f.tabsConfig,
    displayedFieldIds: f.displayedFieldIds,
    visibleFieldIds: f.visibleFieldIds,
    defaultConfig: f.defaultConfig,
    numberRule: f.numberRule,
  };
}

/**
 * 纯事务体：全部直插 + 派生物 + replica_state，只使用传入 tx（回调内禁止再入队/再开事务）。
 * 测试可对第二 client 直调本函数。
 */
export async function importReplicaBootstrapTx(
  tx: DbTx,
  page: ReplicaBootstrapPage,
  ctx: RequiredCtx,
): Promise<ImportTxResult> {
  validatePage(page);
  const baseId = page.baseId;

  // ① 守门：已引导完成的副本零写返回（防重复覆盖；增量归 S3b-3 pull）。
  const prior = await tx.replicaState.findUnique({
    where: { nodeId_remoteBaseId: { nodeId: ctx.nodeId, remoteBaseId: baseId } },
  });
  if (prior?.snapshotDone) {
    return {
      baseId,
      localBaseId: prior.localBaseId,
      anchorSeq: page.anchorSeq,
      counts: emptyCounts(),
      alreadyBootstrapped: true,
    };
  }

  // ② base（保 id；createdAt 默认 now；createdBy 重映射为本地属主；deletedAt 不设=活库）。
  await tx.base.upsert({
    where: { id: page.base.id },
    create: {
      id: page.base.id,
      name: page.base.name,
      iconColor: page.base.iconColor,
      icon: page.base.icon,
      shareEnabled: page.base.shareEnabled,
      createdBy: ctx.ownerUserId,
    },
    update: {},
  });

  // ③ 本地 owner 成员 + 库节点 legacy 投影 + 库级管理员视野（与 createBase 同款；零表时刻调用，
  //    逐表 scope 省略——owner 靠库节点策略天然全表，starter 建表也不写表级 scope）。
  const member = await tx.member.upsert({
    where: { baseId_userId: { baseId, userId: ctx.ownerUserId } },
    create: { baseId, userId: ctx.ownerUserId, role: "owner" },
    update: {},
  });
  await syncBaseMemberTx(tx, { oldRowId: member.id, baseId, userId: ctx.ownerUserId, role: "owner" });
  await seedAdminScopeTx(tx, "base", baseId, ctx.ownerUserId);

  // ④ tables（primaryFieldId 直接写页值，不先空串后 update；无该列 FK）。
  for (const t of page.tables) {
    await tx.table.upsert({
      where: { id: t.id },
      create: {
        id: t.id,
        baseId,
        name: t.name,
        primaryFieldId: t.primaryFieldId,
        icon: t.icon,
        iconColor: t.iconColor,
        shareEnabled: t.shareEnabled,
        createdBy: ctx.ownerUserId,
      },
      update: {},
    });
  }

  // ⑤ fields（正反向配对、lookup/rollup/formula 等原样列一次性直写，无顺序依赖——link 列无 FK）。
  for (const f of page.fields) {
    await tx.field.upsert({ where: { id: f.id }, create: fieldCreateInput(f), update: {} });
  }

  // ⑥ views（config/adminConfig 原样字符串）。
  for (const v of page.views) {
    await tx.view.upsert({
      where: { id: v.id },
      create: {
        id: v.id,
        tableId: v.tableId,
        name: v.name,
        type: v.type,
        lockMode: v.lockMode,
        order: v.order,
        config: v.config,
        adminConfig: v.adminConfig,
      },
      update: {},
    });
  }

  // ⑦ records（逐行 upsert by 主键；fields 序列化 JSON；update:{} 不覆盖。
  //    SQLite 连接器不支持 createMany.skipDuplicates，故与 tables/fields/views 同构逐行 upsert；
  //    首导目标为空库主键不冲突，重复引导由事务体开头 snapshotDone 守门挡掉）。
  for (const r of page.records) {
    await tx.record.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        tableId: r.tableId,
        fields: JSON.stringify(r.fields),
        createdBy: ctx.ownerUserId,
        updatedBy: ctx.ownerUserId,
      },
      update: {},
    });
  }

  // ⑧ link_rows（必须晚于 records——parentRowId/childRowId 是真 FK；逐行 upsert by 主键不覆盖。
  //    空库首导不撞 @@unique([linkFieldId,parentRowId,childRowId])；重复引导由守门挡掉）。
  for (const l of page.links) {
    await tx.linkRow.upsert({
      where: { id: l.id },
      create: {
        id: l.id,
        linkFieldId: l.linkFieldId,
        parentRowId: l.parentRowId,
        childRowId: l.childRowId,
        ord: l.ord,
      },
      update: {},
    });
  }

  // ⑨ replica_state 记账游标（保 id 故三者同值；不订阅；authzVersion 存字符串）。
  await tx.replicaState.upsert({
    where: { nodeId_remoteBaseId: { nodeId: ctx.nodeId, remoteBaseId: baseId } },
    create: {
      nodeId: ctx.nodeId,
      remoteBaseId: baseId,
      localBaseId: baseId,
      pullCursorSeq: BigInt(page.anchorSeq),
      snapshotDone: true,
      subscribed: false,
      lastPulledAt: ctx.now,
      authzVersion: String(page.authzVersion),
      encrypted: false,
    },
    update: {},
  });

  // ⑩ 派生物重建（同事务末尾）：逐表重建 fieldIndex sidecar，再全量对齐 nav（bump navVersion）。
  for (const t of page.tables) await rebuildTableTx(tx, t.id);
  await syncNavFromEntitiesTx(tx);

  return {
    baseId,
    localBaseId: baseId,
    anchorSeq: page.anchorSeq,
    counts: {
      tables: page.tables.length,
      fields: page.fields.length,
      views: page.views.length,
      records: page.records.length,
      links: page.links.length,
    },
    alreadyBootstrapped: false,
  };
}

/**
 * 门面：off 首行零查零写；on 时在串行写队列单事务内执行导入。
 */
export async function importReplicaBootstrap(
  page: ReplicaBootstrapPage,
  ctx: ImportReplicaCtx,
): Promise<ImportReplicaResult> {
  if (!offlineReplicaEnabled()) {
    return {
      ran: false,
      baseId: page.baseId,
      localBaseId: page.baseId,
      anchorSeq: page.anchorSeq,
      counts: emptyCounts(),
      alreadyBootstrapped: false,
    };
  }
  const fullCtx: RequiredCtx = {
    ownerUserId: ctx.ownerUserId,
    nodeId: ctx.nodeId ?? offlineNodeId(),
    now: ctx.now ?? new Date(),
  };
  const out = await withWriteTx("replica.bootstrap", (tx) =>
    importReplicaBootstrapTx(tx, page, fullCtx),
  );
  return { ran: true, ...out };
}
