// apps/web/src/features/kb/__tests__/public-share-model.test.ts
// 公开分享三类分发的纯函数模型：类型守卫、渲染列、分页口径、库外壳可点表过滤、表路由。

import { describe, it, expect } from "vitest";
import type {
  PublicDocShareDTO,
  PublicTableShareDTO,
  PublicBaseShareDTO,
  PublicShareTableItem,
} from "../../../api/client";
import {
  isDocShare,
  isTableShare,
  isBaseShare,
  shareTableColumns,
  pagerModel,
  openableShareTables,
  baseTableHref,
} from "../public-share-model";

const doc: PublicDocShareDTO = {
  kind: "doc",
  rootToken: "tok",
  shareRole: "viewer",
  canEdit: false,
  requestedMode: "view",
  mode: "view",
  degraded: false,
  includeChildren: false,
  doc: { id: "d1", kind: "doc", title: "t", content: "c", canEdit: false },
  tree: [],
};

const table = {
  kind: "table",
  token: "ttok",
  mode: "view",
  requestedMode: "view",
  degraded: false,
  canEdit: false,
  table: { id: "t1", name: "T", icon: null, iconColor: null, primaryFieldId: "f1", baseId: "b1", baseName: "B" },
  view: null,
  fields: [{ id: "f1" }, { id: "f2" }],
  visibleFields: [{ id: "f1" }],
  records: [{ id: "r1", fields: { f1: "x" } }],
  total: 1,
  filteredTotal: 1,
  page: { limit: 50, offset: 0 },
} as unknown as PublicTableShareDTO;

const base: PublicBaseShareDTO = {
  kind: "base",
  token: "btok",
  mode: "view",
  canEdit: false,
  base: { id: "b1", name: "客户库" },
  tables: [],
};

describe("类型守卫：按 kind 三类分发", () => {
  it("kind=doc 或缺省 kind + doc 体 → 文档族", () => {
    expect(isDocShare(doc)).toBe(true);
    expect(isTableShare(doc)).toBe(false);
    expect(isBaseShare(doc)).toBe(false);

    const legacy = { ...doc };
    delete (legacy as Partial<PublicDocShareDTO>).kind;
    expect(isDocShare(legacy)).toBe(true);
  });

  it("kind=table → 表族", () => {
    expect(isTableShare(table)).toBe(true);
    expect(isDocShare(table)).toBe(false);
    expect(isBaseShare(table)).toBe(false);
  });

  it("kind=base → 库族", () => {
    expect(isBaseShare(base)).toBe(true);
    expect(isDocShare(base)).toBe(false);
    expect(isTableShare(base)).toBe(false);
  });

  it("undefined 三守卫全 false（fail-closed）", () => {
    expect(isDocShare(undefined)).toBe(false);
    expect(isTableShare(undefined)).toBe(false);
    expect(isBaseShare(undefined)).toBe(false);
  });
});

describe("shareTableColumns：可见列优先，空则回落全字段", () => {
  it("优先 visibleFields", () => {
    expect(shareTableColumns(table).map((f) => f.id)).toEqual(["f1"]);
  });
  it("visibleFields 缺失/空 → 回落 fields", () => {
    expect(shareTableColumns({ ...table, visibleFields: [] }).map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(
      shareTableColumns({ ...table, visibleFields: undefined as never }).map((f) => f.id),
    ).toEqual(["f1", "f2"]);
  });
});

describe("pagerModel：offset / size / 总数推导", () => {
  it("首页：1–50，可下一页不可上一页", () => {
    const p = pagerModel(0, 50, 120, 120);
    expect(p).toMatchObject({ from: 1, to: 50, count: 120, canPrev: false, canNext: true });
  });
  it("次页：51–100，双向可翻", () => {
    const p = pagerModel(50, 50, 120, 120);
    expect(p).toMatchObject({ from: 51, to: 100, canPrev: true, canNext: true });
  });
  it("末页：101–120，不可再下一页", () => {
    const p = pagerModel(100, 50, 120, 120);
    expect(p).toMatchObject({ from: 101, to: 120, canPrev: true, canNext: false });
  });
  it("空结果 from=0", () => {
    const p = pagerModel(0, 50, 0, 0);
    expect(p).toMatchObject({ from: 0, to: 0, count: 0, canNext: false });
  });
  it("filteredTotal 优先于 total（筛选 0 条不回落 total）", () => {
    const p = pagerModel(0, 50, 0, 300);
    expect(p.count).toBe(0);
    expect(p.canNext).toBe(false);
  });
});

describe("openableShareTables：只保留带 token 的表（fail-closed，不渲染不可点卡）", () => {
  it("过滤掉无 token / 空 token 的表", () => {
    const tables: PublicShareTableItem[] = [
      { id: "t1", name: "可看", icon: null, token: "tok1" },
      { id: "t2", name: "无 token 字段", icon: null },
      { id: "t3", name: "空 token", icon: null, token: "" },
    ];
    const out = openableShareTables(tables);
    expect(out.map((t) => t.id)).toEqual(["t1"]);
  });
});

describe("baseTableHref：库作用域单表路由", () => {
  it("拼出 /s/:baseToken/t/:tableId", () => {
    expect(baseTableHref("btok", "t9")).toBe("/s/btok/t/t9");
  });
});
