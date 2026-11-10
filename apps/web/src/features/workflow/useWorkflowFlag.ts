// 工作流引擎能力位 hook（#1296 刀 C1）：把 client.ts 的 probeWorkflowEngine 包成 react-query。
//
// 后端路由恒挂载、GX_WORKFLOW_ENGINE 请求期裁决，出厂默认 off（404 WORKFLOW_DISABLED）。
// 能力位在单次部署内不变（探针自身还有模块级缓存），故这里 Infinity stale/gc + 不重试，
// 全会话逻辑上只探一次；切数据源节点时 client 层订阅会清模块缓存，query 缓存另由
// main.tsx 的 queryClientBridge 在 nodeId 变化时整体清空，二者不会串节点。
//
// 范式逐字对齐 features/workspace/featureFlags.ts 的 useNavV2Flag。
import { useQuery } from "@tanstack/react-query";
import { probeWorkflowEngine } from "../../api/client";

export const WORKFLOW_FLAG_QK = ["feature-flags", "workflow"] as const;

export interface WorkflowFlagState {
  /** null=探活中（或探针抛非 off 错误时尚未决）；true=引擎 on；false=总门 off。 */
  enabled: boolean | null;
  isLoading: boolean;
}

export function useWorkflowFlag(): WorkflowFlagState {
  const query = useQuery({
    queryKey: WORKFLOW_FLAG_QK,
    queryFn: probeWorkflowEngine,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  return {
    enabled: query.isSuccess ? query.data : null,
    isLoading: query.isLoading,
  };
}
