// M6-FE PAT hooks：列表查询 / 签发 / 吊销 + 企业门控探针 + 错误归一。
// 所有请求走 api/client.ts 的 PatsApi（禁裸 fetch）；错误码在 pat-labels 翻成中性中文。
// 纪律：403/404/429 不自动重试（429 尊重 Retry-After，绝不重试风暴）；写操作成功即失效列表。
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  PatsApi,
  fetchEnterpriseMeta,
  type CreatePatInput,
  type PatMetadata,
} from "../../api/client";
import type { PatErrorInfo } from "./pat-labels";

export const PAT_QK = {
  list: ["m6", "pats"] as const,
} as const;

/** 企业组织能力位查询键，与 authz 的 ["enterprise-meta"] 共用缓存（不重复请求）。 */
const ENTERPRISE_META_QK = ["enterprise-meta"] as const;

/**
 * 企业组织是否开启（GX_ENTERPRISE_ORG）。loading / 探测失败 / 非 true 一律 false（fail-closed）：
 * 未开启时 /api/v1/meta 返回 404、/api/v1/pats 亦 404，MCP 接入入口不得出现。
 */
export function useEnterpriseOrgFlag(): boolean {
  const q = useQuery({
    queryKey: ENTERPRISE_META_QK,
    queryFn: fetchEnterpriseMeta,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  return q.data?.enterpriseOrg === true;
}

/** 本人令牌列表；403/404（门控关 / 未登录竞态）不重试、不刷错误。 */
export function usePatList(enabled = true) {
  return useQuery({
    queryKey: PAT_QK.list,
    queryFn: PatsApi.list,
    enabled,
    staleTime: 10_000,
    retry: (n, e) => !isPatUnavailable(e) && n < 2,
  });
}

/** 签发令牌；成功后失效列表。429 不重试（mutation 默认不重试）。 */
export function useCreatePat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePatInput) => PatsApi.create(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PAT_QK.list });
    },
  });
}

/** 吊销令牌；成功后失效列表。 */
export function useRevokePat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => PatsApi.revoke(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PAT_QK.list });
    },
  });
}

/** 403/404/429 属「不可重试」类（门控关 / 不存在 / 限流）。 */
export function isPatUnavailable(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 403 || e.status === 404 || e.status === 429);
}

/** 把任意错误归一为 {@link PatErrorInfo}（供中性文案映射；非 ApiError 视为网络/未知）。 */
export function normalizePatError(e: unknown): PatErrorInfo {
  if (e instanceof ApiError) {
    const body = e.body as { error?: unknown; message?: unknown; code?: unknown };
    const code = typeof body?.code === "string" ? body.code : null;
    const message =
      typeof body?.error === "string"
        ? body.error
        : typeof body?.message === "string"
          ? body.message
          : null;
    return { status: e.status, code, message, retryAfterSec: e.retryAfter ?? null };
  }
  return { status: 0, code: null, message: null };
}

export type { PatMetadata };
