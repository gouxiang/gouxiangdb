// 自研工作流引擎（#1296）刀 B1：DAG 图解析、结构校验与拓扑就绪计算（纯函数、零 IO）。
//
// 全部函数不碰 db/Hono/定时器，只对内存中的 WorkflowGraph 做判定，可表驱动单测。
// 坏输入一律抛 HttpError(4xx, 人话消息, 机器码)，由 service/路由的统一错误出口转信封；
// 绝不用 console 吞掉或静默返回空图——坏图被当成空跑是典型的沉默逻辑错误。

import { HttpError } from "../../httpError.js";
import {
  WORKFLOW_ACTION_OPS,
  WORKFLOW_NODE_TYPES,
  type ActionNodeConfig,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
} from "./types.js";

function badGraph(message: string, code: string): never {
  throw new HttpError(400, message, code);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 解析 workflow_defs.graph 存储串。
 * 坏 JSON / 顶层不是对象 -> 400 WORKFLOW_GRAPH_INVALID（不静默回落空图）。
 */
export function parseWorkflowGraph(raw: string): WorkflowGraph {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    badGraph("工作流图不是合法 JSON", "WORKFLOW_GRAPH_INVALID");
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    badGraph("工作流图必须是含 nodes/edges 数组的对象", "WORKFLOW_GRAPH_INVALID");
  }
  return parsed as unknown as WorkflowGraph;
}

/** 校验单个 action 节点配置；不合规抛 400 WORKFLOW_ACTION_CONFIG。 */
function validateActionConfig(node: WorkflowNode): void {
  const cfg = node.config as ActionNodeConfig | undefined;
  if (!cfg || !isPlainObject(cfg)) {
    badGraph(`动作节点「${node.id}」缺少 config`, "WORKFLOW_ACTION_CONFIG");
  }
  if (!WORKFLOW_ACTION_OPS.includes(cfg.op)) {
    badGraph(`动作节点「${node.id}」的 op 必须是 create 或 update`, "WORKFLOW_ACTION_CONFIG");
  }
  if (typeof cfg.tableId !== "string" || cfg.tableId.trim() === "") {
    badGraph(`动作节点「${node.id}」缺少 tableId`, "WORKFLOW_ACTION_CONFIG");
  }
  if (!isPlainObject(cfg.payload)) {
    badGraph(`动作节点「${node.id}」的 payload 必须是对象`, "WORKFLOW_ACTION_CONFIG");
  }
  // update 的 recordId 允许是占位串（运行期渲染），但若给了就必须是非空字符串。
  if (cfg.op === "update" && cfg.recordId !== undefined
    && (typeof cfg.recordId !== "string" || cfg.recordId.trim() === "")) {
    badGraph(`动作节点「${node.id}」update 操作的 recordId 必须是非空字符串`, "WORKFLOW_ACTION_CONFIG");
  }
}

/**
 * 深度优先环检测（三色标记的灰集变体）：沿出边递归，再次撞到当前递归栈上的节点即有环。
 * 只看图结构，节点合法性已在调用前逐节点校验。
 */
function assertAcyclic(graph: WorkflowGraph): void {
  const adjacency = new Map<string, string[]>();
  for (const n of graph.nodes) adjacency.set(n.id, []);
  for (const e of graph.edges) adjacency.get(e.from)?.push(e.to);

  const state = new Map<string, 0 | 1 | 2>(); // 0=未访问 1=在栈 2=已完成
  const visit = (id: string): void => {
    state.set(id, 1);
    for (const next of adjacency.get(id) ?? []) {
      const s = state.get(next) ?? 0;
      if (s === 1) badGraph("工作流图存在环，不允许循环依赖", "WORKFLOW_GRAPH_CYCLE");
      if (s === 0) visit(next);
    }
    state.set(id, 2);
  };
  for (const n of graph.nodes) {
    if ((state.get(n.id) ?? 0) === 0) visit(n.id);
  }
}

/**
 * 全量结构校验：节点/连线/类型/触发器唯一性/动作配置/无环。
 * 通过后图才允许落库或参与调度；任何一项不满足都抛 400，不返回布尔。
 */
export function validateWorkflowGraph(graph: WorkflowGraph): void {
  if (graph.nodes.length === 0) {
    badGraph("工作流图至少需要一个节点", "WORKFLOW_GRAPH_EMPTY");
  }

  const ids = new Set<string>();
  let triggerCount = 0;
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== "string" || node.id.trim() === "") {
      badGraph("存在缺少 id 的节点", "WORKFLOW_NODE_INVALID");
    }
    if (ids.has(node.id)) {
      badGraph(`节点 id「${node.id}」重复`, "WORKFLOW_NODE_DUPLICATE");
    }
    ids.add(node.id);
    if (!WORKFLOW_NODE_TYPES.includes(node.type)) {
      badGraph(`节点「${node.id}」类型非法：${String(node.type)}`, "WORKFLOW_NODE_UNKNOWN_TYPE");
    }
    if (node.type === "trigger") {
      triggerCount += 1;
    } else if (node.type === "action") {
      validateActionConfig(node);
    }
  }

  if (triggerCount !== 1) {
    badGraph(`工作流图必须恰好有一个 trigger 节点，当前 ${triggerCount} 个`, "WORKFLOW_TRIGGER_COUNT");
  }

  for (const edge of graph.edges as WorkflowEdge[]) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      badGraph(`连线 ${edge.from} -> ${edge.to} 引用了不存在的节点`, "WORKFLOW_EDGE_DANGLING");
    }
    if (edge.from === edge.to) {
      badGraph("工作流图存在环，不允许循环依赖", "WORKFLOW_GRAPH_CYCLE");
    }
  }

  assertAcyclic(graph);
}

/** 入口节点 id：唯一的 trigger 节点（校验已保证恰好一个）。 */
export function startNodeId(graph: WorkflowGraph): string {
  const trigger = graph.nodes.find((n) => n.type === "trigger");
  if (!trigger) badGraph("工作流图缺少 trigger 节点", "WORKFLOW_TRIGGER_COUNT");
  return trigger.id;
}

/** 某节点的直接后继（出边终点），保持 edges 声明顺序。 */
export function nextNodeIds(graph: WorkflowGraph, nodeId: string): string[] {
  return graph.edges.filter((e) => e.from === nodeId).map((e) => e.to);
}

/** 某节点的直接前驱（入边起点）。 */
export function prevNodeIds(graph: WorkflowGraph, nodeId: string): string[] {
  return graph.edges.filter((e) => e.to === nodeId).map((e) => e.from);
}

/**
 * 拓扑就绪集：未完成、且全部前驱都已完成的节点。
 * 首轮（doneNodeIds 为空）只有零入度的 trigger 就绪；随 doneNodeIds 增长逐轮放开后继。
 */
export function readyNodes(graph: WorkflowGraph, doneNodeIds: readonly string[]): WorkflowNode[] {
  const done = new Set(doneNodeIds);
  return graph.nodes.filter((node) => {
    if (done.has(node.id)) return false;
    return prevNodeIds(graph, node.id).every((pred) => done.has(pred));
  });
}
