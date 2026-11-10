// 工作流 DAG 图前端纯函数（#1296 刀 C1）：安全解析 + 运行态判定，零 IO、零 React、零抛错。
//
// 与后端 apps/api/src/domain/workflow/graph.ts 的刻意区别：
//   后端 parseWorkflowGraph/validateWorkflowGraph 是写入口守卫，坏图直接抛 HttpError(400)；
//   前端这里面对的是【已落库】的历史 graph 文本（列表/详情/画布回显），坏数据不能让页面崩，
//   故 safeParseGraph 永不 throw，以判别联合把「坏图」显式交回调用方走降级 UI。
// 本文件只做 JSON 解析与基础形状判定（对齐后端 parse 层），不重复后端 validate 的全量业务校验
// （trigger 唯一/动作 config/环检测等）——提交前的合法性仍由服务端权威收口，前端不做第二套规则。
import type { WorkflowEdge, WorkflowGraph, WorkflowNode, WorkflowRunStatus } from "@gx/shared-types";
import { WORKFLOW_RUN_STATUSES } from "@gx/shared-types";

/** 解析成功：拿到可渲染的图对象。 */
export interface GraphParseOk {
  ok: true;
  graph: WorkflowGraph;
}

/** 解析失败：reason 是人话诊断（供降级态/调试），调用方不得据此发起写请求。 */
export interface GraphParseBad {
  ok: false;
  reason: string;
}

export type GraphParseResult = GraphParseOk | GraphParseBad;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 轻量节点形状判定：id/type 必须是非空字符串（name/config 可选，交给画布与服务端约束）。 */
function isNodeShape(v: unknown): v is WorkflowNode {
  if (!isPlainObject(v)) return false;
  return typeof v.id === "string" && v.id.trim() !== "" && typeof v.type === "string";
}

/** 轻量连线形状判定：from/to 必须是字符串。 */
function isEdgeShape(v: unknown): v is WorkflowEdge {
  if (!isPlainObject(v)) return false;
  return typeof v.from === "string" && typeof v.to === "string";
}

/**
 * 安全解析 workflow_defs.graph 存储串（JSON 文本 → WorkflowGraph）。
 * 任何坏输入（非法 JSON / 顶层非对象 / nodes|edges 缺数组 / 元素形状错）都返回 {ok:false}，
 * 绝不静默回落空图——把坏图当空跑是典型沉默逻辑错误，调用方必须显式处理失败分支。
 */
export function safeParseGraph(raw: string): GraphParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "工作流图不是合法 JSON" };
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    return { ok: false, reason: "工作流图必须是含 nodes/edges 数组的对象" };
  }
  if (!parsed.nodes.every(isNodeShape)) {
    return { ok: false, reason: "存在形状非法的节点（缺少 id 或 type）" };
  }
  if (!parsed.edges.every(isEdgeShape)) {
    return { ok: false, reason: "存在形状非法的连线（from/to 必须是字符串）" };
  }
  return { ok: true, graph: parsed as unknown as WorkflowGraph };
}

/**
 * 运行是否已进入终态（不会再被 runtime 推进）：succeeded / failed / canceled。
 * pending/running/waiting_approval 均为非终态。canceled 为冻结枚举的单 l 拼写，此处不写字面量，
 * 一律从 shared-types 的 WORKFLOW_RUN_STATUSES 派生，杜绝拼写漂移。
 */
const TERMINAL_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set<WorkflowRunStatus>([
  "succeeded",
  "failed",
  "canceled",
]);

export function isTerminalRunStatus(status: WorkflowRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/** 冻结枚举运行期守卫：未知字符串（旧前端遇到后端新枚举）不入判定，返回 false 而非抛错。 */
export function isKnownRunStatus(status: string): status is WorkflowRunStatus {
  return (WORKFLOW_RUN_STATUSES as readonly string[]).includes(status);
}
