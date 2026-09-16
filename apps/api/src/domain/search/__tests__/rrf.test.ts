// M5/S3 rrf 纯函数表驱动测试（零 IO）：
// 多路合并 / 权重 / 空路 / 同路去重 / topN / 确定性 tie-break 与乱序可重放。

import { describe, expect, it } from "vitest";
import { reciprocalRankFusion, type FusionInput } from "../rrf.js";

function route(routeName: string, pairs: Array<[string, string, number?]>, weight?: number): FusionInput {
  return {
    route: routeName,
    weight,
    hits: pairs.map(([entityType, entityId, rank]) => ({ entityType, entityId, rank })),
  };
}

function ids(cands: ReturnType<typeof reciprocalRankFusion>): string[] {
  return cands.map((c) => `${c.entityType}:${c.entityId}`);
}

describe("reciprocalRankFusion: 基础计分与合并", () => {
  it("三路命中同一实体：分数为各路 1/(k+rank) 等权之和（k=60）", () => {
    const out = reciprocalRankFusion([
      route("fts", [["record", "a", 1]]),
      route("vec", [["record", "a", 2]]),
      route("like", [["record", "a", 3]]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].score).toBeCloseTo(1 / 61 + 1 / 62 + 1 / 63, 12);
    expect(out[0].routes).toEqual(["fts", "like", "vec"]);
  });

  it("多路出现的实体排名高于仅单路出现的实体", () => {
    const out = reciprocalRankFusion([
      route("fts", [["record", "multi", 10], ["record", "onlyFts", 1]]),
      route("vec", [["record", "multi", 1]]),
    ]);
    expect(ids(out)).toEqual(["record:multi", "record:onlyFts"]);
  });

  it("缺省 rank 按数组下标 +1 计名", () => {
    const out = reciprocalRankFusion([{
      route: "fts",
      hits: [{ entityType: "doc", entityId: "d1" }, { entityType: "doc", entityId: "d2" }],
    }]);
    expect(out[0].entityId).toBe("d1");
    expect(out[0].contributions[0].rank).toBe(1);
    expect(out[1].contributions[0].rank).toBe(2);
  });

  it("k 可配：k 越大各路分差越被压平", () => {
    const inputs = [route("fts", [["record", "a", 1]]), route("fts", [["record", "b", 20]])];
    const k60 = reciprocalRankFusion(inputs, { k: 60 });
    const k1000 = reciprocalRankFusion(inputs, { k: 1000 });
    expect(k60[0].score - k60[1].score).toBeGreaterThan(k1000[0].score - k1000[1].score);
  });

  it("非法 k（0/负数/NaN）抛错", () => {
    expect(() => reciprocalRankFusion([], { k: 0 })).toThrow();
    expect(() => reciprocalRankFusion([], { k: -1 })).toThrow();
    expect(() => reciprocalRankFusion([], { k: Number.NaN })).toThrow();
  });

  it("非法 rank（0/负数/非整数）抛错", () => {
    expect(() => reciprocalRankFusion([route("fts", [["record", "a", 0]])])).toThrow();
    expect(() => reciprocalRankFusion([route("fts", [["record", "a", -2]])])).toThrow();
    expect(() => reciprocalRankFusion([route("fts", [["record", "a", 1.5]])])).toThrow();
  });

  it("非法 hit（缺 entityType/entityId）抛错而非静默丢弃", () => {
    expect(() => reciprocalRankFusion([{ route: "fts", hits: [{ entityType: "record" } as never] }])).toThrow();
    expect(() => reciprocalRankFusion([{ route: "fts", hits: [{ entityId: "x" } as never] }])).toThrow();
  });
});

describe("reciprocalRankFusion: 权重", () => {
  it("单路 weight 生效：2 权路贡献翻倍", () => {
    const out = reciprocalRankFusion([
      route("fts", [["record", "a", 1]], 2),
      route("vec", [["record", "a", 1]], 1),
    ]);
    expect(out[0].score).toBeCloseTo(2 / 61 + 1 / 61, 12);
    expect(out[0].contributions.find((c) => c.route === "fts")?.weight).toBe(2);
  });

  it("全局 weights 对未在单路声明权重的路生效", () => {
    const out = reciprocalRankFusion(
      [route("fts", [["record", "a", 1]]), route("like", [["record", "a", 1]])],
      { weights: { fts: 3, like: 1 } },
    );
    expect(out[0].score).toBeCloseTo(3 / 61 + 1 / 61, 12);
  });

  it("单路 weight 优先于全局 weights", () => {
    const out = reciprocalRankFusion(
      [route("fts", [["record", "a", 1]], 5)],
      { weights: { fts: 1 } },
    );
    expect(out[0].score).toBeCloseTo(5 / 61, 12);
  });

  it("0 权路：实体仍出现在候选但贡献为 0", () => {
    const out = reciprocalRankFusion([route("fts", [["record", "a", 1]], 0)]);
    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(0);
  });

  it("负权/非有限权重抛错", () => {
    expect(() => reciprocalRankFusion([route("fts", [["record", "a", 1]], -1)])).toThrow();
    expect(() => reciprocalRankFusion([route("fts", [["record", "a", 1]], Number.POSITIVE_INFINITY)])).toThrow();
  });
});

describe("reciprocalRankFusion: 空路与全空", () => {
  it("某路为空不影响其他路结果", () => {
    const out = reciprocalRankFusion([
      { route: "vec", hits: [] },
      route("fts", [["record", "a", 1], ["doc", "b", 2]]),
      { route: "like", hits: [] },
    ]);
    expect(ids(out)).toEqual(["record:a", "doc:b"]);
  });

  it("所有路为空（含零输入）返回空数组", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([{ route: "fts", hits: [] }])).toEqual([]);
  });
});

