// M5 统一检索数据 hook：v1 优先、v1 自身 404 回退旧链（逻辑在 search-query.fetchUnifiedSearch，
// 可单测注入）。组件只拿归一结果，不感知分支。
import { useQuery } from "@tanstack/react-query";
import type { UnifiedSearchResult } from "./search-adapter";
import { fetchUnifiedSearch } from "./search-query";

export const UNIFIED_SEARCH_QK = ["unified-search"] as const;

/**
 * 全局统一搜索。空 q 不发请求（与旧对话框引导态一致）；
 * v1 off 自动回退旧 /api/search；非 404（401/403/500 等）照常抛出。
 */
export function useUnifiedSearch(qRaw: string) {
  const q = qRaw.trim();
  return useQuery<UnifiedSearchResult>({
    queryKey: [...UNIFIED_SEARCH_QK, q],
    enabled: q.length > 0,
    staleTime: 5_000,
    queryFn: () => fetchUnifiedSearch(q),
  });
}
