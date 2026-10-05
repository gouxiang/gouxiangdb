// P1/S2 scopeProjection 稀疏条目（API-only 形状）取舍测试。
//
// 稀疏条目（API 直发、UI 不产生：缺 read 的 tables 项）是第二代号与投影规则的已知分叉点：
//   第二代 tableAccessOf 对精确条目原样返回（{update:true} -> read=false），
//   而 P1 §4.4/§4.7 规定 visible=1 即以只读基线 r 起、逐表叠加增量（-> r,u）。
// 真实 UI 落库条目恒含 read=true（library-scope-draft.toggleTable），故实际数据两轨一致；
// 本文件锁定投影在稀疏输入上的有意取舍。

import { describe, expect, it } from "vitest";
import { parseActionString } from "@gx/shared-types";
import {
  projectScopeRow,
  type ScopeProjectionInput,
} from "../scopeProjection.js";
import { SHAPE } from "./scopeProjectionShape.js";

describe("projectScopeRow 稀疏条目（API-only 形状）按 §4.4 有意取舍", () => {
  it("base：{t:{update:true}} 缺 read -> 投影仍给基线 r（comment,r,u）", () => {
    const row: ScopeProjectionInput = {
      roleId: "r1", libraryKind: "base", libraryId: "b1",
      canManage: 0, visible: 1, canShare: 0,
      config: JSON.stringify({ tables: { t2: { update: true } } }),
    };
    const policy = projectScopeRow(row, SHAPE).find((p) => p.nodeId === "nav_table_t2");
    expect(policy).toBeDefined();
    expect(parseActionString(policy!.actions)).toEqual(["comment", "r", "u"]);
  });

  it("base：visible=0 即使 tables 有增量也不出表行", () => {
    const row: ScopeProjectionInput = {
      roleId: "r1", libraryKind: "base", libraryId: "b1",
      canManage: 0, visible: 0, canShare: 0,
      config: JSON.stringify({ tables: { t1: { create: true } } }),
    };
    expect(projectScopeRow(row, SHAPE)).toEqual([]);
  });

  it("kb：visible=0 canShare=1 content 有增量 -> 零投影（visible=0 表动作空集，canShare 不投影 manage_share）", () => {
    const row: ScopeProjectionInput = {
      roleId: "r1", libraryKind: "kb", libraryId: "k9",
      canManage: 0, visible: 0, canShare: 1,
      config: JSON.stringify({ tables: { content: { delete: true } } }),
    };
    expect(projectScopeRow(row, SHAPE)).toEqual([]);
  });
});
