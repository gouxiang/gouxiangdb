// 工作流状态/类型中文标签纯映射（#1296 刀 C1）：零 IO、零 React、零颜色令牌，可表驱动单测。
//
// 仿 features/settings/pat-labels.ts：用 Record<冻结联合, string> 做穷举映射，后端枚举一旦新增
// 成员而这里漏改，TS 立即编译报错（不依赖运行期兜底）。未知字符串的运行期入口（旧前端遇后端新值）
// 走 labelOr 回落原文，绝不渲染空白。文案是展示层唯一真源，C3 页面不得另写字面量。
import type {
  WorkflowApprovalStatus,
  WorkflowDefStatus,
  WorkflowNodeType,
  WorkflowRunStatus,
  WorkflowTriggerType,
} from "@gx/shared-types";

/** 流程定义状态：草稿 / 已发布 / 已停用。 */
export const WORKFLOW_DEF_STATUS_LABEL: Record<WorkflowDefStatus, string> = {
  draft: "草稿",
  published: "已发布",
  disabled: "已停用",
};

/** 运行实例状态（canceled 单 l 是冻结枚举，标签为「已取消」）。 */
export const WORKFLOW_RUN_STATUS_LABEL: Record<WorkflowRunStatus, string> = {
  pending: "等待执行",
  running: "执行中",
  waiting_approval: "等待审批",
  succeeded: "执行成功",
  failed: "执行失败",
  canceled: "已取消",
};

/** 人工审批单状态。 */
export const WORKFLOW_APPROVAL_STATUS_LABEL: Record<WorkflowApprovalStatus, string> = {
  pending: "待审批",
  approved: "已通过",
  rejected: "已驳回",
};

/** 触发器类型（同时出现在定义与运行 DTO 上）。 */
export const WORKFLOW_TRIGGER_TYPE_LABEL: Record<WorkflowTriggerType, string> = {
  manual: "手动触发",
  record_created: "记录创建时",
  record_updated: "记录更新时",
  scheduled: "定时触发",
};

/** DAG 节点类型（C3 画布/节点列表消费）。 */
export const WORKFLOW_NODE_TYPE_LABEL: Record<WorkflowNodeType, string> = {
  trigger: "触发器",
  action: "动作",
  approval: "审批",
};

/** 查表取标签；键不在词典（后端新增枚举的前向兼容）时回落原文，保证不渲染空白。 */
function labelOr(table: Record<string, string>, key: string): string {
  return table[key] ?? key;
}

export function workflowDefStatusLabel(status: WorkflowDefStatus | string): string {
  return labelOr(WORKFLOW_DEF_STATUS_LABEL, status);
}

export function workflowRunStatusLabel(status: WorkflowRunStatus | string): string {
  return labelOr(WORKFLOW_RUN_STATUS_LABEL, status);
}

export function workflowApprovalStatusLabel(status: WorkflowApprovalStatus | string): string {
  return labelOr(WORKFLOW_APPROVAL_STATUS_LABEL, status);
}

export function workflowTriggerTypeLabel(triggerType: WorkflowTriggerType | string): string {
  return labelOr(WORKFLOW_TRIGGER_TYPE_LABEL, triggerType);
}

export function workflowNodeTypeLabel(nodeType: WorkflowNodeType | string): string {
  return labelOr(WORKFLOW_NODE_TYPE_LABEL, nodeType);
}
