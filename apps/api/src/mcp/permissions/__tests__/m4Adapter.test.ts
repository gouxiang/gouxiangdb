// M6/S3 M4 适配层单测（真迁移临时库 + 真 M4 引擎/scope，无替身）。
//
// 夹具：user u1；NB(base b1) -> NT(table t1)（u1 持 r 且字段白名单 f1）、NB2(base b2，无策略不可见)。
// 断言：族可见集按 kind 归集；can 逐动作判定；不可见/不存在同口径 false；fieldCapability 白名单收窄。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createNavNodes, createPolicies, createUsers, setupEngineHarness, type EngineHarness,
} from "../../../domain/authz/__tests__/engineHarness.js";

let h: EngineHarness;
let adapter: typeof import("../m4Adapter.js");

const NB = "nav_base_b1", NT = "nav_table_t1", NB2 = "nav_base_b2";
// NB3 无策略（自身不可见），但其下的 NT2 有自己的字段白名单 -> 读来源只有窄源。
const NB3 = "nav_base_b3", NT2 = "nav_table_t2";

beforeAll(async () => {
  h = await setupEngineHarness("gx-m6-s3-adapter-");
  await createUsers(h.prisma, [{ id: "u1" }, { id: "u2" }]);
  await createNavNodes(h.prisma, [
    { id: NB, kind: "base", resourceType: "base", resourceId: "b1" },
    { id: NT, kind: "table", resourceType: "table", resourceId: "t1", parentId: NB },
    { id: NB2, kind: "base", resourceType: "base", resourceId: "b2" }, // 无策略 -> 不可见
    { id: NB3, kind: "base", resourceType: "base", resourceId: "b3" }, // 无策略 -> 不可见
    { id: NT2, kind: "table", resourceType: "table", resourceId: "t2", parentId: NB3 },
  ]);
  await createPolicies(h.prisma, [
    { id: "p_base", nodeId: NB, subjectType: "user", subjectId: "u1", actions: "r" },
    // 表级：r + 字段白名单（仅 f1 可见）
    { id: "p_table", nodeId: NT, subjectType: "user", subjectId: "u1", actions: "r", fieldMask: JSON.stringify({ allowFields: ["f1"] }) },
    // t2：整条链只有这一个读来源且带白名单 -> 真正的字段收窄
    { id: "p_table2", nodeId: NT2, subjectType: "user", subjectId: "u1", actions: "r", fieldMask: JSON.stringify({ allowFields: ["f1", "f2"] }) },
  ]);
  adapter = await import("../m4Adapter.js");
}, 120000);

afterAll(async () => { await h?.cleanup(); });

function port(userId: string, scopes: string[] = ["record:read"]) {
  return adapter.createMcpPermissionPort({ userId, patId: `pat_${userId}`, scopes: scopes as never });
}

describe("S3 闸门一：listAccessibleResources 按族归集可见资源", () => {
  it("table 族 -> byKind 含 base/table 且只含可见者（b2 不可见不出现）", async () => {
    const acc = await port("u1").listAccessibleResources("table");
    expect(acc.byKind.base).toEqual(["b1"]);
    expect(acc.byKind.table).toEqual(["t1", "t2"]);
    expect(acc.truncated).toBe(false);
  });

  it("doc/canvas 族为空（无相应可见资源）", async () => {
    expect((await port("u1").listAccessibleResources("doc")).byKind).toEqual({});
    expect((await port("u1").listAccessibleResources("canvas")).byKind).toEqual({});
  });

  it("无授权用户（u2）族为空", async () => {
    expect((await port("u2").listAccessibleResources("table")).byKind).toEqual({});
  });
});

describe("S3 闸门二：can 单资源逐动作判定", () => {
  it("可见且动作命中 -> true；动作未授予 -> false", async () => {
    const p = port("u1");
    expect(await p.can("r", { kind: "base", id: "b1" })).toBe(true);
    expect(await p.can("r", { kind: "table", id: "t1" })).toBe(true);
    expect(await p.can("u", { kind: "table", id: "t1" })).toBe(false); // 只授了 r
    expect(await p.can("d", { kind: "table", id: "t1" })).toBe(false);
  });

  it("不可见资源与不存在资源同口径 false（不泄漏存在性）", async () => {
    const p = port("u1");
    expect(await p.can("r", { kind: "base", id: "b2" })).toBe(false); // 存在但无权
    expect(await p.can("r", { kind: "base", id: "nonexistent" })).toBe(false);
    expect(await p.can("r", { kind: "doc", id: "b1" })).toBe(false); // 类型不符
  });
});

describe("S3 字段面：fieldCapability（schema 收窄 + 出参投影）", () => {
  it("整条链只有窄读来源 -> visibleFields 为白名单、visibleAll=false", async () => {
    const cap = await port("u1").fieldCapability(NT2);
    expect(cap.visible).toBe(true);
    expect(cap.visibleAll).toBe(false);
    expect(cap.visibleFields).toEqual(["f1", "f2"]);
  });

  it("祖先有宽读来源 -> 宽来源胜出（visibleAll=true、visibleFields=null）", async () => {
    // NT 的祖先 NB 授了无 mask 的 r，故并集为「全字段可见」——M4 §fieldMask 语义，此处锁定。
    const cap = await port("u1").fieldCapability(NT);
    expect(cap.visible).toBe(true);
    expect(cap.visibleAll).toBe(true);
    expect(cap.visibleFields).toBeNull();
  });

  it("节点不可见 -> visible=false（调用方直接 FORBIDDEN/剪枝）", async () => {
    const cap = await port("u2").fieldCapability(NT);
    expect(cap.visible).toBe(false);
    expect(cap.visibleFields).toBeNull();
  });
});
