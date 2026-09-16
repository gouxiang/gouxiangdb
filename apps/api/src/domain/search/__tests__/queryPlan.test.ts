// M5/S3 queryPlan 纯函数表驱动测试（零 IO）：
// 码元长度分流（ASCII/中文/混排/emoji/代理对/空格）、LIKE 与 FTS 转义参数化、
// 空查询 browse、entityType 白名单整数映射、KNN 必带 k、limit 上限。

import { describe, expect, it } from "vitest";
import {
  ALL_ENTITY_TYPES,
  ENTITY_TYPE_CODE,
  FTS_CODEPOINT_MIN,
  buildAllowedPredicate,
  buildFtsPhrase,
  buildLikePattern,
  buildSearchQueryPlan,
  codepointLength,
  escapeLikeLiteral,
  normalizeQuery,
} from "../queryPlan.js";

describe("codepointLength / normalizeQuery：码元口径", () => {
  const cases: Array<[string, number]> = [
    ["abc", 3],
    ["ab", 2],
    ["订单表", 3],
    ["订单", 2],
    ["a订单", 3],
    ["订a单", 3],
    // emoji 代理对：String.length=2，码点数=1
    ["😀", 1],
    ["😀😀", 2],
    // ZWJ 家族序列按码点数计（不合并簇），关键是不用 .length
    ["👨‍👩‍👧", 5],
    ["中😀a", 3],
  ];
  for (const [input, want] of cases) {
    it(`码点数 ${JSON.stringify(input)} = ${want}（非 .length=${input.length}）`, () => {
      expect(codepointLength(input)).toBe(want);
    });
  }

  it("trim 首尾空白（含全角不加裁，仅 String.trim 口径）", () => {
    expect(normalizeQuery("  abc  ")).toBe("abc");
    expect(normalizeQuery("\t\n订单 \n")).toBe("订单");
  });
});

describe("buildSearchQueryPlan：码元长度分流", () => {
  const strategyCases: Array<[string, "fts" | "like" | "browse", number]> = [
    ["abc", "fts", 3],
    ["abcd", "fts", 4],
    ["ab", "like", 2],
    ["a", "like", 1],
    ["订单表", "fts", 3],
    ["订单", "like", 2],
    ["中", "like", 1],
    ["a订单", "fts", 3],
    ["😀😀😀", "fts", 3],
    ["😀😀", "like", 2],
    ["", "browse", 0],
    ["   ", "browse", 0],
  ];
  for (const [q, strategy, len] of strategyCases) {
    it(`${JSON.stringify(q)} -> ${strategy}（len=${len}）`, () => {
      const plan = buildSearchQueryPlan(q);
      expect(plan.query).toBe(q.trim());
      expect(plan.codepointLength).toBe(len);
      expect(plan.strategy).toBe(strategy);
    });
  }

  it("FTS_CODEPOINT_MIN 常量为 3（H9 实测门槛）", () => {
    expect(FTS_CODEPOINT_MIN).toBe(3);
  });

  it(">=3 码元：fts 路启用、like 路为 null", () => {
    const plan = buildSearchQueryPlan("订单表");
    expect(plan.routes.fts).toBe(true);
    expect(plan.routes.like).toBe(false);
    expect(plan.fts).not.toBeNull();
    expect(plan.like).toBeNull();
    expect(plan.browse).toBeNull();
  });

  it("<3 码元：like 路启用、fts 路为 null", () => {
    const plan = buildSearchQueryPlan("订单");
    expect(plan.routes.like).toBe(true);
    expect(plan.routes.fts).toBe(false);
    expect(plan.like).not.toBeNull();
    expect(plan.fts).toBeNull();
  });

  it("空查询：browse 仅 identity 有界，fts/like/vector 全不启用", () => {
    const plan = buildSearchQueryPlan("   ");
    expect(plan.strategy).toBe("browse");
    expect(plan.routes).toEqual({ fts: false, like: false, vector: false, browse: true });
    expect(plan.browse?.identityOnly).toBe(true);
    expect(plan.browse?.bounded).toBe(true);
    expect(plan.browse?.sql).toContain("chunkKind = 'identity'");
    expect(plan.browse?.bindings).toEqual([100]);
    expect(plan.vector.enabled).toBe(false);
  });
});

