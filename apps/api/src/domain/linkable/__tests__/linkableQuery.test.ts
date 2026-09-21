// apps/api/src/domain/linkable/__tests__/linkableQuery.test.ts
// 关联选择器的可见性过滤单测：不可见的对象一律不出现在结果里（后端过滤，不靠前端）。

import { describe, it, expect, vi } from "vitest";
import type { LibraryAccessDTO, TableAccess } from "@gx/shared-types";

const scenario = {
  /** 用户能看见哪些库（libraryPolicy 的列表出口）。 */
  baseIds: ["b-visible"] as string[],
  kbIds: ["kb-visible"] as string[],
  /** 每张表/每个库内容在可见库内的读权限。 */
  tableRead: { "t-read": true, "t-noread": false } as Record<string, boolean>,
  contentRead: true as boolean,
};

const rows = {
  bases: [
    { id: "b-visible", name: "可见库", icon: null, iconColor: null },
    { id: "b-hidden", name: "不可见库", icon: null, iconColor: null },
  ],
  tables: [
    { id: "t-read", name: "可读表", icon: null, iconColor: null, baseId: "b-visible" },
    { id: "t-noread", name: "不可读表", icon: null, iconColor: null, baseId: "b-visible" },
    { id: "t-other", name: "别库的表", icon: null, iconColor: null, baseId: "b-hidden" },
  ],
  kbs: [
    { id: "kb-visible", name: "可见知识库", icon: null, iconColor: null },
    { id: "kb-hidden", name: "不可见知识库", icon: null, iconColor: null },
  ],
  docs: [
    { id: "d-read", kbId: "kb-visible", kind: "doc", title: "可见文档", parentId: null, updatedAt: new Date() },
    { id: "d-canvas", kbId: "kb-visible", kind: "canvas", title: "可见画布", parentId: "d-read", updatedAt: new Date() },
    { id: "d-other", kbId: "kb-hidden", kind: "doc", title: "别库的文档", parentId: null, updatedAt: new Date() },
  ],
};

// fake prisma：忠实执行 where.id.in / where.baseId.in，否则测不出"列表出口只给了可见库 id"。
function inIds<T extends { id: string }>(all: T[], where: Record<string, unknown>): T[] {
  const clause = where?.["id"] as { in?: string[] } | undefined;
  return clause?.in ? all.filter((r) => clause.in!.includes(r.id)) : all;
}

vi.mock("../../../db.js", () => ({
  prisma: {
    base: { findMany: ({ where }: { where: Record<string, unknown> }) => Promise.resolve(inIds(rows.bases, where)) },
    knowledgeBase: { findMany: ({ where }: { where: Record<string, unknown> }) => Promise.resolve(inIds(rows.kbs, where)) },
    table: {
      findMany: ({ where }: { where: Record<string, unknown> }) => {
        const clause = where?.["baseId"] as { in?: string[] } | undefined;
        return Promise.resolve(clause?.in ? rows.tables.filter((t) => clause.in!.includes(t.baseId)) : rows.tables);
      },
    },
    kbDoc: {
      findMany: ({ where }: { where: Record<string, unknown> }) => {
        const clause = where?.["kbId"] as { in?: string[] } | undefined;
        return Promise.resolve(clause?.in ? rows.docs.filter((d) => clause.in!.includes(d.kbId)) : rows.docs);
      },
    },
  },
}));

vi.mock("../../authz/libraryPolicy.js", () => {
  const accessOf = (_id: string): LibraryAccessDTO => ({
    visible: true,
    canManage: false,
    canDeleteLibrary: false,
    canToggleShare: false,
    source: "role_scope",
    tables: Object.fromEntries(
      Object.entries(scenario.tableRead).map(([k, v]) => [k, { read: v, create: v, update: false, delete: false } as TableAccess]),
    ),
    fields: {},
  });
  return {
    visibleLibraryIds: (_u: string, kind: string) => Promise.resolve({
      all: false,
      ids: kind === "base" ? scenario.baseIds : scenario.kbIds,
    }),
    resolveManyAccess: (_u: string, _kind: string, ids: string[]) =>
      Promise.resolve(new Map(ids.map((id) => [id, accessOf(id)]))),
    tableAccessOf: (access: LibraryAccessDTO, tableId: string) =>
      access.tables[tableId] ?? { read: false, create: false, update: false, delete: false },
    contentAccessOf: () => ({ read: scenario.contentRead, create: false, update: false, delete: false }),
  };
});

const { searchLinkable } = await import("../linkableQuery.js");

async function ids(q: { q?: string; types?: string[]; limit?: number }) {
  const r = await searchLinkable({
    userId: "u1",
    q: q.q ?? "",
    types: (q.types ?? []) as never,
    limit: q.limit ?? 50,
  });
  return r.items.map((i) => `${i.type}:${i.id}`);
}

describe("关联选择器按库权限过滤", () => {
  it("不可见的库不出现在结果里", async () => {
    const got = await ids({ types: ["base"] });
    expect(got).toContain("base:b-visible");
    expect(got).not.toContain("base:b-hidden");
  });

  it("库可见但该表不可读 -> 不出现（逐表权限生效，不是库级一把梭）", async () => {
    const got = await ids({ types: ["table"] });
    expect(got).toContain("table:t-read");
    expect(got).not.toContain("table:t-noread");
  });

  it("不可见库里的表连带不可见", async () => {
    const got = await ids({ types: ["table"] });
    expect(got).not.toContain("table:t-other");
  });

  it("不可见知识库与其文档/画布都不出现", async () => {
    const got = await ids({ types: ["kb", "doc", "canvas"] });
    expect(got).toContain("kb:kb-visible");
    expect(got).toContain("doc:d-read");
    expect(got).toContain("canvas:d-canvas");
    expect(got).not.toContain("kb:kb-hidden");
    expect(got).not.toContain("doc:d-other");
  });

  it("内容不可读时文档与画布全部不出现", async () => {
    scenario.contentRead = false;
    const got = await ids({ types: ["doc", "canvas"] });
    expect(got).toEqual([]);
    scenario.contentRead = true;
  });

  it("关键词过滤只在可见集合内生效", async () => {
    const got = await ids({ types: ["base", "table"], q: "可见" });
    expect(got).toEqual(["base:b-visible"]);
  });

  it("文档面包屑来自父链", async () => {
    const r = await searchLinkable({ userId: "u1", q: "可见画布", types: ["canvas"], limit: 50 });
    expect(r.items[0]?.path).toEqual(["可见文档"]);
  });

  it("超出 limit 只截断，不漏权限", async () => {
    const r = await searchLinkable({ userId: "u1", q: "", types: ["base"], limit: 1 });
    expect(r.items.length).toBe(1);
    expect(r.truncated).toBe(false);
  });
});
