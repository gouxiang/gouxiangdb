// apps/web/src/features/kb/canvas/linkable-hooks.ts
// 关联插入选择器的数据源 hooks。
//
// 为什么要单独一个文件：可关联对象的过滤发生在服务端（GET /api/linkable），
// 前端只负责把结果渲染出来——「看得见的才能被关联」这条不变式不在前端兜。
// 本文件的 queryKey 前缀挂在 ["linkable", ...] 下，与 kb 自己的 key 空间隔离。

import { useQuery } from "@tanstack/react-query";
import { LinkableApi, Views, type LinkableItem, type LinkableType } from "../../../api/client";

/** 选择器里可作为关联块插入的类型（与后端 LinkableType 同集；base/kb 是「库」本身，不作插入目标）。 */
export const LINKABLE_PICKABLE_TYPES: readonly LinkableType[] = ["doc", "canvas", "table"];

/**
 * 当前用户【看得见】的可关联对象。
 *
 * @param opts.q       关键词（空 = 不按关键词过滤；服务端 trim 并截断到 100 字）
 * @param opts.types   类型过滤（空数组 = 全部类型）
 * @param opts.limit   条数上限（后端默认 50、上限 200）
 * @param opts.enabled false 时不发请求（分享页 / 无 kbId 时用）
 */
export function useLinkable(opts: {
  q?: string;
  types?: LinkableType[];
  limit?: number;
  enabled?: boolean;
}) {
  const q = opts.q?.trim() ?? "";
  const types = opts.types ?? [];
  const limit = opts.limit ?? 50;
  const enabled = opts.enabled ?? true;
  // types 排序后再进 key：勾选顺序不同不应产生重复缓存 / 重复请求
  const typesKey = [...types].sort().join(",");

  return useQuery({
    queryKey: ["linkable", q, typesKey, limit],
    queryFn: () => LinkableApi.search({ q, types, limit }),
    enabled,
    // 选择器是弹层：失败不重试，避免用户在弹层关闭后还收到串行重试。
    retry: false,
    staleTime: 15_000,
  });
}

/** 结果里实际要用的两段（items / truncated），组件只消费这个。 */
export interface LinkableResult {
  items: LinkableItem[];
  truncated: boolean;
}

/**
 * 一张表的视图清单（「插入数据表」时选插哪个视图：网格/看板/画廊/日历…）。
 * 只在用户真正展开某张表时才 enabled，避免每渲染一行都打请求。
 */
export function useTableViews(tableId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["linkable", "views", tableId ?? ""],
    queryFn: () => Views.list(tableId!).then((r) => r.views),
    enabled: enabled && !!tableId,
    retry: false,
    staleTime: 60_000,
  });
}
