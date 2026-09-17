// M5/S11 RRF 标题 boost 纯函数表驱动测试 + 小样标定（零 IO）。
//
// 依据 M5-implementation-plan §4.5 步骤 5：「每路 score += 1/(60+rank)；标题精确等于 q /
// 前缀命中加固定 boost（S11 小样标定常量）」。常量取值与标定依据见 docs/baseline/2026-09-17-m5-gate.md。
//
// 标尺：默认 k=60 时单路 rank=1 的 RRF 权重 = 1/(60+1) ≈ 0.016393。
//   TITLE_EXACT_BOOST = 0.016（≈0.98 个 rank-1 单位，严格小于一整个单位）
//   TITLE_PREFIX_BOOST = 0.008（exact 的一半）
// 保证：exact > prefix > 无加成；单路 rank-1 标题精确命中(0.0324) < 两路 rank-1 正文命中(0.0328)
// -> 不把多路正文强命中挤出。以下表驱动逐条钉死。

import { describe, expect, it } from "vitest";
import {
  reciprocalRankFusion,
  TITLE_EXACT_BOOST,
  TITLE_PREFIX_BOOST,
  type FusionInput,
} from "../rrf.js";

/** 构造一路命中，hit = [entityType, entityId, rank, title?]。 */
function route(name: string, hits: Array<[string, string, number?, string?]>, weight?: number): FusionInput {
  return {
    route: name,
    weight,
    hits: hits.map(([entityType, entityId, rank, title]) => ({ entityType, entityId, rank, title })),
  };
}

function scoreOf(out: ReturnType<typeof reciprocalRankFusion>, key: string): number {
  const c = out.find((x) => `${x.entityType}:${x.entityId}` === key);
  if (!c) throw new Error(`missing candidate ${key}`);
  return c.score;
}

describe("标题 boost 常量标定（与 1/(k+1) 单位的关系）", () => {
  it("常量恰为标定值，且均小于单路 rank-1 权重 1/(60+1)", () => {
    expect(TITLE_EXACT_BOOST).toBe(0.016);
    expect(TITLE_PREFIX_BOOST).toBe(0.008);
    expect(TITLE_PREFIX_BOOST).toBe(TITLE_EXACT_BOOST / 2);
    const rank1Unit = 1 / 61;
    expect(TITLE_EXACT_BOOST).toBeLessThan(rank1Unit);
    expect(TITLE_PREFIX_BOOST).toBeLessThan(TITLE_EXACT_BOOST);
  });

  it("非位移保证：单路 rank-1 标题精确命中 < 两路 rank-1 正文命中（不被顶掉）", () => {
    // 甲：标题精确命中，仅 fts rank1。
    const titleOnly = reciprocalRankFusion(
      [route("fts", [["doc", "t", 1, "季度报告"]])],
      { titleQuery: "季度报告" },
    );
    // 乙：无标题命中，但 fts rank1 + vec rank1（两路强命中）。
    const twoRoute = reciprocalRankFusion([
      route("fts", [["doc", "b", 1, "无关文档"]]),
      route("vec", [["doc", "b", 1, "无关文档"]]),
    ], { titleQuery: "季度报告" });
    expect(scoreOf(titleOnly, "doc:t")).toBeLessThan(scoreOf(twoRoute, "doc:b"));
    expect(scoreOf(titleOnly, "doc:t")).toBeCloseTo(1 / 61 + TITLE_EXACT_BOOST, 12);
    expect(scoreOf(twoRoute, "doc:b")).toBeCloseTo(2 / 61, 12);
  });
});