describe("LIKE 转义：% _ \\ 全部按字面量，模式参数化", () => {
  const escCases: Array<[string, string]> = [
    ["abc", "abc"],
    ["100%", "100\\%"],
    ["a_b", "a\\_b"],
    ["back\\slash", "back\\\\slash"],
    ["%_\\", "\\%\\_\\\\"],
    ["50% off_a\\b", "50\\% off\\_a\\\\b"],
  ];
  for (const [input, want] of escCases) {
    it(`escapeLikeLiteral ${JSON.stringify(input)}`, () => {
      expect(escapeLikeLiteral(input)).toBe(want);
    });
    it(`buildLikePattern ${JSON.stringify(input)} 包裹通配符`, () => {
      expect(buildLikePattern(input)).toBe(`%${want}%`);
    });
  }

  it("短词 LIKE 计划：两绑定位同值、SQL 带 ESCAPE 反斜杠、无内插用户文本", () => {
    const plan = buildSearchQueryPlan("50");
    expect(plan.like?.sql).toBe("(c.title LIKE ? ESCAPE '\\' OR f.body LIKE ? ESCAPE '\\')");
    expect(plan.like?.bindings).toEqual(["%50%", "%50%"]);
    expect(plan.like?.sql).not.toContain("50");
  });

  it("元字符短查询：% 与 _ 进绑定而非 SQL，不构成通配注入", () => {
    for (const q of ["%", "_", "\\"]) {
      const plan = buildSearchQueryPlan(q);
      expect(plan.strategy).toBe("like");
      expect(plan.like?.sql).not.toContain(q === "\\" ? "\\\\" : q);
      expect(plan.like?.bindings[0]).toBe(buildLikePattern(q));
      expect(plan.like?.bindings[0].startsWith("%")).toBe(true);
      expect(plan.like?.bindings[0].endsWith("%")).toBe(true);
    }
  });
});

describe("FTS MATCH 短语：双引号包裹与翻倍，参数化", () => {
  const ftsCases: Array<[string, string]> = [
    ['abc', '"abc"'],
    ['a"b', '"a""b"'],
    ["he said \"hi\"", '"he said ""hi"""'],
    ["'; DROP TABLE x;--", '"\'; DROP TABLE x;--"'],
  ];
  for (const [input, want] of ftsCases) {
    it(`buildFtsPhrase ${JSON.stringify(input)}`, () => {
      expect(buildFtsPhrase(input)).toBe(want);
    });
  }

  it("fts 计划：MATCH 右值绑定短语，SQL 无用户文本内插", () => {
    const evil = '100"; DROP TABLE chunks;--';
    const plan = buildSearchQueryPlan(evil);
    expect(plan.strategy).toBe("fts");
    expect(plan.fts?.sql).toBe("fts_chunks MATCH ?");
    expect(plan.fts?.bindings).toEqual([buildFtsPhrase(evil)]);
    expect(plan.fts?.sql).not.toContain("DROP");
  });

  it("SQL 特殊字符组合 ' \" ; -- 在 >=3 码元时走 fts 且全部只在绑定中", () => {
    const q = `a';--"b`;
    const plan = buildSearchQueryPlan(q);
    expect(plan.strategy).toBe("fts");
    expect(plan.fts?.bindings[0]).toBe(buildFtsPhrase(q));
    expect(plan.allowed.bindings).toEqual([]);
  });

  it("2 码元中文且含特殊字符回 LIKE 并转义", () => {
    const plan = buildSearchQueryPlan("订_");
    expect(plan.strategy).toBe("like");
    expect(plan.like?.bindings[0]).toBe("%订\\_%");
  });
});

describe("entityType 白名单与整数映射", () => {
  it("整数映射 1=record 2=doc 3=canvas", () => {
    expect(ENTITY_TYPE_CODE).toEqual({ record: 1, doc: 2, canvas: 3 });
    expect(ALL_ENTITY_TYPES).toEqual(["record", "doc", "canvas"]);
  });

  it("type=all：三名 + 三码", () => {
    const plan = buildSearchQueryPlan("abc");
    expect(plan.entityTypes.names).toEqual(["record", "doc", "canvas"]);
    expect(plan.entityTypes.codes).toEqual([1, 2, 3]);
  });

  for (const t of ["record", "doc", "canvas"] as const) {
    it(`type=${t} 仅该类型名与码`, () => {
      const plan = buildSearchQueryPlan("abc", { type: t });
      expect(plan.entityTypes.names).toEqual([t]);
      expect(plan.entityTypes.codes).toEqual([ENTITY_TYPE_CODE[t]]);
      expect(plan.vector.entityTypeCodes).toEqual([ENTITY_TYPE_CODE[t]]);
    });
  }

  it("未知 type 抛错", () => {
    expect(() => buildSearchQueryPlan("abc", { type: "nope" as never })).toThrow();
  });
});

