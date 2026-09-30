// 知识库内容创建事务体（REST POST /:kbId/docs 与 MCP doc.create / canvas.create 共用）。
//
// 纪律：本文件只承载回调内多步写（只用传入 tx）；授权（content c 档位）不在此层
// （REST 经 contentAccessOf(access).create，MCP 经权限端口在 kb 节点判 c）。
// 顺序 / 默认标题 / 父文档校验 / 首版本 + outbox + nav 同步与原 routes/kb/docs.ts 逐字一致。

import type { DbTx } from "../db.js";
import { HttpError } from "../guards.js";
import { changeEntityOfKind } from "./kbDocWrite.js";
import { enqueueChangeEventTx } from "./search/outbox.js";
import { syncNavFromEntitiesTx } from "./nav/sync.js";

export type ContentKind = "doc" | "canvas";

export interface CreateContentTxInput {
  kbId: string;
  kind: ContentKind;
  /** 已 trim 的标题；空串时由本层按 kind 取默认名。 */
  title?: string;
  /** doc 层级父文档；canvas 恒挂 kb 下（传入会被忽略）。 */
  parentId?: string | null;
  userId: string;
}

/**
 * 建 doc/canvas + 首版本 + outbox upsert + 同步 nav。
 * doc 的 parentId 必须同库、未删除且为 doc；canvas 不支持层级。
 */
export async function createContentTx(tx: DbTx, input: CreateContentTxInput) {
  const kind = input.kind;
  const title = input.title || (kind === "canvas" ? "未命名画布" : "未命名文档");

  let parentId: string | null = null;
  if (kind === "doc" && input.parentId) {
    const parent = await tx.kbDoc.findFirst({
      where: { id: input.parentId, kbId: input.kbId, deletedAt: null, kind: "doc" },
      select: { id: true },
    });
    if (!parent) throw new HttpError(400, "父文档不存在或已被删除");
    parentId = parent.id;
  }

  const d = await tx.kbDoc.create({
    data: {
      kbId: input.kbId,
      kind,
      title,
      content: kind === "canvas" ? "[]" : "",
      searchText: "",
      createdBy: input.userId,
      updatedBy: input.userId,
      ...(parentId ? { parentId } : {}),
    },
  });
  await tx.kbDocVersion.create({
    data: { docId: d.id, version: 1, label: "创建", title: d.title, content: d.content, createdBy: input.userId },
  });
  // 登记 upsert（version 取新内容版本 0，worker 抽当前内容）。
  await enqueueChangeEventTx(tx, {
    entityType: changeEntityOfKind(d.kind), entityId: d.id, op: "upsert", version: BigInt(d.contentVersion),
  });
  await syncNavFromEntitiesTx(tx);
  return d;
}
