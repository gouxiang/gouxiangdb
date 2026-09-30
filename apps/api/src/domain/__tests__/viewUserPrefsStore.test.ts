// view_user_prefs 存储串解析与加载单测（#561）。
//
// 覆盖纪律：
//  - 形状纠偏（宽松）：坏数组/坏 filters/坏 aggregations/坏 search/坏 rowHeight/坏 groupByFieldId
//    一律回落默认形状，只挑已知键；
//  - 坏 JSON / 顶层非对象 fail-closed 上抛，不静默当默认；
//  - loadUserPrefs：无行 -> null，有行 -> 解析结果；client 为最小结构化接口。

import { describe, expect, it } from "vitest";
import {
  loadUserPrefs,
  parseViewUserPrefs,
  type ViewUserPrefClient,
} from "../viewUserPrefsStore.js";

describe("parseViewUserPrefs 形状纠偏", () => {
  it("空对象：全部键按默认补齐，version 恒为 1", () => {
    const p = parseViewUserPrefs("{}");
    expect(p).toEqual({
      version: 1,
      filters: null,
      sorts: [],
      search: "",
      rowHeight: "medium",
      collapsedGroupKeys: [],
      groupByFieldId: null,
      aggregations: {},
    });
  });

  it("合法全量值原样保留（未知键被丢弃）", () => {
    const p = parseViewUserPrefs(
      JSON.stringify({
        version: 1,
        filters: { kind: "condition", fieldId: "f1", op: "is", value: "x" },
        sorts: [{ fieldId: "f1", direction: "asc" }],
        search: "关键词",
        rowHeight: "tall",
        collapsedGroupKeys: ["g1"],
        groupByFieldId: "f2",
        aggregations: { f1: "sum", f2: null },
        bogus: 123,
      }),
    );
    expect(p.filters).toEqual({ kind: "condition", fieldId: "f1", op: "is", value: "x" });
    expect(p.sorts).toEqual([{ fieldId: "f1", direction: "asc" }]);
    expect(p.search).toBe("关键词");
    expect(p.rowHeight).toBe("tall");
    expect(p.collapsedGroupKeys).toEqual(["g1"]);
    expect(p.groupByFieldId).toBe("f2");
    expect(p.aggregations).toEqual({ f1: "sum", f2: null });
    expect(Object.keys(p)).not.toContain("bogus");
  });

  it("数组键非数组回落 []（sorts / collapsedGroupKeys）", () => {
    const p = parseViewUserPrefs(JSON.stringify({ sorts: "x", collapsedGroupKeys: 5 }));
    expect(p.sorts).toEqual([]);
    expect(p.collapsedGroupKeys).toEqual([]);
  });

  it("filters 非对象回落 null；合法对象保留", () => {
    expect(parseViewUserPrefs(JSON.stringify({ filters: [] })).filters).toBeNull();
    expect(parseViewUserPrefs(JSON.stringify({ filters: "x" })).filters).toBeNull();
    const node = { kind: "and", children: [] };
    expect(parseViewUserPrefs(JSON.stringify({ filters: node })).filters).toEqual(node);
  });

  it("aggregations 非对象回落 {}；非法枚举值回落 null，合法值保留", () => {
    expect(parseViewUserPrefs(JSON.stringify({ aggregations: [] })).aggregations).toEqual({});
    const p = parseViewUserPrefs(
      JSON.stringify({ aggregations: { a: "sum", b: "nope", c: 7, d: null } }),
    );
    expect(p.aggregations).toEqual({ a: "sum", b: null, c: null, d: null });
  });

  it("search 非字符串回落空串", () => {
    expect(parseViewUserPrefs(JSON.stringify({ search: 9 })).search).toBe("");
    expect(parseViewUserPrefs(JSON.stringify({ search: null })).search).toBe("");
  });

  it("rowHeight 非三档回落 medium", () => {
    expect(parseViewUserPrefs(JSON.stringify({ rowHeight: "huge" })).rowHeight).toBe("medium");
    expect(parseViewUserPrefs(JSON.stringify({ rowHeight: 1 })).rowHeight).toBe("medium");
    expect(parseViewUserPrefs(JSON.stringify({ rowHeight: "short" })).rowHeight).toBe("short");
    expect(parseViewUserPrefs(JSON.stringify({ rowHeight: "tall" })).rowHeight).toBe("tall");
  });

  it("groupByFieldId 非字符串回落 null", () => {
    expect(parseViewUserPrefs(JSON.stringify({ groupByFieldId: 9 })).groupByFieldId).toBeNull();
    expect(parseViewUserPrefs(JSON.stringify({ groupByFieldId: "f" })).groupByFieldId).toBe("f");
  });
});

describe("parseViewUserPrefs fail-closed", () => {
  it("坏 JSON 上抛，不静默回落默认", () => {
    expect(() => parseViewUserPrefs("{not json")).toThrow();
  });

  it("顶层非对象（数组/字符串/null）上抛", () => {
    expect(() => parseViewUserPrefs("[]")).toThrow("must be a JSON object");
    expect(() => parseViewUserPrefs('"x"')).toThrow("must be a JSON object");
    expect(() => parseViewUserPrefs("null")).toThrow("must be a JSON object");
  });
});

describe("loadUserPrefs", () => {
  function fakeClient(rows: Array<{ viewId: string; userId: string; prefs: string }>): ViewUserPrefClient {
    return {
      viewUserPref: {
        async findUnique(args: {
          where: { viewId_userId: { viewId: string; userId: string } };
        }) {
          const { viewId, userId } = args.where.viewId_userId;
          return rows.find((r) => r.viewId === viewId && r.userId === userId) ?? null;
        },
      },
    } as unknown as ViewUserPrefClient;
  }

  it("无 prefs 行 -> null（未自定义，跟随默认）", async () => {
    const r = await loadUserPrefs(fakeClient([]), "v1", "u1");
    expect(r).toBeNull();
  });

  it("有行 -> 按存储串解析", async () => {
    const client = fakeClient([
      { viewId: "v1", userId: "u1", prefs: JSON.stringify({ search: "我的" }) },
    ]);
    const r = await loadUserPrefs(client, "v1", "u1");
    expect(r?.search).toBe("我的");
    // 其他用户仍未自定义。
    expect(await loadUserPrefs(client, "v1", "u2")).toBeNull();
  });
});