describe("vector 路计划：KNN 必带 k（H4）", () => {
  it("非空 auto：vector 启用且 k=perRoute（默认 100）", () => {
    const plan = buildSearchQueryPlan("语义检索测试");
    expect(plan.vector.enabled).toBe(true);
    expect(plan.vector.k).toBe(100);
    expect(plan.limits.perRoute).toBe(100);
  });

  it("mode=fts：vector 不启用，但 fts 关键词计划仍产出", () => {
    const plan = buildSearchQueryPlan("语义检索测试", { mode: "fts" });
    expect(plan.vector.enabled).toBe(false);
    expect(plan.routes.vector).toBe(false);
    expect(plan.routes.fts).toBe(true);
  });

  it("mode=vector：关键词 fts/like 路不启用，vector 启用", () => {
    const plan = buildSearchQueryPlan("语义检索测试", { mode: "vector" });
    expect(plan.routes.fts).toBe(false);
    expect(plan.routes.like).toBe(false);
    expect(plan.vector.enabled).toBe(true);
  });

  it("空查询即使 mode=vector 也不规划向量（无查询向量可算）", () => {
    const plan = buildSearchQueryPlan("", { mode: "vector" });
    expect(plan.vector.enabled).toBe(false);
    expect(plan.strategy).toBe("browse");
  });

  it("自定义 perRoute 透传给 KNN k 与 browse 绑定", () => {
    const plan = buildSearchQueryPlan("abc", { perRoute: 25 });
    expect(plan.vector.k).toBe(25);
    expect(plan.limits.perRoute).toBe(25);
    const browse = buildSearchQueryPlan("", { perRoute: 25 });
    expect(browse.browse?.bindings).toEqual([25]);
  });

  it("非法 perRoute/mode 抛错", () => {
    expect(() => buildSearchQueryPlan("abc", { perRoute: 0 })).toThrow();
    expect(() => buildSearchQueryPlan("abc", { perRoute: 1.5 })).toThrow();
    expect(() => buildSearchQueryPlan("abc", { mode: "bad" as never })).toThrow();
  });
});

describe("limit 收敛", () => {
  it("默认 finalTopN=20", () => {
    expect(buildSearchQueryPlan("abc").limits.finalTopN).toBe(20);
  });
  it("自定义 limit 透传", () => {
    expect(buildSearchQueryPlan("abc", { limit: 10 }).limits.finalTopN).toBe(10);
  });
  it("limit>50 收敛到 50（§9 硬上限）", () => {
    expect(buildSearchQueryPlan("abc", { limit: 500 }).limits.finalTopN).toBe(50);
  });
  it("非法 limit 抛错", () => {
    expect(() => buildSearchQueryPlan("abc", { limit: 0 })).toThrow();
    expect(() => buildSearchQueryPlan("abc", { limit: -3 })).toThrow();
  });
});

describe("allowed 谓词（§4.5 步骤 4a / §4.7）", () => {
  const pred = buildAllowedPredicate();
  it("identity 恒可见分支存在", () => {
    expect(pred.sql).toContain("c.chunkKind = 'identity'");
    expect(pred.identityAlwaysVisible).toBe(true);
  });
  it("无 mask 表（该表无授权行）NOT EXISTS 放行分支存在", () => {
    expect(pred.sql).toContain("NOT EXISTS");
    expect(pred.sql).toContain("g0.tableNodeId = c.nodeId");
  });
  it("白名单 EXISTS 命中分支存在且按 (tableNodeId,fieldId) 双键", () => {
    expect(pred.sql).toContain("EXISTS");
    expect(pred.sql).toContain("g.tableNodeId = c.nodeId");
    expect(pred.sql).toContain("g.fieldId = c.fieldId");
  });
  it("谓词零绑定零内插（表名固定）", () => {
    expect(pred.bindings).toEqual([]);
    expect(pred.grantTable).toBe("temp_field_grant");
  });
  it("每次产出独立对象（无共享可变状态）", () => {
    expect(buildAllowedPredicate()).toEqual(buildAllowedPredicate());
    expect(buildAllowedPredicate()).not.toBe(buildAllowedPredicate());
  });
});

describe("确定性：同输入同输出", () => {
  it("重复构建深度相等", () => {
    expect(buildSearchQueryPlan(" 订单表 ", { type: "record", limit: 30 }))
      .toEqual(buildSearchQueryPlan("订单表", { type: "record", limit: 30 }));
  });
});
