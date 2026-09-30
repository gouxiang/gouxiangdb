// 知识库内容创建编排层：createContent（REST POST /:kbId/docs 与 MCP doc.create / canvas.create 共用）。
//
// 本文件只负责：入参规整、开交互事务（withWriteTx）。事务体多步写在 contentServiceTx.ts
// （回调内只用传入 tx）。授权（content c 档位）不在此层：REST 经 contentAccessOf(access).create，
// MCP 经权限端口在 kb 节点判 c。

import { withWriteTx } from "../db.js";
import { createContentTx, type ContentKind } from "./contentServiceTx.js";

export interface CreateContentInput {
  kbId: string;
  kind: ContentKind;
  /** 原始标题（可空，事务体按 kind 取默认名）。 */
  title?: string;
  /** doc 层级父文档；canvas 不支持层级。 */
  parentId?: string | null;
}

/** 建 doc/canvas：trim 标题，单事务落库，返回新行。 */
export async function createContent(input: CreateContentInput, operatorUserId: string) {
  const title = input.title?.trim() ?? "";
  return withWriteTx("doc.create", (tx) =>
    createContentTx(tx, {
      kbId: input.kbId,
      kind: input.kind,
      title,
      parentId: input.parentId ?? null,
      userId: operatorUserId,
    }),
  );
}
