// WorkflowDefList 组件级回归（#1318 刀 C3-a2-i，node：react-dom/server + vi.mock，无 jsdom/新依赖）。
//
// 路线照 features/settings/PatListPanel.test.tsx：mock 掉 api/client（禁真实 fetch），用 QueryClient
// setQueryData 直接灌列表缓存驱动渲染，MemoryRouter 提供 Link 上下文。锁：空态不渲染表头、有数据四列中文、
// 名称 Link 指向 /workflow/def/:id、分页键的 disabled 随 total 变化。错误态在 SSR 下无法由 reject 驱动
// （同步渲染恒为 pending），按施工书降级为源码断言。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ReactElement } from "react";
import { renderToString as rtsRaw } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkflowDefDTO } from "@gx/shared-types";

// Modal 走 createPortal（本组件虽不用 Modal，但 ui 桶被 import，保持与范本一致的 portal 就地渲染）。
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
import { WORKFLOW_DEFAULT_PAGE_SIZE } from "../lib/workflow-paging";
import { WorkflowDefList } from "../WorkflowDefList";

const GRAPH = JSON.stringify({
  nodes: [{ id: "t1", type: "trigger", config: {} }],
  edges: [],
});

function def(over: Partial<WorkflowDefDTO> = {}): WorkflowDefDTO {
  return {
    id: "wf_1",
    name: "入职审批流",
    description: null,
    version: 1,
    status: "draft",
    triggerType: "manual",
    triggerConfig: "{}",
    graph: GRAPH,
    createdBy: null,
    updatedBy: null,
    createdAt: "2026-09-18T08:30:00.000Z",
    updatedAt: "2026-09-19T09:00:00.000Z",
    ...over,
  };
}

function render(items: WorkflowDefDTO[], total: number): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  });
  qc.setQueryData(WORKFLOW_QK.defsList({ page: 1, limit: WORKFLOW_DEFAULT_PAGE_SIZE }), { items, total });
  const node: ReactElement = (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/workflow"]}>
        <WorkflowDefList />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return rtsRaw(node).replace(/<!--[^>]*-->/g, "");
}

/** 判断某 aria-label 的分页按钮是否带【独立 disabled 属性】，排除 class 里的 disabled: 工具类。 */
function isDisabled(html: string, label: string): boolean {
  const seg = html.split("<button").find((s) => s.includes(`aria-label="${label}"`));
  if (!seg) return false;
  const openTag = seg.slice(0, seg.indexOf(">"));
  return /\sdisabled(=|\s|>)/.test(openTag);
}

describe("WorkflowDefList 列表渲染", () => {
  it("空态：显引导文案，不渲染表头/分页表格", () => {
    const html = render([], 0);
    expect(html).toContain("还没有流程定义");
    expect(html).not.toContain("流程名称"); // 表头独有列名
  });

  it("有数据：渲染名称、状态/触发方式中文、版本号，名称是指向详情的 Link", () => {
    const html = render(
      [def(), def({ id: "wf_2", name: "离职交接", status: "published" })],
      2,
    );
    expect(html).toContain("入职审批流");
    expect(html).toContain("离职交接");
    expect(html).toContain("草稿"); // workflowDefStatusLabel(draft)
    expect(html).toContain("已发布"); // workflowDefStatusLabel(published)
    expect(html).toContain("手动触发"); // workflowTriggerTypeLabel(manual)
    expect(html).toContain("v1");
    expect(html).toContain("/workflow/def/wf_1");
    expect(html).toContain("/workflow/def/wf_2");
  });

  it("更新时间切片到分钟（不引日期库），不出现原始 T 与毫秒", () => {
    const html = render([def()], 1);
    expect(html).toContain("2026-09-19 09:00");
    expect(html).not.toContain("2026-09-19T09:00");
  });
});

describe("WorkflowDefList 分页底栏", () => {
  it("total=25（超首页）：下一页可点（无 disabled 属性），上一页在首页禁用", () => {
    const html = render([def()], 25);
    expect(html).toContain("第 1–20 条 · 共 25 条");
    expect(isDisabled(html, "下一页")).toBe(false);
    expect(isDisabled(html, "上一页")).toBe(true);
  });

  it("total=10（不足一页）：上一页/下一页都禁用", () => {
    const html = render([def()], 10);
    expect(isDisabled(html, "上一页")).toBe(true);
    expect(isDisabled(html, "下一页")).toBe(true);
  });
});

describe("WorkflowDefList 错误分支（源码断言，SSR 无法驱动 reject 态）", () => {
  it("源码接 normalizeWorkflowError/workflowErrorText，提供 alertCircle + refetch 重试，无裸 fetch", () => {
    const src = readFileSync(fileURLToPath(new URL("../WorkflowDefList.tsx", import.meta.url)), "utf8");
    expect(src).toContain("normalizeWorkflowError");
    expect(src).toContain("workflowErrorText");
    expect(src).toContain('name="alertCircle"');
    expect(src).toContain("refetch()");
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("WorkflowDefList 新建流程入口", () => {
  it("空态：EmptyState 的 action 渲染指向 /workflow/new 的新建链接与引导文案", () => {
    const html = render([], 0);
    expect(html).toContain('href="/workflow/new"');
    expect(html).toContain("新建流程");
    expect(html).toContain("创建第一个流程"); // 更新后的空态引导文案
  });

  it("有数据态：表格上方操作区同样渲染指向 /workflow/new 的新建链接", () => {
    const html = render([def()], 1);
    expect(html).toContain('href="/workflow/new"');
    expect(html).toContain("新建流程");
  });
});
