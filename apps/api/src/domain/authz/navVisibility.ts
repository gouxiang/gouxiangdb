// M4/S7 nav 剪枝可见索引（计划 §7-S7，裁决 A-6）。
//
// authz 侧唯一构造点：复用 S4 scope 的 prepareScope（与 visible-scope/decide 同一判定内核，
// 零第二套判定）预算主体 r 可见的全量活节点集，包成 nav/prune 需要的结构类型 PruneIndex。
// 引擎永久单一化后路由恒定调本文件构造剪枝索引（无开关、无 off/shadow）。
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

/**
 * 剪枝可见性按节点资源类型选动作（与七守 P0-A / preflightScopeVisibility 同口径）：
 *   - 库门节点 base/kb 判 enter：库节点结构性地不投影内容 r（§1.3 防无 mask 下放），
 *     库门准入位是 enter；若这里对库节点判 r，则任何只拿到 enter 的合法成员（含天然进全部
 *     库的管理员）都会让库节点进不了 visible 集，进而被 resourceAncestorsPass 连坐，整库连同
 *     其下已授权 r 的表/文档一起从权威树与菜单 shortcut 被剪掉——「点得开、导航却没有」。
 *   - 其余内容节点（table/doc/canvas/view…）仍判 r：内容可见性必须有真实读授权（含 fieldMask）。
 * 仅决定导航条目的显隐，不返回任何字段数据，故库门用 enter 不会重蹈「库节点补 r」的泄漏口。
 */
function navVisibilityAction(node: { resourceType: string | null }): ResourceAction {
  return node.resourceType === "base" || node.resourceType === "kb" ? "enter" : "r";
}

/** 构造单请求生命期的剪枝索引（引擎永久生效）；库门判 enter、内容节点判 r（见 navVisibilityAction）。 */
export async function buildNavVisibility(
  client: AuthzClient,
  userId: string,
): Promise<NavVisibility> {
  const prepared = await prepareScope(client, userId);
  const visible = new Set<string>();
  for (const node of prepared.nodes) {
    if (nodeVisibleInPrepared(prepared, node, navVisibilityAction(node))) visible.add(node.id);
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
