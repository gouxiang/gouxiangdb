// YN7#788-D 结构冲突面板的「服务端当前结构快照」（§19.3 冲突解决统一形态）。
//
// 设计权威：docs/design/2026-10-node-mode/DESIGN-OFFLINE-SYNC.md §19.3：
//   服务端把入站结构 op 落 sync_incoming(status=conflict, reasonCode,
//   conflictServerPayload=服务端当前结构快照)；前端弹结构冲突面板（我的结构改动 / 服务端当前结构）。
//
// 边界与纪律：
//   - 只含【结构元数据】（表名/图标/主字段、活字段 id/名/类型/顺序/选项、活视图），绝不含任何记录行
//     明文（结构元数据按 manage_schema 可见，oplog payload 也是同一口径）。
//   - 只读、事务外调用（结构冲突是在回放事务因版本分叉中止后才构建快照，此时事务可能已被毒化，
//     故不能复用该 tx；用非事务 prisma 读当前权威结构即可，快照仅供展示、不参与裁决）。
//   - 软删表/字段也如实给 isDeleted，前端据此区分「字段被对方删了」（§19.3 场景 2）与「仍存活」。
//   - 构建失败软处理：快照仅为弹窗展示，绝不能因快照失败弄丢用户离线改动（与 record 快照同策略）。

import { prisma } from "../../db.js";
import type { IncomingOp } from "./push.js";
import { readSchemaVersion } from "./structureOplog.js";

export interface StructureSnapshot extends Record<string, unknown> {
  version: string;
  serverTime: string;
  kind: "structure";
  tableId: string;
  table: {
    id: string;
    name: string;
    isDeleted: boolean;
    icon: string | null;
    iconColor: string | null;
    primaryFieldId: string | null;
  } | null;
  fields: Array<{
    id: string;
    name: string;
    type: string;
    order: number;
    isDeleted: boolean;
    isPrimary: boolean;
    options: unknown;
  }>;
  // 视图无软删列（删除即应用层清行），故只有存活视图。
  views: Array<{ id: string; name: string; type: string; order: number }>;
}

/** 从结构 op 解析它作用的表 id（与注册表 resolve 的取法同源，但此处只读、且容忍软删）。 */
export async function resolveStructureTableId(o: IncomingOp): Promise<string | null> {
  const explicit = (o.payload && typeof o.payload.tableId === "string" && o.payload.tableId) || null;
  if (explicit) {
    const t = await prisma.table.findUnique({ where: { id: explicit }, select: { id: true } });
    if (t) return explicit;
  }
  if (o.entityType === "table") return o.entityId;
  if (o.entityType === "field") {
    // reorder_fields 约定 entityId=tableId；其它 field op 用 entityId 反查（含软删字段）。
    const byField = await prisma.field.findUnique({
      where: { id: o.entityId },
      select: { tableId: true },
    });
    if (byField) return byField.tableId;
    return explicit ?? o.entityId;
  }
  if (o.entityType === "view") {
    const v = await prisma.view.findUnique({
      where: { id: o.entityId },
      select: { tableId: true },
    });
    if (v) return v.tableId;
  }
  return explicit;
}

/**
 * 构建某条结构 op 对应表的服务端当前结构快照（事务外只读）。
 * 表不存在（如建表 id 撞库等极端情形）也回最小占位，前端仍可让用户选「采用服务端」。
 */
export async function buildStructureSnapshot(
  baseId: string,
  o: IncomingOp,
): Promise<Record<string, unknown>> {
  const base = {
    version: "0",
    serverTime: new Date().toISOString(),
    kind: "structure" as const,
  };
  try {
    const tableId = await resolveStructureTableId(o);
    if (!tableId) return { ...base, unavailable: true };

    const version = await readSchemaVersion(tableId);
    const table = await prisma.table.findUnique({
      where: { id: tableId },
      select: {
        id: true, name: true, baseId: true, deletedAt: true,
        icon: true, iconColor: true, primaryFieldId: true,
      },
    });
    if (!table || table.baseId !== baseId) {
      return { ...base, version: version.toString(), tableId, table: null, fields: [], views: [] };
    }

    const [fieldRows, viewRows] = await Promise.all([
      prisma.field.findMany({
        where: { tableId },
        select: {
          id: true, name: true, type: true, order: true, deletedAt: true, options: true,
        },
        orderBy: [{ order: "asc" }, { id: "asc" }],
      }),
      prisma.view.findMany({
        where: { tableId },
        select: { id: true, name: true, type: true, order: true },
        orderBy: [{ order: "asc" }, { id: "asc" }],
      }),
    ]);

    const primaryFieldId = table.primaryFieldId;
    const snap: StructureSnapshot = {
      ...base,
      version: version.toString(),
      tableId,
      table: {
        id: table.id,
        name: table.name,
        isDeleted: table.deletedAt !== null,
        icon: table.icon,
        iconColor: table.iconColor,
        primaryFieldId,
      },
      fields: fieldRows.map((f) => {
        let parsedOptions: unknown = null;
        if (f.options) {
          try { parsedOptions = JSON.parse(f.options); } catch { parsedOptions = null; }
        }
        return {
          id: f.id, name: f.name, type: f.type, order: f.order,
          isDeleted: f.deletedAt !== null, isPrimary: f.id === primaryFieldId, options: parsedOptions,
        };
      }),
      views: viewRows.map((v) => ({
        id: v.id, name: v.name, type: v.type, order: v.order,
      })),
    };
    return snap;
  } catch (e) {
    console.error("[sync.push] build structure snapshot failed:", o.clientOpId, e);
    return { ...base, unavailable: true };
  }
}
