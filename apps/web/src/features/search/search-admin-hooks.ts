// M5 检索管理面 hooks：嵌入配置读写、apiKey 轮换/清除、触发重建、检索状态轮询。
// 所有请求走 client.ts 的 EmbeddingAdminApi（禁直连 fetch）；错误码在 search-admin-copy
// 翻译成中性文案；管理端点 role_owner，403 由面板据 isOwner 门控 + onError 静默处理。
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EmbeddingAdminApi, ApiError } from "../../api/client";
import type {
  EmbeddingConfigPatch,
  M5AdminErrorCode,
  ReindexRequest,
} from "@gx/shared-types";

export const SEARCH_ADMIN_QK = {
  config: ["m5", "embedding-config"] as const,
  status: ["m5", "search-status"] as const,
};

/** 从 ApiError 信封取后端错误码（{error,code}；兼容个别经 details 透传的形态）。 */
export function errorCode(e: unknown): M5AdminErrorCode | string | null {
  if (!(e instanceof ApiError)) return null;
  const body = e.body as { code?: unknown; details?: { code?: unknown } };
  const code = body?.code ?? body?.details?.code;
  return typeof code === "string" ? code : null;
}

export function isForbidden(e: unknown): boolean {
  return e instanceof ApiError && e.status === 403;
}

/**
 * 检索子面未启用（GX_M5_SEARCH 关 → /api/v1 下不挂检索 admin 路由，端点回
 * 404 {code:"NOT_FOUND"}）。这不是"稍后重试能好"的故障，而是功能没开，
 * 调用方据此显示"未启用"空态并禁用重建，不要落进通用错误分支。
 */
export function isSearchNotEnabled(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 404 || errorCode(e) === "NOT_FOUND");
}

/** 读嵌入配置（apiKey 只有存在性 + 末 4，绝不回明文）。 */
export function useEmbeddingConfig(enabled: boolean) {
  return useQuery({
    queryKey: SEARCH_ADMIN_QK.config,
    queryFn: EmbeddingAdminApi.getConfig,
    enabled,
    staleTime: 10_000,
    // 403 不当作错误刷屏：面板已按 owner 门控，竞态/越权直访时静默。
    retry: (n, e) => !(e instanceof ApiError && (e.status === 403 || e.status === 404)) && n < 2,
  });
}

/** 改配置；off->cloud 缺 confirmCloud 时后端 409 NEED_CLOUD_CONFIRM，由调用方接住补确认。 */
export function usePatchEmbeddingConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: EmbeddingConfigPatch) => EmbeddingAdminApi.patchConfig(patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SEARCH_ADMIN_QK.config });
      void qc.invalidateQueries({ queryKey: SEARCH_ADMIN_QK.status });
    },
  });
}

/** 轮换 db apiKey（只写，回存在性形状）。 */
export function useRotateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (apiKey: string) => EmbeddingAdminApi.rotateApiKey(apiKey),
    onSuccess: () => void qc.invalidateQueries({ queryKey: SEARCH_ADMIN_QK.config }),
  });
}

/** 连通性自检：按已保存配置探活，不落库；失败也是 200，结论在本体 ok 字段里。 */
export function useTestConnection() {
  return useMutation({ mutationFn: () => EmbeddingAdminApi.testConnection() });
}

/** 清除 db apiKey（204 无体）。 */
export function useClearApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => EmbeddingAdminApi.clearApiKey(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: SEARCH_ADMIN_QK.config }),
  });
}

/** 触发重建索引；进行中再调 409 REINDEX_IN_PROGRESS（面板给中性提示，不当错误弹窗）。 */
export function useReindex() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReindexRequest) => EmbeddingAdminApi.reindex(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: SEARCH_ADMIN_QK.status }),
  });
}

/**
 * 检索子系统状态：30s 节流轮询，且仅在页面可见时轮询；隐藏/切走标签页立即停止，
 * 卸载即清理，不把定时器泄到全局。enabled=false（非 owner）时不发请求。
 */
export function useSearchStatus(enabled: boolean, intervalMs = 30_000) {
  const query = useQuery({
    queryKey: SEARCH_ADMIN_QK.status,
    queryFn: EmbeddingAdminApi.status,
    enabled,
    staleTime: 5_000,
    refetchInterval: (q) => {
      if (!enabled) return false;
      // 重建进行中加快到 5s 以便状态及时翻转为完成；正常 30s。
      const rebuilding = q.state.data?.index?.rebuilding === true;
      return rebuilding ? 5_000 : intervalMs;
    },
    refetchIntervalInBackground: false, // 标签页隐藏时不轮询
    retry: (n, e) => !(e instanceof ApiError && (e.status === 403 || e.status === 404)) && n < 2,
  });

  // 页面从隐藏回到可见时立即拉一次（visibilitychange），离开不停用 query 仅停止 interval。
  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void query.refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return query;
}
