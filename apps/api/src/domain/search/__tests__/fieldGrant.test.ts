// M5/S3 fieldGrant 纯函数表驱动测试（零 IO）：
// scope 内无 mask 全可见 / scope 内有 mask 仅白名单可见（identity 不受影响）/
// scope 外全不可见 / identity 恒可见 / 授权行仅展开 scope 内 mask 表 / 去重排序 / 可重放。

import { describe, expect, it } from "vitest";
import {
  buildFieldGrantRows,
  classifyChunks,
  isChunkAllowed,
  resolveFieldGrants,
  type ChunkVisibilityInput,
  type FieldChunkRegistration,
} from "../fieldGrant.js";

let rowidSeq = 0n;
function reg(tableNodeId: string, fieldId: string): FieldChunkRegistration {
  rowidSeq += 1n;
  return { chunkRowid: rowidSeq, tableNodeId, fieldId };
}

function cid(result: { chunkRowid: bigint }[]): bigint[] {
  return result.map((r) => r.chunkRowid);
}

describe("isChunkAllowed：§4.7 规则 4/7", () => {
  it("scope 内无 mask 表：identity 与全部 field 均可见", () => {
    const scope = new Set(["t1"]);
    expect(isChunkAllowed("t1", "identity", null, scope, {})).toBe(true);
    expect(isChunkAllowed("t1", "field", "f1", scope, {})).toBe(true);
    expect(isChunkAllowed("t1", "field", "f2", scope, {})).toBe(true);
  });

  it("scope 内有 mask 表：identity 恒可见，field 仅白名单可见", () => {
    const scope = new Set(["t1"]);
    const masks = { t1: ["f1", "f2"] };
    expect(isChunkAllowed("t1", "identity", null, scope, masks)).toBe(true);
    expect(isChunkAllowed("t1", "field", "f1", scope, masks)).toBe(true);
    expect(isChunkAllowed("t1", "field", "f2", scope, masks)).toBe(true);
    expect(isChunkAllowed("t1", "field", "secret", scope, masks)).toBe(false);
    // 空白名单 = 所有 field 不可见，但 identity 仍可见
    expect(isChunkAllowed("t1", "identity", null, scope, { t1: [] })).toBe(true);
    expect(isChunkAllowed("t1", "field", "f1", scope, { t1: [] })).toBe(false);
  });

  it("scope 外表：identity 与 field 全部不可见（即使无 mask / 在白名单）", () => {
    expect(isChunkAllowed("tX", "identity", null, new Set(["t1"]), {})).toBe(false);
    expect(isChunkAllowed("tX", "field", "f1", new Set(["t1"]), {})).toBe(false);
    expect(isChunkAllowed("tX", "field", "f1", new Set(["t1"]), { tX: ["f1"] })).toBe(false);
  });

  it("field chunk 缺 fieldId 且表有 mask 时不可见", () => {
    const scope = new Set(["t1"]);
    expect(isChunkAllowed("t1", "field", null, scope, { t1: ["f1"] })).toBe(false);
    expect(isChunkAllowed("t1", "field", undefined, scope, { t1: ["f1"] })).toBe(false);
  });

  it("一表有 mask 不影响另一无 mask 表（逐表独立）", () => {
    const scope = new Set(["t1", "t2"]);
    const masks = { t1: ["f1"] };
    expect(isChunkAllowed("t2", "field", "anything", scope, masks)).toBe(true);
    expect(isChunkAllowed("t1", "field", "f2", scope, masks)).toBe(false);
  });
});

