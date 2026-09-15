// M4/S1 客体收集：nav 物化路径祖先链 + navVersion 失配即弃的 LRU 结构缓存 + inheritAncestors cutoff。
//
// 纯域：只依赖注入的 client（nav_nodes/workspaces），不 import Hono/guards，不查旧三表。
// 缓存只存可重算结构数据（决策结果不缓存，见计划 §0-10/§5.6，避免字段掩码上下文串味）。

import type { AuthzClient, AuthzNode } from "./types.js";

/** 物化路径切 id（含自身，叶->根序）："/a/b/" -> ["a","b"]。 */
export function nodeIdsFromPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

const NODE_SELECT = {
  id: true,
  workspaceId: true,
  parentId: true,
  kind: true,
  resourceType: true,
  resourceId: true,
  name: true,
  path: true,
  depth: true,
  inheritAncestors: true,
  deletedAt: true,
} as const;

/**
 * 决策收集范围（cutoff 纯函数，计划 §4.5）。
 * chain[0] 为被决策节点自身，其后为自近及远的祖先。
 *  - 自身始终收集；自身 inheritAncestors=0 时不收集任何祖先；
 *  - 否则沿祖先向上，遇到第一个 inheritAncestors=0 的祖先 K：收集 K 后即停止
 *    （K 是"被允许的最后一个祖先边界"，K 之上不收集；K 自身策略仍收集）。
 * 返回应收集策略的节点在 chain 中的下标集合。
 */
export function collectibleChainIndexes(chain: readonly Pick<AuthzNode, "id" | "inheritAncestors">[]): number[] {
  if (chain.length === 0) return [];
  const indexes = [0];
  if (chain[0]!.inheritAncestors !== 1) return indexes; // 被决策节点自身关闭继承
  for (let i = 1; i < chain.length; i++) {
    indexes.push(i);
    if (chain[i]!.inheritAncestors === 0) break; // cutoff：含 K 后停止
  }
  return indexes;
}

/** 单个工作区的祖先链缓存条目：版本失配整体作废。 */
interface WorkspaceCache {
  navVersion: number;
  chains: Map<string, AuthzNode[]>;
}

/**
 * navVersion 失配即弃的 LRU（容量 1000，key=workspaceId）。
 * 结构缓存不涉即时性承诺：auth_policies/dept 写 bump policyVersion、nav 写 bump navVersion，
 * nav 结构变化（move/继承开关）下一次请求 navVersion 已变，缓存整体弃用。
 */
export class NavChainCache {
  private readonly workspaces = new Map<string, WorkspaceCache>();
  constructor(private readonly capacity: number = 1000) {}

  private touchWorkspace(workspaceId: string, navVersion: number): WorkspaceCache {
    const existing = this.workspaces.get(workspaceId);
    if (existing && existing.navVersion === navVersion) {
      this.workspaces.delete(workspaceId);
      this.workspaces.set(workspaceId, existing); // LRU 提到最新
      return existing;
    }
    const fresh: WorkspaceCache = { navVersion, chains: new Map() };
    this.workspaces.set(workspaceId, fresh);
    if (this.workspaces.size > this.capacity) {
      const oldest = this.workspaces.keys().next().value;
      if (oldest !== undefined) this.workspaces.delete(oldest);
    }
    return fresh;
  }

  /**
   * 缓存命中快路径：同工作区同版本下该节点链已取过时直接返回，0 往返（不点查节点）。
   * 单工作区恒 ws_default（M4 计划 §1.4）；未命中或版本失配返回 null 走点查。
   */
  peekChain(workspaceId: string, navVersion: number, nodeId: string): AuthzNode[] | null {
    const ws = this.workspaces.get(workspaceId);
    if (!ws || ws.navVersion !== navVersion) return null;
    return ws.chains.get(nodeId) ?? null;
  }

  /**
   * 取节点祖先链（含自身，叶->根序）。冷取往返：节点点查 1 + id IN 批量 1（版本由调用方
   * 预取传入，见 engine）；同版本同节点命中缓存时 peekChain 快路径 0 往返。
   */
  async ancestorChain(
    client: AuthzClient,
    nodeId: string,
    navVersion: number,
    workspaceId = "ws_default",
  ): Promise<AuthzNode[]> {
    const hit = this.peekChain(workspaceId, navVersion, nodeId);
    if (hit) return hit;

    const target = await client.navNode.findFirst({
      where: { id: nodeId, deletedAt: null },
      select: NODE_SELECT,
    });
    if (!target) throw new Error("NAV_NODE_NOT_FOUND");
    const cache = this.touchWorkspace(target.workspaceId, navVersion);
    const cached = cache.chains.get(nodeId);
    if (cached) return cached;

    // 物化 path 切段为根->叶（"/B/T/" -> [B,T]）；决策约定 chain[0]=被决策节点自身，
    // 故反转为叶->根 [T,B]（collectibleChainIndexes/decide/viaAncestor 均依此序）。
    const ids = nodeIdsFromPath(target.path).reverse();
    const rows = await client.navNode.findMany({
      where: { id: { in: ids } },
      select: NODE_SELECT,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    // 按叶->根序还原；缺失段容错跳过（target 已点查命中，chain[0] 必为自身）。
    const chain: AuthzNode[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (row) chain.push(row as AuthzNode);
    }
    cache.chains.set(nodeId, chain);
    return chain;
  }

  clear(): void {
    this.workspaces.clear();
  }
}

/** 取当前工作区 navVersion（调用方决定缓存策略；S1 每次决策显式传入以保持定数可测）。 */
export async function navVersionOf(client: AuthzClient, workspaceId = "ws_default"): Promise<number> {
  const ws = await client.workspace.findUnique({ where: { id: workspaceId }, select: { navVersion: true } });
  return ws?.navVersion ?? 0;
}
