// 工作流草稿不可变编辑纯函数单测（#1317 刀 C3-a1，纯 node，零 IO/React/依赖）。
//
// 锁四件事：
//   ① id 分配不冲突、createEmptyGraph 天然满足「单 trigger + 空边」；
//   ② 所有更新不可变——入参对象/数组绝不被 mutate，返回的是新引用（配合 React setState）；
//   ③ removeNode 级联删边、addEdge 自环/重复拒绝（ok:false 回原引用）；
//   ④ nodeOptions 的 name 回落与保序、serializeGraph 可 JSON.parse 回等形。
import { describe, it, expect } from "vitest";
import type { ActionNodeConfig, WorkflowGraph } from "@gx/shared-types";
import {
  NODE_ID_PREFIX,
  makeNodeId,
  createEmptyGraph,
  addNode,
  removeNode,
  updateNode,
  addEdge,
  removeEdge,
  nodeOptions,
  serializeGraph,
} from "../workflow-edit";

/** 深快照：用于断言操作后入参未被 mutate。 */
function snapshot<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe("makeNodeId 冲突避让", () => {
  it("从 1 起取最小未占用 id，已占用则顺延", () => {
    const g: WorkflowGraph = {
      nodes: [
        { id: "action_1", type: "action", config: {} },
        { id: "action_2", type: "action", config: {} },
      ],
      edges: [],
    };
    expect(makeNodeId("action", g)).toBe("action_3");
  });

  it("不同类型前缀独立计数，互不干扰", () => {
    const g: WorkflowGraph = { nodes: [{ id: "trigger_1", type: "trigger", config: {} }], edges: [] };
    expect(makeNodeId("action", g)).toBe("action_1");
    expect(makeNodeId("approval", g)).toBe("approval_1");
  });

  it("中间出现空洞时回填最小未占用值（不盲目递增）", () => {
    const g: WorkflowGraph = {
      nodes: [
        { id: "action_1", type: "action", config: {} },
        { id: "action_3", type: "action", config: {} },
      ],
      edges: [],
    };
    expect(makeNodeId("action", g)).toBe("action_2");
  });

  it("前缀表覆盖三类节点且与 type 同名", () => {
    expect(NODE_ID_PREFIX).toEqual({ trigger: "trigger", action: "action", approval: "approval" });
  });
});

describe("createEmptyGraph / addNode", () => {
  it("空图恰有一个 trigger 节点、空连线，天然满足后端非空+单 trigger", () => {
    const g = createEmptyGraph();
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0].type).toBe("trigger");
    expect(g.nodes[0].config).toEqual({});
    expect(g.edges).toEqual([]);
  });

  it("传入 triggerName 时挂到节点 name，不传则无 name 字段", () => {
    expect(createEmptyGraph("入职流程").nodes[0].name).toBe("入职流程");
    expect(createEmptyGraph().nodes[0].name).toBeUndefined();
  });

  it("addNode 自动分配 id、缺省 config 给空形态、可带 name，且不可变", () => {
    const base = createEmptyGraph();
    const before = snapshot(base);
    const r = addNode(base, { type: "action", name: "建记录" });
    expect(base).toEqual(before); // 入参未被改
    expect(r.nodeId).toBe("action_1");
    expect(r.graph.nodes).toHaveLength(2);
    expect(r.graph.nodes[1]).toMatchObject({ id: "action_1", type: "action", name: "建记录", config: {} });
    expect(r.graph.nodes).not.toBe(base.nodes); // 新数组引用
  });

  it("addNode 显式传入 config 时原样保留", () => {
    const base = createEmptyGraph();
    const cfg: ActionNodeConfig = { op: "create", tableId: "t1", payload: { a: 1 } };
    const r = addNode(base, { type: "action", config: cfg });
    expect(r.graph.nodes[1].config).toEqual(cfg);
  });
});