describe("buildFieldGrantRows：temp_field_grant 物化行（§4.5 步骤 3）", () => {
  it("仅展开 scope 内 mask 表的白名单字段，(table,field) 确定序", () => {
    const rows = buildFieldGrantRows(new Set(["t1", "t2"]), {
      t1: ["f2", "f1", "f2"],
      t2: ["fa"],
    });
    expect(rows).toEqual([
      { tableNodeId: "t1", fieldId: "f1" },
      { tableNodeId: "t1", fieldId: "f2" },
      { tableNodeId: "t2", fieldId: "fa" },
    ]);
  });

  it("scope 外 mask 表不出任何行", () => {
    const rows = buildFieldGrantRows(new Set(["t1"]), { tX: ["f1", "f2"], t1: ["fa"] });
    expect(rows).toEqual([{ tableNodeId: "t1", fieldId: "fa" }]);
  });

  it("无 mask 表不出行（空表代表无字段收窄，召回 NOT EXISTS 分支放行）", () => {
    expect(buildFieldGrantRows(new Set(["t1", "t2"]), {})).toEqual([]);
  });

  it("空白名单表不出行（该表 field 全部由 NOT EXISTS 反判定为 masked——空集即不放行）", () => {
    // 空数组语义=仅白名单可见且白名单为空；物化零行与召回谓词配合：NOT EXISTS 为假、EXISTS 为假 -> field 不可见
    const rows = buildFieldGrantRows(new Set(["t1"]), { t1: [] });
    expect(rows).toEqual([]);
  });
});

describe("resolveFieldGrants：授权行 + 逐 field chunk 判定", () => {
  it("scope 内无 mask：登记表全部 field chunk 可见，grantRows 为空", () => {
    const regs = [reg("t1", "f1"), reg("t1", "f2"), reg("t1", "secret")];
    const res = resolveFieldGrants(new Set(["t1"]), {}, regs);
    expect(res.grantRows).toEqual([]);
    expect(res.fieldChunkVisibility.map((v) => v.visibility)).toEqual(["visible", "visible", "visible"]);
    expect(res.fieldChunkVisibility.every((v) => v.reason === null)).toBe(true);
  });

  it("scope 内有 mask：白名单字段可见，被 mask 字段 hidden 且 reason=field_masked", () => {
    const regs = [reg("t1", "f1"), reg("t1", "secret"), reg("t1", "f2")];
    const res = resolveFieldGrants(new Set(["t1"]), { t1: ["f1", "f2"] }, regs);
    expect(res.grantRows).toEqual([
      { tableNodeId: "t1", fieldId: "f1" },
      { tableNodeId: "t1", fieldId: "f2" },
    ]);
    expect(cid(res.fieldChunkVisibility)).toEqual(cid(regs)); // 顺序与登记一致
    expect(res.fieldChunkVisibility.map((v) => v.visibility)).toEqual(["visible", "hidden", "visible"]);
    expect(res.fieldChunkVisibility[1]).toMatchObject({ visibility: "hidden", reason: "field_masked" });
  });

  it("scope 外表登记：field chunk 全 hidden 且 reason=table_out_of_scope，授权行不含该表", () => {
    const regs = [reg("tX", "f1"), reg("t1", "f1")];
    const res = resolveFieldGrants(new Set(["t1"]), { tX: ["f1"] }, regs);
    expect(res.grantRows).toEqual([]);
    expect(res.fieldChunkVisibility.map((v) => v.visibility)).toEqual(["hidden", "visible"]);
    expect(res.fieldChunkVisibility[0].reason).toBe("table_out_of_scope");
    expect(res.fieldChunkVisibility[1].reason).toBeNull();
  });

  it("多表混合：mask 表/无 mask 表/scope 外表各自正确", () => {
    const regs = [
      reg("t1", "visible1"),
      reg("t1", "hidden1"),
      reg("t2", "any"),
      reg("tX", "any"),
    ];
    const res = resolveFieldGrants(
      new Set(["t1", "t2"]),
      { t1: ["visible1"], tX: ["any"] },
      regs,
    );
    expect(res.grantRows).toEqual([{ tableNodeId: "t1", fieldId: "visible1" }]);
    expect(res.fieldChunkVisibility.map((v) => v.visibility)).toEqual([
      "visible", "hidden", "visible", "hidden",
    ]);
    expect(res.fieldChunkVisibility.map((v) => v.reason)).toEqual([
      null, "field_masked", null, "table_out_of_scope",
    ]);
  });
});

