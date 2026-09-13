// apps/api/src/domain/prismaDeps.ts
// HydrateDeps 的 Prisma 实现（domain 层与 ORM 解耦，单测可换内存实现）

import { prisma } from "../db.js";
import type { HydrateDeps, LinkBatchQuery, LinkRowRef } from "./hydrate.js";
import type { FieldMeta, RawRecord, SelectOption, TabConfig } from "./types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrismaFieldRow = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrismaRecordRow = any;

export function toFieldMeta(f: PrismaFieldRow): FieldMeta {
  return {
    id: f.id,
    tableId: f.tableId,
    name: f.name,
    type: f.type,
    description: f.description ?? "",
    order: f.order,
    required: f.required,
    unique: f.unique,
    options: f.options ? safeParse<SelectOption[]>(f.options, null) : null,
    precision: f.precision ?? null,
    maxLength: f.maxLength ?? null,
    defaultNow: Boolean(f.defaultNow),
    linkFieldId: f.linkFieldId ?? null,
    relatedTableId: f.relatedTableId ?? null,
    relationKind: (f.relationKind as FieldMeta["relationKind"]) ?? null,
    isReverse: Boolean(f.isReverse),
    reverseFieldId: f.reverseFieldId ?? null,
    linkDisplayFieldId: f.linkDisplayFieldId ?? null,
    lookupFieldId: f.lookupFieldId ?? null,
    rollupFunction: (f.rollupFunction as FieldMeta["rollupFunction"]) ?? null,
    formula: f.formula ?? null,
    recordFilter: f.recordFilter ? safeParse(f.recordFilter, null) : null,
    tabsConfig: f.tabsConfig ? safeParse<TabConfig[]>(f.tabsConfig, null) : null,
    displayedFieldIds: f.displayedFieldIds ? safeParse<string[]>(f.displayedFieldIds, null) : null,
    visibleFieldIds: f.visibleFieldIds ? safeParse<string[]>(f.visibleFieldIds, null) : null,
    defaultConfig: f.defaultConfig ? safeParse(f.defaultConfig, null) : null,
    numberRule: f.numberRule ? safeParse(f.numberRule, null) : null,
  };
}

export function toRawRecord(r: PrismaRecordRow): RawRecord {
  return {
    id: r.id,
    tableId: r.tableId,
    fields: r.fields,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : String(r.updatedAt),
    createdBy: r.createdBy,
    updatedBy: r.updatedBy,
  };
}

function safeParse<T>(s: string, fallback: T | null): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

// autoNumber 序号缓存：避免 N 条记录 N 次 count 查询
const ordinalCache = new Map<string, { ids: string[]; at: number }>();
const ORDINAL_TTL = 5_000;

async function orderedIds(tableId: string): Promise<string[]> {
  const hit = ordinalCache.get(tableId);
  if (hit && Date.now() - hit.at < ORDINAL_TTL) return hit.ids;
  const rows = await prisma.record.findMany({
    where: { tableId, deletedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  const ids = rows.map((r) => r.id);
  ordinalCache.set(tableId, { ids, at: Date.now() });
  return ids;
}

export function invalidateOrdinalCache(tableId?: string): void {
  if (tableId) ordinalCache.delete(tableId);
  else ordinalCache.clear();
}

// 用户名缓存
const userNameCache = new Map<string, { name: string; at: number }>();
const NAME_TTL = 60_000;

export const prismaDeps: HydrateDeps = {
  async getFields(tableId) {
    const rows = await prisma.field.findMany({
      where: { tableId, deletedAt: null },
      orderBy: { order: "asc" },
    });
    return rows.map(toFieldMeta);
  },

  async getRecordsByIds(ids) {
    if (ids.length === 0) return [];
    const rows = await prisma.record.findMany({
      where: { id: { in: ids }, deletedAt: null },
    });
    return rows.map(toRawRecord);
  },

  async getLinkRows(q): Promise<LinkRowRef[]> {
    const rows = await prisma.linkRow.findMany({
      where: {
        // 软删的关联不参与计算（记录删除时只是打标记）
        deletedAt: null,
        ...(q.linkFieldId ? { linkFieldId: q.linkFieldId } : {}),
        ...(q.parentRowId ? { parentRowId: q.parentRowId } : {}),
        ...(q.childRowId ? { childRowId: q.childRowId } : {}),
      },
      orderBy: { ord: "asc" },
    });
    return rows.map((r) => ({
      id: r.id,
      linkFieldId: r.linkFieldId,
      parentRowId: r.parentRowId,
      childRowId: r.childRowId,
      ord: r.ord,
    }));
  },

  async countLinkRows(q) {
    return await prisma.linkRow.count({
      where: {
        deletedAt: null,
        ...(q.linkFieldId ? { linkFieldId: q.linkFieldId } : {}),
        ...(q.parentRowId ? { parentRowId: q.parentRowId } : {}),
        ...(q.childRowId ? { childRowId: q.childRowId } : {}),
      },
    });
  },

  // M1/S5 批量：每组 (linkFieldId, 方向) 一条 IN 查询，随 ord 升序返回；hydrateBatch 按行分桶。
  async getLinkRowsBulk(qs: LinkBatchQuery[]): Promise<LinkRowRef[][]> {
    return await Promise.all(
      qs.map(async (g) => {
        const rows = await prisma.linkRow.findMany({
          where: {
            deletedAt: null,
            linkFieldId: g.linkFieldId,
            ...(g.dir === "parent"
              ? { parentRowId: { in: g.rowIds } }
              : { childRowId: { in: g.rowIds } }),
          },
          orderBy: { ord: "asc" },
        });
        return rows.map((r) => ({
          id: r.id,
          linkFieldId: r.linkFieldId,
          parentRowId: r.parentRowId,
          childRowId: r.childRowId,
          ord: r.ord,
        }));
      }),
    );
  },

  // M1/S5 批量：页内去重 user id 一次 IN 解析显示名；结果同时回填单名缓存。
  async resolveUserNames(userIds: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    if (userIds.length === 0) return out;
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, displayName: true },
    });
    for (const u of users) {
      out[u.id] = u.displayName;
      userNameCache.set(u.id, { name: u.displayName, at: Date.now() });
    }
    return out;
  },

  async getRecordOrdinal(tableId, recordId) {
    const ids = await orderedIds(tableId);
    const idx = ids.indexOf(recordId);
    return idx === -1 ? ids.length + 1 : idx + 1;
  },

  async resolveUserName(userId) {
    const hit = userNameCache.get(userId);
    if (hit && Date.now() - hit.at < NAME_TTL) return hit.name;
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } });
    const name = u?.displayName ?? userId;
    userNameCache.set(userId, { name, at: Date.now() });
    return name;
  },
};