describe("removeNode 级联删边 + 不可变", () => {
  it("删节点同时删掉所有 from 或 to 引用它的边（两个方向各造一条）", () => {
    const g: WorkflowGraph = {
      nodes: [
        { id: "t1", type: "trigger", config: {} },
        { id: "a1", type: "action", config: { op: "create", tableId: "t", payload: {} } },
        { id: "ap1", type: "approval", config: {} },
      ],
      edges: [
        { from: "t1", to: "a1" }, // to 引用 a1
        { from: "a1", to: "ap1" }, // from 引用 a1
        { from: "t1", to: "ap1" }, // 不引用 a1，应保留
      ],
    };
    const before = snapshot(g);
    const next = removeNode(g, "a1");
    expect(g).toEqual(before); // 入参未被改
    expect(next.nodes.map((n) => n.id)).toEqual(["t1", "ap1"]);
    expect(next.edges).toEqual([{ from: "t1", to: "ap1" }]);
    expect(next.edges).not.toBe(g.edges);
  });

  it("删除不存在的 id 时幂等：节点/边内容不变（仍返回新数组引用）", () => {
    const g = createEmptyGraph();
    const next = removeNode(g, "ghost");
    expect(next.nodes).toEqual(g.nodes);
    expect(next.edges).toEqual(g.edges);
  });
});

describe("updateNode 只改 name/config 且不可变", () => {
  it("补丁合并到目标节点，id/type 不变，其余节点不动", () => {
    const g: WorkflowGraph = {
      nodes: [
        { id: "t1", type: "trigger", config: {} },
        { id: "a1", type: "action", config: { op: "create", tableId: "old", payload: {} } },
      ],
      edges: [],
    };
    const before = snapshot(g);
    const next = updateNode(g, "a1", { name: "新名字" });
    expect(g).toEqual(before);
    const node = next.nodes.find((n) => n.id === "a1");
    expect(node?.name).toBe("新名字");
    expect(node?.type).toBe("action"); // type 不被补丁影响
    expect(next.nodes[0]).toEqual(g.nodes[0]); // 其它节点引用透传
  });

  it("可改 config；节点不存在时 map 透传，图内容等价", () => {
    const g = createEmptyGraph();
    const next = updateNode(g, "t1", { config: {} });
    expect(next.nodes[0].config).toEqual({});
    const miss = updateNode(g, "nope", { name: "x" });
    expect(miss).toEqual(g);
  });
});

describe("addEdge / removeEdge", () => {
  const base: WorkflowGraph = {
    nodes: [
      { id: "t1", type: "trigger", config: {} },
      { id: "a1", type: "action", config: { op: "create", tableId: "t", payload: {} } },
    ],
    edges: [],
  };

  it("合法连线追加成功 ok:true，返回新数组", () => {
    const r = addEdge(base, "t1", "a1");
    expect(r.ok).toBe(true);
    expect(r.graph.edges).toEqual([{ from: "t1", to: "a1" }]);
  });

  it("自环拒绝 ok:false，回原 graph 同一引用", () => {
    const r = addEdge(base, "t1", "t1");
    expect(r.ok).toBe(false);
    expect(r.graph).toBe(base);
    expect(r.graph.edges).toHaveLength(0);
  });

  it("完全相同的边重复添加拒绝 ok:false，不产生重复边", () => {
    const once = addEdge(base, "t1", "a1");
    const twice = addEdge(once.graph, "t1", "a1");
    expect(twice.ok).toBe(false);
    expect(twice.graph).toBe(once.graph);
    expect(twice.graph.edges).toHaveLength(1);
  });

  it("removeEdge 删除指定方向边，幂等且不可变", () => {
    const withEdge = addEdge(base, "t1", "a1").graph;
    const removed = removeEdge(withEdge, "t1", "a1");
    expect(removed.edges).toEqual([]);
    expect(removeEdge(removed, "t1", "a1")).toEqual(removed); // 再删幂等
  });
});

describe("nodeOptions / serializeGraph", () => {
  it("name 去空白后非空用 name，否则回落 id；保持 nodes 声明顺序", () => {
    const g: WorkflowGraph = {
      nodes: [
        { id: "t1", type: "trigger", name: "  触发器  ", config: {} },
        { id: "a1", type: "action", config: {} }, // 无 name → 回落 id
        { id: "ap1", type: "approval", name: "   ", config: {} }, // 空白 name → 回落 id
      ],
      edges: [],
    };
    expect(nodeOptions(g)).toEqual([
      { value: "t1", label: "触发器" },
      { value: "a1", label: "a1" },
      { value: "ap1", label: "ap1" },
    ]);
  });

  it("serializeGraph 产出 JSON 文本且可 parse 回与原图等形", () => {
    const g: WorkflowGraph = {
      nodes: [{ id: "t1", type: "trigger", config: {} }],
      edges: [{ from: "t1", to: "t1" }],
    };
    const text = serializeGraph(g);
    expect(typeof text).toBe("string");
    expect(JSON.parse(text)).toEqual(g);
  });
});
