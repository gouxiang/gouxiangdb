// M5 统一检索数据 hook：优先打 /api/v1/search，v1 未挂载（flag off 自身 404）时自动
// 回退旧 /api/search，并经 search-adapter 归一成单一 UI 模型。组件只拿归一结果，不感知分支。
import { useQuery } from "@tanstack/react-query";
import { ApiError, SearchApi, SearchV1Api } from "../../api/client";
import { isV1NotFound, normalizeLegacy, normalizeV1, type UnifiedSearchResult } from "./search-adapter";

export const UNIFIED_SEARCH_QK = ["unified-search"] as const;

/**
 * 全局统一搜索。
 * - v1 on/shadow：v1 返归一结果（带中性状态条 notice）；
 * - v1 off：v1 404 → 回退旧 /api/search，归一为旧形态（notice=null，体验与旧版一致）；
 * - 空 q：不发请求（与旧对话框行为一致，由组件直接展示引导态）；
 * - 非 404 错误（401/403/500 等）照常抛出，不静默吞成旧链。
 */
export function useUnifiedSearch(qRaw: string) {
  const q = qRaw.trim();
  return useQuery<UnifiedSearchResult>({
    queryKey: [...UNIFIED_SEARCH_QK, q],
    enabled: q.length > 0,
    staleTime: 5_000,
    queryFn: async () => {
      try {
        const v1 = await SearchV1Api.search({ q, type: "all", mode: "auto", limit: 20 });
        return normalizeV1(v1);
      } catch (e) {
        // 仅 v1 自身 404（端点未挂载）才回退；其它错误透传给全局错误处理/组件。
        if (e instanceof ApiError && isV1NotFound(e.status, (e.body as { code?: unknown })?.code)) {
          const legacy = await SearchApi.global(q);
          return normalizeLegacy(legacy.records, legacy.docs);
        }
        throw e;
      }
    },
  });
}
