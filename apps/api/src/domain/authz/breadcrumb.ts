// M4/S7 面包屑中性截断域服务（裁决 A-6 配套，计划 §7-S7 行640）。
//
// 直达打开"父无权、子 direct 有权"节点后，parentChain 只输出从该用户【有权的最高祖先】
// 到自身的连续可见段；无权祖先段整体截断（不返回其 id/name/path），仅给 truncatedAbove 标记。
// group 透明（不阻断、段内照常显示）。物理祖先链与继承 cutoff 无关，故走结构链缓存。
//
// 纯域：只依赖注入 client，不 import Hono。判定内核与 scope/decide 同源（零分叉）。

import type { BreadcrumbNodeDTO, NodeBreadcrumbDTO } from "@gx/shared-types";
import { navPruneEnforceEffective } from "../../configAuthz.js";
import { NavChainCache, navVersionOf } from "./nodes.js";
import { prepareScope, nodeVisibleInPrepared } from "./scope.js";
import { pruneBreadcrumb } from "../nav/prune.js";
import type { AuthzClient, AuthzNode } from "./types.js";

function toDto(n: AuthzNode): BreadcrumbNodeDTO {
  return {
    id: n.id,
    parentId: n.parentId,
    kind: n.kind as BreadcrumbNodeDTO["kind"],
    resourceType: n.resourceType,
    resourceId: n.resourceId,
    name: n.name,
    path: n.path,
    depth: n.depth,
  };
}

/**
 * 求节点对某主体的可见面包屑。
 * 节点缺失/软删 -> null（路由 404）；节点对该主体无 r -> "forbidden"（路由 403，不借端点探测）。
 */
export async function visibleBreadcrumb(
  client: AuthzClient,
  userId: string,
  nodeId: string,
): Promise<NodeBreadcrumbDTO | null | "forbidden"> {
  const target = await client.navNode.findFirst({ where: { id: nodeId, deletedAt: null } });
  if (!target) return null;

  const version = await navVersionOf(client);
  const chainLeafFirst = await new NavChainCache().ancestorChain(client, nodeId, version);

  // off/shadow（独立剪枝门关闭，S10 前的默认姿态）：不实例化 scope、零引擎 SQL，
  // 回全物理祖先链且 truncatedAbove=false，与 M3 金标准一致（任何登录用户均可解析面包屑，
  // 与 tree/menu M3 零剪枝姿态对齐；内容能否打开仍由旧守卫决定）。
  if (!navPruneEnforceEffective()) {
    return {
      nodeId,
      chain: [...chainLeafFirst].reverse().map(toDto),
      truncatedAbove: false,
    };
  }

  const prepared = await prepareScope(client, userId);
  const targetAsNode = target as unknown as AuthzNode;
  if (targetAsNode.kind !== "group" && !nodeVisibleInPrepared(prepared, targetAsNode, "r")) {
    return "forbidden";
  }

  const visible = new Set<string>();
  for (const n of prepared.nodes) {
    if (nodeVisibleInPrepared(prepared, n, "r")) visible.add(n.id);
  }
  const { chain, truncatedAbove } = pruneBreadcrumb(chainLeafFirst, visible);
  const dtos = chain.map(toDto);
  if (truncatedAbove && dtos.length > 0) {
    // 中性化：链首节点自身的 parentId/path/depth 仍含无权祖先的 id 与层数信息，
    // 按可见段重写为相对坐标（段首 parentId=null、path=/<id>/、depth=0，段内顺序递增），
    // 确保不借面包屑泄漏无权节点的 id/name/path 或其存在性/深度。
    for (let i = 0; i < dtos.length; i++) {
      const dto = dtos[i]!;
      dto.depth = i;
      dto.parentId = i === 0 ? null : dtos[i - 1]!.id;
      dto.path = `/${dtos.slice(0, i + 1).map((d) => d.id).join("/")}/`;
    }
  }
  return {
    nodeId,
    chain: dtos,
    truncatedAbove,
  };
}
