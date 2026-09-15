// M3 统一导航 TanStack Query hooks：tree（权威实体树）/ menu（引用树）。
// 所有请求经 client.ts NavApi 段，禁裸 fetch。写 mutation 在 S9 NavComposer 追加。
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavApi } from "../../api/client";
import type { MenuTreeDTO, NavTreeDTO, NavTreeQuery } from "@gx/shared-types";
import { indexNavNodes, type NodeIndex } from "./lib/nav-links";

export const NAV_QK = {
  tree: ["nav-tree"] as const,
  treeFiltered: (params: NavTreeQuery) =>
    [
      "nav-tree",
      params.parentId ?? "root",
      params.maxDepth ?? "",
      params.kind ?? "",
      params.all ? "all" : "",
    ] as const,
  menu: ["nav-menu"] as const,
};

/** 菜单引用树（新壳一级导航数据源）；M3 全员同一份不剪枝。 */
export function useNavMenu(): {
  menu: MenuTreeDTO | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
} {
  const q = useQuery({ queryKey: NAV_QK.menu, queryFn: NavApi.menu, staleTime: 10_000 });
  return { menu: q.data, isLoading: q.isLoading, isError: q.isError, error: q.error };
}

/**
 * 权威实体树。后端要求非 all 请求必须显式锚点（省略 parentId=全量→400，10 万节点保护）：
 * 根层传 parentId="root"，子树传具体节点 id。SecondaryNav 按容器锚点取子树。
 */
export function useNavTree(params: NavTreeQuery = { parentId: "root", maxDepth: 2 }): {
  tree: NavTreeDTO | undefined;
  isLoading: boolean;
  isError: boolean;
} {
  const q = useQuery({
    queryKey: NAV_QK.treeFiltered(params),
    queryFn: () => NavApi.tree(params),
    staleTime: 10_000,
  });
  return { tree: q.data, isLoading: q.isLoading, isError: q.isError };
}

/**
 * 深层根块（普通登录通道，非 all=1 管理开关）：parentId=root + maxDepth 取后端上限 10，
 * 取回浅层活节点供菜单 shortcut 的 href 祖先解析（base/kb 恒在 depth 1）。
 * 注意：① 不能省略 parentId（全量 400）；② 不能用 all=1（管理员通道，普通成员 403）。
 * 深于 10 层的实体不在本块（其 shortcut 显示但 href=null 禁用，不白屏），S9 锚点子树精确取。
 */
export function useNavTreeDeep(): {
  tree: NavTreeDTO | undefined;
  isLoading: boolean;
} {
  const q = useQuery({
    queryKey: ["nav-tree", "root", "deep", 10],
    queryFn: () => NavApi.tree({ parentId: "root", maxDepth: 10 }),
    staleTime: 10_000,
  });
  return { tree: q.data, isLoading: q.isLoading };
}

/** 管理全量 tree（all=1，仅组织管理员可用）：含软删节点，S9 编排/清理态使用。 */
export function useNavTreeAll(): {
  tree: NavTreeDTO | undefined;
  isLoading: boolean;
} {
  const q = useQuery({
    queryKey: ["nav-tree", "all"],
    queryFn: () => NavApi.tree({ all: true }),
    staleTime: 10_000,
  });
  return { tree: q.data, isLoading: q.isLoading };
}

/** 由深层 tree 构造节点索引（shortcut href 祖先解析）。 */
export function useNavNodeIndex(): { index: NodeIndex; isLoading: boolean } {
  const { tree, isLoading } = useNavTreeDeep();
  const index = useMemo(() => indexNavNodes(tree?.items ?? []), [tree?.items]);
  return { index, isLoading };
}
