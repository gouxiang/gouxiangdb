// 工作流图编辑期自检纯函数单测（#1317 刀 C3-a1，纯 node，零 IO/React/依赖）。
//
// 锁四件事：
//   ① 合法图返回空数组（前端视角暂未发现问题）；
//   ② 镜像后端七条校验的 8 个细分码各造反例，断言对应 code 出现（不依赖中文 message）；
//   ③ 只提示不守门：任何坏图都不 throw、不短路，一次收集多个问题；
//   ④ 自环与多节点环都归 WORKFLOW_GRAPH_CYCLE，且不误报悬空边。
import { describe, it, expect } from "vitest";
import type { WorkflowGraph } from "@gx/shared-types";
import { lintWorkflowGraph } from "../workflow-lint";

/** 合法基线图：单 trigger + 合法 action + approval，两条连通边。 */
const VALID_GRAPH: WorkflowGraph = {
  nodes: [
    { id: "n1", type: "trigger", config: {} },
    { id: "n2", type: "action", config: { op: "create", tableId: "t1", payload: {} } },
    { id: "n3", type: "approval", config: { approverIds: ["u1"] } },
  ],
  edges: [
    { from: "n1", to: "n2" },
    { from: "n2", to: "n3" },
  ],
};

/** 故意造坏图：绕过字面量类型约束。 */
function bad(raw: unknown): WorkflowGraph {
  return raw as unknown as WorkflowGraph;
}

const codesOf = (g: WorkflowGraph): string[] => lintWorkflowGraph(g).map((i) => i.code);
const hasCode = (g: WorkflowGraph, code: string): boolean => codesOf(g).includes(code);

describe("合法图", () => {
  it("结构完整的图返回空问题数组", () => {
    expect(lintWorkflowGraph(VALID_GRAPH)).toEqual([]);
  });

  it("最小合法图（单 trigger、无边）也通过", () => {
    const g: WorkflowGraph = { nodes: [{ id: "t", type: "trigger", config: {} }], edges: [] };
    expect(lintWorkflowGraph(g)).toEqual([]);
  });
});

describe("各细分码反例（逐字镜像后端 graph.ts）", () => {
  it("WORKFLOW_GRAPH_EMPTY：零节点", () => {
    expect(hasCode(bad({ nodes: [], edges: [] }), "WORKFLOW_GRAPH_EMPTY")).toBe(true);
  });

  it("WORKFLOW_NODE_INVALID：id 空串 / 纯空白 / 缺 id", () => {
    const cases = [
      { nodes: [{ id: "", type: "trigger" }], edges: [] },
      { nodes: [{ id: "   ", type: "trigger" }], edges: [] },
      { nodes: [{ type: "trigger" }], edges: [] },
    ];
    for (const c of cases) {
      expect(hasCode(bad(c), "WORKFLOW_NODE_INVALID")).toBe(true);
    }
  });

  it("WORKFLOW_NODE_DUPLICATE：两个节点 id 相同", () => {
    const g = bad({
      nodes: [
        { id: "x", type: "trigger", config: {} },
        { id: "x", type: "approval", config: {} },
      ],
      edges: [],
    });
    expect(hasCode(g, "WORKFLOW_NODE_DUPLICATE")).toBe(true);
  });

  it("WORKFLOW_NODE_UNKNOWN_TYPE：type 不在 trigger/action/approval", () => {
    const g = bad({ nodes: [{ id: "x", type: "weird", config: {} }], edges: [] });
    expect(hasCode(g, "WORKFLOW_NODE_UNKNOWN_TYPE")).toBe(true);
  });

  it("WORKFLOW_ACTION_CONFIG：缺 config / 非法 op / 缺 tableId / payload 非对象 / update 空 recordId", () => {
    const cases: unknown[] = [
      { nodes: [{ id: "a", type: "action" }], edges: [] }, // 无 config
      { nodes: [{ id: "a", type: "action", config: {} }], edges: [] }, // op 非法
      {
        nodes: [{ id: "a", type: "action", config: { op: "delete", tableId: "t", payload: {} } }],
        edges: [],
      },
      {
        nodes: [{ id: "a", type: "action", config: { op: "create", payload: {} } }],
        edges: [],
      }, // 缺 tableId
      {
        nodes: [{ id: "a", type: "action", config: { op: "create", tableId: "t", payload: "no" } }],
        edges: [],
      }, // payload 非对象
      {
        nodes: [
          {
            id: "a",
            type: "action",
            config: { op: "update", tableId: "t", payload: {}, recordId: "  " },
          },
        ],
        edges: [],
      }, // update 空 recordId
    ];
    for (const c of cases) {
      expect(hasCode(bad(c), "WORKFLOW_ACTION_CONFIG")).toBe(true);
    }
  });

  it("WORKFLOW_TRIGGER_COUNT：0 个与 2 个 trigger 都提示", () => {
    const noTrigger = bad({
      nodes: [
        { id: "a", type: "action", config: { op: "create", tableId: "t", payload: {} } },
        { id: "p", type: "approval", config: {} },
      ],
      edges: [],
    });
    const twoTrigger = bad({
      nodes: [
        { id: "t1", type: "trigger", config: {} },
        { id: "t2", type: "trigger", config: {} },
      ],
      edges: [],
    });
    expect(hasCode(noTrigger, "WORKFLOW_TRIGGER_COUNT")).toBe(true);
    expect(hasCode(twoTrigger, "WORKFLOW_TRIGGER_COUNT")).toBe(true);
  });

  it("WORKFLOW_EDGE_DANGLING：边端点引用不存在的节点", () => {
    const g = bad({
      nodes: [{ id: "n1", type: "trigger", config: {} }],
      edges: [{ from: "n1", to: "ghost" }],
    });
    expect(hasCode(g, "WORKFLOW_EDGE_DANGLING")).toBe(true);
  });

  it("WORKFLOW_GRAPH_CYCLE：自环", () => {
    const g = bad({
      nodes: [{ id: "n1", type: "trigger", config: {} }],
      edges: [{ from: "n1", to: "n1" }],
    });
    expect(hasCode(g, "WORKFLOW_GRAPH_CYCLE")).toBe(true);
    expect(hasCode(g, "WORKFLOW_EDGE_DANGLING")).toBe(false); // 自环节点存在，不算悬空
  });

  it("WORKFLOW_GRAPH_CYCLE：两节点互指与三节点环（DFS 多节点环）", () => {
    const twoNode = bad({
      nodes: [
        { id: "n1", type: "trigger", config: {} },
        { id: "n2", type: "action", config: { op: "create", tableId: "t", payload: {} } },
      ],
      edges: [
        { from: "n1", to: "n2" },
        { from: "n2", to: "n1" },
      ],
    });
    const threeNode = bad({
      nodes: [
        { id: "n1", type: "trigger", config: {} },
        { id: "n2", type: "action", config: { op: "create", tableId: "t", payload: {} } },
        { id: "n3", type: "approval", config: {} },
      ],
      edges: [
        { from: "n1", to: "n2" },
        { from: "n2", to: "n3" },
        { from: "n3", to: "n1" },
      ],
    });
    expect(hasCode(twoNode, "WORKFLOW_GRAPH_CYCLE")).toBe(true);
    expect(hasCode(threeNode, "WORKFLOW_GRAPH_CYCLE")).toBe(true);
    // 环上节点都真实存在，不应同时报悬空。
    expect(hasCode(threeNode, "WORKFLOW_EDGE_DANGLING")).toBe(false);
  });
});