describe("标题 boost 三档单调与加成语义", () => {
  it("同一路同一 rank：精确 > 前缀 > 无标题命中", () => {
    const out = reciprocalRankFusion([
      route("fts", [
        ["record", "exact", 3, "项目计划"],
        ["record", "prefix", 3, "项目计划 / 里程碑"],
        ["record", "none", 3, "别的标题"],
      ]),
    ], { titleQuery: "项目计划" });
    const e = scoreOf(out, "record:exact");
    const p = scoreOf(out, "record:prefix");
    const n = scoreOf(out, "record:none");
    expect(e).toBeGreaterThan(p);
    expect(p).toBeGreaterThan(n);
    expect(e - p).toBeCloseTo(TITLE_EXACT_BOOST - TITLE_PREFIX_BOOST, 12);
    expect(p - n).toBeCloseTo(TITLE_PREFIX_BOOST, 12);
    const byId = (id: string) => out.find((x) => x.entityId === id)!.titleBoost;
    expect(byId("exact")).toBe(TITLE_EXACT_BOOST);
    expect(byId("prefix")).toBe(TITLE_PREFIX_BOOST);
    expect(byId("none")).toBe(0);
  });

  it("每实体至多加一次：跨路同标题只取一次（不是每路各加）", () => {
    const out = reciprocalRankFusion([
      route("fts", [["doc", "x", 1, "季度报告"]]),
      route("vec", [["doc", "x", 1, "季度报告"]]),
    ], { titleQuery: "季度报告" });
    expect(out[0].titleBoost).toBe(TITLE_EXACT_BOOST);
    expect(out[0].score).toBeCloseTo(2 / 61 + TITLE_EXACT_BOOST, 12);
  });

  it("同实体多命中取最大加成：exact 覆盖 prefix（与命中序无关）", () => {
    const hitsA: Array<[string, string, number?, string?]> = [
      ["doc", "x", 2, "季度报告 / 背景"],
      ["doc", "x", 5, "季度报告"],
    ];
    const fwd = reciprocalRankFusion([route("fts", hitsA)], { titleQuery: "季度报告" });
    const rev = reciprocalRankFusion([route("fts", [...hitsA].reverse())], { titleQuery: "季度报告" });
    expect(fwd[0].titleBoost).toBe(TITLE_EXACT_BOOST);
    expect(rev[0].titleBoost).toBe(TITLE_EXACT_BOOST);
    expect(fwd).toEqual(rev);
  });

  it("比较大小写不敏感且两端 trim", () => {
    const out = reciprocalRankFusion([
      route("fts", [
        ["doc", "a", 1, "  Quarterly Report  "],
        ["doc", "b", 1, "Quarterly Report / Detail"],
      ]),
    ], { titleQuery: "quarterly report" });
    expect(out.find((x) => x.entityId === "a")!.titleBoost).toBe(TITLE_EXACT_BOOST);
    expect(out.find((x) => x.entityId === "b")!.titleBoost).toBe(TITLE_PREFIX_BOOST);
  });

  it("titleQuery 为空/仅空白 -> 完全不加成（等价历史行为）", () => {
    const inputs = [
      route("fts", [["doc", "a", 1, "季度报告"]]),
      route("vec", [["doc", "b", 1, "季度报告"]]),
    ];
    const noOpt = reciprocalRankFusion(inputs);
    for (const q of ["", "   ", undefined]) {
      const withOpt = reciprocalRankFusion(inputs, { titleQuery: q });
      expect(withOpt.map((c) => c.score)).toEqual(noOpt.map((c) => c.score));
      expect(withOpt.map((c) => c.titleBoost)).toEqual([0, 0]);
    }
  });

  it("命中缺 title 字段时不加成、不抛错", () => {
    const out = reciprocalRankFusion([
      { route: "fts", hits: [{ entityType: "doc", entityId: "a", rank: 1 }] },
    ], { titleQuery: "季度报告" });
    expect(out[0].titleBoost).toBe(0);
    expect(out[0].score).toBeCloseTo(1 / 61, 12);
  });
});

