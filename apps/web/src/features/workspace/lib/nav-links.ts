// M3 菜单 shortcut → 既有内容 URL 解析（纯函数）。
//
// N5 铁律（裁决 2/ADR-0028）：内容 URL 永不改名，shortcut 只解析回
// /base/...、/kb/... 旧形，不引入 /w/node。doc/canvas 的 URL 需要 kbId，
// 而菜单摘要只带 resourceId（= kb_docs.id），故借 nav tree 的 parentId 链
// 向上找 kb 祖先；table 向上找 base 祖先。解析失败返回 null（broken/未知名类型，
// 调用方禁用该项而非硬跳）。

import type { NavKind, NavNodeDTO } from "@gx/shared-types";

export interface NodeIndex {
  byId: Map<string, NavNodeDTO>;
  /** resourceType:resourceId → 节点（同资源唯一权威挂载）。 */
  byResource: Map<string, NavNodeDTO>;
}

/** 用平铺 tree items 建索引（parentId 链查找祖先用）。 */
export function indexNavNodes(items: readonly NavNodeDTO[]): NodeIndex {
  const byId = new Map<string, NavNodeDTO>();
  const byResource = new Map<string, NavNodeDTO>();
  for (const n of items) {
    byId.set(n.id, n);
    if (n.resourceType && n.resourceId) byResource.set(`${n.resourceType}:${n.resourceId}`, n);
  }
  return { byId, byResource };
}

/** 沿 parentId 找最近的指定 kind 祖先；防御异常环（已访问集合 + 32 深度后端护栏）。 */
export function findAncestorOfKind(index: NodeIndex, node: NavNodeDTO, kind: NavKind): NavNodeDTO | null {
  let cur: NavNodeDTO | undefined = node;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const pid = cur.parentId;
    if (!pid) return null;
    cur = index.byId.get(pid);
    if (cur?.kind === kind) return cur;
  }
  return null;
}

/**
 * 把资源节点解析为既有应用路由（react-router 相对路径，不带部署 basename）。
 *  - base → /base/:baseId
 *  - table → /base/:baseId/table/:tableId（TableIndexRedirect 自动跳首视图）
 *  - kb → /kb/:kbId
 *  - doc → /kb/:kbId/doc/:docId
 *  - canvas → /kb/:kbId/canvas/:docId
 *  - view/group/未知/祖先缺失 → null
 */
export function navNodeHref(index: NodeIndex, node: NavNodeDTO): string | null {
  const rid = node.resourceId;
  if (!rid) return null;
  switch (node.kind) {
    case "base":
      return `/base/${rid}`;
    case "kb":
      return `/kb/${rid}`;
    case "table": {
      const base = findAncestorOfKind(index, node, "base");
      return base?.resourceId ? `/base/${base.resourceId}/table/${rid}` : null;
    }
    case "doc":
    case "canvas": {
      const kb = findAncestorOfKind(index, node, "kb");
      return kb?.resourceId ? `/kb/${kb.resourceId}/${node.kind}/${rid}` : null;
    }
    case "view":
    case "group":
      return null;
    default:
      return null;
  }
}

/** 便捷：按 (resourceType, resourceId) 解析快捷方式 href。 */
export function resourceHref(
  index: NodeIndex,
  resourceType: string | null | undefined,
  resourceId: string | null | undefined,
): string | null {
  if (!resourceType || !resourceId) return null;
  const node = index.byResource.get(`${resourceType}:${resourceId}`);
  return node ? navNodeHref(index, node) : null;
}
