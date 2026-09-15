// M4 统一权限 TanStack Query hooks：策略读/写、effective、visible-scope、继承影响/切换、面包屑。
// 所有请求经 client.ts AuthzApi 段，禁裸 fetch；写操作全程 toast；PUT 整单合法才提交（4xx 全拒）。
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AuthzApi } from "../../api/client";
import { toast } from "../../components/ui";
import { formatLegacyUnmappable } from "./lib/policy-model";
import type { PolicyWriteRequestDTO } from "@gx/shared-types";

export const AUTHZ_QK = {
  policies: (nodeId: string) => ["node-policies", nodeId] as const,
  effective: (nodeId: string, userId?: string) =>
    ["node-effective", nodeId, userId ?? "self"] as const,
  visibleScope: (params: string) => ["visible-scope", params] as const,
  breadcrumb: (nodeId: string) => ["node-breadcrumb", nodeId] as const,
};

export function useNodePolicies(nodeId: string | null) {
  const q = useQuery({
    queryKey: AUTHZ_QK.policies(nodeId ?? ""),
    queryFn: () => AuthzApi.getNodePolicies(nodeId as string),
    enabled: !!nodeId,
    staleTime: 10_000,
  });
  return { view: q.data, isLoading: q.isLoading, isError: q.isError, error: q.error };
}

/**
 * 整单 PUT 策略。onSuccess 返回完整 result（含 legacyUnmappable 成功提示明细）给调用方展示；
 * legacyUnmappable 是 200 成功、不可反写旧三表——只轻提示明细，不弹错误框、不回滚 UI。
 */
export function useSavePolicies(nodeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PolicyWriteRequestDTO) => AuthzApi.putNodePolicies(nodeId, body),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: AUTHZ_QK.policies(nodeId) });
      if (result.legacyUnmappable.length) {
        toast(`${result.legacyUnmappable.length} 项授权仅在企业权限引擎生效（旧权限表无对应档）`, "info");
      } else {
        toast("权限已保存", "success");
      }
    },
    onError: (e: unknown) => {
      // 整单 4xx 全拒：服务端未落任何变更，提示错误但不做局部乐观回滚（本就未乐观写）。
      const msg = e instanceof Error ? e.message : "保存失败，整单未生效";
      toast(msg, "error");
    },
  });
}

/** 供组件展示 legacyUnmappable 明细的纯格式化（转发，组件可不直接依赖 model 深路径）。 */
export { formatLegacyUnmappable };

export function useEffective(nodeId: string | null, userId?: string, enabled = true) {
  const q = useQuery({
    queryKey: AUTHZ_QK.effective(nodeId ?? "", userId),
    queryFn: () => AuthzApi.getEffective(nodeId as string, userId),
    enabled: !!nodeId && enabled,
    staleTime: 30_000,
  });
  return { view: q.data, isLoading: q.isLoading, isError: q.isError, error: q.error };
}

export function useBreadcrumb(nodeId: string | null) {
  const q = useQuery({
    queryKey: AUTHZ_QK.breadcrumb(nodeId ?? ""),
    queryFn: () => AuthzApi.getBreadcrumb(nodeId as string),
    enabled: !!nodeId,
    staleTime: 30_000,
  });
  return { crumb: q.data, isLoading: q.isLoading, isError: q.isError };
}

/** 继承影响面预览：用 mutation 承载按需 GET（带目标值与分页）。 */
export function useInheritanceImpact() {
  return useMutation({
    mutationFn: (p: { nodeId: string; value: boolean; limit?: number; offset?: number }) =>
      AuthzApi.getInheritanceImpact(p.nodeId, p.value, p.limit, p.offset),
  });
}

/**
 * 切换继承。确认后以 confirmed=true 提交；409 INHERITANCE_CONFIRM_REQUIRED 是预期分支
 * （防竞态），调用方用 extractInheritanceImpact 取附 impact 重弹同一 Modal 后原样重放，
 * 故本 mutation 不做全局 error toast——错误向上抛给调用方分流（409 重弹 / 其它提示）。
 */
export function usePatchInheritance(nodeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { value: boolean; confirmed: boolean }) =>
      AuthzApi.patchInheritance(nodeId, p.value, p.confirmed),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: AUTHZ_QK.policies(nodeId) });
      qc.invalidateQueries({ queryKey: ["node-breadcrumb"] });
      toast(res.inheritAncestors ? "已恢复从上级继承" : "已中断从上级继承", "success");
    },
  });
}