describe("只提示不守门", () => {
  it("任何坏图都不 throw", () => {
    // 仅喂【形状合法】（nodes/edges 为数组）但内容坏的图——元素级坏数据由各检查项收集，绝不抛错。
    const badGraphs: unknown[] = [
      { nodes: [], edges: [] },
      { nodes: [{ type: "trigger" }], edges: [{ from: "x", to: "y" }] },
      { nodes: [{ id: "x", type: "trigger" }, { id: "x", type: "approval" }], edges: [] },
      { nodes: [{ id: "a", type: "action" }], edges: [{ from: "a", to: "a" }] },
    ];
    for (const g of badGraphs) {
      expect(() => lintWorkflowGraph(bad(g))).not.toThrow();
    }
  });

  it("一次收集多个问题、不短路：复合坏图返回多个不同 code", () => {
    const g = bad({
      nodes: [
        { id: "x", type: "trigger", config: {} },
        { id: "x", type: "weird", config: {} }, // 重复 id + 非法类型
        { id: "a", type: "action" }, // action 缺 config
      ],
      edges: [{ from: "x", to: "ghost" }], // 悬空边
    });
    const issues = lintWorkflowGraph(g);
    const distinct = new Set(issues.map((i) => i.code));
    expect(issues.length).toBeGreaterThanOrEqual(4);
    expect(distinct.has("WORKFLOW_NODE_DUPLICATE")).toBe(true);
    expect(distinct.has("WORKFLOW_NODE_UNKNOWN_TYPE")).toBe(true);
    expect(distinct.has("WORKFLOW_ACTION_CONFIG")).toBe(true);
    expect(distinct.has("WORKFLOW_EDGE_DANGLING")).toBe(true);
  });

  it("每条 issue 都带非空 message，且 code 落在 8 个镜像码内", () => {
    const g = bad({
      nodes: [{ id: "a", type: "action" }],
      edges: [{ from: "a", to: "a" }],
    });
    const allowed = new Set([
      "WORKFLOW_GRAPH_EMPTY",
      "WORKFLOW_NODE_INVALID",
      "WORKFLOW_NODE_DUPLICATE",
      "WORKFLOW_NODE_UNKNOWN_TYPE",
      "WORKFLOW_ACTION_CONFIG",
      "WORKFLOW_TRIGGER_COUNT",
      "WORKFLOW_EDGE_DANGLING",
      "WORKFLOW_GRAPH_CYCLE",
    ]);
    for (const issue of lintWorkflowGraph(g)) {
      expect(allowed.has(issue.code)).toBe(true);
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });
});
