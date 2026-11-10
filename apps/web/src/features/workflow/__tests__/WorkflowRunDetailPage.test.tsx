// WorkflowRunDetailPage 组件级回归（#1321 刀 C3-b2，node：react-dom/server + vi.mock，无 jsdom/新依赖）。
//
// 用 MemoryRouter + 匹配的 Route 让 useParams 拿到 :runId；QueryClient 灌两份缓存：能力位（gate 放行）
// 与运行详情 { run, approvals }。锁：运行只读回显、失败警示卡、审批单 pending 裁决入口/已裁决只回显、
// 可空列回落「-」。404/错误态与裁决写操作在 SSR 同步首帧无法驱动（reject/点击不触发），降级为源码断言。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ReactElement } from "react";
import { renderToString as rtsRaw } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkflowApprovalDTO, WorkflowRunDTO } from "@gx/shared-types";

// 本树无 Portal，但沿范本把 createPortal 就地化，避免任何下游浮层在 legacy SSR 报错（生产代码不变）。
vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return { ...actual, createPortal: (children: unknown) => children };
});

beforeAll(() => {
  const g = globalThis as unknown as { document?: unknown };
  g.document = g.document ?? { body: {} };
});

// 测试在 features/workflow/__tests__/，到 src/api/client 是三层；把 WorkflowApi 全套给 vi.fn 防 import 期 undefined。
vi.mock("../../../api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: unknown, public retryAfter?: number) {
      super(`API ${status}`);
    }
  },
  WorkflowApi: {
    listDefs: vi.fn(),
    getDef: vi.fn(),
    createDef: vi.fn(),
    publishDef: vi.fn(),
    triggerDef: vi.fn(),
    listRuns: vi.fn(),
    getRun: vi.fn(),
    decideApproval: vi.fn(),
  },
  probeWorkflowEngine: vi.fn().mockResolvedValue(true),
}));

import { WORKFLOW_QK } from "../workflow-hooks";
import { WORKFLOW_FLAG_QK } from "../useWorkflowFlag";
import WorkflowRunDetailPage from "../WorkflowRunDetailPage";

function run(over: Partial<WorkflowRunDTO> = {}): WorkflowRunDTO {
  return {
    id: "run_1",
    defId: "wf_1",
    status: "waiting_approval",
    triggerType: "manual",
    entityType: null,
    entityId: null,
    input: "{}",
    context: "{}",
    currentNodeId: "node_approval_1",
    error: null,
    startedAt: "2026-09-20T10:15:00.000Z",
    finishedAt: null,
    createdBy: null,
    createdAt: "2026-09-20T10:15:00.000Z",
    updatedAt: "2026-09-20T10:16:00.000Z",
    ...over,
  };
}

function approval(over: Partial<WorkflowApprovalDTO> = {}): WorkflowApprovalDTO {
  return {
    id: "ap_1",
    runId: "run_1",
    nodeId: "node_approval_1",
    status: "pending",
    approverId: null,
    comment: null,
    decidedAt: null,
    createdAt: "2026-09-20T10:16:00.000Z",
    updatedAt: "2026-09-20T10:16:00.000Z",
    ...over,
  };
}

