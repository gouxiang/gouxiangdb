// beta.2 S3b-3b：下行同步泵的【单条 op 回放事务体】（三轨分派：record / structure / tree）。
// 设计权威：DESIGN-OFFLINE-SYNC.md §6（下行回放）、§8.4（保 cuid 直插）、§8.6（结构/树回放只走注册表）。
//
// 唯一入口 applyPullOpTx 只接收一个已打开的写事务 tx + 一条 PullOp + 本地属主，自己【绝不】开事务、
// 绝不发网络、绝不读 env（编排器负责 HTTP 在事务外、每页一个 withWriteTx("replica.pull.apply")）。
//
// 三条最致命的纪律：
//  1) 绝不回流 outbox：record 轨一律【裸写】，严禁调用 createRecordTx / updateRecordTx /
//     softDeleteRecordTx / restoreRecordTx——那四个在线/*Push 回放事务体内含 recordSyncOpTx +
//     recordLocalReplicaTx 切面，会在回推时造出重复 op。本文件只复用【无切面】的物理原语：
//     applyFieldWrites（不传第 7 参 trace → 不写变更历史）、restoreLinkRows、deleteRecordsTx、
//     restoreRecordsTx，外加对 records / link_rows 的直接 update。
//  2) 绝不调结构/树注册表的 resolve：下行副本是 owner 全权（服务端已按当前权限裁剪好 payload），
//     结构 op 只调 handler.apply、树 op 只过 handler.assertTx 再 applyTx。resolve 是给服务端 push
//     回放挂 manage_schema/manage_menu 权限点用的，副本回放无权可判、也不该判。
//  3) links 语义边界：record oplog 的 changes 只含【物理列】（links/subtable 不进 records.fields，
//     故不进 diffRecordFields 产出的 changes）；关联初始全集只来自 bootstrap.links 直插，本期【没有】
//     独立的 link_row 增量拉取通道。故 applyPullOpTx 不自行补拉/猜测/合成任何 link_row；applyFieldWrites
//     若遇到 links 字段（理论上不会出现）按其既有 writeLinks 语义处理，目标缺失会抛错回滚整页、不静默写半。

import type { DbTx } from "../../db.js";
// toFieldMeta 为纯行映射（prismaDeps 同时导出 prismaDeps 单例，但只取命名函数不触发额外查询）；
// 本模块经 recordWrite 已传递依赖 prismaDeps，测试在 setupOrgHarness 注入临时库后才动态 import 本链。
import { toFieldMeta } from "../prismaDeps.js";
import type { FieldMeta } from "../types.js";
import { applyFieldWrites, restoreLinkRows } from "../recordWrite.js";
import { deleteRecordsTx, restoreRecordsTx } from "../fieldIndex/sync.js";
import { getStructureOpHandler } from "./structureRegistry.js";
import { getTreeOpHandler } from "./navRegistry.js";
import type { IncomingOp } from "./push.js";
import type { PullOp } from "./pull.js";

/** 一条下行 op 的回放归宿（供编排器计数：应用条数 / 跳过条数）。 */
export type PullApplyKind = "record" | "structure" | "tree" | "skipped";

