// M5/S7 shadow 对拍纯函数 + registry 单测（零 IO：直接构造新链 items / 旧链结果）。
//
// 覆盖派工 shadow 三态：
//  - drift=0：新旧命中实体集合/顺序一致 -> comparable、driftCount 0、不进 drift ring；
//  - drift：overDeny（旧有新无）/ overAllow（新有旧无）/ 共有实体相对顺序不一致 -> 计数与脱敏 ring；
//  - 不可比：hybrid/vector（向量新增能力）与空 q 整路跳过，comparable=false、driftCount 恒 0。
//
// 2026-09-17 总监裁决：strict 判据 = setDriftCount（集合漂移 overDeny+overAllow）；ORDER 降为观测
// （driftCount 仍含 ORDER，用于日志/registry）。本文件同时锁 setDriftCount 与 driftCount 两种语义。

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareSearchShadow,
  searchShadowRegistry,
  hashUser,
} from "../queryShadow.js";
import type { UnifiedSearchItem } from "../queryTypes.js";
import type { LegacySearchResult } from "../legacySearch.js";

function item(type: "record" | "doc" | "canvas", entityId: string): UnifiedSearchItem {
  return {
    type, entityId, nodeId: `nav_${type}_${entityId}`, title: entityId, snippet: "",
    score: 1, matchedVia: [], chunkSeq: null, matchedField: null,
  };
}

function legacy(records: string[], docs: Array<[string, "doc" | "canvas"]> = []): LegacySearchResult {
  return {
    records: records.map((id) => ({
      type: "record" as const, baseId: "b", baseName: "B", tableId: "t", tableName: "T",
      recordId: id, title: id, snippet: "", matchedField: "f",
    })),
    docs: docs.map(([id, kind]) => ({
      type: kind, kbId: "k", kbName: "K", docId: id, title: id, snippet: "",
    })),
    boundedPreview: true as const, previewLimit: 2000,
  };
}

afterEach(() => {
  searchShadowRegistry.reset();
  vi.restoreAllMocks();
});

describe("compareSearchShadow 可比集（两模式都 FTS/LIKE）", () => {
  it("集合与顺序一致 -> comparable、零漂移（两种计数均 0）", () => {
    const r = compareSearchShadow("fts", [item("record", "a"), item("record", "b")], legacy(["a", "b"]), true);
    expect(r.comparable).toBe(true);
    expect(r.overDeny).toEqual([]);
    expect(r.overAllow).toEqual([]);
    expect(r.orderDiffer).toBe(false);
    expect(r.setDriftCount).toBe(0);
    expect(r.driftCount).toBe(0);
  });

  it("overDeny：旧有新无（新链路更严/漏召回）-> setDriftCount>0（strict 判据）", () => {
    const r = compareSearchShadow("like", [item("record", "a")], legacy(["a", "b"]), true);
    expect(r.overDeny.map((k) => k.id)).toEqual(["b"]);
    expect(r.setDriftCount).toBe(1);
    expect(r.driftCount).toBe(1);
  });

  it("overAllow：新有旧无（新链路更宽/越过旧有界预览窗）-> setDriftCount>0（strict 判据）", () => {
    const r = compareSearchShadow("fts", [item("record", "a"), item("record", "c")], legacy(["a"]), true);
    expect(r.overAllow.map((k) => k.id)).toEqual(["c"]);
    expect(r.setDriftCount).toBe(1);
    expect(r.driftCount).toBe(1);
  });

  it("纯 ORDER 漂移：orderDiffer=true 但 setDriftCount=0（strict 不失败），driftCount=1（仅观测）", () => {
    // 旧 a,b；新 b,a：实体集合完全相同，仅相对顺序颠倒。
    const r = compareSearchShadow("fts", [item("record", "b"), item("record", "a")], legacy(["a", "b"]), true);
    expect(r.overDeny).toEqual([]);
    expect(r.overAllow).toEqual([]);
    expect(r.orderDiffer).toBe(true);
    expect(r.setDriftCount).toBe(0); // 集合零漂移 -> strict 判据为 0（不失败）
    expect(r.driftCount).toBe(1); // 观测总量含 ORDER
  });

  it("共有实体相对顺序不一致 -> order 计入 driftCount，集合漂移计入 setDriftCount", () => {
    // 旧 a,b；新 b,a,c：共有 a/b 相对顺序颠倒，c 是新独有只计 overAllow。
    const r = compareSearchShadow(
      "fts",
      [item("record", "b"), item("record", "a"), item("record", "c")],
      legacy(["a", "b"]),
      true,
    );
    expect(r.orderDiffer).toBe(true);
    expect(r.overAllow.map((k) => k.id)).toEqual(["c"]);
    expect(r.setDriftCount).toBe(1); // 仅 overAllow（ORDER 不计入 strict 判据）
    expect(r.driftCount).toBe(2); // overAllow 1 + order 1
  });

  it("record/doc 跨类型按 (type,id) 区分：同 id 不同类型不算同一实体", () => {
    const r = compareSearchShadow("fts", [item("doc", "x")], legacy([], [["x", "doc"]]), true);
    expect(r.driftCount).toBe(0); // doc x 对 doc x
    const r2 = compareSearchShadow("fts", [item("record", "x")], legacy([], [["x", "doc"]]), true);
    expect(r2.overAllow.length + r2.overDeny.length).toBe(2);
    expect(r2.setDriftCount).toBe(2);
  });
});