describe("classifyChunks：identity + field 混合判定", () => {
  const chunks: ChunkVisibilityInput[] = [
    { chunkRowid: 1n, nodeId: "t1", chunkKind: "identity" },
    { chunkRowid: 2n, nodeId: "t1", chunkKind: "field", tableNodeId: "t1", fieldId: "f1" },
    { chunkRowid: 3n, nodeId: "t1", chunkKind: "field", tableNodeId: "t1", fieldId: "secret" },
    { chunkRowid: 4n, nodeId: "tX", chunkKind: "identity" },
    { chunkRowid: 5n, nodeId: "tX", chunkKind: "field", tableNodeId: "tX", fieldId: "f9" },
    { chunkRowid: 6n, nodeId: "t2", chunkKind: "identity" },
  ];

  it("mask 表 identity 不受影响、field 按白名单；scope 外 identity 也不可见", () => {
    const out = classifyChunks(chunks, new Set(["t1", "t2"]), { t1: ["f1"] });
    expect(out.map((r) => [Number(r.chunkRowid), r.visibility, r.reason])).toEqual([
      [1, "visible", null],            // mask 表 identity 恒可见
      [2, "visible", null],            // 白名单字段
      [3, "hidden", "field_masked"],   // 被 mask 字段
      [4, "hidden", "table_out_of_scope"], // scope 外 identity 也不可见
      [5, "hidden", "table_out_of_scope"],
      [6, "visible", null],            // 无 mask 表 identity
    ]);
  });

  it("field chunk 缺省 tableNodeId 时取 nodeId", () => {
    const out = classifyChunks(
      [{ chunkRowid: 9n, nodeId: "t1", chunkKind: "field", fieldId: "secret" }],
      new Set(["t1"]),
      { t1: ["f1"] },
    );
    expect(out[0]).toMatchObject({ visibility: "hidden", reason: "field_masked" });
  });
});

describe("确定性 / 纯函数", () => {
  it("登记乱序不影响 grantRows（恒按 table,field 排序），逐 chunk 判定保序", () => {
    const regsA = [reg("t1", "f1"), reg("t2", "fa"), reg("t1", "f2")];
    const regsB = [regsA[2], regsA[0], regsA[1]];
    const a = resolveFieldGrants(new Set(["t1", "t2"]), { t1: ["f2", "f1"], t2: ["fa"] }, regsA);
    const b = resolveFieldGrants(new Set(["t2", "t1"]), { t2: ["fa"], t1: ["f1", "f2"] }, regsB);
    expect(a.grantRows).toEqual(b.grantRows);
    // 逐 chunk 结果按各自输入顺序（内容相同，rowid 相同则判定相同）
    expect(
      b.fieldChunkVisibility.sort((x, y) => (x.chunkRowid < y.chunkRowid ? -1 : 1)),
    ).toEqual(a.fieldChunkVisibility);
  });

  it("不修改输入集合/数组", () => {
    const scope = new Set(["t1"]);
    const masks = { t1: ["f2", "f1"] };
    const regs = [reg("t1", "f1"), reg("t1", "f2")];
    const masksSnapshot = structuredClone(masks);
    resolveFieldGrants(scope, masks, regs);
    expect(masks).toEqual(masksSnapshot);
    expect(scope.size).toBe(1);
    expect(regs).toHaveLength(2);
  });

  it("bigint rowid 全程保号不丢精度", () => {
    const big = { chunkRowid: 9007199254740993n, nodeId: "t1", chunkKind: "field" as const, fieldId: "f1" };
    const out = classifyChunks([big], new Set(["t1"]), {});
    expect(out[0].chunkRowid).toBe(9007199254740993n);
  });
});
