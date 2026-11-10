// WorkflowComposer 新建编排页组件级回归（#1319 刀 C3-a2-ii，node：react-dom/server + vi.mock，无 jsdom/新依赖）。
//
// 路线照 WorkflowDefList.test.tsx：mock 掉 api/client（禁真实 fetch；workflow-error 顶层值导入 ApiError、
// workflow-hooks 导入 WorkflowApi，故 mock 必须提供二者），MemoryRouter 提供 useNavigate 上下文，
// QueryClientProvider 提供 useMutation 宿主。SSR 同步首帧下 mutation 不会自动触发、事件无法交互，
// 故数据态聚焦【初始结构】，create/navigate/事件等交互接线用【源码断言】锁定，不假装能在 renderToString 点按钮。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ReactElement } from "react";
import { renderToString as rtsRaw } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ui 桶顶层 import createPortal（Modal/Popover 用），node 环境把 portal 就地渲染返回 children。
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
    createDef: vi.fn(),
  },
  probeWorkflowEngine: vi.fn().mockResolvedValue(true),
}));

import { WorkflowComposer } from "../WorkflowComposer";

function render(): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  });
  const node: ReactElement = (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/workflow/new"]}>
        <WorkflowComposer />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return rtsRaw(node).replace(/<!--[^>]*-->/g, "");
}

const composerSrc = readFileSync(
  fileURLToPath(new URL("../WorkflowComposer.tsx", import.meta.url)),
  "utf8",
);

describe("WorkflowComposer 初始 SSR 结构", () => {
  it("渲染基础表单：名称输入、描述、触发方式选择与创建/取消入口", () => {
    const html = render();
    expect(html).toContain("给流程起个名字"); // 名称 Input placeholder
    expect(html).toContain("说明这个流程在什么场景下使用"); // 描述 Textarea placeholder
    expect(html).toContain("触发方式");
    expect(html).toContain("创建流程");
  });

  it("触发方式 Select 默认选中 manual（含 manual 选项与「手动触发」标签，源码默认值锁 manual）", () => {
    const html = render();
    expect(html).toContain('value="manual"');
    expect(html).toContain("手动触发"); // workflowTriggerTypeLabel(manual)
    expect(composerSrc).toContain('useState<WorkflowTriggerType>("manual")');
  });

  it("初始图含唯一 trigger 节点：显「触发器」与节点计数 1，且 trigger 不渲染删除入口", () => {
    const html = render();
    expect(html).toContain("触发器"); // workflowNodeTypeLabel(trigger)
    expect(html).toContain("节点（1）");
    expect(html).not.toContain("删除节点"); // 唯一 trigger 禁删，IconButton 删除入口不渲染
  });

  it("只允许添加 action/approval，不提供添加 trigger 的入口", () => {
    const html = render();
    expect(html).toContain("添加动作");
    expect(html).toContain("添加审批");
    expect(html).not.toContain("添加触发器");
  });

  it("初始图合法：自检区显「自检通过」，连线区为空态提示", () => {
    const html = render();
    expect(html).toContain("自检通过"); // createEmptyGraph 合法 → issues 为空
    expect(html).toContain("还没有连线");
  });
});

describe("WorkflowComposer 接线（源码断言，SSR 无法驱动交互）", () => {
  it("接 useCreateWorkflowDef + serializeGraph + lintWorkflowGraph + createEmptyGraph + 触发枚举，且零裸 fetch", () => {
    expect(composerSrc).toContain("useCreateWorkflowDef");
    expect(composerSrc).toContain("serializeGraph(graph)");
    expect(composerSrc).toContain("lintWorkflowGraph(graph)");
    expect(composerSrc).toContain("createEmptyGraph()");
    expect(composerSrc).toContain("WORKFLOW_TRIGGER_TYPES");
    expect(composerSrc).not.toMatch(/\bfetch\s*\(/);
  });

  it("create 成功后 navigate 到 /workflow/def/:id，失败走错误归一 + toast", () => {
    expect(composerSrc).toContain('navigate(`/workflow/def/${encodeURIComponent(r.id)}`)');
    expect(composerSrc).toContain("normalizeWorkflowError");
    expect(composerSrc).toContain("workflowErrorText");
    expect(composerSrc).toContain('toast(');
  });

  it("提交按钮不被 lint issues 禁用（lint 只提示不守门），空名仅行内报错不发请求", () => {
    expect(composerSrc).not.toContain("disabled={issues");
    expect(composerSrc).toContain("setNameError(true)");
  });
});
