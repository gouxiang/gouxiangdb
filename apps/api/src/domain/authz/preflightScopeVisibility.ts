// apps/api/src/domain/authz/preflightScopeVisibility.ts
// 通电前体检【语义面·第二段】：库节点到底在不在 S4 可见集里。
//
// 为什么在「库级判定可达性」之外还要单列这一段：前一段只证明「七守问库节点会 403」，
// 而这一段证明的是更硬、更外层的失效——通电后【库整层从可见集消失】。
// 可见集是 M5「先收敛后召回」的唯一入口，也是 M3 导航剪枝的消费面；
// 库节点缺席 = 检索只召回表/视图、导航里点不进任何库，而守卫判不判得通已经无所谓了。
//
// 判定与 S4 端点同源同内核（scope.prepareScope + nodeVisibleInPrepared，即
// resolveVisibleNodeIds 的内部两步），不另写一套近似集合运算，故不存在第二语义。
//
// 只读、有界（用户/库均设上限），不写库、不接线。

import type { AuthzClient } from "./types.js";
import { nodeVisibleInPrepared, prepareScope } from "./scope.js";

/** 抽样上限（保证体检是有界动作，不为大库拖垮）。 */
const LIMITS = { users: 5, libraries: 8 } as const;

export interface ScopeVisibilitySample {
  userId: string;
  /** 库节点 id（nav_nodes.id）。 */
  nodeId: string;
  /** base | kb。 */
  kind: string;
  visible: boolean;
}

export interface PreflightScopeVisibility {
  /** 参与抽样的非 owner 用户数（owner 走硬短路，全量可见，不具代表性）。 */
  sampledUsers: number;
  /** 因是 workspace owner 而跳过的用户数。 */
  ownerSkipped: number;
  /** 用户 × 库节点 抽样总数。 */
  checked: number;
  /** 其中判定为可见的次数。 */
  visible: number;
  /**
   * 【核心信号】表/视图可见、但库节点一个都不可见的用户数。
   * 只看这一个数：库不可见本身可能是该用户本就无视野（合法），
   * 「表可见而装表的库不可见」才是通电后的确定性失效——导航点不进库、检索只召回表。
   */
  orphanTableUsers: number;
  /** 样例（最多 10 条，够定位）。 */
  samples: ScopeVisibilitySample[];
  /** 抽样抛错次数（多为 nav 面问题，先跑 reconcile-nav）。 */
  errors: number;
}

function isLibraryNode(resourceType: string | null): boolean {
  return resourceType === "base" || resourceType === "kb";
}

/**
 * 只读抽样：对若干非 owner 用户，用 S4 同一内核逐个判其库节点的 enter 库门可见性
 * （内容节点 table/view/doc 仍判 r，见下）。
 * 只统计「有没有」，不重排、不落预算（体检要的是定性信号，不是端点契约）。
 */
export async function computeScopeVisibility(client: AuthzClient): Promise<PreflightScopeVisibility> {
  const out: PreflightScopeVisibility = {
    sampledUsers: 0, ownerSkipped: 0, checked: 0, visible: 0,
    orphanTableUsers: 0, samples: [], errors: 0,
  };

  const users = await client.user.findMany({ select: { id: true }, take: LIMITS.users });
  if (users.length === 0) return out;

  for (const { id: userId } of users) {
    try {
      const prepared = await prepareScope(client, userId, {});
      if (prepared.subject.isWorkspaceOwner) {
        out.ownerSkipped += 1;
        continue;
      }
      out.sampledUsers += 1;

      const libraryNodes = prepared.nodes
        .filter((n) => isLibraryNode(n.resourceType))
        .slice(0, LIMITS.libraries);
      const otherNodes = prepared.nodes.filter((n) => !isLibraryNode(n.resourceType));

      let userHasLibrary = false;
      for (const node of libraryNodes) {
        // 库门与守卫同口径判 enter（不再判 r：库节点无内容 r）。
        const visible = nodeVisibleInPrepared(prepared, node, "enter");
        out.checked += 1;
        if (visible) {
          out.visible += 1;
          userHasLibrary = true;
        } else if (out.samples.length < 10) {
          out.samples.push({ userId, nodeId: node.id, kind: node.resourceType ?? "?", visible });
        }
      }
      // 表/视图可见而库不可见：这才是确定性失效（库不可见但本就无视野是合法的）。
      // 只判到第一个可见即停，且设上限，保证大库下体检仍是有界动作。
      let anyOtherVisible = false;
      for (const node of otherNodes.slice(0, LIMITS.libraries * LIMITS.libraries)) {
        if (nodeVisibleInPrepared(prepared, node, "r")) { anyOtherVisible = true; break; }
      }
      if (!userHasLibrary && anyOtherVisible) out.orphanTableUsers += 1;
    } catch {
      out.errors += 1;
    }
  }
  return out;
}
