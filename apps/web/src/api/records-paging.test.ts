// S8 纯函数单测：能力探测降级、游标续翻判定、有界截断、400 分类、degraded 置灰判定。
import { describe, it, expect } from "vitest";
import {
  BOUNDED_PAGE_SIZE,
  GRID_PAGE_SIZE,
  GX_GROUP_BOUND,
  LINK_CANDIDATE_LIMIT,
  computeBounded,
  isAggregationRestricted,
  isComputedInMem,
  isPagingClientError,
  isPhysicalField,
  isSearchRestricted,
  isSortGroupRestricted,
  mergePages,
  pageHasMore,
  supportsKeyset,
} from "./records-paging";

function rec(id: string) {
  return { id };
}

function page(ids: string[], extra?: Partial<{ hasMore: boolean; nextCursor: string | null; degraded: string[] }>) {
  return { records: ids.map(rec), total: ids.length, filteredTotal: ids.length, ...extra };
}

describe("常量取值（M1 保守预览上限）", () => {
  it("GX_GROUP_BOUND=10000，页大小在服务端 1000 硬上限内", () => {
    expect(GX_GROUP_BOUND).toBe(10000);
    expect(BOUNDED_PAGE_SIZE).toBeLessThanOrEqual(1000);
    expect(GRID_PAGE_SIZE).toBe(200);
    expect(LINK_CANDIDATE_LIMIT).toBe(50);
  });
});

describe("supportsKeyset 能力探测（off 态必须为 false）", () => {
  it("undefined / null / 无 hasMore 键 → false", () => {
    expect(supportsKeyset(undefined)).toBe(false);
    expect(supportsKeyset(null)).toBe(false);
    // off 态服务端响应根本不含 hasMore 键
    expect(supportsKeyset(page(["a"]) as never)).toBe(false);
  });
  it("显式 hasMore=false（首页即末页，keyset on）→ true", () => {
    expect(supportsKeyset(page(["a"], { hasMore: false }) as never)).toBe(true);
    expect(supportsKeyset(page(["a"], { hasMore: true, nextCursor: "c1" }) as never)).toBe(true);
  });
});

describe("pageHasMore", () => {
  it("hasMore=true 但缺 nextCursor → 不可续翻", () => {
    expect(pageHasMore(page(["a"], { hasMore: true }) as never)).toBe(false);
  });
  it("hasMore=true 且有 nextCursor → 可续翻", () => {
    expect(pageHasMore(page(["a"], { hasMore: true, nextCursor: "tok" }) as never)).toBe(true);
  });
  it("off 态无键 → false", () => {
    expect(pageHasMore(page(["a"]) as never)).toBe(false);
  });
});

describe("mergePages 跨页去重保序", () => {
  it("边界行重叠时按 id 去重，保持首次出现顺序", () => {
    const merged = mergePages([page(["a", "b"]), page(["b", "c"]), page(["c", "d"])]);
    expect(merged.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("computeBounded 有界预览（两条后端形态）", () => {
  it("off 态：默认单页（<bound）、无 nextPage → bounded=false（零行为变化）", () => {
    const st = computeBounded([page(Array.from({ length: 200 }, (_, i) => `r${i}`))], false);
    expect(st.bounded).toBe(false);
    expect(st.records.length).toBe(200);
  });
  it("游标档累计达到 GX_GROUP_BOUND → bounded=true 并截断", () => {
    const ids = Array.from({ length: GX_GROUP_BOUND + 1 }, (_, i) => `r${i}`);
    const st = computeBounded([page(ids)], false);
    expect(st.bounded).toBe(true);
    expect(st.records.length).toBe(GX_GROUP_BOUND);
    expect(st.loadedCount).toBe(GX_GROUP_BOUND + 1);
  });
  it("游标档仍有未取页（未触顶）→ bounded=true", () => {
    const st = computeBounded([page(Array.from({ length: 1000 }, (_, i) => `r${i}`))], true);
    expect(st.bounded).toBe(true);
  });
});

describe("isPagingClientError 400 分类", () => {
  it("仅 400 触发回首页，其它状态码不拦截", () => {
    expect(isPagingClientError(400)).toBe(true);
    expect(isPagingClientError(401)).toBe(false);
    expect(isPagingClientError(404)).toBe(false);
    expect(isPagingClientError(500)).toBe(false);
  });
});

describe("isPhysicalField 物理下推口径（对齐后端 isIndexedField）", () => {
  it("计算/关联/附件/长正文/系统字段不可下推", () => {
    for (const t of ["formula", "lookup", "rollup", "count", "links", "attachment", "longText", "createdBy"] as const) {
      expect(isPhysicalField({ type: t })).toBe(false);
    }
  });
  it("普通物理字段可下推", () => {
    for (const t of ["number", "date", "singleSelect", "singleLineText", "checkbox", "rating"] as const) {
      expect(isPhysicalField({ type: t })).toBe(true);
    }
  });
  it("主字段即便物理类型是 longText 也可下推，但计算型主字段仍不可", () => {
    expect(isPhysicalField({ type: "longText", isPrimary: true })).toBe(true);
    expect(isPhysicalField({ type: "formula", isPrimary: true })).toBe(false);
  });
});

describe("degraded=computedInMem 置灰判定", () => {
  it("isComputedInMem 只认真实原因码", () => {
    expect(isComputedInMem(undefined)).toBe(false);
    expect(isComputedInMem([])).toBe(false);
    expect(isComputedInMem(["other"])).toBe(false);
    expect(isComputedInMem(["computedInMem"])).toBe(true);
  });
  it("无 degraded 时计算字段排序也不禁用（off 态零变化）", () => {
    expect(isSortGroupRestricted([], { type: "formula" })).toBe(false);
    expect(isSortGroupRestricted(undefined, { type: "formula" })).toBe(false);
  });
  it("degraded 时：非物理字段排序分组受限，物理字段不受限", () => {
    const d = ["computedInMem"];
    expect(isSortGroupRestricted(d, { type: "formula" })).toBe(true);
    expect(isSortGroupRestricted(d, { type: "links" })).toBe(true);
    expect(isSortGroupRestricted(d, { type: "number" })).toBe(false);
    expect(isSortGroupRestricted(d, { type: "singleSelect" })).toBe(false);
  });
  it("degraded 时聚合/搜索一律标记受限（整表口径无法按字段区分）", () => {
    expect(isAggregationRestricted(["computedInMem"])).toBe(true);
    expect(isAggregationRestricted([])).toBe(false);
    expect(isSearchRestricted(["computedInMem"])).toBe(true);
    expect(isSearchRestricted([])).toBe(false);
  });
});
