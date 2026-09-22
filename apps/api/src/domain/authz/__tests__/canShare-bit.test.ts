// apps/api/src/domain/authz/__tests__/canShare-bit.test.ts
// 锁住「可分享」独立位 canShare 与旧派生规则的关系。
//
// 为什么值得单独一个测试文件：分享权原先是 canManage 的派生（canToggleShare: canManage），
// 拆成独立列后判定改成 canManage || canShare。这个改动有两个方向都会出事，
// 且两个方向都不会有人立刻发现：
//   1. 写反成只看 canShare → 存量 canManage=1 / canShare=0 的行在升级后静默失去分享权。
//      收权方向错了没人会来报，只会表现为"我以前能开分享现在不能了"的零星困惑。
//   2. 顺手让 canShare 也带出 canManage / 通配表权限 → 等于凭空放权，
//      "让他分享"被实现成"让他改结构改数据"。
// 故本文件同时钉住放权方向（canManage 照旧有效）与收权方向（canShare 不给别的权）。

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
  it("canManage=1 且 canShare=0 仍可开分享：存量授权升级后不许静默收权", () => {
    expect(synthesizeAccess([row({ canManage: 1 })]).canToggleShare).toBe(true);
  });

  it("canManage=0 且 canShare=1 可开分享：这是本次新增的显式授予路径", () => {
    expect(synthesizeAccess([row({ canShare: 1 })]).canToggleShare).toBe(true);
  });

  it("两位都为 0 时不可开分享", () => {
    expect(synthesizeAccess([row()]).canToggleShare).toBe(false);
    expect(synthesizeAccess([row({ visible: 1 })]).canToggleShare).toBe(false);
  });

  it("多角色取并集：任一条带 canShare=1 即成立", () => {
    const merged = synthesizeAccess([row({ visible: 1 }), row({ canShare: 1 })]);
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
