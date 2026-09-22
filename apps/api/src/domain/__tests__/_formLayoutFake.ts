// apps/api/src/domain/__tests__/_formLayoutFake.ts
// 布局版本领域测试共用的内存假 Prisma client（不碰真实 dev.db，不依赖迁移）。
//
// 只实现 formLayoutVersion / view / field 三个模型里本模块真正用到的那几个调用，
// 刻意不做通用 Mock —— 通用 Mock 会把"查询条件写错了"这类 bug 也吞掉。

import type { DbTx } from "../../db.js";

export interface Row {
  id: string;
  viewId: string;
  version: number;
  label: string | null;
  snapshot: string;
  createdBy: string;
  createdAt: Date;
}
export interface FakeView { id: string; tableId: string; type: string; config: string }
export interface FakeField {
  id: string;
  tableId: string;
  name: string;
  type: string;
  tabsConfig: string | null;
  deletedAt: Date | null;
}

/** 一个固定的"已软删"时间戳，测试里用于制造"字段已被删"的态。 */
export const DELETED = new Date("2026-01-01T00:00:00Z");

export function matchWhere(row: object, where: Record<string, unknown> = {}): boolean {
  const rec = row as Record<string, unknown>;
  for (const [k, cond] of Object.entries(where)) {
    if (k === "OR") {
      if (!(cond as Record<string, unknown>[]).some((sub) => matchWhere(row, sub))) return false;
      continue;
    }
    const val = rec[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      const c = cond as Record<string, unknown>;
      if ("in" in c) {
        if (!(c["in"] as unknown[]).includes(val)) return false;
        continue;
      }
      continue;
    }
    if (cond === null) {
      if (val !== null && val !== undefined) return false;
      continue;
    }
    if (val !== cond) return false;
  }
  return true;
}

export function sortRows<T extends object>(rows: T[], orderBy: unknown): T[] {
  const list = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  return rows.slice().sort((a, b) => {
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    for (const o of list) {
      for (const [k, dir] of Object.entries(o as Record<string, string>)) {
        const av = ra[k] instanceof Date ? (ra[k] as Date).getTime() : Number(ra[k]);
        const bv = rb[k] instanceof Date ? (rb[k] as Date).getTime() : Number(rb[k]);
        if (av !== bv) return dir === "desc" ? bv - av : av - bv;
      }
    }
    return 0;
  });
}

export interface FakeDb {
  client: DbTx;
  /** 实时版本行（create/delete 会就地反映） */
  versions: Row[];
  views: FakeView[];
  fields: FakeField[];
  /** 写操作日志，用于断言"写了几列、按什么顺序" */
  log: string[];
}

export function makeFake(opts: { versions?: Row[]; views?: FakeView[]; fields?: FakeField[] } = {}): FakeDb {
  const versions: Row[] = (opts.versions ?? []).map((v) => ({ ...v }));
  const views: FakeView[] = (opts.views ?? []).map((v) => ({ ...v }));
  const fields: FakeField[] = (opts.fields ?? []).map((f) => ({ ...f }));
  const log: string[] = [];
  let seq = 0;

  const client = {
    formLayoutVersion: {
      findMany: async (args: Record<string, unknown> = {}) => {
        const rows = sortRows(
          versions.filter((r) => matchWhere(r, (args["where"] ?? {}) as Record<string, unknown>)),
          args["orderBy"],
        );
        const take = args["take"] as number | undefined;
        return take ? rows.slice(0, take) : rows;
      },
      findFirst: async (args: Record<string, unknown> = {}) => {
        const rows = sortRows(
          versions.filter((r) => matchWhere(r, (args["where"] ?? {}) as Record<string, unknown>)),
          args["orderBy"],
        );
        return rows[0] ?? null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = {
          id: `gen_${++seq}`,
          viewId: data["viewId"] as string,
          version: data["version"] as number,
          label: (data["label"] as string | null) ?? null,
          snapshot: data["snapshot"] as string,
          createdBy: data["createdBy"] as string,
          createdAt: (data["createdAt"] as Date) ?? new Date(),
        };
        versions.push(row);
        return row;
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const ids = new Set((where["id"] as { in: string[] })["in"]);
        let n = 0;
        for (let i = versions.length - 1; i >= 0; i--) {
          if (ids.has(versions[i]!.id)) {
            versions.splice(i, 1);
            n += 1;
          }
        }
        return { count: n };
      },
    },
    view: {
      findUnique: async ({ where }: { where: { id: string } }) => views.find((v) => v.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const v = views.find((x) => x.id === where.id);
        if (!v) throw new Error("视图不存在");
        Object.assign(v, data);
        log.push(`view.update:${where.id}`);
        return v;
      },
    },
    field: {
      findMany: async (args: Record<string, unknown> = {}) =>
        fields.filter((f) => matchWhere(f, (args["where"] ?? {}) as Record<string, unknown>)),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const f = fields.find((x) => x.id === where.id);
        if (!f) throw new Error("字段不存在");
        Object.assign(f, data);
        log.push(`field.update:${where.id}:${Object.keys(data).sort().join(",")}`);
        return f;
      },
    },
  };
  return { client: client as unknown as DbTx, versions, views, fields, log };
}

/** 一个默认可用的 detail 视图（type=detail 才会留布局版本）。 */
export const VIEW: FakeView = { id: "vw1", tableId: "tb1", type: "detail", config: "{}" };
