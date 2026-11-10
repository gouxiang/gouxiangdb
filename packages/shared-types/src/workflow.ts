// packages/shared-types/src/workflow.ts
// 自研工作流引擎（#1296 刀 C1）前后端共用契约：冻结枚举 + DAG 图结构 + HTTP DTO + 机器码。
//
// 服务端真源（字面量逐字对齐，任何一刀都不得改字面量，改了会与迁移默认值/历史行失配）：
//   - 冻结枚举/图结构：apps/api/src/domain/workflow/types.ts
//   - HTTP 契约（8 端点、状态码、query、机器码）：apps/api/src/routes/v1/workflow/index.ts
//   - 表结构（列序、可空列、JSON 文本列）：apps/api/prisma/schema.prisma（@@map workflow_defs/runs/approvals）
//
// 序列化口径（Prisma → JSON over HTTP）：
//   - graph/triggerConfig/input/context 在 DB 内是 JSON【文本】列，DTO 保持 string，不替调用方 parse；
//   - DateTime 经 JSON 序列化为 ISO string；可空列显式 `| null`，不依赖全局可选属性。
// 运行态枚举里 canceled 为单 l（美式拼写），与迁移默认值/历史行绑定，禁止改成 cancelled。

// ---------------------------------------------------------------------------
// 冻结枚举（数组用于运行期收窄/校验，联合类型用于编译期判别）
// ---------------------------------------------------------------------------

/** DAG 节点类型。 */
export const WORKFLOW_NODE_TYPES = ["trigger", "action", "approval"] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

/** 流程定义状态：draft --publish--> published；published --disable--> disabled（后续刀补）。 */
export const WORKFLOW_DEF_STATUSES = ["draft", "published", "disabled"] as const;
export type WorkflowDefStatus = (typeof WORKFLOW_DEF_STATUSES)[number];

