// M4 权限能力位适配 hook：GET /api/v1/meta → authzManage 严格门控。
//
// 使用方（PermPanel / 继承开关 / 保存按钮）只认 `canManage`：
//   - 探针加载中（meta 尚未回来）= false（fail-closed，首帧绝不闪编辑入口）；
//   - meta 缺失 / authzManage!==true / 探针失败 = false；
//   - 仅明确 true 才放行。
// 只读解释类能力不要使用本 hook 做门控（effective/visible-scope/breadcrumb 常上线）。
import { useQuery } from "@tanstack/react-query";
import { fetchEnterpriseMeta, type EnterpriseMeta } from "../../api/client";
import { authzGateState, canManageAuthz, type AuthzGateState } from "./lib/capability";

export const AUTHZ_META_QK = ["enterprise-meta"] as const;

export interface AuthzCapability {
  /** 是否放行权限写入口（策略编辑/保存、继承开关）。加载中也为 false。 */
  canManage: boolean;
  /** loading | off | on；loading 仅用于需要显式骨架的场景，渲染门控一律看 canManage。 */
  gate: AuthzGateState;
  isLoading: boolean;
  meta: EnterpriseMeta | null | undefined;
}

export function useAuthzCapability(): AuthzCapability {
  // 能力位单次部署内不变：拉取一次，会话内缓存，不重试不窗口聚焦重拉（失败即关）。
  const q = useQuery({
    queryKey: AUTHZ_META_QK,
    queryFn: fetchEnterpriseMeta,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  const canManage = canManageAuthz(q.data);
  return {
    canManage,
    gate: authzGateState(q.data, q.isLoading),
    isLoading: q.isLoading,
    meta: q.data,
  };
}
