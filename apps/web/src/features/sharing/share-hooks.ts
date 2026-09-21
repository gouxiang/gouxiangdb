// apps/web/src/features/sharing/share-hooks.ts
// 分享链接的数据层与「建链接 / 关链接」动作（数据表为主，可关联对象给选择器用）。
//
// 为什么单独成文件：api/hooks.ts 已 658 行，项目有「单文件 ≤300 行」门禁，新增的分享 hooks
// 一律放这里，不往 hooks.ts 里堆。
//
// 权限口径（本文件的全部边界都在这三条里）：
//   1) 前端**不算权限**。档位只有两档（view / edit），model 里的 mode 是「创建时申请的档位」，
//      effectiveMode 是「本次访问实际生效的档位」——列表与链接区一律以 effectiveMode 为准。
//   2) degraded=true 表示分享人已被降权，edit 链接自动回落 view。这是后端每次访问现算的
//      （shareCaps.ts），不是一次性落库的状态，前端只负责把它显示出来。
//   3) 「可编辑」置灰只是提示，不是防线：后端 POST 会再判一次（tableShares.ts:98），
//      拒绝时 body.error 原样 toast（shareErrorMessage），前端不改写措辞。

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { LinkableType, LinkableResponse, ObjectShareLinkDTO, ShareMode } from "@gx/shared-types";
import { ApiError, LinkableApi, TableShares } from "../../api/client";
import { toast } from "../../components/ui";

export const SHARE_QK = {
  tableLinks: (tableId: string) => ["tableShareLinks", tableId] as const,
  linkable: (q: string, types: string, limit: number) => ["linkable", q, types, limit] as const,
};

/**
 * 本表当前的全部分享链接（档位由后端现算）。
 *
 * retry=false：表看不见 / 两级「允许分享」开关没开时后端统一 403，重试只是白等两轮——
 * 弹窗里的错误态要立刻给出原因，而不是转圈。
 */
export function useTableShareLinks(
  tableId: string | null,
  enabled = true,
): UseQueryResult<ObjectShareLinkDTO[]> {
  return useQuery({
    queryKey: SHARE_QK.tableLinks(tableId ?? ""),
    queryFn: async () => (await TableShares.list(tableId!)).links,
    enabled: !!tableId && enabled,
    retry: false,
  });
}

export function useCreateTableShareLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (p: { tableId: string; mode: ShareMode; viewId?: string }) =>
      (await TableShares.create(p.tableId, { mode: p.mode, viewId: p.viewId })).link,
    onSuccess: (_d, v) => void qc.invalidateQueries({ queryKey: SHARE_QK.tableLinks(v.tableId) }),
  });
}

export function useRevokeTableShareLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (p: { tableId: string; linkId: string }) =>
      await TableShares.remove(p.tableId, p.linkId),
    onSuccess: (_d, v) => void qc.invalidateQueries({ queryKey: SHARE_QK.tableLinks(v.tableId) }),
  });
}

/** 可关联对象搜索（后端按 libraryPolicy 过滤，前端不再二次裁剪）。 */
export function useLinkable(params: {
  q?: string;
  types?: readonly LinkableType[];
  limit?: number;
}): UseQueryResult<LinkableResponse> {
  const q = params.q ?? "";
  const types = params.types?.length ? params.types.join(",") : "";
  const limit = params.limit ?? 50;
  return useQuery({
    queryKey: SHARE_QK.linkable(q, types, limit),
    queryFn: () => LinkableApi.search({ q, types: params.types, limit }),
  });
}

/**
 * 分享类写操作失败时给用户的文案。
 *
 * 后端 HttpError 的可读文案在 **body.error**（guards.ts errorResponse 的形状是
 * { error, code }），而 ApiError.message 是拼了前缀的 "API 403: …"，直接 toast 会把
 * 状态码前缀甩到用户脸上。故优先取 body.error，其次 body.message（少数端点带），
 * 都没有才用调用方的兜底文案。
 */
export function shareErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.body?.error || e.body?.message || fallback;
  if (e instanceof Error) return e.message || fallback;
  return fallback;
}

export interface SubmitTableShareArgs {
  tableId: string;
  mode: ShareMode;
  /** 不传 = 后端回落该表第一个视图 */
  viewId?: string;
  create: (p: { tableId: string; mode: ShareMode; viewId?: string }) => Promise<unknown>;
}

/**
 * 建一条数据表分享链接：成功 toast 并失效列表，失败把后端 403 的原始文案 toast 出来。
 *
 * 抽成纯函数而不是写在组件里，是因为「置灰不能只靠前端猜」这条要能被单测直接验证——
 * 组件里的点击在 node 环境（无 jsdom）跑不起来，而这一段是真正的业务判定出口。
 */
export async function submitTableShare(args: SubmitTableShareArgs): Promise<boolean> {
  try {
    await args.create({ tableId: args.tableId, mode: args.mode, viewId: args.viewId });
    toast("已生成分享链接", "success");
    return true;
  } catch (e) {
    // 两道前置门与「可编辑」硬约束都在后端判：403 的文案直接就是给用户的答案，别改写。
    toast(shareErrorMessage(e, "创建分享链接失败"), "error");
    return false;
  }
}

/** 关链接失败同理：后端 404/403 的原文比前端兜底文案更可操作。 */
export function revokeErrorMessage(e: unknown): string {
  return shareErrorMessage(e, "关闭分享链接失败");
}