describe("reciprocalRankFusion: 同路去重", () => {
  it("同一路同一实体重复出现只保留最靠前名次", () => {
    const out = reciprocalRankFusion([{
      route: "fts",
      hits: [
        { entityType: "record", entityId: "a", rank: 5 },
        { entityType: "record", entityId: "a", rank: 2 },
        { entityType: "record", entityId: "a", rank: 9 },
      ],
    }]);
    expect(out).toHaveLength(1);
    expect(out[0].score).toBeCloseTo(1 / 62, 12);
    expect(out[0].contributions).toHaveLength(1);
    expect(out[0].contributions[0].rank).toBe(2);
  });
});

describe("reciprocalRankFusion: topN 截断", () => {
  const inputs: FusionInput[] = [route("fts", [
    ["record", "a", 1], ["record", "b", 2], ["record", "c", 3], ["record", "d", 4], ["record", "e", 5],
  ])];

  it("topN=3 只保留融合排序前 3", () => {
    expect(reciprocalRankFusion(inputs, { topN: 3 })).toHaveLength(3);
  });

  it("topN=0 返回空；topN 大于候选数不补位", () => {
    expect(reciprocalRankFusion(inputs, { topN: 0 })).toEqual([]);
    expect(reciprocalRankFusion(inputs, { topN: 99 })).toHaveLength(5);
  });

  it("非法 topN（负数/非整数）抛错", () => {
    expect(() => reciprocalRankFusion(inputs, { topN: -1 })).toThrow();
    expect(() => reciprocalRankFusion(inputs, { topN: 1.5 })).toThrow();
  });
});

describe("reciprocalRankFusion: 确定性与可重放", () => {
  const inputs: FusionInput[] = [
    route("vec", [["record", "z", 1], ["doc", "a", 1], ["canvas", "a", 1], ["record", "a", 1]]),
    route("fts", [["record", "a", 1], ["canvas", "a", 1]]),
    route("like", [["doc", "a", 1]]),
  ];

  it("完全同分时按 entityType 再 entityId 字典序 tie-break", () => {
    const out = reciprocalRankFusion([
      route("fts", [["record", "z", 1], ["doc", "m", 1], ["canvas", "x", 1]]),
    ]);
    expect(ids(out)).toEqual(["canvas:x", "doc:m", "record:z"]);
  });

  it("同实体内同分按 entityId 字典序", () => {
    const out = reciprocalRankFusion([
      route("fts", [["record", "b", 2], ["record", "a", 2]]),
    ]);
    expect(ids(out)).toEqual(["record:a", "record:b"]);
  });

  it("两次调用同输入产出深度一致结果", () => {
    const r1 = reciprocalRankFusion(inputs, { k: 60, topN: 3 });
    const r2 = reciprocalRankFusion(inputs, { k: 60, topN: 3 });
    expect(r1).toEqual(r2);
  });

  it("输入路序打乱不改变输出序列与分数", () => {
    const shuffled: FusionInput[] = [inputs[2], inputs[0], inputs[1]];
    const r1 = reciprocalRankFusion(inputs);
    const r2 = reciprocalRankFusion(shuffled);
    expect(r2).toEqual(r1);
    expect(ids(r2)).toEqual(ids(r1));
  });

  it("路内命中顺序打乱不改变结果（重复项取最小 rank）", () => {
    const a: FusionInput[] = [route("fts", [["record", "a", 1], ["record", "b", 2], ["record", "c", 3]])];
    const b: FusionInput[] = [route("fts", [["record", "c", 3], ["record", "a", 1], ["record", "b", 2]])];
    expect(reciprocalRankFusion(b)).toEqual(reciprocalRankFusion(a));
  });

  it("rawScore 仅透传：不同 rawScore 不影响融合顺序", () => {
    const r1 = reciprocalRankFusion([{
      route: "fts",
      hits: [{ entityType: "record", entityId: "a", rank: 1, rawScore: -9.2 }],
    }]);
    const r2 = reciprocalRankFusion([{
      route: "fts",
      hits: [{ entityType: "record", entityId: "a", rank: 1, rawScore: 123.7 }],
    }]);
    expect(r1[0].score).toBe(r2[0].score);
    expect(r1[0].rawScores.fts).toBe(-9.2);
    expect(r2[0].rawScores.fts).toBe(123.7);
  });
});
