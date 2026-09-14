// M2/S7 通讯录纯函数：平铺部门数据组树、展开拍平、移动候选父过滤（前端拦环）、虚拟窗口计算。
// 全部无副作用、不依赖 React/DOM（虚拟窗口只做纯算术，DOM 滚动状态由组件传入），便于 vitest 单测。

/** tree.ts 只依赖部门的最小结构（DeptDTO 的结构化子集，避免测试构造完整 DTO）。 */
export interface DeptLike {
  id: string;
  parentId: string | null;
  name: string;
  ord?: number;
  memberCount?: number;
}

export interface DeptTreeNode<T extends DeptLike = DeptLike> {
  dept: T;
  children: DeptTreeNode<T>[];
}

export interface FlatDeptRow<T extends DeptLike = DeptLike> {
  dept: T;
  depth: number;
}

/** 同父下的排序：ord 升序，ord 相同按名称（与后端 listDepartments 的 ord→createdAt 近似，前端只用于稳定展示）。 */
function siblingSorter(a: DeptLike, b: DeptLike): number {
  const oa = a.ord ?? 0;
  const ob = b.ord ?? 0;
  if (oa !== ob) return oa - ob;
  return a.name.localeCompare(b.name, "zh-Hans-CN");
}

/**
 * 把后端平铺部门列表组为树（parentId 真相）。
 * 容错：parentId 指向的父不在列表中（异常/软删竞态）时按根节点挂出，避免整树丢失。
 */
export function buildDeptTree<T extends DeptLike>(flat: readonly T[]): DeptTreeNode<T>[] {
  const nodes = new Map<string, DeptTreeNode<T>>();
  for (const d of flat) nodes.set(d.id, { dept: d, children: [] });

  const roots: DeptTreeNode<T>[] = [];
  for (const d of flat) {
    const node = nodes.get(d.id)!;
    if (d.parentId && nodes.has(d.parentId)) {
      nodes.get(d.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortRec = (list: DeptTreeNode<T>[]) => {
    list.sort((a, b) => siblingSorter(a.dept, b.dept));
    list.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

/**
 * 按展开集合把树深度优先拍平为带层级的行（供缩进渲染）。
 * expanded 不含的节点其子树整体跳过；根始终展开。
 */
export function flattenVisible<T extends DeptLike>(
  nodes: readonly DeptTreeNode<T>[],
  expanded: ReadonlySet<string>,
): FlatDeptRow<T>[] {
  const out: FlatDeptRow<T>[] = [];
  const walk = (list: readonly DeptTreeNode<T>[], depth: number) => {
    for (const n of list) {
      out.push({ dept: n.dept, depth });
      if (expanded.has(n.dept.id)) walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return out;
}

/**
 * 计算某节点的全部子孙部门 id（含自身可选）。基于 parentId 图，不依赖物化 path，
 * 用于移动部门时在前端先拦一次环（后端 deptTree.wouldCreateCycle 是最终防线）。
 */
export function descendantIds<T extends DeptLike>(
  flat: readonly T[],
  rootId: string,
  includeSelf = false,
): Set<string> {
  const childrenOf = new Map<string | null, string[]>();
  for (const d of flat) {
    const key = d.parentId;
    const arr = childrenOf.get(key) ?? [];
    arr.push(d.id);
    childrenOf.set(key, arr);
  }
  const result = new Set<string>();
  if (includeSelf) result.add(rootId);
  const stack = [...(childrenOf.get(rootId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (result.has(id)) continue; // 防御异常环数据
    result.add(id);
    for (const child of childrenOf.get(id) ?? []) stack.push(child);
  }
  return result;
}

/**
 * 移动「movingId」时可选的新父候选：排除自身、自己的全部子孙（否则成环），
 * 其余部门均可作为父（含「无上级（根）」，由组件额外提供）。
 */
export function movableParentCandidates<T extends DeptLike>(
  flat: readonly T[],
  movingId: string,
): T[] {
  const blocked = descendantIds(flat, movingId, true);
  return flat.filter((d) => !blocked.has(d.id));
}

/** 前端环预判：把 movingId 移到 candidateParentId 下是否非法（移到自身或其子孙之下）。 */
export function wouldFormCycle<T extends DeptLike>(
  flat: readonly T[],
  movingId: string,
  candidateParentId: string | null,
): boolean {
  if (candidateParentId === null) return false; // 移到根不可能成环
  if (candidateParentId === movingId) return true;
  return descendantIds(flat, movingId, false).has(candidateParentId);
}

// ============ 成员列表虚拟窗口（定高行，自实现窗口化，不引依赖） ============

export interface VirtualWindow {
  /** 可视区（含 overscan）首行索引 */
  start: number;
  /** 可视区（含 overscan）末行索引（不含） */
  end: number;
  /** 顶部占位高度（把窗口内首行推到正确纵向位置） */
  padTop: number;
  /** 底部占位高度（撑出完整滚动高度） */
  padBottom: number;
  /** 全部行撑起的总高度 */
  totalHeight: number;
}

/**
 * 定高行虚拟窗口纯计算。
 * @param scrollTop 滚动容器 scrollTop
 * @param viewportH 滚动容器可视高
 * @param rowH 行高（常量）
 * @param total 总行数
 * @param overscan 上下额外渲染的行数（默认 8）
 */
export function virtualWindow(
  scrollTop: number,
  viewportH: number,
  rowH: number,
  total: number,
  overscan = 8,
): VirtualWindow {
  const safeTotal = Math.max(0, Math.floor(total));
  if (safeTotal === 0 || rowH <= 0) {
    return { start: 0, end: 0, padTop: 0, padBottom: 0, totalHeight: 0 };
  }
  const start = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const visibleCount = Math.ceil(viewportH / rowH);
  const end = Math.min(safeTotal, start + visibleCount + overscan * 2);
  const totalHeight = safeTotal * rowH;
  return {
    start,
    end,
    padTop: start * rowH,
    padBottom: Math.max(0, totalHeight - end * rowH),
    totalHeight,
  };
}
