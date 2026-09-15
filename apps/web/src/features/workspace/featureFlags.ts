// M3 feature flag：navV2 新工作区外壳开关（前端探活侧）。
//
// 后端默认 GX_ENTERPRISE_NAV=on；off 时 /api/v1/workspaces/current/menu 返 404，
// probeNavV2 据此 false，App 回退旧 AppShell/KbShell（双壳保留，M3 出口后按
// PRD :258 一个迭代再删）。flag 在单次部署内不变，结果模块级缓存 + TanStack 不重取。
import { useQuery } from "@tanstack/react-query";
import { probeNavV2 } from "../../api/client";

export const FEATURE_FLAGS_QK = ["feature-flags", "nav-v2"] as const;

export interface NavFlagState {
  /** null=探活中；true=新壳；false=旧壳。 */
  enabled: boolean | null;
  isLoading: boolean;
}

export function useNavV2Flag(): NavFlagState {
  const query = useQuery({
    queryKey: FEATURE_FLAGS_QK,
    queryFn: probeNavV2,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  return {
    enabled: query.isSuccess ? query.data : null,
    isLoading: query.isLoading,
  };
}