/** 运行实例状态（canceled 单 l，冻结）。 */
export const WORKFLOW_RUN_STATUSES = [
  "pending",
  "running",
  "waiting_approval",
  "succeeded",
  "failed",
  "canceled",
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

/** 人工审批单状态。 */
export const WORKFLOW_APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type WorkflowApprovalStatus = (typeof WORKFLOW_APPROVAL_STATUSES)[number];

/** 触发器类型。 */
export const WORKFLOW_TRIGGER_TYPES = [
  "manual",
  "record_created",
  "record_updated",
  "scheduled",
] as const;
export type WorkflowTriggerType = (typeof WORKFLOW_TRIGGER_TYPES)[number];

/** 动作节点操作类型。 */
export const WORKFLOW_ACTION_OPS = ["create", "update"] as const;
export type WorkflowActionOp = (typeof WORKFLOW_ACTION_OPS)[number];

// ---------------------------------------------------------------------------
// DAG 图结构（workflow_defs.graph 解析后的内存形态；线上传输/落库始终是 JSON 字符串）
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

/**
 * 一次运行在 DAG 上的累积上下文（workflow_runs.context 解析后的形态）：
 * doneNodeIds 已完成节点（拓扑推进依据）；nodeOutputs 每个节点的产出，供后续节点占位渲染。
 */
export interface RunContext {
  doneNodeIds: string[];
  nodeOutputs: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 读模型 DTO（字段顺序严格对齐 schema.prisma 列序；JSON 列保持 string，时间列为 string）
// ---------------------------------------------------------------------------

/** workflow_defs 行的线上形态（12 列）。 */
export interface WorkflowDefDTO {
  id: string;
  name: string;
  description: string | null;
  version: number;
  status: WorkflowDefStatus;
  triggerType: WorkflowTriggerType;
  /** 触发器参数 JSON 文本（空配置为 "{}"）。 */
  triggerConfig: string;
  /** DAG 节点与连线定义 JSON 文本。 */
  graph: string;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** workflow_runs 行的线上形态（15 列）。 */
export interface WorkflowRunDTO {
  id: string;
  /** 归属的流程定义 id（无物理外键，定义删除后悬挂由应用层清理）。 */
  defId: string;
  status: WorkflowRunStatus;
  triggerType: WorkflowTriggerType;
  /** 触发所关联的实体类型（手动触发可无实体）。 */
  entityType: string | null;
  entityId: string | null;
  /** 触发输入 JSON 文本。 */
  input: string;
  /** 运行上下文/节点产出累积 JSON 文本。 */
  context: string;
  /** 当前停留节点 id（等待审批/失败时定位用）。 */
  currentNodeId: string | null;
  /** 失败原因（status=failed 时落，其余为空）。 */
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** workflow_approvals 行的线上形态（9 列）。 */
export interface WorkflowApprovalDTO {
  id: string;
  /** 归属的流程运行 id（无物理外键，悬挂由应用层清理）。 */
  runId: string;
  /** DAG 中对应的审批节点 id。 */
  nodeId: string;
  status: WorkflowApprovalStatus;
  approverId: string | null;
  comment: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 请求体（路由层手动 typeof/trim 校验；成功响应裸资源、无 {data} 信封）
// ---------------------------------------------------------------------------

/** POST /defs 请求体：name trim 后非空、graph 必须是 JSON 字符串，其余可选。 */
export interface CreateWorkflowDefRequest {
  name: string;
  /** DAG 图 JSON 文本（服务端落库前 parse + 全量校验，坏图 400 不落库）。 */
  graph: string;
  description?: string;
  /** 缺省服务端回落 "manual"；携带则必须在冻结白名单内，否则 400 WORKFLOW_TRIGGER_INVALID。 */
  triggerType?: WorkflowTriggerType;
  /** 触发器参数对象；服务端 JSON.stringify 后落 triggerConfig 文本列。 */
  triggerConfig?: Record<string, unknown>;
}

/** POST /defs/:id/trigger 请求体：整体可选，只接收形状正确的字段。 */
export interface TriggerWorkflowRequest {
  entityType?: string;
  entityId?: string;
  input?: Record<string, unknown>;
}

/** POST /approvals/:id/decide 请求体：decision 只收 approved/rejected（其它值 400）。 */
export interface ApprovalDecisionRequest {
  decision: "approved" | "rejected";
  /** 审批意见；缺省/非字符串服务端归一为 null。 */
  comment?: string | null;
}

// ---------------------------------------------------------------------------
// 响应 DTO
// ---------------------------------------------------------------------------

/** 新建定义/手动触发的 201 响应：仅回新建行 id。 */
export interface WorkflowIdDTO {
  id: string;
}

/** GET /defs 分页响应（裸 {items,total}，无 data 信封）。 */
export interface PaginatedWorkflowDefs {
  items: WorkflowDefDTO[];
  total: number;
}

/** GET /runs 分页响应（裸 {items,total}，无 data 信封）。 */
export interface PaginatedWorkflowRuns {
  items: WorkflowRunDTO[];
  total: number;
}

/** GET /runs/:id 响应：运行本体 + 其全部审批单（后端按 createdAt asc 排序）。 */
export interface WorkflowRunDetailDTO {
  run: WorkflowRunDTO;
  approvals: WorkflowApprovalDTO[];
}

// ---------------------------------------------------------------------------
// 机器码（错误信封 body.code 的全部合法取值，与路由/域层 throw 点逐一对齐）
// ---------------------------------------------------------------------------

export const WORKFLOW_ERROR_CODES = [
  /** 总门关闭：组首中间件在鉴权/DB 之前直接 404（出厂默认 off）。 */
  "WORKFLOW_DISABLED",
  "WORKFLOW_NAME_EMPTY",
  "WORKFLOW_GRAPH_INVALID",
  "WORKFLOW_TRIGGER_INVALID",
  "WORKFLOW_DEF_NOT_FOUND",
  /** 发布时定义非 draft（409）。 */
  "WORKFLOW_DEF_NOT_DRAFT",
  /** 触发时定义非 published（409）。 */
  "WORKFLOW_DEF_NOT_PUBLISHED",
  "WORKFLOW_APPROVAL_INVALID",
  "WORKFLOW_APPROVAL_NOT_FOUND",
  /** 审批单已裁决，不能重复操作（409）。 */
  "WORKFLOW_APPROVAL_DECIDED",
  /** 非白名单审批人（403）。 */
  "WORKFLOW_NOT_APPROVER",
  "WORKFLOW_RUN_NOT_FOUND",
] as const;
export type WorkflowErrorCode = (typeof WORKFLOW_ERROR_CODES)[number];

/** 工作流路由挂载点（恒挂载，可达性由总门 GX_WORKFLOW_ENGINE 请求期裁决）。 */
export const WORKFLOW_API_PREFIX = "/api/v1/workflow" as const;
