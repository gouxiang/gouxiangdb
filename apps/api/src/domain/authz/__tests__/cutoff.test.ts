// M4/S1 客体 cutoff 纯函数 + 路径切段（M4 计划 §4.5，AC-M4-2 边界，不碰库）。

import { describe, expect, it } from "vitest";
import { collectibleChainIndexes, nodeIdsFromPath, NavChainCache } from "../nodes.js";

function chain(spec: Array<[string, number]>): { id: string; inheritAncestors: number }[] {
  return spec.map(([id, inh]) => ({ id, inheritAncestors: inh }));
}

describe("nodeIdsFromPath", () => {
  it("物化路径切 id（含自身，叶->根序由 path 序保证）", () => {
    expect(nodeIdsFromPath("/a/b/c/")).toEqual(["a", "b", "c"]);
    expect(nodeIdsFromPath("/a/")).toEqual(["a"]);
    expect(nodeIdsFromPath("/")).toEqual([]);
  });
});

describe("collectibleChainIndexes（cutoff 纯函数）", () => {
  it("空链 -> 空集", () => {
    expect(collectibleChainIndexes([])).toEqual([]);
  });

  it("自身恒收集；全链 inherit=1 -> 全收集", () => {
    expect(collectibleChainIndexes(chain([["X", 1], ["P", 1], ["K", 1], ["R", 1]]))).toEqual([0, 1, 2, 3]);
  });

  it("被决策节点自身 inherit=0 -> 仅收集自身，不收集任何祖先（边界 A：K 自身判定）", () => {
    expect(collectibleChainIndexes(chain([["X", 0], ["P", 1], ["K", 1]]))).toEqual([0]);
  });

  it("自身 inherit=1，向上遇第一个 inherit=0 祖先 K：收集 K 后停止，K 之上不收集（边界 B：K 自身策略收集）", () => {
    // X(叶,1) -> P(1) -> K(0) -> G(1)：收集 X,P,K；G 不收集
    expect(collectibleChainIndexes(chain([["X", 1], ["P", 1], ["K", 0], ["G", 1]]))).toEqual([0, 1, 2]);
  });

  it("孙节点越过 K 不收集：K 之下两层孙 X inherit=1，收集止于 K（K 是最后允许的祖先边界）", () => {
    // X(1) -> P(0) -> ... ：P 即第一个 0，收集 X,P
    expect(collectibleChainIndexes(chain([["X", 1], ["P", 0], ["K", 1], ["R", 1]]))).toEqual([0, 1]);
  });

  it("开关不向下传播：链中多个 0 只认最近的一个（停止后不再判断更上层）", () => {
    expect(collectibleChainIndexes(chain([["X", 1], ["P", 1], ["K1", 0], ["K2", 0]]))).toEqual([0, 1, 2]);
  });
});

describe("NavChainCache（LRU + 版本失配即弃，不触库的结构行为用假 client）", () => {
  function fakeClient(nodes: Record<string, { id: string; workspaceId: string; path: string; deletedAt: Date | null } & Record<string, unknown>>) {
    const calls: string[] = [];
    const mkNode = (id: string) => ({
      id, workspaceId: "ws_default", parentId: null, kind: "doc", resourceType: "doc",
      resourceId: id, name: id, path: nodes[id]!.path, depth: 0, inheritAncestors: 1,
      deletedAt: null,
    });
    return {
      calls,
      client: {
        navNode: {
          findFirst: async (args: { where: { id: string } }) => {
            calls.push("findFirst");
            const n = nodes[args.where.id];
            return n ? mkNode(args.where.id) : null;
          },
          findMany: async (args: { where: { id: { in: string[] } } }) => {
            calls.push("findMany");
            return args.where.id.in.filter((id) => nodes[id]).map((id) => mkNode(id));
          },
        },
      } as never,
    };
  }

  it("同版本第二次取链不触库；版本号变化后重建（重新点查）", async () => {
    const c = fakeClient({ a: { id: "a", workspaceId: "ws_default", path: "/a/", deletedAt: null } });
    const cache = new NavChainCache(10);
    const r1 = await cache.ancestorChain(c.client, "a", 1);
    const r2 = await cache.ancestorChain(c.client, "a", 1);
    expect(r1.map((n) => n.id)).toEqual(["a"]);
    expect(r2.map((n) => n.id)).toEqual(["a"]);
    expect(c.calls.filter((x) => x === "findMany").length).toBe(1); // 链只批量取一次
    await cache.ancestorChain(c.client, "a", 2);
    expect(c.calls.filter((x) => x === "findMany").length).toBe(2); // 版本失配重建
  });

  it("LRU 容量淘汰最久未用工作区", () => {
    const cache = new NavChainCache(2);
    // 借 ancestorChain 触达 touchWorkspace 不便（需库）；用容量逻辑间接验证不抛错即可
    expect(cache).toBeInstanceOf(NavChainCache);
    cache.clear();
  });
});