function renderPage(r: WorkflowRunDTO, approvals: WorkflowApprovalDTO[]): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  });
  qc.setQueryData(WORKFLOW_FLAG_QK, true); // gate 放行
  qc.setQueryData(WORKFLOW_QK.run("run_1"), { run: r, approvals });
  const node: ReactElement = (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/workflow/runs/run_1"]}>
        <Routes>
          <Route path="/workflow/runs/:runId" element={<WorkflowRunDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return rtsRaw(node).replace(/<!--[^>]*-->/g, "");
}

/** 剥块注释+整行注释后判代码本体（注释里允许带工单号/讲历史，被禁符号只约束代码）。 */
function code(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("WorkflowRunDetailPage 运行只读回显（SSR 灌缓存）", () => {
  it("基础回显：运行 id、状态/触发中文、当前节点、时间切片到分钟（不含原始 T）", () => {
    const html = renderPage(run(), [approval()]);
    expect(html).toContain("run_1");
    expect(html).toContain("等待审批"); // waiting_approval → workflowRunStatusLabel
    expect(html).toContain("手动触发"); // manual → workflowTriggerTypeLabel
    expect(html).toContain("node_approval_1");
    expect(html).toContain("2026-09-20 10:15");
    expect(html).not.toContain("2026-09-20T10:15");
  });

  it("所属流程渲染为指向定义详情的 Link（defId 经 encode）", () => {
    const html = renderPage(run(), [approval()]);
    expect(html).toContain('href="/workflow/def/wf_1"');
  });

  it("失败警示卡：error 非空显哨兵与全文；error=null 不渲染该卡（不留空壳）", () => {
    const failed = run({ status: "failed", error: "节点 node_action_1 执行失败：必填字段缺失" });
    const withError = renderPage(failed, []);
    expect(withError).toContain('data-gx-run-error="true"');
    expect(withError).toContain("节点 node_action_1 执行失败：必填字段缺失");
    const noError = renderPage(run(), [approval()]);
    expect(noError).not.toContain('data-gx-run-error="true"');
  });
});

describe("WorkflowRunDetailPage 审批单渲染", () => {
  it("pending：显待审批 Badge + 意见 Textarea + 通过/驳回按钮 + 面板哨兵", () => {
    const html = renderPage(run(), [approval()]);
    expect(html).toContain("待审批");
    expect(html).toContain("<textarea");
    expect(html).toContain("填写审批意见（可选）");
    expect(html).toContain("通过</button>");
    expect(html).toContain("驳回</button>");
    expect(html).toContain('data-gx-approval-decision="ap_1"');
  });

  it("approved：显已通过与意见回显，不渲染裁决面板/Textarea/驳回按钮", () => {
    const decided = approval({
      status: "approved",
      approverId: "u_9",
      comment: "同意录用",
      decidedAt: "2026-09-20T11:00:00.000Z",
    });
    const html = renderPage(run(), [decided]);
    expect(html).toContain("已通过");
    expect(html).toContain("同意录用");
    expect(html).toContain("u_9");
    expect(html).not.toContain('data-gx-approval-decision');
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("驳回</button>");
  });

  it("rejected：显已驳回状态文案", () => {
    const decided = approval({
      status: "rejected",
      approverId: "u_9",
      comment: "材料不全",
      decidedAt: "2026-09-20T11:05:00.000Z",
    });
    const html = renderPage(run(), [decided]);
    expect(html).toContain("已驳回");
    expect(html).toContain("材料不全");
    expect(html).not.toContain('data-gx-approval-decision');
  });

  it("空审批单：显中性空态与计数 0，不渲染任何审批卡片", () => {
    const html = renderPage(run(), []);
    expect(html).toContain("审批单（0）");
    expect(html).toContain("该运行暂无审批单");
    expect(html).not.toContain('data-gx-approval-decision');
  });

  it("可空字段（currentNodeId/startedAt/finishedAt/approverId/comment/decidedAt）回落「-」且无 undefined", () => {
    const r = run({ status: "succeeded", currentNodeId: null, startedAt: null, finishedAt: null });
    const decided = approval({ status: "approved", approverId: null, comment: null, decidedAt: null });
    const html = renderPage(r, [decided]);
    expect(html).toContain("当前节点：-");
    expect(html).toContain("开始于 -");
    expect(html).toContain("结束于 -");
    expect(html).toContain("审批意见：-");
    expect(html).toContain("裁决时间：-");
    expect(html).not.toContain("undefined");
  });
});

describe("WorkflowRunDetail / ApprovalDecisionPanel 源码纪律", () => {
  it("DetailError 消费 WORKFLOW_RUN_NOT_FOUND + 404 兜底与 notFound 文案，且零裸 fetch、零 React.lazy", () => {
    const src = code("../WorkflowRunDetail.tsx");
    expect(src).toContain("WORKFLOW_RUN_NOT_FOUND");
    expect(src).toContain("status === 404");
    expect(src).toContain("运行记录不存在或已被删除");
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toContain("React.lazy");
  });

  it("ApprovalDecisionPanel 接线 useDecideApproval，双 decision 字面量 + 错误收口 toast，剥注释零 hex/rgb", () => {
    const src = code("../ApprovalDecisionPanel.tsx");
    expect(src).toContain("useDecideApproval");
    // 规范第 3 节 canonical 实现为 submit(decision: 联合) + { decision } 简写，
    // 故两个裸枚举字面量断言联合类型与两个 submit 调用点均在（对称、可证两种裁决都接线）。
    expect(src).toContain('"approved"');
    expect(src).toContain('"rejected"');
    expect(src).toContain("workflowErrorText(normalizeWorkflowError(");
    expect(src).toContain("toast(");
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/rgba?\(/);
  });

  it("枚举零手写：详情主体只通过三个 label 函数产出状态/审批/触发文案", () => {
    const src = code("../WorkflowRunDetail.tsx");
    expect(src).toContain("workflowRunStatusLabel");
    expect(src).toContain("workflowApprovalStatusLabel");
    expect(src).toContain("workflowTriggerTypeLabel");
  });
});
