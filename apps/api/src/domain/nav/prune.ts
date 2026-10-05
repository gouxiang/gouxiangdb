// M4/S7 权威树/菜单服务端剪枝纯函数（裁决 A-6，计划 §7-S7 行639-640）。
//
// nav 层保持纯域：本文件只接收结构类型 PruneIndex（由 authz 层 buildNavVisibility 构造），
// 不 import authz/db/Hono。on 态在 readNavTree/readMenuTree 取到全量行【之后、DTO 装配之前】
// 调用本文件；off/shadow 路由不构造索引、不调用本文件（零新增 SQL，响应与 M3 字节一致）。
//
// 裁决 A-6 核心语义：
//   - 资源节点可见 = 节点自身 r 成立，但其任一资源祖先（group 是透明容器，不阻断）无 r，
//     则权威树中【整棵子树裁剪】——即便子节点有 direct 授予（权限在、导航路径断），
//     不造伪父链、不做可见性提升位；该子节点只能经 menu shortcut / 直达 URL 到达；
//   - shortcut 通道只看目标节点【自身】r（不做祖先裁剪），故"父无权子有权"时 shortcut 正常显示；
//   - 空容器（group/菜单容器）对普通成员隐藏；对管理能力者保留并标 dimmed（ARCH #17）。

export interface PruneNode {
  id: string;
  parentId: string | null;
  kind: string;
  path: string;
  resourceType: string | null;
}

export interface PruneIndex {
  /** 自身 r 成立的资源节点集（shortcut 通道据此判定，不查祖先）。 */
  visible: ReadonlySet<string>;
  /** 工作区全部活节点（判定容器子树内容时不受 tree 读窗口 depth 限制）。 */
  allNodes: readonly PruneNode[];
  /** 组织管理能力者（manage_share/manage_menu）：空容器保留可见。 */
  manageAll: boolean;
}

interface PrunedNode<T extends PruneNode> {
  row: T;
  /** 仅 group：管理能力者可见但子树对其无任何可见内容（前端标灰）。 */
  dimmed: boolean;
}

function isGroup(n: PruneNode): boolean {
  return n.kind === "group";
}

/**
 * 资源节点的祖先资源门：沿 parentId 向上（跨透明 group），任一资源祖先不在 visible 集即拒。
 * 用全量 byId 遍历，链长有界（深度护栏 32）。
 */