describe("compareSearchShadow 不可比集（跳过对拍）", () => {
  it("hybrid 路（向量参与）-> reason=vector_route、comparable=false、driftCount 恒 0", () => {
    const r = compareSearchShadow("hybrid", [item("record", "z")], legacy([]), true);
    expect(r.comparable).toBe(false);
    expect(r.reason).toBe("vector_route");
    expect(r.driftCount).toBe(0);
  });

  it("vector 路 -> vector_route 跳过", () => {
    const r = compareSearchShadow("vector", [item("record", "z")], legacy(["z"]), true);
    expect(r.comparable).toBe(false);
    expect(r.reason).toBe("vector_route");
  });

  it("空 q -> reason=empty_query、跳过", () => {
    const r = compareSearchShadow("like", [], legacy([]), false);
    expect(r.comparable).toBe(false);
    expect(r.reason).toBe("empty_query");
    expect(r.driftCount).toBe(0);
  });
});

describe("SearchShadowRegistry 计数与脱敏", () => {
  it("零漂移只累加 compared；drift 累加 drift/overAllow 并写脱敏 ring（只含 user hash）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    searchShadowRegistry.record(
      compareSearchShadow("fts", [item("record", "a")], legacy(["a"]), true), "u-secret",
    );
    const drift = compareSearchShadow("fts", [item("record", "c")], legacy([]), true);
    searchShadowRegistry.record(drift, "u-secret");

    const snap = searchShadowRegistry.snapshot();
    expect(snap.compared).toBe(2);
    expect(snap.drift).toBe(1);
    expect(snap.overAllow).toBe(1);
    expect(snap.recent).toHaveLength(1);
    // 日志/ring 不含明文 userId、不含 q/标题业务值；只含 12 位 hash。
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("[m5-search-shadow]");
    expect(logged).toContain(hashUser("u-secret"));
    expect(logged).not.toContain("u-secret");
    expect(snap.recent[0]!.userHash).toBe(hashUser("u-secret"));
  });

  it("不可比报告计入 skipped 而非 compared，不写 drift ring", () => {
    searchShadowRegistry.record(
      compareSearchShadow("hybrid", [item("record", "z")], legacy([]), true), "u",
    );
    const snap = searchShadowRegistry.snapshot();
    expect(snap.skipped).toBe(1);
    expect(snap.compared).toBe(0);
    expect(snap.recent).toEqual([]);
  });

  it("纯 ORDER 漂移仍被观测：计入 order 计数并 warn（但 setDriftCount=0，不触发 strict 失败）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = compareSearchShadow("fts", [item("record", "b"), item("record", "a")], legacy(["a", "b"]), true);
    expect(r.setDriftCount).toBe(0); // 集合零漂移
    searchShadowRegistry.record(r, "u-order");
    const snap = searchShadowRegistry.snapshot();
    expect(snap.compared).toBe(1);
    expect(snap.order).toBe(1); // ORDER 仍计数
    expect(snap.drift).toBe(1); // 观测总量含 ORDER
    expect(snap.overDeny).toBe(0);
    expect(snap.overAllow).toBe(0);
    expect(snap.recent).toHaveLength(1);
    expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("SHADOW_ORDER");
  });
});
