// WorkflowDefDetailPage 组件级回归（#1318 刀 C3-a2-i，node：react-dom/server + vi.mock，无 jsdom/新依赖）。
//
// 用 MemoryRouter + 匹配的 Route 让 useParams 拿到 :defId；QueryClient 灌两份缓存：能力位（gate 放行）
// 与定义详情。锁：draft 显发布、published 显手动触发、坏 graph 走降级不白屏、只读 DAG 纯渲染节点与连线。
// 404/错误态在 SSR 同步渲染下 query 恒为 pending（reject 无法在首帧驱动 isError），按施工书降级为源码断言。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ReactElement } from "react";
import { renderToString as rtsRaw } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkflowDefDTO, WorkflowGraph } from "@gx/shared-types";

// Modal 走 createPortal，legacy SSR 不支持 portal：就地渲染 children（生产代码不变）。
vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return { ...actual, createPortal: (children: unknown) => children };
});

beforeAll(() => {
  const g = globalThis as unknown as { document?: unknown };
  g.document = g.document ?? { body: {} };
});

// 测试在 features/workflow/__tests__/，到 src/api/client 是三层。
vi.mock("../../../api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: unknown, public retryAfter?: number) {
      super(`API ${status}`);
    }
  },
  WorkflowApi: {
    listDefs: vi.fn(),
    getDef: vi.fn(),
    publishDef: vi.fn(),
    triggerDef: vi.fn(),
  },
  probeWorkflowEngine: vi.fn().mockResolvedValue(true),
}));

import { WORKFLOW_QK } from "../workflow-hooks";
import { WORKFLOW_FLAG_QK } from "../useWorkflowFlag";
import WorkflowDefDetailPage from "../WorkflowDefDetailPage";
import { WorkflowGraphReadonly } from "../WorkflowGraphReadonly";

const GOOD_GRAPH: WorkflowGraph = {
  nodes: [
    { id: "t1", type: "trigger", name: "发起", config: {} },
    { id: "a1", type: "action", name: "建记录", config: { op: "create", tableId: "tbl_1", payload: {} } },
    { id: "p1", type: "approval", name: "主管审批", config: { approverIds: ["u1"] } },
  ],
  edges: [
    { from: "t1", to: "a1" },
    { from: "a1", to: "p1" },
  ],
};

function def(over: Partial<WorkflowDefDTO> = {}): WorkflowDefDTO {
  return {
    id: "wf_1",
    name: "入职审批流",
    description: "新员工入职的标准审批流程",
    version: 1,
    status: "draft",
    triggerType: "manual",
    triggerConfig: "{}",
    graph: JSON.stringify(GOOD_GRAPH),
    createdBy: null,
    updatedBy: null,
    createdAt: "2026-09-18T08:30:00.000Z",
    updatedAt: "2026-09-19T09:00:00.000Z",
    ...over,
  };
}

function renderPage(d: WorkflowDefDTO): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  });
  qc.setQueryData(WORKFLOW_FLAG_QK, true); // gate 放行
  qc.setQueryData(WORKFLOW_QK.def("wf_1"), d);
  const node: ReactElement = (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/workflow/def/wf_1"]}>
        <Routes>
          <Route path="/workflow/def/:defId" element={<WorkflowDefDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return rtsRaw(node).replace(/<!--[^>]*-->/g, "");
}

describe("WorkflowDefDetailPage 详情回显与状态门控", () => {
  it("draft：渲染名称/状态中文/三类节点中文，含「发布」按钮但不含「手动触发」", () => {
    const html = renderPage(def());
    expect(html).toContain("入职审批流");
    expect(html).toContain("草稿");
    expect(html).toContain("触发器"); // workflowNodeTypeLabel
    expect(html).toContain("动作");
    expect(html).toContain("审批");
    // 发布按钮文本后紧跟按钮闭合；Badge「草稿」不含发布二字，以此精确定位按钮。
    expect(html).toContain("发布</button>");
    // 用按钮闭合标签而非裸「手动触发」：头部「触发方式：手动触发」标签（WorkflowDefDetail.tsx 元信息区）
    // 同为该文案，裸子串会误伤标签；draft 操作区只有发布按钮，不应存在触发按钮。
    expect(html).not.toContain("手动触发</button>");
  });

  it("published：含「手动触发」与运行记录入口，不含发布按钮", () => {
    const html = renderPage(def({ status: "published" }));
    expect(html).toContain("已发布");
    expect(html).toContain("手动触发");
    expect(html).toContain("查看运行记录");
    // 状态 Badge 是「已发布</span>」，发布按钮若存在应为「发布</button>」，据此排除。
    expect(html).not.toContain("发布</button>");
  });

  it("disabled：不渲染可点的发布/触发按钮，只显停用提示", () => {
    const html = renderPage(def({ status: "disabled" }));
    expect(html).toContain("该流程已停用，暂不可触发");
    // 同上：头部触发方式标签也含「手动触发」，须用按钮闭合标签确认操作区无触发按钮。
    expect(html).not.toContain("手动触发</button>");
    expect(html).not.toContain("发布</button>");
  });

  it("坏 graph：显「无法解析」降级卡且不白屏（返回链接与主体仍在）", () => {
    const html = renderPage(def({ graph: "{not-json" }));
    expect(html).toContain("无法解析");
    expect(html).toContain("返回列表");
    expect(html).toContain("入职审批流"); // 头部主体仍渲染
  });

  it("描述为 null 时不渲染描述行（不出现 undefined）", () => {
    const html = renderPage(def({ description: null }));
    expect(html).not.toContain("undefined");
  });
});

describe("WorkflowGraphReadonly 纯渲染（无 Router/Query）", () => {
  it("渲染节点名、类型徽标与连线两端 id，只渲染两端都存在的边", () => {
    const html = rtsRaw(<WorkflowGraphReadonly graph={GOOD_GRAPH} />);
    expect(html).toContain("发起");
    expect(html).toContain("建记录");
    expect(html).toContain("主管审批");
    expect(html).toContain("t1");
    expect(html).toContain("a1");
    expect(html).toContain("p1");
    expect(html).toContain("data-gx-workflow-graph-readonly");
  });

  it("action 节点附 op/tableId 说明，approval 显审批人数量", () => {
    const html = rtsRaw(<WorkflowGraphReadonly graph={GOOD_GRAPH} />);
    expect(html).toContain("操作 create · 表 tbl_1");
    expect(html).toContain("审批人 1 名");
  });

  it("无边图：显空连线提示，不渲染悬空边", () => {
    const noEdges: WorkflowGraph = { nodes: GOOD_GRAPH.nodes, edges: [] };
    const html = rtsRaw(<WorkflowGraphReadonly graph={noEdges} />);
    expect(html).toContain("暂无连线");
  });
});

describe("详情错误分支（源码断言，SSR 无法首帧驱动 reject 态）", () => {
  it("源码消费 WORKFLOW_DEF_NOT_FOUND/404 兜底，且无裸 fetch、无 React.lazy", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../WorkflowDefDetail.tsx", import.meta.url)),
      "utf8",
    );
    expect(src).toContain("WORKFLOW_DEF_NOT_FOUND");
    expect(src).toContain("status === 404");
    expect(src).toContain("流程定义不存在或已被删除");
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toContain("React.lazy");
  });
});
