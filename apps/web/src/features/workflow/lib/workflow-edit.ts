// 工作流 DAG 草稿不可变编辑纯函数（#1317 刀 C3-a1）：零 IO、零 React、零抛错，可表驱动单测。
//
// 职责边界：只管「画布草稿」的增删改与序列化（配合 React setState 的引用变化），不做合法性守门——
//   编辑期可能临时存在环 / 缺 trigger / action 缺 config 等中间态，提交合法性永远以后端
//   validateWorkflowGraph 的 400 为权威（对齐 workflow-graph.ts:7-8 的立场）；编辑期友好提示由
//   workflow-lint.ts 另出，不与本文件混责。
// 草稿类型直接复用冻结契约 WorkflowGraph，不另造形状；所有更新均不可变（返回新对象/新数组，绝不 mutate 入参）。
import type {
  NodeConfig,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeType,
} from "@gx/shared-types";

/** 草稿就是一张图：编辑器 state 直接持有 WorkflowGraph，提交时 serializeGraph 成 JSON 文本。 */
export type WorkflowDraft = WorkflowGraph;

/** 各类节点新建 id 的前缀（与 type 同名，画布上一眼可辨节点种类）。 */
export const NODE_ID_PREFIX: Record<WorkflowNodeType, string> = {
  trigger: "trigger",
  action: "action",
  approval: "approval",
};

/** 节点下拉选项（连线目标选择等）：value=id，label 优先用去空白后的 name，回落 id。 */
export interface NodeOption {
  value: string;
  label: string;
}

/** addNode 入参：type 必填，name/config 可选（config 缺省按 type 给安全空形态）。 */
export interface AddNodeInput {
  type: WorkflowNodeType;
  name?: string;
  config?: NodeConfig;
}

/** addNode 结果：新图 + 新节点 id（调用方常需立刻选中/连线该节点）。 */
export interface AddNodeResult {
  graph: WorkflowGraph;
  nodeId: string;
}

/** addEdge 结果：ok=false 表示被拒绝（自环/重复），此时 graph 原样返回（同一引用）。 */
export interface AddEdgeResult {
  graph: WorkflowGraph;
  ok: boolean;
}

/** 生成 `${prefix}_N` 且不与现有节点 id 冲突的下一个 id：N 从 1 起取最小未占用值。 */
export function makeNodeId(type: WorkflowNodeType, graph: WorkflowGraph): string {
  const prefix = NODE_ID_PREFIX[type];
  const taken = new Set(graph.nodes.map((n) => n.id));
  let n = 1;
  let id = `${prefix}_${n}`;
  while (taken.has(id)) {
    n += 1;
    id = `${prefix}_${n}`;
  }
  return id;
}

/**
 * 新建一张含单个 trigger 节点、空连线的图——天然满足后端「节点非空 + 恰好一个 trigger」。
 * triggerName 缺省则不挂 name（展示层自行回落 id/类型标签）。
 */
export function createEmptyGraph(triggerName?: string): WorkflowGraph {
  const node: WorkflowNode = {
    id: makeNodeId("trigger", { nodes: [], edges: [] }),
    type: "trigger",
    config: {},
  };
  if (triggerName !== undefined) node.name = triggerName;
  return { nodes: [node], edges: [] };
}

/**
 * 追加节点：自动分配不冲突 id。
 * config 缺省按 type 给安全空形态——当前三类都先给 {}（action 的 {} 缺 op/tableId/payload，
 * 属编辑期中间态，由 workflow-lint 提示补全后才能通过后端校验）。不可变。
 */
export function addNode(graph: WorkflowGraph, input: AddNodeInput): AddNodeResult {
  const nodeId = makeNodeId(input.type, graph);
  const node: WorkflowNode = {
    id: nodeId,
    type: input.type,
    config: input.config ?? ({} as NodeConfig),
  };
  if (input.name !== undefined) node.name = input.name;
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, nodeId };
}

/** 删除节点并级联删除所有 from 或 to 引用它的边（绝不留悬空边）。不可变。 */
export function removeNode(graph: WorkflowGraph, nodeId: string): WorkflowGraph {
  return {
    nodes: graph.nodes.filter((n) => n.id !== nodeId),
    edges: graph.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
  };
}

/**
 * 只允许改 name/config 的补丁；不提供改 id/type 的入口（type 变更需删重建，避免 NodeConfig
 * 判别联合形状错乱）。节点不存在时 map 原样透传，等于返回等价新图。不可变。
 */
export function updateNode(
  graph: WorkflowGraph,
  nodeId: string,
  patch: Partial<Pick<WorkflowNode, "name" | "config">>,
): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)),
  };
}

/** 追加连线：自环（from===to）或完全相同的边已存在时拒绝（ok:false，回原 graph 同一引用）。不可变。 */
export function addEdge(graph: WorkflowGraph, from: string, to: string): AddEdgeResult {
  if (from === to) return { graph, ok: false };
  const duplicated = graph.edges.some((e) => e.from === from && e.to === to);
  if (duplicated) return { graph, ok: false };
  return { graph: { ...graph, edges: [...graph.edges, { from, to }] }, ok: true };
}

/** 删除一条指定方向的边；不存在时 filter 幂等，原样返回等价新图。不可变。 */
export function removeEdge(graph: WorkflowGraph, from: string, to: string): WorkflowGraph {
  return {
    ...graph,
    edges: graph.edges.filter((e) => !(e.from === from && e.to === to)),
  };
}

/** 节点下拉选项：保持 nodes 声明顺序；name 去空白后非空则用 name，否则回落 id。 */
export function nodeOptions(graph: WorkflowGraph): NodeOption[] {
  return graph.nodes.map((n) => {
    const trimmed = n.name?.trim();
    return { value: n.id, label: trimmed ? trimmed : n.id };
  });
}

/** 序列化为提交给 POST /defs 的 graph 字段（JSON 文本）。 */
export function serializeGraph(graph: WorkflowGraph): string {
  return JSON.stringify(graph);
}
