// WorkflowRunList 组件级回归（#1320 刀 C3-b1，node：react-dom/server + vi.mock，无 jsdom/新依赖）。
//
// 路线照 WorkflowDefList.test.tsx：mock 掉 api/client（禁真实 fetch），用 QueryClient setQueryData
// 直接灌 runs 列表缓存驱动渲染，MemoryRouter 提供 Link 与 useSearchParams 上下文。锁：全量/过滤两态
// 空态文案与筛选 chip、有数据七列中文与 Link 走向、可空列回落「-」、error 着 danger、分页键 disabled
// 随 total 变化。错误态 SSR 无法由 reject 驱动（同步渲染恒 pending），按范本降级为源码断言。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ReactElement } from "react";
import { renderToString as rtsRaw } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkflowRunDTO } from "@gx/shared-types";

// ui 桶被 import，保持与范本一致的 createPortal 就地渲染，避免 SSR 下 portal 脱离容器。
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
    listRuns: vi.fn(),
    getRun: vi.fn(),
  },
  probeWorkflowEngine: vi.fn().mockResolvedValue(true),
}));

import { WORKFLOW_QK } from "../workflow-hooks";
import { WORKFLOW_DEFAULT_PAGE_SIZE } from "../lib/workflow-paging";
import { WorkflowRunList } from "../WorkflowRunList";

function run(over: Partial<WorkflowRunDTO> = {}): WorkflowRunDTO {
  return {
    id: "run_1",
    defId: "wf_1",
    status: "succeeded",
    triggerType: "manual",
    entityType: null,
    entityId: null,
    input: "{}",
    context: "{}",
    currentNodeId: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    createdBy: null,
    createdAt: "2026-09-20T10:15:00.000Z",
    updatedAt: "2026-09-20T10:16:00.000Z",
    ...over,
  };
}

/** defId 缺省走全量态（无筛选 chip）；传入则 MemoryRouter 带 ?defId= 且用同 params 灌缓存。 */
function renderRuns(
  items: WorkflowRunDTO[],
  total: number,
  defId?: string,
): string {
  const params = { page: 1, limit: WORKFLOW_DEFAULT_PAGE_SIZE, defId };
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  });
  qc.setQueryData(WORKFLOW_QK.runsList(params), { items, total });
  const entry = defId ? `/workflow/runs?defId=${encodeURIComponent(defId)}` : "/workflow/runs";
  const node: ReactElement = (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <WorkflowRunList />
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

describe("WorkflowRunList 空态（全量 / defId 过滤）", () => {
  it("全量空态：显全量引导文案，不渲染表头，也不出现筛选 chip", () => {
    const html = renderRuns([], 0);
    expect(html).toContain("还没有运行记录");
    expect(html).not.toContain("运行编号"); // 表头独有列名
    expect(html).not.toContain("仅看流程：");
    expect(html).not.toContain('href="/workflow/runs"'); // 清除链接只在过滤态出现
  });

  it("过滤空态（?defId=wf_1）：显过滤文案 + 筛选 chip + 回无参列表的清除链接", () => {
    const html = renderRuns([], 0, "wf_1");
    expect(html).toContain("该流程暂无运行记录");
    expect(html).not.toContain("运行编号");
    expect(html).toContain("仅看流程：");
    expect(html).toContain("wf_1");
    expect(html).toContain('href="/workflow/runs"');
    expect(html).toContain("清除");
  });
});

describe("WorkflowRunList 有数据七列", () => {
  it("渲染运行/定义 Link 走向，状态与触发方式走 labels 中文（枚举零手写）", () => {
    const html = renderRuns(
      [
        run(),
        run({ id: "run_2", defId: "wf_2", status: "failed", triggerType: "record_created" }),
      ],
      2,
    );
    expect(html).toContain("/workflow/runs/run_1");
    expect(html).toContain("/workflow/runs/run_2");
    expect(html).toContain("/workflow/def/wf_1");
    expect(html).toContain("/workflow/def/wf_2");
    expect(html).toContain("执行成功"); // workflowRunStatusLabel(succeeded)
    expect(html).toContain("执行失败"); // workflowRunStatusLabel(failed)
    expect(html).toContain("手动触发"); // workflowTriggerTypeLabel(manual)
    expect(html).toContain("记录创建时"); // workflowTriggerTypeLabel(record_created)
  });

  it("可空列（currentNodeId/error 为空）回落「-」，不渲染空白", () => {
    const html = renderRuns([run()], 1);
    expect(html).toContain(">-</span>");
  });

  it("error 非空着 text-gx-danger 并带 title，currentNodeId 有值时原样显示", () => {
    const html = renderRuns(
      [run({ id: "run_3", status: "failed", currentNodeId: "node_approval_1", error: "节点执行超时" })],
      1,
    );
    expect(html).toContain("text-gx-danger");
    expect(html).toContain("节点执行超时");
    expect(html).toContain('title="节点执行超时"');
    expect(html).toContain("node_approval_1");
  });

  it("创建时间切片到分钟（不引日期库），不出现原始 T 与毫秒", () => {
    const html = renderRuns([run()], 1);
    expect(html).toContain("2026-09-20 10:15");
    expect(html).not.toContain("2026-09-20T10:15");
  });
});

describe("WorkflowRunList 分页底栏", () => {
  it("total=25（超首页）：下一页可点（无 disabled 属性），上一页在首页禁用", () => {
    const html = renderRuns([run()], 25);
    expect(html).toContain("第 1–20 条 · 共 25 条");
    expect(isDisabled(html, "下一页")).toBe(false);
    expect(isDisabled(html, "上一页")).toBe(true);
  });

  it("total=10（不足一页）：上一页/下一页都禁用", () => {
    const html = renderRuns([run()], 10);
    expect(isDisabled(html, "上一页")).toBe(true);
    expect(isDisabled(html, "下一页")).toBe(true);
  });
});

describe("WorkflowRunList 错误分支与只读纪律（源码断言，SSR 无法驱动 reject 态）", () => {
  // 剥块注释与整行注释后只判代码本体：注释里允许讲历史/带工单号（如 #1320），被禁符号只约束代码。
  // 与 workflow-shell.test.tsx 的 code() 护栏同构，避免标题注释里的工单号/历史措辞误伤断言。
  const src = readFileSync(
    fileURLToPath(new URL("../WorkflowRunList.tsx", import.meta.url)),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

  it("接 normalizeWorkflowError/workflowErrorText，提供 alertCircle + refetch 重试，无裸 fetch", () => {
    expect(src).toContain("normalizeWorkflowError");
    expect(src).toContain("workflowErrorText");
    expect(src).toContain('name="alertCircle"');
    expect(src).toContain("refetch()");
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });

  it("defId 过滤接 useSearchParams 并透传 useWorkflowRuns，无删除/取消类写操作按钮", () => {
    expect(src).toContain("useSearchParams");
    expect(src).toContain("useWorkflowRuns");
    expect(src).toContain('searchParams.get("defId")');
    expect(src).not.toContain('name="trash"');
    expect(src).not.toContain("删除");
    expect(src).not.toContain("取消");
  });

  it("样式零硬编码 hex/rgb，只用 gx-* token", () => {
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/\brgb\s*\(/);
  });
});
