// apps/api/src/domain/authz/__tests__/canShare-bit.test.ts
// 锁住「可分享」独立位 canShare 与库级总闸开关权 canToggleShare 的【分家】语义。
//
// 为什么值得单独一个测试文件：这两枚判定都从同一个 canShare 列派生，一旦混用就会出现
// 两种都不会有人立刻发现的错：
//   1. 收权方向：写反成只看 canShare → 存量 canManage=1 / canShare=0 的行在升级后静默失去
//      分享权。收权方向错了没人会来报，只会表现为"我以前能发链接现在不能了"的零星困惑。
//   2. 放权方向：让 canShare 位带出总闸开关权 → "让他发链接"被实现成"让他决定这个库能不能
//      对外"，与硬规则 C（总闸权 = canManage）冲突；或让 canShare 带出 canManage / 通配表
//      权限 → 凭空放权成"能改结构改数据"。
// 故本文件同时钉住：放权方向（canManage 照旧有效）、收权方向（canShare 不给别的权）、
// 以及两枚判定各自独立的那一条分界线。

import { describe, expect, it, vi } from "vitest";

vi.mock("../../../db.js", () => ({
  prisma: { roleLibraryScope: { findMany: () => Promise.resolve([]) } },
  withWriteTx: (_label: string, fn: (t: unknown) => unknown) => Promise.resolve(fn({})),
}));

const { synthesizeAccess } = await import("../libraryPolicy.js");

type Row = { canManage: number; visible: number; canShare: number; config: string };

const EMPTY = '{"tables":{},"fields":{}}';
const row = (over: Partial<Row> = {}): Row => ({
  canManage: 0, visible: 0, canShare: 0, config: EMPTY, ...over,
});

describe("canShare 独立分享位", () => {
  it("canManage=1 且 canShare=0 仍可发链接：存量授权升级后不许静默收权", () => {
    const a = synthesizeAccess([row({ canManage: 1 })]);
    expect(a.canShare).toBe(true);
    expect(a.canToggleShare).toBe(true);
  });

  it("canManage=0 且 canShare=1 可发链接：这是本次新增的显式授予路径", () => {
    const a = synthesizeAccess([row({ canShare: 1 })]);
    expect(a.canShare).toBe(true);
  });

  it("★仅有 canShare 位时：canShare=true 但 canToggleShare=false（发链接 ≠ 动总闸）", () => {
    const a = synthesizeAccess([row({ visible: 1, canShare: 1 })]);
    expect(a.canShare, "被单独授予可分享的人必须能建/管分享链接").toBe(true);
    expect(a.canToggleShare, "总闸开关权归硬规则 C：只有 canManage 能带来它").toBe(false);
  });

  it("★仅有可见权（无 canShare、无 canManage）：两枚判定都为 false", () => {
    const a = synthesizeAccess([row({ visible: 1 })]);
    expect(a.visible).toBe(true);
    expect(a.canShare).toBe(false);
    expect(a.canToggleShare).toBe(false);
  });

  it("两位都为 0 时不可发链接也不可动总闸", () => {
    const a = synthesizeAccess([row()]);
    expect(a.canShare).toBe(false);
    expect(a.canToggleShare).toBe(false);
  });

  it("多角色取并集：任一条带 canShare=1 即能发链接，但仍动不了总闸", () => {
    const merged = synthesizeAccess([row({ visible: 1 }), row({ canShare: 1 })]);
    expect(merged.canShare).toBe(true);
    expect(merged.canToggleShare).toBe(false);
  });

  it("多角色取并集：任一条带 canManage=1 则两枚判定都成立", () => {
    const merged = synthesizeAccess([row({ visible: 1 }), row({ canManage: 1 })]);
    expect(merged.canShare).toBe(true);
    expect(merged.canToggleShare).toBe(true);
  });

  it("canShare 不隐含管理权：拿不到 canManage，也拿不到全表通配", () => {
    const a = synthesizeAccess([row({ canShare: 1 })]);
    expect(a.canManage).toBe(false);
    expect(a.canDeleteLibrary).toBe(false);
    expect(a.tables["*"], "分享权不得顺带放出全表权限").toBeUndefined();
  });

  it("canShare 不隐含可见：只勾可分享的人进不去这个库", () => {
    const a = synthesizeAccess([row({ canShare: 1 })]);
    expect(a.visible).toBe(false);
    expect(a.source).toBe("none");
  });

  it("canManage=1 依旧带出全表通配（既有行为不因本次拆列改变）", () => {
    const a = synthesizeAccess([row({ canManage: 1 })]);
    expect(a.tables["*"]).toEqual({ read: true, create: true, update: true, delete: true });
  });
});
