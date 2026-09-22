// apps/api/src/domain/__tests__/formLayoutSnapshot.test.ts
// 布局快照信封的纯函数单测：构造 / 归一化 / 解析 / 回滚 SQL / 列缺失判定。
// 事务版（自动快照、裁剪、净化）在 formLayoutVersion.test.ts 与 formLayoutContent.test.ts。

import { describe, it, expect } from "vitest";
import {
  buildSnapshotEnvelope,
  extractSnapshot,
  isMissingTabsConfigColumn,
  normalizeTabs,
  normalizeTabsWithIssues,
  rollback_FORM_LAYOUT_VERSIONS,
  SNAPSHOT_ENVELOPE_VERSION,
} from "../formLayoutSnapshot.js";

describe("buildSnapshotEnvelope", () => {
  it("键序固定 + tabs 键升序，同一内容序列化结果确定", () => {
    const a = buildSnapshotEnvelope(null, { zz: { cards: ["f1"], lazyTouched: [] }, aa: { cards: [], lazyTouched: ["t1"] } });
    const b = buildSnapshotEnvelope(null, { aa: { cards: [], lazyTouched: ["t1"] }, zz: { cards: ["f1"], lazyTouched: [] } });
    expect(Object.keys(a)).toEqual(["version", "layout", "tabs"]);
    expect(Object.keys(a.tabs)).toEqual(["aa", "zz"]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.version).toBe(SNAPSHOT_ENVELOPE_VERSION);
  });

  it("非法入参降级为空布局/空 tabs，不抛错", () => {
    const env = buildSnapshotEnvelope("not-an-object", [{ x: 1 }]);
    expect(env.layout).toBeNull();
    expect(env.tabs).toEqual({});
  });

  it("cards 去重保序，非字符串丢弃", () => {
    const env = buildSnapshotEnvelope(null, { c1: { cards: ["f1", "f2", "f1", 7 as unknown as string, ""], lazyTouched: [] } });
    expect(env.tabs["c1"]!.cards).toEqual(["f1", "f2"]);
  });

  it("layout：非法 colCount/width 回退，widths 只留本行字段", () => {
    const env = buildSnapshotEnvelope(
      { defaultRowColumns: 9, rows: [{ colCount: 7, fieldIds: ["f1", "f2"], widths: { f1: 50, f2: 33, f9: 100 } }] },
      {},
    );
    expect(env.layout!.defaultRowColumns).toBe(2);
    expect(env.layout!.rows[0]!.colCount).toBe(2);
    expect(env.layout!.rows[0]!.widths).toEqual({ f1: 50 });
  });
});

describe("normalizeTabsWithIssues（防御：不静默归零）", () => {
  it("容器值发成裸数组 → 记为 not-object，不再静默变成 {}", () => {
    const bare = [{ id: "t1", name: "A", fieldIds: ["f1"] }];
    const { tabs, issues } = normalizeTabsWithIssues({ c1: bare });
    expect(tabs["c1"]).toEqual({ cards: [], lazyTouched: [] }); // 归一化结果照旧（向后兼容）
    expect(issues).toEqual([{ key: "c1", kind: "not-object" }]); // 但一定要报出来
  });

  it("字符串 / 数字 / 布尔同样记为 not-object", () => {
    for (const v of ["x", 1, true]) {
      expect(normalizeTabsWithIssues({ c1: v }).issues).toEqual([{ key: "c1", kind: "not-object" }]);
    }
  });

  it("null 视为空容器，不算可疑（合法语义）", () => {
    const { tabs, issues } = normalizeTabsWithIssues({ c1: null });
    expect(issues).toEqual([]);
    expect(tabs["c1"]).toEqual({ cards: [], lazyTouched: [] });
  });

  it("对象是空的（无 cards 也无 tabs）→ 记为 object-without-members", () => {
    expect(normalizeTabsWithIssues({ c1: {} }).issues).toEqual([{ key: "c1", kind: "object-without-members" }]);
  });

  it("正常容器（cards + tabs）零 issue，且 normalizeTabs 行为与旧版一致", () => {
    const value = { cards: ["f1"], lazyTouched: ["t1"], tabs: [{ id: "t1", name: "A", fieldIds: ["f1"] }] };
    const { tabs, issues } = normalizeTabsWithIssues({ c1: value });
    expect(issues).toEqual([]);
    expect(tabs).toEqual(normalizeTabs({ c1: value }));
    expect(tabs["c1"]!.tabs).toHaveLength(1);
  });
});

describe("extractSnapshot", () => {
  it("坏 JSON / 非对象 / 空串 → null", () => {
    expect(extractSnapshot("{oops")).toBeNull();
    expect(extractSnapshot("[1,2]")).toBeNull();
    expect(extractSnapshot("")).toBeNull();
    expect(extractSnapshot(null)).toBeNull();
  });

  it("正常信封往返一致", () => {
    const env = buildSnapshotEnvelope({ defaultRowColumns: 2, rows: [{ colCount: 1, fieldIds: ["f1"] }] }, { c1: { cards: ["f1"], lazyTouched: ["t1"] } });
    expect(extractSnapshot(JSON.stringify(env))).toEqual(env);
  });
});

describe("结构快照的确定性", () => {
  it("按固定键序重建，同一内容两次序列化结果一致", () => {
    const a = buildSnapshotEnvelope(null, { c1: { cards: [], lazyTouched: [], tabs: [{ name: "A", rows: [{ items: [{ widthPct: 25, fieldId: "f1" }] }], widths: { f1: 25 }, fieldIds: ["f1"], id: "t1" }] } });
    const b = buildSnapshotEnvelope(null, { c1: { tabs: [{ id: "t1", name: "A", fieldIds: ["f1"], widths: { f1: 25 }, rows: [{ items: [{ fieldId: "f1", widthPct: 25 }] }] }], lazyTouched: [], cards: [] } });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("isMissingTabsConfigColumn", () => {
  it("只认 tabsConfig + 缺失语义同时命中", () => {
    expect(isMissingTabsConfigColumn(new Error("The column `tabsConfig` does not exist"))).toBe(true);
    expect(isMissingTabsConfigColumn(new Error("no such column: tabsConfig"))).toBe(true);
    expect(isMissingTabsConfigColumn(new Error("Unknown argument `tabsConfig`"))).toBe(true);
    expect(isMissingTabsConfigColumn(new Error("SQLITE_BUSY: database is locked"))).toBe(false);
    expect(isMissingTabsConfigColumn(null)).toBe(false);
  });
});

describe("rollback_FORM_LAYOUT_VERSIONS", () => {
  it("先删索引再删表（否则 SQLite 上表删了索引还在会报错）", () => {
    const i1 = rollback_FORM_LAYOUT_VERSIONS.indexOf("DROP INDEX");
    const t = rollback_FORM_LAYOUT_VERSIONS.indexOf("DROP TABLE");
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(t).toBeGreaterThan(i1);
    expect(rollback_FORM_LAYOUT_VERSIONS).toContain("form_layout_versions");
    // 索引名必须与迁移实际建出来的一致（列名 camelCase，索引名随 model 字段名）：
    // 本表 @@map 只改表名，列名不加 @map，所以是 viewId 而不是 view_id。
    expect(rollback_FORM_LAYOUT_VERSIONS).toContain("form_layout_versions_viewId_version_key");
    expect(rollback_FORM_LAYOUT_VERSIONS).toContain("form_layout_versions_viewId_idx");
  });
});
