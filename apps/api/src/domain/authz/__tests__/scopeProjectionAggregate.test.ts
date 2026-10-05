// 库级聚合位 enter / edit_data 专项（ADR-0056 §4 / §9.2 定稿派工）。
// 从 scopeProjection.test.ts 拆出（单文件 ≤300 行硬门禁）：这两枚位是本次新增的派生位，
// 反证口径与逐值对拍不同，单独立 spec 便于架构师/判定层对齐时单独跑。
//
// 三条不变量的直接落点：
//   I1 派生而非手工维护 —— enter 只由库 visible/canManage 派生，零表库照样 emit；
//   I3 不改既有 manage_* 规则 —— canShare=1 & canManage=0 仍不得拿 manage_table；
//   I2 聚合位策略恒不带 fieldMask（由本文件之外的作用域测试覆盖）。

import { describe, expect, it } from "vitest";
import { parseActionString } from "@gx/shared-types";
import {
  projectScopeRow,
  tableActions,
  type LiveSchemaShape,
  type ScopeProjectionInput,
} from "../scopeProjection.js";
import { SHAPE } from "./scopeProjectionShape.js";

describe("库级聚合位 enter / edit_data", () => {
  const baseInput = (over: Partial<ScopeProjectionInput>): ScopeProjectionInput => ({
    roleId: "r1", libraryKind: "base", libraryId: "b1",
    canManage: 0, visible: 0, canShare: 0, config: "{}", ...over,
  });

  it("零表库：无活表也 emit base 节点 enter（库级准入不遍历表，覆盖空表库）", () => {
    const empty: LiveSchemaShape = { tableIds: [], fieldIdsByTable: new Map() };
    const policies = projectScopeRow(baseInput({ visible: 1 }), empty);
    expect(policies).toHaveLength(1);
    expect(policies[0]!.nodeId).toBe("nav_base_b1");
    const acts = parseActionString(policies[0]!.actions);
    expect(acts).toEqual(["enter"]); // 仅准入位；零表无可写 -> 无 edit_data
  });

  it("canShare=1 且 canManage=0：库节点仅 enter，不含 manage_share/manage_table（toggle overallow 反证）", () => {
    const policies = projectScopeRow(baseInput({ visible: 1, canShare: 1 }), SHAPE);
    const lib = policies.find((p) => p.nodeId === "nav_base_b1");
    expect(lib, "缺 base 节点投影").toBeDefined();
    const acts = parseActionString(lib!.actions);
    expect(acts.includes("enter")).toBe(true);
    // manage_share 被 requireCanToggleShare 读取，语义=legacy canToggleShare(=canManage)；
    // 仅 canShare 不得拿该位，否则开关分享总闸 overallow（on-guard-exhaustive canShareOnly）。
    expect(acts.includes("manage_share")).toBe(false);
    // manage_table 严格 iff canManage；只勾 canShare 不得拿到库管理权。
    expect(acts.includes("manage_table")).toBe(false);
  });
});

// ---------- 通配表配置 tables["*"] ----------
// legacy tableAccessOf 是【通配优先 -> 精确 -> 库级默认】（libraryPolicy.ts:68-73），
// 投影侧若只做精确查找，配了 "*" 的角色在通电后会被判成只有 r：legacy 给全表 c/u/d、
// 投影一份写权都不给 -> OVERDENY，且库节点 edit_data 因 anyTableWritable 恒 false 也算错。
// 本机 203 条 scope 行实测 0 条通配配置（潜伏缺口），故此处必须由测试钉死，不能靠数据证明。
describe("通配表配置 tables['*'] 与 legacy tableAccessOf 同口径", () => {
  const input = (config: string): ScopeProjectionInput => ({
    roleId: "r1", libraryKind: "base", libraryId: "b1",
    canManage: 0, visible: 1, canShare: 0, config,
  });
  const wildcard = JSON.stringify({ tables: { "*": { create: true, update: true } }, fields: {} });

  it("通配命中：未逐表配置的表也拿到 c/u（不是只有 r）", () => {
    const { actions } = tableActions(input(wildcard), "t1");
    expect(actions).toContain("c");
    expect(actions).toContain("u");
    expect(actions).toContain("comment"); // comment 跟随 c/u/d
    // 逐值对齐：同形状下第二代表达即 r,c,u,comment（delete 未配）
    expect(actions).toEqual(["r", "c", "u", "comment"]);
  });

  it("通配优先于精确：精确条目不覆盖通配（与 tableAccessOf 同一顺序）", () => {
    const both = JSON.stringify({
      tables: { "*": { create: true }, t1: { delete: true } }, fields: {},
    });
    // 通配命中即返回，t1 的精确条目不生效——逐字复现 legacy，不做"合并"。
    expect(tableActions(input(both), "t1").actions).toEqual(["r", "c", "comment"]);
  });

  it("库节点 edit_data 由通配推导：全表可写 -> 库可写", () => {
    const policies = projectScopeRow(input(wildcard), SHAPE);
    const lib = policies.find((p) => p.nodeId === "nav_base_b1");
    expect(lib).toBeDefined();
    const acts = parseActionString(lib!.actions);
    // 若不通配，anyTableWritable 恒 false -> edit_data 缺失 -> 与 legacy canEditData 不等价
    expect(acts).toContain("edit_data");
    expect(acts).toContain("enter");
  });
});