export interface PullApplyCtx {
  /** 本地副本属主：必须是本地库真实 User（records.createdBy/updatedBy 落它）。 */
  ownerUserId: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/**
 * 事务内加载一张表的活字段（转 FieldMeta）。
 * 必须走 tx 而不能用 recordService.loadTableFields（那个走全局 prisma 连接）：同一 PullPage 内
 * 服务端 seq 全局混排，可能先到 create_table、后到该表 record create，二者在同一写事务内回放时
 * 新字段尚未提交，全局连接读不到 → applyFieldWrites 会把新表记录的全部列静默丢弃（沉默逻辑错误）。
 */
async function loadFieldsTx(tx: DbTx, tableId: string): Promise<FieldMeta[]> {
  const rows = await tx.field.findMany({ where: { tableId, deletedAt: null }, orderBy: { order: "asc" } });
  return rows.map(toFieldMeta);
}

/** 把 PullOp 转成结构/树注册表消费的 IncomingOp（baseVersion 串→bigint；payload 收敛为对象）。 */
function toIncoming(op: PullOp, payload: Record<string, unknown>): IncomingOp {
  return {
    clientOpId: op.clientOpId,
    entityType: op.entityType,
    entityId: op.entityId,
    op: op.op,
    baseVersion: BigInt(op.baseVersion || "0"),
    payload,
  };
}

/** 从 record oplog payload 取 tableId 与「fieldId→after」物理列补丁（changes 缺形回 null）。 */
function extractRecordPatch(
  payload: Record<string, unknown>,
): { tableId: string; patch: Record<string, unknown> } | null {
  const tableId = str(payload.tableId);
  if (!tableId) return null;
  const rawChanges = payload.changes;
  if (!Array.isArray(rawChanges)) return null;
  const patch: Record<string, unknown> = {};
  for (const ch of rawChanges) {
    const c = asRecord(ch);
    const fid = c ? str(c.fieldId) : null;
    // 只取物理列 after；links/subtable 无独立增量通道（见文件头纪律 3），出现也不猜测，交 applyFieldWrites。
    if (fid) patch[fid] = c!["after"];
  }
  return { tableId, patch };
}

/**
 * record 轨裸写回放（create/update(patch)/delete/restore）。
 * 幂等：create 按主键 upsert（重放覆盖同值）、update 合并同值、delete 对已删行再删幂等、restore 对活行幂等。
 */
async function applyRecordTx(tx: DbTx, op: PullOp, ctx: PullApplyCtx): Promise<PullApplyKind> {
  const payload = asRecord(op.payload) ?? {};
  const parsed = extractRecordPatch(payload);
  const isPatch = op.op === "update" || op.op === "patch";

  if (op.op === "create") {
    if (!parsed) return "skipped"; // 坏 shape（缺 tableId/changes 非数组）：跳本条，不崩整页、不丢游标。
    // 保 id 直插（§8.4）：record 主键用服务端下发的 entityId；属主重映射为本地 owner。
    await tx.record.upsert({
      where: { id: op.entityId },
      create: {
        id: op.entityId,
        tableId: parsed.tableId,
        fields: JSON.stringify(parsed.patch),
        createdBy: ctx.ownerUserId,
        updatedBy: ctx.ownerUserId,
      },
      // 重入：行已在（重放）不覆盖身份列；随后 applyFieldWrites 会把物理列合并成同值，幂等。
      update: {},
    });
    const fields = await loadFieldsTx(tx, parsed.tableId);
    await applyFieldWrites(parsed.tableId, op.entityId, parsed.patch, fields, tx, true);
    return "record";
  }

  // patch/delete/restore 都需要本地已存在该行；先点查一次拿 tableId 与墓碑态（payload.tableId 优先）。
  if (isPatch || op.op === "delete" || op.op === "restore") {
    const existing = await tx.record.findUnique({
      where: { id: op.entityId }, select: { tableId: true, deletedAt: true },
    });
    // 合法缺口：delete 墓碑可能针对本地从未引导到的行（表可读即下发删除，不要求行在可见集）。
    // 本地无行则无可删/改/恢复 → 跳过幂等（不猜建行，避免拼出缺字段的残行）。
    if (!existing) return "skipped";
    const tableId = parsed?.tableId ?? existing.tableId;

    if (isPatch) {
      if (!parsed) return "skipped";
      const fields = await loadFieldsTx(tx, tableId);
      // applyFieldWrites 合并物理列 + 维护 link_row + 重建该记录 sidecar（不传 trace，零变更历史）；
      // 已删行收到 patch（乱序）也按服务端事实合并值，但不动墓碑（后续 delete/restore 定终态）。
      await applyFieldWrites(tableId, op.entityId, parsed.patch, fields, tx, true);
      await tx.record.update({ where: { id: op.entityId }, data: { updatedBy: ctx.ownerUserId } });
      return "record";
    }

    if (op.op === "delete") {
      if (existing.deletedAt) return "record"; // 已在回收站：幂等，不重复刷 link_row 墓碑/sidecar。
      // 裸软删（与 softDeleteRecordTx 物理动作同构，但剥掉 oplog/outbox/变更历史/检索 outbox 切面）。
      const now = new Date();
      await tx.record.update({ where: { id: op.entityId }, data: { deletedAt: now, updatedBy: ctx.ownerUserId } });
      await tx.linkRow.updateMany({
        where: { OR: [{ parentRowId: op.entityId }, { childRowId: op.entityId }], deletedAt: null },
        data: { deletedAt: now },
      });
      await deleteRecordsTx(tx, [op.entityId]); // 撤 sidecar（内部按 flag/raw 能力自跳过）。
      return "record";
    }

    // restore
    await tx.record.update({
      where: { id: op.entityId },
      data: { deletedAt: null, updatedBy: ctx.ownerUserId },
    });
    await restoreLinkRows(tx, [op.entityId]); // 仅回填两端仍活的 link_row。
    await restoreRecordsTx(tx, tableId, [op.entityId]); // 按最新 fields 重建 sidecar。
    return "record";
  }

  // 未知 record op：不支持就跳过（不抛、不假装生效），与注册表未登记同口径。
  return "skipped";
}

/**
 * 在调用方写事务内回放一条下行 op，返回归宿。
 * - table/field/view → 结构注册表 handler.apply（不调 resolve）；未登记 → skipped。
 * - navnode          → 树注册表 handler.assertTx 然后 applyTx；未登记 → skipped。
 * - record           → 本文件裸写 applier。
 * 已登记 op 的处理函数内部抛错（坏 payload/业务校验）原样上抛：整页随事务回滚、游标不推进，下轮重拉。
 */
export async function applyPullOpTx(tx: DbTx, op: PullOp, ctx: PullApplyCtx): Promise<PullApplyKind> {
  // 结构轨（table/field/view）：per-base 页内 baseId 非空。
  const structureHandler = getStructureOpHandler(op.entityType, op.op);
  if (structureHandler) {
    const baseId = op.baseId as string;
    const incoming = toIncoming(op, asRecord(op.payload) ?? {});
    await structureHandler.apply(tx, ctx.ownerUserId, baseId, incoming);
    return "structure";
  }

  // 树轨（本期仅 navnode；baseId 恒 null）。
  const treeHandler = getTreeOpHandler(op.entityType, op.op);
  if (treeHandler) {
    const incoming = toIncoming(op, asRecord(op.payload) ?? {});
    await treeHandler.assertTx(tx, incoming);
    await treeHandler.applyTx(tx, ctx.ownerUserId, incoming);
    return "tree";
  }

  // record 轨（含未知 op → skipped）。
  if (op.entityType === "record") {
    return await applyRecordTx(tx, op, ctx);
  }

  // 其它实体族（doc/canvas 走协同轨等，本期下行泵不受理）：跳过不抛。
  return "skipped";
}
