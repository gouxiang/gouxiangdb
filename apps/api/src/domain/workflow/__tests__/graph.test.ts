// 刀 B1 graph.ts 纯函数表驱动单测（零 DB、零 IO）：解析、结构校验、环检测、拓扑就绪。
// 坏输入必须抛 HttpError(400, 机器码)，绝不静默回落空图。

import { describe, expect, it } from "vitest";
import { HttpError } from "../../../httpError.js";
import {
  nextNodeIds,
  parseWorkflowGraph,
  prevNodeIds,
  readyNodes,
  startNodeId,
  validateWorkflowGraph,
} from "../graph.js";
import type { NodeConfig, WorkflowGraph, WorkflowNode } from "../types.js";

function expectHttpCode(fn: () => unknown, status: number, code: string): void {
  try {
    fn();
    throw new Error("预期抛错但未抛");
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(status);
    expect((e as HttpError).code).toBe(code);
  }
}

function node(id: string, type: WorkflowNode["type"], extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id, type, ...extra };
}

const actionCfg = { op: "create" as const, tableId: "t1", payload: { f1: "v" } };

describe("parseWorkflowGraph", () => {
  it("合法图正常解析", () => {
    const g = parseWorkflowGraph(JSON.stringify({ nodes: [node("tr", "trigger")], edges: [] }));
    expect(g.nodes).toHaveLength(1);
  });
  it("坏 JSON -> 400 WORKFLOW_GRAPH_INVALID", () => {
    expectHttpCode(() => parseWorkflowGraph("{not-json"), 400, "WORKFLOW_GRAPH_INVALID");
  });
  it("顶层缺 nodes/edges -> 400 WORKFLOW_GRAPH_INVALID", () => {
    expectHttpCode(() => parseWorkflowGraph(JSON.stringify({ nodes: [] })), 400, "WORKFLOW_GRAPH_INVALID");
    expectHttpCode(() => parseWorkflowGraph(JSON.stringify({ nodes: [], edges: {} })), 400, "WORKFLOW_GRAPH_INVALID");
  });
});

