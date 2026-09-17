// M6/S4 MCP 只读投影（新增的 domain 只读模型；**不改任何既有文件**）。
//
// 为什么需要它：M6 §3-3 规定 mcp/** 内不得裸查 prisma（PAT 存储为唯一例外），而 base/table 的
// 元数据读取此前只内联在路由里。故在此提供**只读**投影，供 MCP 工具消费；不含任何授权判定
// （授权一律经 permissions 端口 / M4）。

import { prisma } from "../db.js";

export interface BaseBrief { id: string; name: string }
export interface TableBrief { id: string; baseId: string; name: string }

/** 按 id 取可见 base 的元数据（顺序按入参顺序；缺者跳过）。 */
export async function listBasesByIds(ids: readonly string[]): Promise<BaseBrief[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.base.findMany({
    where: { id: { in: [...ids] }, deletedAt: null },
    select: { id: true, name: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => (byId.has(id) ? [{ id, name: byId.get(id)!.name }] : []));
}

/** 取若干 base 下未删除的表（按 baseId+name 排序，确定性）。 */
export async function listTablesUnderBases(baseIds: readonly string[]): Promise<TableBrief[]> {
  if (baseIds.length === 0) return [];
  const rows = await prisma.table.findMany({
    where: { baseId: { in: [...baseIds] }, deletedAt: null },
    select: { id: true, baseId: true, name: true },
    orderBy: [{ baseId: "asc" }, { name: "asc" }],
  });
  return rows;
}

/** 单表元数据（含 baseId），供写入前置的可见性/归属判定。 */
export async function tableBriefById(tableId: string): Promise<TableBrief | null> {
  const t = await prisma.table.findUnique({
    where: { id: tableId },
    select: { id: true, baseId: true, name: true, deletedAt: true },
  });
  if (!t || t.deletedAt) return null;
  return { id: t.id, baseId: t.baseId, name: t.name };
}

/** 单 base 元数据（供 list_records 的 baseId 归属校验）。 */
export async function baseExists(baseId: string): Promise<boolean> {
  const b = await prisma.base.findUnique({ where: { id: baseId }, select: { id: true, deletedAt: true } });
  return !!b && !b.deletedAt;
}

/** 单记录最小投影（MCP 写前存在性/归属校验用；不做授权判定）。 */
export async function recordBriefById(recordId: string): Promise<{ id: string; tableId: string; deletedAt: Date | null } | null> {
  const r = await prisma.record.findUnique({
    where: { id: recordId },
    select: { id: true, tableId: true, deletedAt: true },
  });
  return r ?? null;
}
