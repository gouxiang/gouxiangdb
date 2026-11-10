// 工作流图编辑期自检纯函数（#1317 刀 C3-a1）：零 IO、零 React、零抛错，可表驱动单测。
//
// 【纪律】这是编辑期的【友好提示】，不是第二套守门规则：
//   - 后端 apps/api/src/domain/workflow/graph.ts 的 validateWorkflowGraph 是写入口权威守卫，坏图直接 400；
//   - 本文件一次性跑全部检查、【收集所有问题】（不 throw、不短路、不阻止提交），把中间态图的毛病提示给用户；
//   - 提交合法性永远以后端 400 为权威。后端规则若漂移，代价仅是前端提示暂时失准，不影响权威收口
//     （对齐 workflow-graph.ts:7-8 的既有立场）。message 是中性人话，code 才是程序判定依据，禁止按文案分支。
//
// 下方 WorkflowLintCode 的 8 个码【逐字镜像】 graph.ts 内联字面量（这些细分码定义在 api 域内、
// 不在 shared-types 的 WORKFLOW_ERROR_CODES——那是另 12 个 HTTP 层码）。前端不 import api 内部包、
// 不改 shared-types 加码，故在本文件内自定义字符串字面量联合并逐字对齐。
import { WORKFLOW_ACTION_OPS, WORKFLOW_NODE_TYPES } from "@gx/shared-types";
import type {
  ActionNodeConfig,
  WorkflowGraph,
  WorkflowNode,
} from "@gx/shared-types";

/** 8 个图校验细分码，逐字镜像 apps/api/src/domain/workflow/graph.ts（顺序对应后端七步校验）。 */
export type WorkflowLintCode =
  | "WORKFLOW_GRAPH_EMPTY"
  | "WORKFLOW_NODE_INVALID"
  | "WORKFLOW_NODE_DUPLICATE"
  | "WORKFLOW_NODE_UNKNOWN_TYPE"
  | "WORKFLOW_ACTION_CONFIG"
  | "WORKFLOW_TRIGGER_COUNT"
  | "WORKFLOW_EDGE_DANGLING"
  | "WORKFLOW_GRAPH_CYCLE";

