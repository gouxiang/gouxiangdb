// M6/S4 MCP 只读投影（新增的 domain 只读模型；**不改任何既有文件**）。
//
// 为什么需要它：M6 §3-3 规定 mcp/** 内不得裸查 prisma（PAT 存储为唯一例外），而 base/table 的
// 元数据读取此前只内联在路由里。故在此提供**只读**投影，供 MCP 工具消费；不含任何授权判定
// （授权一律经 permissions 端口 / M4）。

import { prisma } from "../db.js";

interface BaseBrief { id: string; name: string }
interface TableBrief { id: string; baseId: string; name: string }

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

/** 单记录最小投影（MCP 写前存在性/归属校验用；不做授权判定）。 */export async function recordBriefById(recordId: string): Promise<{ id: string; tableId: string; deletedAt: Date | null } | null> {
  const r = await prisma.record.findUnique({
    where: { id: recordId },
    select: { id: true, tableId: true, deletedAt: true },
  });
  return r ?? null;
}

/** 单字段最小投影：由 fieldId 反查 tableId（字段搭建工具权限判定用）。 */
export async function fieldBriefById(fieldId: string): Promise<{ id: string; tableId: string } | null> {
  const f = await prisma.field.findUnique({
    where: { id: fieldId },
    select: { id: true, tableId: true, deletedAt: true },
  });
  if (!f || f.deletedAt) return null;
  return { id: f.id, tableId: f.tableId };
}

/** 字段已有配置投影（update_field 合并校验用；只取 fieldValidation 需要的标量列）。 */
export async function fieldConfigById(
  fieldId: string,
): Promise<{
  id: string; tableId: string; type: string; formula: string | null;
  lookupFieldId: string | null; rollupFunction: string | null;
  linkDisplayFieldId: string | null; relatedTableId: string | null; linkFieldId: string | null;
} | null> {
  const f = await prisma.field.findFirst({
    where: { id: fieldId, deletedAt: null },
    select: {
      id: true, tableId: true, type: true, formula: true, lookupFieldId: true,
      rollupFunction: true, linkDisplayFieldId: true, relatedTableId: true, linkFieldId: true,
    },
  });
  return f ?? null;
}

/** 单视图最小投影：由 viewId 反查 tableId/类型/现有配置（视图搭建工具权限判定用）。 */
export async function viewBriefById(
  viewId: string,
): Promise<{ id: string; tableId: string; type: string; config: string; lockMode: string } | null> {
  const v = await prisma.view.findUnique({
    where: { id: viewId },
    select: { id: true, tableId: true, type: true, config: true, lockMode: true },
  });
  return v ?? null;
}

/** 单知识库最小投影：由 kbId 确认存在（内容创建工具前置用）。 */
export async function kbBriefById(kbId: string): Promise<{ id: string } | null> {
  const k = await prisma.knowledgeBase.findFirst({
    where: { id: kbId, deletedAt: null },
    select: { id: true },
  });
  return k ?? null;
}
