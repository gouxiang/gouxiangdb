// M3 统一导航 TanStack Query hooks：tree（权威实体树）/ menu（引用树）。
// 所有请求经 client.ts NavApi 段，禁裸 fetch。
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, NavApi } from "../../api/client";
import type {
  CreateGroupInput,
  GroupDeleteStrategy,
  MenuOp,
  MenuTreeDTO,
  MoveImpactDTO,
  NavTreeDTO,
  NavTreeQuery,
} from "@gx/shared-types";
import { indexNavNodes, type NodeIndex } from "./lib/nav-links";

/** 409 MOVE_NEEDS_CONFIRM 错误体（body 在 ApiError 公共类型之外，窄化提取）。 */
interface MoveConfirmBody {
  error?: string;
  code?: string;
  impact?: MoveImpactDTO;
}

/** 从 move 409 错误中取影响面；非确认型错误返回 null。 */
export function extractMoveImpact(e: unknown): MoveImpactDTO | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const body = e.body as MoveConfirmBody;
  if (body?.code !== "MOVE_NEEDS_CONFIRM" || !body.impact) return null;
  return body.impact;
}

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

// ============ S9 写 mutations（菜单引用层 + group 实体 + 权威移动） ============
//
// 成功后统一失效 menu/tree 两类查询；菜单编排的乐观/本地态由 NavComposer 自行持有 draft，
// 保存时一次性提交（整单事务），故这里不做逐操作乐观更新。

/** 菜单批量 diff 整单提交（PATCH menu）。 */
export function usePatchMenu() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (operations: MenuOp[]) => NavApi.patchMenu(operations),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: NAV_QK.menu });
    },
  });
}

export function useCreateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateGroupInput) => NavApi.createGroup(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: NAV_QK.menu });
      void qc.invalidateQueries({ queryKey: NAV_QK.tree });
    },
  });
}

export function useDeleteGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; strategy: GroupDeleteStrategy; targetParentId?: string }) =>
      NavApi.deleteGroup(args.id, args.strategy, args.targetParentId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: NAV_QK.menu });
      void qc.invalidateQueries({ queryKey: NAV_QK.tree });
    },
  });
}

/**
 * 权威节点移动（nav_nodes.parentId）。调用方流程：
 *   mutate 不带 confirmed → 409 MOVE_NEEDS_CONFIRM，extractMoveImpact 取影响面弹模态；
 *   用户确认后以 confirmed=true 重发同一请求 → 200。
 * 菜单层拖拽不走本 hook（菜单零副作用，AC-M3-1 边界）。
 */
export function useMoveNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; newParentId: string; confirmed: boolean }) =>
      NavApi.move(args.id, args.newParentId, args.confirmed),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: NAV_QK.tree });
      void qc.invalidateQueries({ queryKey: NAV_QK.menu });
    },
  });
}