describe("validateWorkflowGraph 结构校验", () => {
  it("空节点 -> WORKFLOW_GRAPH_EMPTY", () => {
    expectHttpCode(() => validateWorkflowGraph({ nodes: [], edges: [] }), 400, "WORKFLOW_GRAPH_EMPTY");
  });
  it("节点 id 重复 -> WORKFLOW_NODE_DUPLICATE", () => {
    const g: WorkflowGraph = { nodes: [node("a", "trigger"), node("a", "action", { config: actionCfg })], edges: [] };
    expectHttpCode(() => validateWorkflowGraph(g), 400, "WORKFLOW_NODE_DUPLICATE");
  });
  it("未知节点类型 -> WORKFLOW_NODE_UNKNOWN_TYPE", () => {
    const g = { nodes: [{ id: "x", type: "nope" }], edges: [] } as unknown as WorkflowGraph;
    expectHttpCode(() => validateWorkflowGraph(g), 400, "WORKFLOW_NODE_UNKNOWN_TYPE");
  });
  it("无 trigger / 两个 trigger -> WORKFLOW_TRIGGER_COUNT", () => {
    const noTrigger: WorkflowGraph = { nodes: [node("a1", "action", { config: actionCfg })], edges: [] };
    expectHttpCode(() => validateWorkflowGraph(noTrigger), 400, "WORKFLOW_TRIGGER_COUNT");
    const twoTrigger: WorkflowGraph = { nodes: [node("t1", "trigger"), node("t2", "trigger")], edges: [] };
    expectHttpCode(() => validateWorkflowGraph(twoTrigger), 400, "WORKFLOW_TRIGGER_COUNT");
  });
  it("action 缺 tableId / op 非法 -> WORKFLOW_ACTION_CONFIG", () => {
    const badOp: WorkflowGraph = {
      nodes: [node("tr", "trigger"), node("ac", "action", { config: { op: "delete", tableId: "t1", payload: {} } as unknown as NodeConfig })],
      edges: [{ from: "tr", to: "ac" }],
    };
    expectHttpCode(() => validateWorkflowGraph(badOp), 400, "WORKFLOW_ACTION_CONFIG");
    const noTable: WorkflowGraph = {
      nodes: [node("tr", "trigger"), node("ac", "action", { config: { op: "create", payload: {} } as unknown as NodeConfig })],
      edges: [{ from: "tr", to: "ac" }],
    };
    expectHttpCode(() => validateWorkflowGraph(noTable), 400, "WORKFLOW_ACTION_CONFIG");
  });
  it("连线引用不存在节点 -> WORKFLOW_EDGE_DANGLING", () => {
    const g: WorkflowGraph = {
      nodes: [node("tr", "trigger")],
      edges: [{ from: "tr", to: "ghost" }],
    };
    expectHttpCode(() => validateWorkflowGraph(g), 400, "WORKFLOW_EDGE_DANGLING");
  });
  it("自环 / 多节点环 -> WORKFLOW_GRAPH_CYCLE", () => {
    const selfLoop: WorkflowGraph = {
      nodes: [node("tr", "trigger"), node("ac", "action", { config: actionCfg })],
      edges: [{ from: "ac", to: "ac" }],
    };
    expectHttpCode(() => validateWorkflowGraph(selfLoop), 400, "WORKFLOW_GRAPH_CYCLE");
    const cycle: WorkflowGraph = {
      nodes: [
        node("tr", "trigger"),
        node("a1", "action", { config: actionCfg }),
        node("a2", "action", { config: actionCfg }),
      ],
      edges: [
        { from: "tr", to: "a1" }, { from: "a1", to: "a2" }, { from: "a2", to: "a1" },
      ],
    };
    expectHttpCode(() => validateWorkflowGraph(cycle), 400, "WORKFLOW_GRAPH_CYCLE");
  });
  it("合法线性 DAG 校验通过", () => {
    const g: WorkflowGraph = {
      nodes: [
        node("tr", "trigger"),
        node("ac", "action", { config: actionCfg }),
        node("ap", "approval", { config: { approverIds: ["u1"] } }),
      ],
      edges: [{ from: "tr", to: "ac" }, { from: "ac", to: "ap" }],
    };
    expect(() => validateWorkflowGraph(g)).not.toThrow();
  });
});

describe("拓扑就绪计算", () => {
  // 菱形：tr -> a1,a2 -> join(approval)
  const diamond: WorkflowGraph = {
    nodes: [
      node("tr", "trigger"),
      node("a1", "action", { config: actionCfg }),
      node("a2", "action", { config: actionCfg }),
      node("join", "approval"),
    ],
    edges: [
      { from: "tr", to: "a1" }, { from: "tr", to: "a2" },
      { from: "a1", to: "join" }, { from: "a2", to: "join" },
    ],
  };
  it("startNodeId 指向唯一 trigger", () => {
    expect(startNodeId(diamond)).toBe("tr");
  });
  it("next/prev 邻接", () => {
    expect(nextNodeIds(diamond, "tr").sort()).toEqual(["a1", "a2"]);
    expect(prevNodeIds(diamond, "join").sort()).toEqual(["a1", "a2"]);
  });
  it("首轮只有零入度 trigger 就绪", () => {
    expect(readyNodes(diamond, []).map((n) => n.id)).toEqual(["tr"]);
  });
  it("trigger 完成后 a1/a2 同时就绪", () => {
    expect(readyNodes(diamond, ["tr"]).map((n) => n.id).sort()).toEqual(["a1", "a2"]);
  });
  it("汇合点 join 必须等两个前驱都完成才就绪", () => {
    expect(readyNodes(diamond, ["tr", "a1"]).map((n) => n.id)).toEqual(["a2"]);
    expect(readyNodes(diamond, ["tr", "a1", "a2"]).map((n) => n.id)).toEqual(["join"]);
  });
  it("已完成节点不再出现在就绪集", () => {
    expect(readyNodes(diamond, ["tr", "a1", "a2", "join"])).toHaveLength(0);
  });
});
