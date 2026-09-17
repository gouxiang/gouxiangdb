// M5 搜索适配层纯函数测试：v1/legacy 归一、空 q like、degraded 多值中性文案、
// scopeTruncated 提示、404 回退分类、命中跳转路由。
import { describe, it, expect } from "vitest";
import type { GlobalDocHit, GlobalRecordHit } from "../../api/client";
import type { V1SearchResponse, V1SearchItem } from "@gx/shared-types";
import {
  hitHref,
  isV1NotFound,
  normalizeLegacy,
  normalizeV1,
  v1Notice,
} from "./search-adapter";

function v1Item(over: Partial<V1SearchItem> & { type: V1SearchItem["type"]; entityId: string }): V1SearchItem {
  return {
    nodeId: `node_${over.entityId}`,
    title: "标题",
    snippet: "摘要",
    score: 1,
    matchedVia: [],
    chunkSeq: null,
    matchedField: null,
    ...over,
  };
}

function v1Response(over: Partial<V1SearchResponse> = {}): V1SearchResponse {
  return {
    items: [],
    total: 0,
    limit: 20,
    mode: "hybrid",
    degraded: [],
    scopeTruncated: false,
    policyVersion: 1,
    ...over,
  };
}

const rec: GlobalRecordHit = {
  type: "record",
  baseId: "b1",
  baseName: "客户库",
  tableId: "t1",
  tableName: "客户表",
  recordId: "r1",
  title: "客户A",
  snippet: "片段",
  matchedField: "名称",
};
const doc: GlobalDocHit = {
  type: "doc",
  kbId: "k1",
  kbName: "知识库",
  docId: "d1",
  title: "文档1",
  snippet: "正文",
};

describe("normalizeLegacy 旧形状归一", () => {
  it("docs 在前 records 在后，fromV1=false 且无 notice", () => {
    const r = normalizeLegacy([rec], [doc]);
    expect(r.fromV1).toBe(false);
    expect(r.notice).toBeNull();
    expect(r.hits.map((h) => h.type)).toEqual(["doc", "record"]);
    expect(r.hits[0]).toMatchObject({ type: "doc", docId: "d1", kbId: "k1", matchedField: null });
    expect(r.hits[1]).toMatchObject({ type: "record", entityId: "r1", tableId: "t1", matchedField: "名称" });
  });

  it("canvas 旧命中归一为 canvas 类型", () => {
    const canvas: GlobalDocHit = { ...doc, type: "canvas", docId: "c1" };
    const r = normalizeLegacy([], [canvas]);
    expect(r.hits[0]!.type).toBe("canvas");
    expect(hitHref(r.hits[0]!)).toBe("/kb/k1/canvas/c1");
  });
});

describe("normalizeV1 统一检索归一", () => {
  it("record/item 上下文正确映射，fromV1=true", () => {
    const res = v1Response({
      items: [
        v1Item({
          type: "record",
          entityId: "r9",
          title: "R",
          baseId: "b9",
          baseName: "B",
          tableId: "t9",
          tableName: "T",
          matchedField: "手机",
        }),
      ],
    });
    const r = normalizeV1(res);
    expect(r.fromV1).toBe(true);
    expect(r.hits[0]).toMatchObject({
      type: "record",
      entityId: "r9",
      baseId: "b9",
      tableId: "t9",
      matchedField: "手机",
    });
    expect(hitHref(r.hits[0]!)).toBe("/base/b9/table/t9?record=r9");
  });

  it("doc/canvas 用 docId（缺失时回落 entityId）拼 kb 路由", () => {
    const res = v1Response({
      items: [
        v1Item({ type: "doc", entityId: "x1", kbId: "k1", docId: "doc-1" }),
        v1Item({ type: "canvas", entityId: "x2", kbId: "k1" }),
      ],
    });
    const r = normalizeV1(res);
    expect(hitHref(r.hits[0]!)).toBe("/kb/k1/doc/doc-1");
    expect(hitHref(r.hits[1]!)).toBe("/kb/k1/canvas/x2");
  });

  it("空 items + mode=like（空 q 短路响应）归一为空命中且无打扰 notice", () => {
    const r = normalizeV1(v1Response({ items: [], mode: "like", total: 0 }));
    expect(r.hits).toEqual([]);
    expect(r.notice).toBeNull();
  });
});

describe("v1Notice 中性文案（不泄露实现词）", () => {
  it("hybrid 无降级无截断 → null", () => {
    expect(v1Notice("hybrid", [], false)).toBeNull();
  });

  it("degraded 多值只给一条中性「关键词匹配」文案，不出现实现词", () => {
    const text = v1Notice("vector", ["vec_unavailable", "embedding_unhealthy"], false)!;
    expect(text).toBeTruthy();
    for (const banned of ["vec", "embedding", ".so", "sqlite", "endpoint", "向量", "嵌入"]) {
      expect(text.toLowerCase()).not.toContain(banned.toLowerCase());
    }
    expect(text).toContain("关键词匹配");
  });

  it("scopeTruncated=true 给截断提示", () => {
    const text = v1Notice("hybrid", [], true)!;
    expect(text).toContain("截断");
  });

  it("截断 + 降级同时出现，文案含两部分且无实现词", () => {
    const text = v1Notice("fts", ["dim_mismatch"], true)!;
    expect(text).toContain("截断");
    expect(text).toContain("关键词匹配");
  });
});

describe("isV1NotFound 404 回退分类", () => {
  it("404 + NOT_FOUND/无 code 视为未挂载可回退", () => {
    expect(isV1NotFound(404, "NOT_FOUND")).toBe(true);
    expect(isV1NotFound(404, undefined)).toBe(true);
  });
  it("404 其它 code（真实资源不存在）不回退；非 404 不回退", () => {
    expect(isV1NotFound(404, "SOME_OTHER")).toBe(false);
    expect(isV1NotFound(401)).toBe(false);
    expect(isV1NotFound(403)).toBe(false);
    expect(isV1NotFound(500)).toBe(false);
  });
});
