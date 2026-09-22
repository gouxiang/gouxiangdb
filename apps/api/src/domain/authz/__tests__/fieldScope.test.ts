// apps/api/src/domain/authz/__tests__/fieldScope.test.ts
// 字段权限读侧的纯函数回归。
//
// 最要紧的不是"隐藏能生效"，而是"没配隐藏时一个字节都不许变"：
// 读出口是每次请求都走的热路径，若 fieldScopeOf 在无隐藏时也复制数组、也重写记录，
// 就是把所有用户的响应都改一遍——这条零变化契约必须由测试钉死。

import { describe, expect, it } from "vitest";
import type { LibraryAccessDTO } from "@gx/shared-types";
import { fieldScopeOf, stripHiddenFromRecords, stripHiddenKeys } from "../fieldScope.js";

function access(fields: Record<string, Record<string, "editable" | "visible" | "hidden">>): LibraryAccessDTO {
  return {
    visible: true, canManage: false, canDeleteLibrary: false, canToggleShare: false,
    source: "role_scope", tables: {}, fields,
  };
}

const T = "t1";
const FIELDS = [{ id: "f1" }, { id: "f2" }, { id: "f3" }];

describe("fieldScopeOf", () => {
  it("没配任何 hidden：active=false、数组是同一引用、可见集为空（调用方据此走原路径）", () => {
    const scope = fieldScopeOf(access({}), T, FIELDS);
    expect(scope.active).toBe(false);
    expect(scope.hiddenIds.size).toBe(0);
    expect(scope.fields).toBe(FIELDS);
  });

  it("只配了 editable/visible：同样 active=false（仅可见是写侧的事，读侧不该裁剪）", () => {
    const scope = fieldScopeOf(access({ [T]: { f1: "editable", f2: "visible" } }), T, FIELDS);
    expect(scope.active).toBe(false);
    expect(scope.fields).toBe(FIELDS);
  });

  it("配了 hidden：字段数组剔除它，可见集为其补集", () => {
    const scope = fieldScopeOf(access({ [T]: { f2: "hidden" } }), T, FIELDS);
    expect(scope.active).toBe(true);
    expect(scope.fields.map((f) => f.id)).toEqual(["f1", "f3"]);
    expect([...scope.visibleIds].sort()).toEqual(["f1", "f3"]);
    expect([...scope.hiddenIds]).toEqual(["f2"]);
  });

  it("没有裁决（access 为 null）：按无隐藏处理", () => {
    const scope = fieldScopeOf(null, T, FIELDS);
    expect(scope.active).toBe(false);
    expect(scope.fields).toBe(FIELDS);
  });
});

describe("抹键", () => {
  it("hiddenIds 为空时返回入参本体（不做无谓复制）", () => {
    const values = { f1: "a" };
    expect(stripHiddenKeys(values, new Set())).toBe(values);
    const records = [{ fields: values }];
    expect(stripHiddenFromRecords(records, new Set())).toBe(records);
  });

  it("抹掉隐藏键但不碰其它键，且不改入参对象", () => {
    const values = { f1: "a", f2: "b" };
    const out = stripHiddenKeys(values, new Set(["f2"]));
    expect(out).toEqual({ f1: "a" });
    expect(values).toEqual({ f1: "a", f2: "b" });
  });
});
