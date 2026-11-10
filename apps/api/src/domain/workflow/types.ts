// 自研工作流引擎（#1296）刀 B1：领域类型与冻结枚举。
//
// 本文件零 import、零 IO，只放类型与字面量真源，供 graph/lock/runtime/executor/service 共用。
// 运行态枚举为刀 B 施工书亲验冻结值，任何一刀都不得改字面量（改了会与迁移默认值/历史行失配）：
//   流程定义 def      ：draft | published | disabled
//   运行实例 run      ：pending | running | waiting_approval | succeeded | failed | canceled（canceled 单 l）
//   人工审批 approval ：pending | approved | rejected
//   触发类型 trigger  ：manual | record_created | record_updated | scheduled
//   DAG 节点类型      ：trigger | action | approval

// ---------------------------------------------------------------------------
// 冻结枚举（数组用于运行期校验，联合类型用于编译期收窄）
// ---------------------------------------------------------------------------

export const WORKFLOW_NODE_TYPES = ["trigger", "action", "approval"] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

export const WORKFLOW_DEF_STATUSES = ["draft", "published", "disabled"] as const;
export type WorkflowDefStatus = (typeof WORKFLOW_DEF_STATUSES)[number];

export const WORKFLOW_RUN_STATUSES = [
  "pending",
  "running",
  "waiting_approval",
  "succeeded",
  "failed",
  "canceled",
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export const WORKFLOW_APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type WorkflowApprovalStatus = (typeof WORKFLOW_APPROVAL_STATUSES)[number];

export const WORKFLOW_TRIGGER_TYPES = [
  "manual",
  "record_created",
  "record_updated",
  "scheduled",
] as const;
export type WorkflowTriggerType = (typeof WORKFLOW_TRIGGER_TYPES)[number];

export const WORKFLOW_ACTION_OPS = ["create", "update"] as const;
export type WorkflowActionOp = (typeof WORKFLOW_ACTION_OPS)[number];

// ---------------------------------------------------------------------------
// DAG 图结构（持久化在 workflow_defs.graph，JSON 文本；本类型是其解析后的内存形态）
// ---------------------------------------------------------------------------

/** 触发器节点配置：本期 manual 触发无额外参数，保留空对象形态以便后续触发器扩展。 */
export type TriggerNodeConfig = Record<string, never>;

/** 动作节点配置：对某张表执行 create/update；payload 是字段 id -> 写入值（可含占位）。 */
export interface ActionNodeConfig {
  op: WorkflowActionOp;
  tableId: string;
  payload: Record<string, unknown>;
  /** update 时必填的目标记录 id；create 时忽略。同样支持占位渲染。 */
  recordId?: string;
}

/** 审批节点配置：approverIds 为空表示任意有权者可审批（具体校验在 service 收口）。 */
export interface ApprovalNodeConfig {
  approverIds?: string[];
}

/** 节点配置判别联合：按 node.type 取对应 config 形状。 */
export type NodeConfig = TriggerNodeConfig | ActionNodeConfig | ApprovalNodeConfig;

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  /** 展示名（可选，不参与调度）。 */
  name?: string;
  config?: NodeConfig;
}

export interface WorkflowEdge {
  /** 起点节点 id。 */
  from: string;
  /** 终点节点 id。 */
  to: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

// ---------------------------------------------------------------------------
// 运行上下文（持久化在 workflow_runs.context，JSON 文本）
// ---------------------------------------------------------------------------

/**
 * 一次运行在 DAG 上的累积上下文：
 *   doneNodeIds 已完成节点（拓扑推进依据）；
 *   nodeOutputs 每个节点的产出（action 落库后的 record 摘要等），供后续节点占位渲染。
 */
export interface RunContext {
  doneNodeIds: string[];
  nodeOutputs: Record<string, unknown>;
}

/** 新建运行的初始上下文（不可变常量，调用方按需浅拷贝扩展）。 */
export const EMPTY_RUN_CONTEXT: RunContext = { doneNodeIds: [], nodeOutputs: {} };

/** 动作节点执行结果：actionExec 返回，executor 以当前节点 id 为键并入 RunContext.nodeOutputs。 */
export interface NodeExecutionOutcome {
  /** action 落库后的记录 id（无落库动作时为 null）。 */
  recordId: string | null;
  /** 并入 nodeOutputs 的结构化产出。 */
  output: Record<string, unknown>;
}
