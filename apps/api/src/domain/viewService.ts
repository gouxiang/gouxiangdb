// 视图元数据服务：创建 / 更新 / 删除（对外编排层）。
//
// 本文件只负责：入参规整、开交互事务（withWriteTx）。事务体多步写在 viewServiceTx.ts
// （回调内只用传入 tx）。REST（routes/views.ts）与 MCP（mcp/tools/viewBuild.tools.ts）
// 共用本服务，单一真源。视图不影响记录序号，故不清 ordinal 缓存（与原路由口径一致）。

import { withWriteTx, type DbTx } from "../db.js";
import {
  assertAndPurgeViewTx,
  createViewTx,
  updateViewTx,
  type UpdateViewSnapshot,
} from "./viewServiceTx.js";
import { recordStructureOpTx } from "./sync/structureOplog.js";
import { recordLocalStructureReplicaTx } from "./sync/localOutbox.js";
import { offlineNodeId, offlineClientId } from "../configOfflineReplica.js";

/** 事务内由视图 id 取 (tableId, baseId)（结构 oplog 的版本钟/分片键）。 */
async function viewLocatorTx(
  tx: DbTx,
  viewId: string,
): Promise<{ tableId: string; baseId: string } | null> {
  const v = await tx.view.findUnique({
    where: { id: viewId },
    select: { tableId: true, table: { select: { baseId: true } } },
  });
  return v ? { tableId: v.tableId, baseId: v.table.baseId } : null;
}

interface CreateViewInput {
  tableId: string;
  name: string;
  type: string;
  config?: Record<string, unknown>;
}

/** 建视图：trim 名（纯空格由调用方/此处报错），单事务落库。actorUserId 供 YN7 oplog（可选）。 */
export async function createView(
  input: CreateViewInput,
  actorUserId?: string | null,
): Promise<{ id: string; createdAt: Date }> {
  const name = input.name.trim();
  if (name === "") throw new Error("视图名不能为空");
  const v = await withWriteTx("view.create", async (tx) => {
    const created = await createViewTx(tx, { tableId: input.tableId, name, type: input.type, config: input.config });
    // YN7 §8.6：create_view 结构 oplog（off 时零 IO）。
    const tbl = await tx.table.findUnique({ where: { id: input.tableId }, select: { baseId: true } });
    const baseId = tbl?.baseId ?? null;
    if (baseId) {
      const structInput = {
        entityType: "view" as const, entityId: created.id, tableId: input.tableId, baseId,
        op: "create_view", actorId: actorUserId ?? null,
        payload: { tableId: input.tableId, name, type: input.type, ...(input.config ? { config: input.config } : {}) },
      };
      await recordStructureOpTx(tx, structInput);
      // S2c：离线副本同事务落 local_outbox（默认关零行为；回放走 *Tx 原语不经 wrapper）。
      await recordLocalStructureReplicaTx(tx, structInput, { nodeId: offlineNodeId(), clientId: offlineClientId() });
    }
    return created;
  });
  return { id: v.id, createdAt: v.createdAt };
}

interface UpdateViewPatch {
  /** 调用方按权限组装的可写列；name 已 trim（空串由调用方拦截）。 */
  data: Record<string, unknown>;
  affectsNav: boolean;
  snapshot?: UpdateViewSnapshot | null;
}

/** 改视图：透传已授权的可写列与快照参数，单事务落库，返回更新后的行。actorUserId 供 YN7 oplog。 */
export async function updateView(
  viewId: string,
  patch: UpdateViewPatch,
  actorUserId?: string | null,
) {
  return withWriteTx("view.update", async (tx) => {
    const u = await updateViewTx(tx, { viewId, data: patch.data, affectsNav: patch.affectsNav, snapshot: patch.snapshot ?? null });
    // YN7 §8.6：alter_view 结构 oplog（payload 即授权可写列；off 时零 IO）。
    const loc = await viewLocatorTx(tx, viewId);
    if (loc) {
      const structInput = {
        entityType: "view" as const, entityId: viewId, tableId: loc.tableId, baseId: loc.baseId,
        op: "alter_view", actorId: actorUserId ?? null, payload: { tableId: loc.tableId, ...patch.data },
      };
      await recordStructureOpTx(tx, structInput);
      // S2c：离线副本同事务落 local_outbox（默认关零行为；回放不经此 wrapper）。
      await recordLocalStructureReplicaTx(tx, structInput, { nodeId: offlineNodeId(), clientId: offlineClientId() });
    }
    return u;
  });
}

/** 删视图（至少保留一个；清 nav 节点与布局版本；物理删）。actorUserId 供 YN7 oplog。 */
export async function purgeView(viewId: string, actorUserId?: string | null): Promise<void> {
  await withWriteTx("view.purge", async (tx) => {
    const loc = await viewLocatorTx(tx, viewId);
    await assertAndPurgeViewTx(tx, viewId);
    // YN7 §8.6：delete_view 结构 oplog（先定位再物理删；off 时零 IO）。
    if (loc) {
      const structInput = {
        entityType: "view" as const, entityId: viewId, tableId: loc.tableId, baseId: loc.baseId,
        op: "delete_view", actorId: actorUserId ?? null, payload: { tableId: loc.tableId },
      };
      await recordStructureOpTx(tx, structInput);
      // S2c：离线副本同事务落 local_outbox（默认关零行为；回放不经此 wrapper）。
      await recordLocalStructureReplicaTx(tx, structInput, { nodeId: offlineNodeId(), clientId: offlineClientId() });
    }
  });
}
