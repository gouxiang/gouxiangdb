// 视图结构写事务体（REST routes/views.ts 与 MCP view.* 搭建工具共用）。
//
// 纪律：本文件只承载回调内的多步写（只用传入 tx，禁再次入队）；授权判定不在此层
// （REST 经 requireSchemaDesign，MCP 经权限端口 manage_schema）。
// 顺序 / 错误文案 / nav 同步与表单快照口径与原 routes/views.ts 内联事务体逐字一致。

import type { DbTx } from "../db.js";
import { HttpError } from "../guards.js";
import { parseViewConfig } from "./recordService.js";
import { syncNavFromEntitiesTx, purgeViewNodeTx } from "./nav/sync.js";
import { maybeAutoSnapshotLayoutTx, purgeVersionsTx } from "./formLayoutVersion.js";

export interface CreateViewTxInput {
  tableId: string;
  name: string;
  type: string;
  /** 调用方已校验的视图配置；与默认 ViewConfig 合并后落库。 */
  config?: Record<string, unknown>;
}

/** 建视图：maxOrder+1 -> 合并默认配置 -> create -> 同步 nav 节点。 */
export async function createViewTx(tx: DbTx, input: CreateViewTxInput) {
  const maxOrder = await tx.view.findFirst({
    where: { tableId: input.tableId },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  const order = maxOrder ? maxOrder.order + 1 : 0;
  const merged = {
    ...parseViewConfig(null),
    ...(input.config ?? {}),
  };
  const created = await tx.view.create({
    data: {
      tableId: input.tableId,
      name: input.name,
      type: input.type,
      order,
      config: JSON.stringify(merged),
      lockMode: "collaborative",
    },
  });
  await syncNavFromEntitiesTx(tx);
  return created;
}

export interface UpdateViewSnapshot {
  userId: string;
  tableId: string;
  viewType: string;
  skipIfIdentical?: boolean;
}

export interface UpdateViewTxInput {
  viewId: string;
  /** 调用方按权限组装好的可写列（不含已被拒绝的键）。 */
  data: Record<string, unknown>;
  /** name/order 变更影响 nav 节点。 */
  affectsNav: boolean;
  /** config 变更时传表单快照参数；null=不留快照。 */
  snapshot?: UpdateViewSnapshot | null;
}

/** 改视图：update -> 条件同步 nav -> 条件留布局快照（快照取 update 后的 config）。 */
export async function updateViewTx(tx: DbTx, input: UpdateViewTxInput) {
  const u = await tx.view.update({ where: { id: input.viewId }, data: input.data });
  if (input.affectsNav) await syncNavFromEntitiesTx(tx);
  if (input.snapshot) {
    await maybeAutoSnapshotLayoutTx(tx, input.viewId, input.snapshot.userId, {
      tableId: input.snapshot.tableId,
      viewType: input.snapshot.viewType,
      viewConfigJson: u.config,
      skipIfIdentical: input.snapshot.skipIfIdentical,
    });
  }
  return u;
}

/** 删视图：至少保留一个 -> 清 nav 节点与布局版本 -> 物理删。 */
export async function assertAndPurgeViewTx(tx: DbTx, viewId: string) {
  const v = await tx.view.findUnique({ where: { id: viewId } });
  if (!v) throw new HttpError(404, "视图不存在");

  const count = await tx.view.count({ where: { tableId: v.tableId } });
  if (count <= 1) throw new HttpError(400, "至少保留一个视图");

  // RESTRICT 守卫（节点被菜单引用则 purgeViewNodeTx 抛 409，不静默级联删菜单）；
  // 布局版本是视图派生历史，视图物理删时一并清掉。
  await purgeViewNodeTx(tx, viewId);
  await purgeVersionsTx(tx, viewId);
  await tx.view.delete({ where: { id: viewId } });
}
