// 视图元数据服务：创建 / 更新 / 删除（对外编排层）。
//
// 本文件只负责：入参规整、开交互事务（withWriteTx）。事务体多步写在 viewServiceTx.ts
// （回调内只用传入 tx）。REST（routes/views.ts）与 MCP（mcp/tools/viewBuild.tools.ts）
// 共用本服务，单一真源。视图不影响记录序号，故不清 ordinal 缓存（与原路由口径一致）。

import { withWriteTx } from "../db.js";
import {
  assertAndPurgeViewTx,
  createViewTx,
  updateViewTx,
  type UpdateViewSnapshot,
} from "./viewServiceTx.js";

interface CreateViewInput {
  tableId: string;
  name: string;
  type: string;
  config?: Record<string, unknown>;
}

/** 建视图：trim 名（纯空格由调用方/此处报错），单事务落库。 */
export async function createView(input: CreateViewInput): Promise<{ id: string; createdAt: Date }> {
  const name = input.name.trim();
  if (name === "") throw new Error("视图名不能为空");
  const v = await withWriteTx("view.create", (tx) =>
    createViewTx(tx, { tableId: input.tableId, name, type: input.type, config: input.config }),
  );
  return { id: v.id, createdAt: v.createdAt };
}

interface UpdateViewPatch {
  /** 调用方按权限组装的可写列；name 已 trim（空串由调用方拦截）。 */
  data: Record<string, unknown>;
  affectsNav: boolean;
  snapshot?: UpdateViewSnapshot | null;
}

/** 改视图：透传已授权的可写列与快照参数，单事务落库，返回更新后的行。 */
export async function updateView(viewId: string, patch: UpdateViewPatch) {
  return withWriteTx("view.update", (tx) =>
    updateViewTx(tx, { viewId, data: patch.data, affectsNav: patch.affectsNav, snapshot: patch.snapshot ?? null }),
  );
}

/** 删视图（至少保留一个；清 nav 节点与布局版本；物理删）。 */
export async function purgeView(viewId: string): Promise<void> {
  await withWriteTx("view.purge", (tx) => assertAndPurgeViewTx(tx, viewId));
}