function resourceAncestorsPass(
  node: PruneNode,
  byId: ReadonlyMap<string, PruneNode>,
  visible: ReadonlySet<string>,
): boolean {
  if (!isGroup(node) && !visible.has(node.id)) return false;
  let cur = node.parentId ? byId.get(node.parentId) : undefined;
  while (cur) {
    if (!isGroup(cur) && !visible.has(cur.id)) return false;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return true;
}

/** group 子树内是否含可见资源的 O(n) 索引见 buildGroupContentIndex（S10 前为 O(g*n) 嵌套扫描，已替换）。 */

interface GroupContentIndex {
  /** 子树内含"门通过可见资源"的 group id（这些 group 对普通成员保留）。 */
  contentGroups: ReadonlySet<string>;
  /**
   * 构造期访问的【唯一】节点数（线性证明）：记忆化后序遍历每节点恰好求值一次，
   * 恒等于参与建索引的活节点数，与 group 数量无关（旧 O(g*n) 嵌套全组扫描的替代）。
   */
  scanned: number;
}

/**
 * O(n) 一次遍历求全部 group 的"子树是否含可见内容"（S10 规模门前置，替代 O(g*n)）：
 *   1. 按 parentId 建一次 children 邻接（O(n)）；
 *   2. 自根记忆化后序遍历——资源节点值 = visible 且资源祖先门通过；
 *      group 节点值 = 任一子树为真，为真即沿闭包记入 contentGroups（可见资源沿父链保 group）。
 * 每个节点 memo 命中后不再访问，故总访问数恰为节点数；depth 有护栏（32），森林按根遍历。
 */
export function buildGroupContentIndex(idx: PruneIndex): GroupContentIndex {
  const byId = new Map<string, PruneNode>(idx.allNodes.map((n) => [n.id, n]));
  const children = new Map<string, PruneNode[]>();
  const roots: PruneNode[] = [];
  for (const n of idx.allNodes) {
    if (n.parentId && byId.has(n.parentId)) {
      const arr = children.get(n.parentId) ?? [];
      arr.push(n);
      children.set(n.parentId, arr);
    } else {
      roots.push(n); // parentId=null 或父不在活节点集（森林根/悬挂根）
    }
  }

  const contentGroups = new Set<string>();
  const memo = new Map<string, boolean>();
  let scanned = 0;
  const subtreeHasVisible = (n: PruneNode): boolean => {
    const cached = memo.get(n.id);
    if (cached !== undefined) return cached;
    scanned += 1; // 每个节点仅在 memo miss 时计一次
    let has: boolean;
    if (isGroup(n)) {
      has = false;
      for (const ch of children.get(n.id) ?? []) {
        if (subtreeHasVisible(ch)) has = true;
      }
      if (has) contentGroups.add(n.id);
    } else {
      has = idx.visible.has(n.id) && resourceAncestorsPass(n, byId, idx.visible);
    }
    memo.set(n.id, has);
    return has;
  };

  for (const r of roots) subtreeHasVisible(r);
  // 防御补扫：父在 allNodes 外的悬挂分支理论上已作 root 入列；此处兜底保证全覆盖且不重复计数。
  for (const n of idx.allNodes) {
    if (!memo.has(n.id)) subtreeHasVisible(n);
  }
  return { contentGroups, scanned };
}

/**
 * 权威树后置剪枝。输入为某个读窗口取出的活节点行；输出保留行 + dimmed 标记（A-6）。
 * 资源行：自身可见且资源祖先门通过；group 行：管理能力者全保留（空者 dimmed），
 * 普通成员仅在子树含可见资源时保留（不 dimmed）。
 * group 保活判定经 buildGroupContentIndex 一次遍历预算（O(n)），不再每 group 全组扫描。
 */
export function pruneTreeRows<T extends PruneNode>(rows: readonly T[], idx: PruneIndex): PrunedNode<T>[] {
  const byId = new Map<string, PruneNode>(idx.allNodes.map((n) => [n.id, n]));
  // 与旧实现一致：把读窗口内可能多出的节点并入判定集（正常路径 prepared.nodes 已是全量活节点）。
  const merged: PruneNode[] = [...idx.allNodes];
  for (const r of rows) {
    if (!byId.has(r.id)) {
      byId.set(r.id, r);
      merged.push(r);
    }
  }
  // 用合并集做一次 O(n) 内容索引（窗口额外 group 也参与保活/dimmed 判定）。
  const { contentGroups } = buildGroupContentIndex({ visible: idx.visible, allNodes: merged, manageAll: idx.manageAll });

  const out: PrunedNode<T>[] = [];
  for (const row of rows) {
    if (isGroup(row)) {
      const hasContent = contentGroups.has(row.id);
      if (hasContent || idx.manageAll) {
        out.push({ row, dimmed: !hasContent }); // 普通成员能保留必有 content；dimmed 仅落管理能力者空容器
      }
      continue;
    }
    if (resourceAncestorsPass(row, byId, idx.visible)) out.push({ row, dimmed: false });
  }
  return out;
}

/**
 * 菜单剪枝：shortcut 只看目标节点【自身】可见（A-6 直达通道，不做祖先门）；
 * container（菜单容器，2 层上限）普通成员仅在其下含可见 shortcut 时保留，管理能力者全保留。
 * targetState 回调让调用方按 menu_item.id 取目标节点 id/live 状态，保持本函数零 IO。
 */
export function pruneMenuRows<T>(
  menus: readonly T[],
  isVisibleShortcut: (m: T) => boolean,
  isContainer: (m: T) => boolean,
  parentIdOf: (m: T) => string | null,
  idOf: (m: T) => string,
  manageAll: boolean,
): Set<string> {
  const byParent = new Map<string, T[]>();
  for (const m of menus) {
    const pid = parentIdOf(m);
    if (pid === null) continue;
    const arr = byParent.get(pid) ?? [];
    arr.push(m);
    byParent.set(pid, arr);
  }
  const keep = new Set<string>();
  const containerHasVisibleShortcut = (containerId: string): boolean => {
    for (const child of byParent.get(containerId) ?? []) {
      if (!isContainer(child)) {
        if (isVisibleShortcut(child)) {
          keep.add(idOf(child));
          return true;
        }
      } else if (containerHasVisibleShortcut(idOf(child))) {
        keep.add(idOf(child));
        return true;
      }
    }
    return false;
  };
  for (const m of menus) {
    if (!isContainer(m)) {
      if (isVisibleShortcut(m)) keep.add(idOf(m));
    }
  }
  for (const m of menus) {
    if (isContainer(m)) {
      const has = containerHasVisibleShortcut(idOf(m));
      if (has || manageAll) keep.add(idOf(m));
    }
  }
  return keep;
}

/**
 * 面包屑中性截断（A-6 配套）：输入叶->根序活链，输出根->叶的可见链 + 是否存在被截断的无权上段。
 * group 透明（不阻断、在可见资源段内照常显示）；自下而上第一个不可见资源节点即停止上溯；
 * 截断发生时把根端残留的孤立 group 段一并裁掉（它在权威树中也不可见，不回显其名）。
 */
export function pruneBreadcrumb<T extends PruneNode>(
  chainLeafFirst: readonly T[],
  visible: ReadonlySet<string>,
): { chain: T[]; truncatedAbove: boolean } {
  if (chainLeafFirst.length === 0) return { chain: [], truncatedAbove: false };
  const kept: T[] = [];
  let truncatedAbove = false;
  for (const n of chainLeafFirst) {
    if (isGroup(n)) {
      kept.push(n);
      continue;
    }
    if (visible.has(n.id)) {
      kept.push(n);
    } else {
      truncatedAbove = true;
      break;
    }
  }
  const chain = kept.reverse();
  if (truncatedAbove) {
    while (chain.length > 0 && isGroup(chain[0]!)) chain.shift();
  }
  return { chain, truncatedAbove };
}
