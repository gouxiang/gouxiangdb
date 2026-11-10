// 工作流 DAG 图前端纯函数单测（#1309 刀 C1，纯 node，零 IO/React）。
//
// 锁三件事：
//   ① safeParseGraph 永不 throw：坏 JSON/顶层非对象/数组缺失/元素形状错全部走 {ok:false,reason}，
//      绝不静默回落空图（把坏图当空跑是沉默逻辑错误）；
//   ② 合法图透传，且只做 parse 层形状判定，不重复后端 validate 的 trigger 唯一/环检测；
//   ③ 运行态判定从 WORKFLOW_RUN_STATUSES 冻结枚举派生——尤其 canceled 单 l 拼写不写字面量。
import { describe, it, expect } from "vitest";
import { WORKFLOW_RUN_STATUSES } from "@gx/shared-types";
import {
  safeParseGraph,
  isTerminalRunStatus,
  isKnownRunStatus,
} from "../workflow-graph";

const VALID_GRAPH = {
  nodes: [
    { id: "n1", type: "trigger", config: {} },
    { id: "n2", type: "action", name: "建记录", config: { op: "create", tableId: "t1", payload: {} } },
    { id: "n3", type: "approval", config: { approverIds: ["u1"] } },
  ],
  edges: [
    { from: "n1", to: "n2" },
    { from: "n2", to: "n3" },
  ],
};

describe("safeParseGraph 成功分支", () => {
  it("最小合法图（空 nodes/edges 数组）→ ok:true 且透传图对象", () => {
    const r = safeParseGraph('{"nodes":[],"edges":[]}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.graph).toEqual({ nodes: [], edges: [] });
  });

  it("含三类节点与连线的合法图 → ok:true，节点/连线原样保留（不做业务 validate）", () => {
    const r = safeParseGraph(JSON.stringify(VALID_GRAPH));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.graph.nodes).toHaveLength(3);
      expect(r.graph.edges).toHaveLength(2);
      expect(r.graph.nodes[1]).toMatchObject({ id: "n2", type: "action" });
    }
  });

  it("name/config 缺省的节点仍合法（形状只要求非空 id 与字符串 type）", () => {
    const r = safeParseGraph('{"nodes":[{"id":"x","type":"trigger"}],"edges":[]}');
    expect(r.ok).toBe(true);
  });
});

describe("safeParseGraph 失败分支（永不 throw）", () => {
  it("非法 JSON 字符串 → ok:false，诊断指向 JSON", () => {
    const r = safeParseGraph("{not-json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("JSON");
  });

  it("JSON 顶层是数组/裸字符串/数字/null → ok:false（必须是含 nodes/edges 的对象）", () => {
    for (const raw of ["[]", '"str"', "42", "null"]) {
      const r = safeParseGraph(raw);
      expect(r.ok, `raw=${raw}`).toBe(false);
    }
  });

  it("缺 nodes 或 edges 数组 → ok:false", () => {
    expect(safeParseGraph('{"edges":[]}').ok).toBe(false);
    expect(safeParseGraph('{"nodes":[]}').ok).toBe(false);
    expect(safeParseGraph('{"nodes":{},"edges":[]}').ok).toBe(false); // nodes 非数组
    expect(safeParseGraph('{"nodes":[],"edges":{}}').ok).toBe(false); // edges 非数组
  });

  it("节点缺 id / 空白 id / 缺 type / type 非字符串 → ok:false", () => {
    const bad = [
      '{"nodes":[{"type":"trigger"}],"edges":[]}',
      '{"nodes":[{"id":"  ","type":"trigger"}],"edges":[]}',
      '{"nodes":[{"id":"n1"}],"edges":[]}',
      '{"nodes":[{"id":"n1","type":5}],"edges":[]}',
      '{"nodes":["primitive"],"edges":[]}',
    ];
    for (const raw of bad) {
      expect(safeParseGraph(raw).ok, raw).toBe(false);
    }
  });

  it("连线 from/to 缺失或非字符串 → ok:false", () => {
    const bad = [
      '{"nodes":[],"edges":[{"to":"n2"}]}',
      '{"nodes":[],"edges":[{"from":"n1"}]}',
      '{"nodes":[],"edges":[{"from":1,"to":"n2"}]}',
      '{"nodes":[],"edges":[{"from":"n1","to":null}]}',
    ];
    for (const raw of bad) {
      expect(safeParseGraph(raw).ok, raw).toBe(false);
    }
  });

  it("失败结果带非空 reason 供降级 UI/调试", () => {
    const r = safeParseGraph("garbage");
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
  });
});

describe("isTerminalRunStatus 终态判定", () => {
  it("succeeded/failed/canceled 为终态", () => {
    expect(isTerminalRunStatus("succeeded")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("canceled")).toBe(true); // 冻结枚举单 l
  });

  it("pending/running/waiting_approval 为非终态（runtime 仍会推进）", () => {
    expect(isTerminalRunStatus("pending")).toBe(false);
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("waiting_approval")).toBe(false);
  });

  it("对冻结枚举六个成员逐一给出确定布尔，无遗漏/无溢出", () => {
    const terminals = WORKFLOW_RUN_STATUSES.filter((s) => isTerminalRunStatus(s));
    expect([...terminals].sort()).toEqual(["canceled", "failed", "succeeded"]);
  });
});

describe("isKnownRunStatus 运行期枚举守卫", () => {
  it("冻结枚举六个成员全部收窄为 true", () => {
    for (const s of WORKFLOW_RUN_STATUSES) {
      expect(isKnownRunStatus(s)).toBe(true);
    }
  });

  it("双 l 误拼 cancelled 与未知字符串返回 false（不抛错，前向兼容旧前端遇后端新值）", () => {
    expect(isKnownRunStatus("cancelled")).toBe(false);
    expect(isKnownRunStatus("paused")).toBe(false);
    expect(isKnownRunStatus("")).toBe(false);
  });

  it("类型收窄：true 分支可赋给 WorkflowRunStatus 联合", () => {
    const raw: string = "running";
    if (isKnownRunStatus(raw)) {
      // 编译期守卫成立即可；这里再跑一次终态判定证明类型已收窄。
      expect(isTerminalRunStatus(raw)).toBe(false);
    } else {
      throw new Error("running 应被识别为已知枚举");
    }
  });
});
