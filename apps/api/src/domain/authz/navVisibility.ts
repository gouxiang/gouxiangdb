// M4/S7 nav 剪枝可见索引（计划 §7-S7，裁决 A-6）。
//
// authz 侧唯一构造点：复用 S4 scope 的 prepareScope（与 visible-scope/decide 同一判定内核，
// 零第二套判定）预算主体 r 可见的全量活节点集，包成 nav/prune 需要的结构类型 PruneIndex。
// 调 gate（navPruneEnforceEffective）在路由侧；off/shadow 不调本文件，零新增 SQL。
//
// 纯域：只依赖注入 client，不 import Hono/guards。

import { hasOrgAction } from "../org/authorization.js";
import { prepareScope, nodeVisibleInPrepared, type PreparedScope } from "./scope.js";
import type { ResourceAction } from "@gx/shared-types";
import type { PruneIndex, PruneNode } from "../nav/prune.js";
import type { AuthzClient, AuthzNode } from "./types.js";

interface NavVisibility {
  prepared: PreparedScope;
  index: PruneIndex;
  /** 节点【自身】r 是否成立（不查祖先；shortcut/面包屑逐节点判定用）。 */
  selfVisible: (nodeId: string) => boolean;
  /** 组织导航/分享管理能力（空容器保留标灰）。 */
  manageAll: boolean;
}

function toPruneNode(n: AuthzNode): PruneNode {
  return { id: n.id, parentId: n.parentId, kind: n.kind, path: n.path, resourceType: n.resourceType };
}

/** 构造单请求生命期的剪枝索引（on 态）；节点判定全部走 scope 内核，动作默认 r。 */
export async function buildNavVisibility(
  client: AuthzClient,
  userId: string,
  action: ResourceAction = "r",
): Promise<NavVisibility> {
  const prepared = await prepareScope(client, userId);
  const visible = new Set<string>();
  for (const node of prepared.nodes) {
    if (nodeVisibleInPrepared(prepared, node, action)) visible.add(node.id);
  }
  const [canMenu, canShare] = await Promise.all([
    hasOrgAction(userId, "manage_menu", client),
    hasOrgAction(userId, "manage_share", client),
  ]);
  const byId = prepared.byId;
  return {
    prepared,
    manageAll: canMenu || canShare,
    selfVisible: (nodeId: string) => {
      const n = byId.get(nodeId);
      return !!n && visible.has(n.id);
    },
    index: {
      visible,
      allNodes: prepared.nodes.map(toPruneNode),
      manageAll: canMenu || canShare,
    },
  };
}