describe("小样标定：确定性样本的融合排序结论", () => {
  // 确定性小样：查询 q=「季度报告」。含标题精确/前缀各一、正文单路、正文两路强命中、仅向量各一。
  const SAMPLE: FusionInput[] = [
    route("fts", [
      ["doc", "bodyStrong", 1, "无关文档标题"],       // 与 vec 同实体 -> 两路正文强命中
      ["doc", "prefixA", 2, "季度报告 / 背景"],        // 前缀命中 rank2（单路）
      ["doc", "exactWeak", 6, "季度报告"],             // 精确命中 rank6（名次弱，单路）
    ]),
    route("vec", [
      ["doc", "bodyStrong", 1, "无关文档标题"],        // 与 fts 同实体 -> 合成两路
      ["record", "veconly", 1, "rec_9"],               // 仅向量命中，标题为记录 id（不匹配）
    ]),
  ];

  it("排序：两路正文强命中 > 精确命中(弱名次) > 前缀命中(单路) > 仅向量(无标题)", () => {
    const out = reciprocalRankFusion(SAMPLE, { titleQuery: "季度报告" });
    expect(out.map((c) => `${c.entityType}:${c.entityId}`)).toEqual([
      "doc:bodyStrong",  // 1/61 + 1/61        ≈ 0.032787（两路正文，无标题加成）
      "doc:exactWeak",   // 1/66 + 0.016       ≈ 0.031152（单路 + 精确加成）
      "doc:prefixA",     // 1/62 + 0.008       ≈ 0.024129（单路 + 前缀加成）
      "record:veconly",  // 1/61               ≈ 0.016393（无标题加成）
    ]);
  });

  it("样本内非位移：两路正文强命中仍压过单路精确标题命中（boost 有界，不越级）", () => {
    const out = reciprocalRankFusion(SAMPLE, { titleQuery: "季度报告" });
    expect(scoreOf(out, "doc:bodyStrong")).toBeGreaterThan(scoreOf(out, "doc:exactWeak"));
    expect(scoreOf(out, "doc:bodyStrong")).toBeCloseTo(2 / 61, 12);
    expect(scoreOf(out, "doc:exactWeak")).toBeCloseTo(1 / 66 + TITLE_EXACT_BOOST, 12);
  });

  it("标题命中跨名次仍可压过更靠前的纯正文命中（精确 rank6 胜无标题向量 rank1）", () => {
    const out = reciprocalRankFusion(SAMPLE, { titleQuery: "季度报告" });
    expect(scoreOf(out, "doc:exactWeak")).toBeGreaterThan(scoreOf(out, "record:veconly"));
  });

  it("不相关的纯向量命中（标题为记录 id）不被顶到标题命中之前", () => {
    const out = reciprocalRankFusion(SAMPLE, { titleQuery: "季度报告" });
    const veconlyRank = out.findIndex((c) => c.entityId === "veconly");
    const exactRank = out.findIndex((c) => c.entityId === "exactWeak");
    expect(exactRank).toBeLessThan(veconlyRank);
  });

  it("可重放：样本路序打乱、命中序打乱，输出与分数不变", () => {
    const base = reciprocalRankFusion(SAMPLE, { titleQuery: "季度报告" });
    const shuffledRoutes: FusionInput[] = [
      { ...SAMPLE[1], hits: [...SAMPLE[1].hits].reverse() },
      { ...SAMPLE[0], hits: [...SAMPLE[0].hits].reverse() },
    ] as FusionInput[];
    const shuffled = reciprocalRankFusion(shuffledRoutes, { titleQuery: "季度报告" });
    expect(shuffled).toEqual(base);
  });
});

describe("标题 boost 与权重/截断的组合不破坏既有语义", () => {
  it("score == 各路贡献之和 + titleBoost", () => {
    const out = reciprocalRankFusion([
      route("fts", [["doc", "x", 2, "季度报告"]], 2),
      route("like", [["doc", "x", 4, "季度报告"]]),
    ], { titleQuery: "季度报告" });
    const c = out[0];
    const sum = c.contributions.reduce((a, k) => a + k.contribution, 0);
    expect(c.score).toBeCloseTo(sum + c.titleBoost, 12);
    expect(c.titleBoost).toBe(TITLE_EXACT_BOOST);
  });

  it("topN 截断发生在 boost 重排之后（标题命中被拉入 topN）", () => {
    const out = reciprocalRankFusion([
      route("fts", [
        ["doc", "body1", 1, "无关"],
        ["doc", "b2", 2, "无关"],
        ["doc", "b3", 3, "无关"],
        ["doc", "title", 4, "季度报告"],
      ]),
    ], { titleQuery: "季度报告", topN: 2 });
    expect(out.map((c) => c.entityId)).toEqual(["title", "body1"]);
  });
});
