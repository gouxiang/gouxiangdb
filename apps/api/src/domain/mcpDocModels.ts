// M6/S5 MCP 文档只读投影（新增的 domain 只读模型；**不改任何既有文件**）。
//
// 为什么需要它：M6 §3-3 规定 mcp/** 内不得裸查 prisma（PAT 存储为唯一例外），而文档正文此前只在
// routes/kb/docs.ts 内联读取。故在此提供**只读**投影，供 MCP doc.* 工具消费；
// **不含任何授权判定**（授权一律经 permissions 端口 / M4 闸门二）。
//
// 与 mcpReadModels.ts 同模式（base/table 投影）：本文件是 mcp 工具读取文档的唯一入口。

import { prisma } from "../db.js";

export interface DocBrief {
  id: string;
  kbId: string;
  /** "doc"（Markdown 正文） | "canvas"（画布 JSON）。 */
  kind: string;
  title: string;
  /** doc=Markdown 正文；canvas=PlaitElement[] JSON。 */
  content: string;
  /** 乐观锁版本（写工具 baseVersion 对拍用）。 */
  contentVersion: number;
}

/**
 * 单文档读取（含正文与版本）。不存在 / 已软删 -> null。
 * **不泄漏存在性**：调用方须先经权限端口判定可见，再据此取正文。
 */
export async function docBriefById(docId: string): Promise<DocBrief | null> {
  const d = await prisma.kbDoc.findUnique({
    where: { id: docId },
    select: { id: true, kbId: true, kind: true, title: true, content: true, contentVersion: true, deletedAt: true },
  });
  if (!d || d.deletedAt) return null;
  return {
    id: d.id,
    kbId: d.kbId,
    kind: d.kind,
    title: d.title,
    content: d.content,
    contentVersion: d.contentVersion,
  };
}
