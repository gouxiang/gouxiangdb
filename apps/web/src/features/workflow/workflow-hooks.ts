// 工作流引擎 react-query hooks（#1296 刀 C1）：定义/运行/审批的只读查询与写变更。
//
// 纪律（对齐 features/settings/pat-hooks.ts 与 license-hooks.ts）：
//   - 所有请求只走 api/client.ts 的 WorkflowApi（禁裸 fetch；两个 204 方法已在 client 内手写）；
//   - 查询 retry:false——workflow 的 4xx 都是确定性业务结果（off 404 / 不存在 404 / 冲突 409），
//     重试无意义且会在总门 off 时制造重复请求；门控 on/off 由 useWorkflowFlag 在挂载层挡，
//     默认 off 的安装根本不会挂载这些 query；
//   - 写变更（mutation）react-query 本就不重试；成功后按资源前缀失效相关查询，失败不动缓存；
//   - 本文件零 JSX、零路由、零导航，纯数据层。
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { WorkflowApi } from "../../api/client";
import type {
  ApprovalDecisionRequest,
  CreateWorkflowDefRequest,
  TriggerWorkflowRequest,
} from "@gx/shared-types";

/** 列表查询参数（page/limit 非正整数由后端回落默认；defId 空串在 client qs 层被跳过）。 */
export interface WorkflowListParams {
  page?: number;
  limit?: number;
}

export interface WorkflowRunListParams extends WorkflowListParams {
  defId?: string;
}

/**
 * 查询键工厂。前缀分层让失效可以按资源域一次性收口：
 *   ["workflow","defs"]  同时覆盖定义列表与定义详情；
 *   ["workflow","runs"]  同时覆盖运行列表与运行详情（含审批单）。
 */
export const WORKFLOW_QK = {
  defsList: (params: WorkflowListParams = {}) => ["workflow", "defs", "list", params] as const,
  def: (id: string) => ["workflow", "defs", "detail", id] as const,
  runsList: (params: WorkflowRunListParams = {}) => ["workflow", "runs", "list", params] as const,
  run: (id: string) => ["workflow", "runs", "detail", id] as const,
};

// ───────────────────────────── 只读查询 ─────────────────────────────

/** ③ GET /defs 分页列表（裸 {items,total}）。 */
export function useWorkflowDefs(params?: WorkflowListParams) {
  return useQuery({
    queryKey: WORKFLOW_QK.defsList(params),
    queryFn: () => WorkflowApi.listDefs(params),
    retry: false,
  });
}

/** ④ GET /defs/:id 单定义；id 为空时不发请求（路由参数未就绪兜底）。 */
export function useWorkflowDef(id: string | undefined) {
  return useQuery({
    queryKey: WORKFLOW_QK.def(id ?? ""),
    queryFn: () => WorkflowApi.getDef(id as string),
    enabled: !!id,
    retry: false,
  });
}

/** ⑦ GET /runs 分页列表，可按 defId 过滤。 */
export function useWorkflowRuns(params?: WorkflowRunListParams) {
  return useQuery({
    queryKey: WORKFLOW_QK.runsList(params),
    queryFn: () => WorkflowApi.listRuns(params),
    retry: false,
  });
}

/** ⑧ GET /runs/:id 运行详情（含审批单）；id 为空时不发请求。 */
export function useWorkflowRun(id: string | undefined) {
  return useQuery({
    queryKey: WORKFLOW_QK.run(id ?? ""),
    queryFn: () => WorkflowApi.getRun(id as string),
    enabled: !!id,
    retry: false,
  });
}

// ───────────────────────────── 写变更 ─────────────────────────────

/** ① POST /defs 新建草稿定义，201 回 {id}；成功后失效整个定义域（列表+详情）。 */
export function useCreateWorkflowDef() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWorkflowDefRequest) => WorkflowApi.createDef(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["workflow", "defs"] });
    },
  });
}

/** ② POST /defs/:id/publish 发布（204 无体）；状态变化，失效定义域。 */
export function usePublishWorkflowDef() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => WorkflowApi.publishDef(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["workflow", "defs"] });
    },
  });
}

/** ⑤ POST /defs/:id/trigger 手动触发（201 回 run {id}）；产生新运行，失效运行域。 */
export function useTriggerWorkflowDef() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; body?: TriggerWorkflowRequest }) =>
      WorkflowApi.triggerDef(vars.id, vars.body ?? {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["workflow", "runs"] });
    },
  });
}

/** ⑥ POST /approvals/:id/decide 审批裁决（204 无体）；run/审批单状态变化，失效运行域。 */
export function useDecideApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { approvalId: string; input: ApprovalDecisionRequest }) =>
      WorkflowApi.decideApproval(vars.approvalId, vars.input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["workflow", "runs"] });
    },
  });
}
