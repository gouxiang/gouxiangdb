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

  it("canShare=1 且 canManage=0：库节点含 manage_share/enter，但不含 manage_table（P1 越权反证）", () => {
    const policies = projectScopeRow(baseInput({ visible: 1, canShare: 1 }), SHAPE);
    const lib = policies.find((p) => p.nodeId === "nav_base_b1");
    expect(lib, "缺 base 节点投影").toBeDefined();
    const acts = parseActionString(lib!.actions);
    expect(acts.includes("manage_share")).toBe(true);
    expect(acts.includes("enter")).toBe(true);
    // manage_table 严格 iff canManage；只勾 canShare 不得拿到库管理权（§2.2 OVERALLOW 反证）。
    expect(acts.includes("manage_table")).toBe(false);
  });
});
