// apps/api/src/domain/authz/__tests__/library-share-toggle.test.ts
// 锁住「库级允许分享」总闸的同步语义。
//
// 为什么值得单独一个测试文件：表级 shareEnabled 至今**没有任何写入口**
// （setTableShareEnabled 没有暴露路由），而 tableShareAllowed() 要求库级 && 表级都为 1。
// 于是「只改库级、不同步表级」会让数据表分享永久 403，且界面上找不到能打开它的地方——
// 功能等于不可用，却没有任何测试会红。这条断裂曾真实存在于代码里，故必须由测试钉住。

import { describe, it, expect, vi, beforeEach } from "vitest";

const txCalls = {
  base: [] as Array<{ where: { id: string }; data: { shareEnabled: number } }>,
  table: [] as Array<{ where: Record<string, unknown>; data: { shareEnabled: number } }>,
  kb: [] as Array<{ where: { id: string }; data: { shareEnabled: number } }>,
};

const tx = {
  base: { update: (a: (typeof txCalls)["base"][number]) => { txCalls.base.push(a); return Promise.resolve({}); } },
  table: { updateMany: (a: (typeof txCalls)["table"][number]) => { txCalls.table.push(a); return Promise.resolve({ count: 3 }); } },
  knowledgeBase: { update: (a: (typeof txCalls)["kb"][number]) => { txCalls.kb.push(a); return Promise.resolve({}); } },
};

vi.mock("../../../db.js", () => ({
  prisma: {
    knowledgeBase: { update: (a: (typeof txCalls)["kb"][number]) => { txCalls.kb.push(a); return Promise.resolve({}); } },
  },
  // 事务体直接用同一个记录对象，便于断言「库级与表级写在同一个事务里」。
  withWriteTx: (_label: string, fn: (t: unknown) => unknown) => Promise.resolve(fn(tx)),
}));

const { setShareEnabled } = await import("../libraryVisibility.js");

beforeEach(() => {
  txCalls.base.length = 0;
  txCalls.table.length = 0;
  txCalls.kb.length = 0;
});

describe("库级「允许分享」总闸", () => {
  it("打开库级时把库内所有表一起打开（否则表分享永远 403）", async () => {
    await setShareEnabled("base", "b1", true);

    expect(txCalls.base).toHaveLength(1);
    expect(txCalls.base[0]).toEqual({ where: { id: "b1" }, data: { shareEnabled: 1 } });

    const t = txCalls.table[0];
    expect(t, "库级开关必须同步表级，否则表分享无入口可开").toBeTruthy();
    expect(t.data).toEqual({ shareEnabled: 1 });
    expect(t.where.baseId).toBe("b1");
    // 回收站里的表不该被总闸悄悄改动
    expect(t.where.deletedAt).toBe(null);
  });

  it("关闭库级时同样把表级同步为 0", async () => {
    await setShareEnabled("base", "b1", false);
    expect(txCalls.base[0].data).toEqual({ shareEnabled: 0 });
    expect(txCalls.table[0].data).toEqual({ shareEnabled: 0 });
  });

  it("知识库没有表这一级，不触碰 tables", async () => {
    await setShareEnabled("kb", "k1", true);
    expect(txCalls.kb[0]).toEqual({ where: { id: "k1" }, data: { shareEnabled: 1 } });
    expect(txCalls.table).toHaveLength(0);
    expect(txCalls.base).toHaveLength(0);
  });
});