/** 单条自检问题：code 供程序判定，message 供展示，nodeId 能定位时带上（边级问题可省略）。 */
export interface WorkflowLintIssue {
  code: WorkflowLintCode;
  message: string;
  nodeId?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 镜像 validateActionConfig：对单个 action 节点逐条收 config 毛病（同一节点可有多条）。 */
function lintActionConfig(node: WorkflowNode, out: WorkflowLintIssue[]): void {
  const cfg = node.config as ActionNodeConfig | undefined;
  if (!cfg || !isPlainObject(cfg)) {
    out.push({ code: "WORKFLOW_ACTION_CONFIG", nodeId: node.id, message: `动作节点「${node.id}」缺少 config` });
    return; // config 整体缺失，后续字段判定无意义
  }
  if (!WORKFLOW_ACTION_OPS.includes(cfg.op)) {
    out.push({ code: "WORKFLOW_ACTION_CONFIG", nodeId: node.id, message: `动作节点「${node.id}」的 op 必须是 create 或 update` });
  }
  if (typeof cfg.tableId !== "string" || cfg.tableId.trim() === "") {
    out.push({ code: "WORKFLOW_ACTION_CONFIG", nodeId: node.id, message: `动作节点「${node.id}」缺少 tableId` });
  }
  if (!isPlainObject(cfg.payload)) {
    out.push({ code: "WORKFLOW_ACTION_CONFIG", nodeId: node.id, message: `动作节点「${node.id}」的 payload 必须是对象` });
  }
  // update 的 recordId 允许占位串，但给了就必须是非空字符串（镜像 graph.ts:58-60）。
  if (
    cfg.op === "update" &&
    cfg.recordId !== undefined &&
    (typeof cfg.recordId !== "string" || cfg.recordId.trim() === "")
  ) {
    out.push({ code: "WORKFLOW_ACTION_CONFIG", nodeId: node.id, message: `动作节点「${node.id}」update 操作的 recordId 必须是非空字符串` });
  }
}

/**
 * 灰集三色 DFS 环检测（等价后端 assertAcyclic，但不抛错、只回报是否有环及首个回边节点）。
 * adjacency 已剔除自环边（自环在边遍历阶段单独报 GRAPH_CYCLE），这里只负责多节点环。
 */
function findMultiNodeCycle(graph: WorkflowGraph, idSet: Set<string>): string | null {
  const adjacency = new Map<string, string[]>();
  for (const id of idSet) adjacency.set(id, []);
  for (const e of graph.edges) {
    if (e.from === e.to) continue; // 自环另计，避免同一环被重复报告
    adjacency.get(e.from)?.push(e.to);
  }
  const state = new Map<string, 0 | 1 | 2>(); // 0=未访问 1=在递归栈 2=已完成
  let cycleAt: string | null = null;
  const visit = (id: string): void => {
    state.set(id, 1);
    for (const next of adjacency.get(id) ?? []) {
      if (cycleAt !== null) return; // 已发现环，提前收敛
      const s = state.get(next) ?? 0;
      if (s === 1) {
        cycleAt = next; // 再次撞到栈上节点 → 回边，存在环
        return;
      }
      if (s === 0) visit(next);
    }
    state.set(id, 2);
  };
  for (const id of idSet) {
    if (cycleAt !== null) break;
    if ((state.get(id) ?? 0) === 0) visit(id);
  }
  return cycleAt;
}

/**
 * 编辑期图自检：跑齐后端七条校验，收集全部问题（空数组 = 前端视角暂未发现问题）。
 * 与后端「遇错即抛」不同，这里不短路，以便一次把草稿的所有毛病提示给用户；永不 throw。
 */
export function lintWorkflowGraph(graph: WorkflowGraph): WorkflowLintIssue[] {
  const issues: WorkflowLintIssue[] = [];

  // ① 节点非空（WORKFLOW_GRAPH_EMPTY）。
  if (graph.nodes.length === 0) {
    issues.push({ code: "WORKFLOW_GRAPH_EMPTY", message: "工作流图至少需要一个节点" });
  }

  // ②③④⑤ 逐节点：id 合法 / id 唯一 / 类型合法 / action config；顺带统计 trigger 数。
  const idSet = new Set<string>();
  let triggerCount = 0;
  for (const node of graph.nodes as Array<WorkflowNode | undefined>) {
    if (!node || typeof node.id !== "string" || node.id.trim() === "") {
      issues.push({ code: "WORKFLOW_NODE_INVALID", message: "存在缺少 id 的节点" });
      continue; // 无有效 id，无法参与去重/类型定位
    }
    if (idSet.has(node.id)) {
      issues.push({ code: "WORKFLOW_NODE_DUPLICATE", nodeId: node.id, message: `节点 id「${node.id}」重复` });
    }
    idSet.add(node.id);
    if (!WORKFLOW_NODE_TYPES.includes(node.type)) {
      issues.push({ code: "WORKFLOW_NODE_UNKNOWN_TYPE", nodeId: node.id, message: `节点「${node.id}」类型非法：${String(node.type)}` });
    }
    if (node.type === "trigger") {
      triggerCount += 1;
    } else if (node.type === "action") {
      lintActionConfig(node, issues);
    }
  }

  // ⑥ 恰好一个 trigger（WORKFLOW_TRIGGER_COUNT）：0 个或多个都提示。
  if (triggerCount !== 1) {
    issues.push({ code: "WORKFLOW_TRIGGER_COUNT", message: `工作流图必须恰好有一个 trigger 节点，当前 ${triggerCount} 个` });
  }

  // ⑦ 边：悬空端点 / 自环；多节点环交给 DFS。
  for (const edge of graph.edges) {
    if (!idSet.has(edge.from) || !idSet.has(edge.to)) {
      issues.push({ code: "WORKFLOW_EDGE_DANGLING", message: `连线 ${edge.from} -> ${edge.to} 引用了不存在的节点` });
    }
    if (edge.from === edge.to) {
      issues.push({ code: "WORKFLOW_GRAPH_CYCLE", nodeId: edge.from, message: "工作流图存在环，不允许循环依赖" });
    }
  }
  const cycleAt = findMultiNodeCycle(graph, idSet);
  if (cycleAt !== null) {
    issues.push({ code: "WORKFLOW_GRAPH_CYCLE", nodeId: cycleAt, message: "工作流图存在环，不允许循环依赖" });
  }

  return issues;
}
