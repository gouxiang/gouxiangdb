// M5 统一检索数据 hook：v1 优先、v1 自身 404 回退旧链（逻辑在 search-query.fetchUnifiedSearch，
// 可单测注入）。组件只拿归一结果，不感知分支。
import { useQuery } from "@tanstack/react-query";
import type { UnifiedSearchResult } from "./search-adapter";
import { fetchUnifiedSearch } from "./search-query";

export const UNIFIED_SEARCH_QK = ["unified-search"] as const;

/**
 * 全局统一搜索。
 * @param qRaw 文本查询；
 * @param images 以图搜图图片（data:image/...）。
 * 文本与图片至少一个非空才发请求；v1 off 时纯文本自动回退旧链。
 */
export function useUnifiedSearch(qRaw: string, images: readonly string[] = []) {
  const q = qRaw.trim();
  const imgs = images.length > 0 ? images : undefined;
  return useQuery<UnifiedSearchResult>({
    queryKey: [...UNIFIED_SEARCH_QK, q, imgs?.length ?? 0, imgs?.[0]?.slice(0, 32) ?? ""],
    enabled: q.length > 0 || (imgs !== undefined && imgs.length > 0),
    staleTime: 5_000,
    queryFn: () => fetchUnifiedSearch(q, imgs ?? []),
  });
}
