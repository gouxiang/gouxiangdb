// apps/web/src/api/__tests__/create-refresh.test.ts
// 建库/建表后「等关键列表 refetch 落地再 resolve」的竞态修复（同 #1006 删表跳转）。
//
// 手段：node 环境，用真实 QueryClient + QueryObserver 模拟「某列表正挂载」，
// 验证 await refreshXxx 返回时缓存确已刷新到新数据（而不是只 fire-and-forget 触发失效）。
// 若回归成 void invalidate（不 await），下面「返回时已落地」的断言会失败。

import { describe, it, expect } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { refreshAfterCreateBase, refreshAfterCreateTable } from "../create-refresh";

/** 挂载一个观察某 queryKey 的观察者，模拟页面上正渲染的列表；返回计数器与退订。 */
function mountList(
  qc: QueryClient,
  key: readonly unknown[],
  resolveValue: (n: number) => unknown,
) {
  let calls = 0;
  const observer = new QueryObserver(qc, {
    queryKey: key,
    queryFn: async () => {
      calls += 1;
      await Promise.resolve();
      return resolveValue(calls);
    },
  });
  const unsub = observer.subscribe(() => {});
  return {
    seed: () => observer.refetch(),
    unsub,
    get calls() {
      return calls;
    },
  };
}

describe("refreshAfterCreateBase", () => {
  it("await 结束时库列表已 refetch 落地（不是只触发失效）", async () => {
    const qc = new QueryClient();
    const bases = mountList(qc, ["bases"], (n) => [{ id: `base-v${n}` }]);
    await bases.seed();
    expect(qc.getQueryData(["bases"])).toEqual([{ id: "base-v1" }]);

    await refreshAfterCreateBase(qc);

    // 关键：promise resolve 时缓存已是新值，调用方此刻 navigate('/base/:newId') 不会读到旧列表
    expect(qc.getQueryData(["bases"])).toEqual([{ id: "base-v2" }]);
    expect(bases.calls).toBe(2);
    bases.unsub();
  });
});

describe("refreshAfterCreateTable", () => {
  it("await 结束时 tables / views / fields 三类缓存都已落地", async () => {
    const qc = new QueryClient();
    const tables = mountList(qc, ["tables", "b1"], (n) => [{ id: `t-v${n}` }]);
    const views = mountList(qc, ["views", "tNew"], (n) => [{ id: `v${n}` }]);
    const fields = mountList(qc, ["fields", "tNew"], (n) => [{ id: `f${n}` }]);
    await Promise.all([tables.seed(), views.seed(), fields.seed()]);

    await refreshAfterCreateTable(qc, "b1", "tNew");

    expect(qc.getQueryData(["tables", "b1"])).toEqual([{ id: "t-v2" }]);
    // TableIndexRedirect 读 views：空 views 会被误判为「无视图 → 跳设置页」，这里必须已就位
    expect(qc.getQueryData(["views", "tNew"])).toEqual([{ id: "v2" }]);
    expect(qc.getQueryData(["fields", "tNew"])).toEqual([{ id: "f2" }]);
    expect(views.calls).toBe(2);
    tables.unsub();
    views.unsub();
    fields.unsub();
  });

  it("没有挂载观察者时也正常 resolve（新表场景：导航后才挂载并 fresh fetch）", async () => {
    const qc = new QueryClient();
    await expect(refreshAfterCreateTable(qc, "bX", "tX")).resolves.toBeUndefined();
  });
});
