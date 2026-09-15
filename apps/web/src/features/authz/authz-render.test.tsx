// M4-FE 组件级回归（node：react-dom/server + vi.mock，无 jsdom/新依赖，沿 nav-render.test.tsx 套路）。
// 覆盖：门控 fail-closed 三态渲染、七动作矩阵 manage_schema 置灰、继承 Modal losing/gaining 文案、
// 409 重放走纯函数断言、面包屑截断标记、继承开关仅 doc/canvas。
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import type { ReactElement } from "react";
import { renderToString as rtsRaw } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/** SSR 会在文本/表达式边界插入 <!-- -->，断言前归一化去掉，避免插值文本断裂。 */
function renderToString(node: ReactElement): string {
  // SubjectPicker 等含 useQuery，需挂 QueryClientProvider（SSR 首帧数据未定，不影响结构断言）。
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  });
  return rtsRaw(<QueryClientProvider client={qc}>{node}</QueryClientProvider>).replace(
    /<!--[^>]*-->/g,
    "",
  );
}

// ui.Modal 用 createPortal(children, document.body)；node 环境无 document，
// SSR 只需读取 document.body 引用（Portal 在服务端就地渲染、不 appendChild），给最小桩。
beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document =
    (globalThis as unknown as { document?: unknown }).document ?? { body: {} };
});

import type {
  InheritanceImpactDTO,
  NavNodeDTO,
  NodePoliciesViewDTO,
  PolicyRowDTO,
} from "@gx/shared-types";

// ---- mock 请求层（SubjectPicker/FieldMaskEditor 顶层依赖，queryFn 首次即被引用） ----
vi.mock("../../api/client", () => ({
  AuthzApi: {},
  fetchEnterpriseMeta: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: unknown) {
      super(`API ${status}`);
    }
  },
  OrgMembers: { list: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 200, hasMore: false }) },
  OrgDepartments: { list: vi.fn().mockResolvedValue([]) },
  OrgRoles: { list: vi.fn().mockResolvedValue([]) },
  Fields: { list: vi.fn().mockResolvedValue({ fields: [] }) },
}));

// ---- 门控/数据 hook 由测试用变量驱动 ----
let canManage = false;
let selfActions: string[] = [];
let policiesView: NodePoliciesViewDTO | null = null;

vi.mock("./useAuthzCapability", () => ({
  useAuthzCapability: () => ({ canManage, gate: canManage ? "on" : "off", isLoading: false, meta: null }),
}));

vi.mock("./authz-hooks", () => ({
  useNodePolicies: () => ({
    view: policiesView,
    isLoading: !policiesView,
    isError: policiesView === null && false,
    error: null,
  }),
  useEffective: () => ({ view: { actions: selfActions }, isLoading: false, isError: false, error: null }),
  useSavePolicies: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useBreadcrumb: () => ({ crumb: undefined, isLoading: false, isError: false }),
  useInheritanceImpact: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePatchInheritance: () => ({ mutateAsync: vi.fn(), isPending: false }),
  formatLegacyUnmappable: (items: { subjectType: string; subjectId: string; reasons: string[] }[]) =>
    items.map((i) => `${i.subjectType} ${i.subjectId} 仅企业引擎`),
}));

import { PermNodeEditor } from "./PermNodeEditor";
import { PolicyMatrixRow } from "./PolicyMatrix";
import { ConfirmBody } from "./InheritanceConfirmModal";
import { InheritanceToggle } from "./InheritanceToggle";
import { BreadcrumbChain } from "./NodeBreadcrumb";
import type { EditableRow } from "./lib/policy-model";

const TS = "2026-09-16T00:00:00.000Z";

function node(p: Partial<NavNodeDTO> & { id: string; kind: NavNodeDTO["kind"] }): NavNodeDTO {
  return {
    workspaceId: "ws",
    parentId: null,
    resourceType: p.kind === "group" ? null : p.kind,
    resourceId: p.id,
    name: p.id,
    ord: 0,
    path: `/${p.id}/`,
    depth: 1,
    isSystem: false,
    iconName: null,
    createdAt: TS,
    updatedAt: null,
    deletedAt: null,
    ...p,
  } as NavNodeDTO;
}

function policyRow(p: Partial<PolicyRowDTO> = {}): PolicyRowDTO {
  return {
    id: "p1",
    subjectType: "user",
    subjectId: "u1",
    subjectName: "张三",
    actions: ["r"],
    fieldMask: null,
    reason: "policy:v1",
    createdAt: TS,
    ...p,
  };
}

function view(over: Partial<NodePoliciesViewDTO> = {}): NodePoliciesViewDTO {
  return {
    node: { id: "n1", kind: "doc", resourceType: "doc", name: "需求文档", inheritAncestors: 1 },
    inheritAncestors: true,
    direct: [policyRow()],
    ancestors: [
      {
        nodeId: "kb1",
        nodeName: "产品知识库",
        policies: [{ subjectType: "dept", subjectId: "d1", subjectName: "产品部", actions: ["r", "comment"] }],
      },
    ],
    ...over,
  };
}

const editableRow: EditableRow = {
  subjectType: "user",
  subjectId: "u1",
  actions: ["r"],
  fieldMask: null,
  original: policyRow(),
};

beforeEach(() => {
  canManage = false;
  selfActions = [];
  policiesView = view();
});

describe("PermNodeEditor 门控 fail-closed 三态", () => {
  it("默认（门控关）：不渲染保存按钮/主体页签，显只读提示", () => {
    canManage = false;
    const html = renderToString(<PermNodeEditor node={node({ id: "n1", kind: "doc" })} />);
    expect(html).not.toContain("保存权限");
    expect(html).not.toContain(">成员<"); // SubjectPicker 三页签不渲染
    expect(html).toContain("只读视图");
    expect(html).toContain("权限编辑未在本环境开放");
    // 直接授权行仍只读可见（解释能力上线）
    expect(html).toContain("张三");
  });

  it("门控开但本人无 manage_share：仍只读，提示无分享管理权限（不本地越权放行）", () => {
    canManage = true;
    selfActions = ["r"];
    const html = renderToString(<PermNodeEditor node={node({ id: "n1", kind: "doc" })} />);
    expect(html).not.toContain("保存权限");
    expect(html).toContain("你没有该节点的分享管理权限");
  });

  it("门控开且本人持 manage_share：渲染主体选择与保存按钮（开关后编辑入口出现）", () => {
    canManage = true;
    selfActions = ["r", "manage_share"];
    const html = renderToString(<PermNodeEditor node={node({ id: "n1", kind: "doc" })} />);
    expect(html).toContain("保存权限");
    expect(html).toContain(">成员<");
    expect(html).toContain(">部门<");
    expect(html).toContain(">角色<");
  });

  it("悬挂主体（subjectName=null）显‘已删除主体’；ancestors 标继承自上级且只读", () => {
    canManage = false;
    policiesView = view({ direct: [policyRow({ subjectName: null })] });
    const html = renderToString(<PermNodeEditor node={node({ id: "n1", kind: "doc" })} />);
    expect(html).toContain("已删除主体");
    expect(html).toContain("继承自 产品知识库");
  });
});

describe("七动作矩阵 kind 置灰（manage_schema 仅 table/base）", () => {
  it("doc 节点的‘结构’勾选框 disabled；table 节点可勾", () => {
    const checkboxes = (html: string) => html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    // ACTION_META 顺序：r c u d comment manage_share manage_schema（第 7 个即结构）
    const docHtml = renderToString(
      <PolicyMatrixRow
        row={editableRow}
        nodeKind="doc"
        readonly={false}
        onChange={() => undefined}
        onRemove={() => undefined}
      />,
    );
    expect(docHtml).toContain("结构");
    const docBoxes = checkboxes(docHtml);
    expect(docBoxes.length).toBe(7);
    expect(docBoxes[6]).toContain("disabled"); // manage_schema 置灰
    expect(docBoxes[0]).not.toContain("disabled"); // r 可勾

    const tableHtml = renderToString(
      <PolicyMatrixRow
        row={editableRow}
        nodeKind="table"
        readonly={false}
        onChange={() => undefined}
        onRemove={() => undefined}
      />,
    );
    expect(checkboxes(tableHtml).every((b) => !b.includes("disabled"))).toBe(true);
  });

  it("只读态全部勾选框 disabled，且不渲染移除按钮", () => {
    const html = renderToString(
      <PolicyMatrixRow
        row={editableRow}
        nodeKind="table"
        readonly
        onChange={() => undefined}
        onRemove={() => undefined}
      />,
    );
    const inputs = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    expect(inputs.length).toBe(7);
    expect(inputs.every((i) => i.includes("disabled"))).toBe(true);
    expect(html).not.toContain("移除该主体授权");
  });
});

describe("继承确认 Modal：losing/gaining 文案 + exempt 分开 + 精确计数", () => {
  const impact = (delta: "losing" | "gaining"): InheritanceImpactDTO => ({
    nodeId: "n1",
    from: delta === "losing",
    to: delta !== "losing",
    delta,
    count: 2,
    items: [
      { userId: "u1", name: "甲", via: "direct", sources: ["direct:n1"] },
      { userId: "u2", name: "乙", via: "dept", sources: ["dept:d1"] },
    ],
    limit: 100,
    offset: 0,
    exempt: [{ userId: "owner", name: "所有者", reason: "workspace_owner" }],
  });

  it("losing：显‘N 人失去访问’，exempt 单独列‘不受影响’不计入 N", () => {
    const html = renderToString(
      <ConfirmBody impact={impact("losing")} busy={false} />,
    );
    expect(html).toContain("将有 2 人失去从上级继承来的访问");
    expect(html).toContain("另有 1 位创建者/工作区所有者不受影响");
    expect(html).toContain("不受影响（1）");
  });

  it("gaining：显‘N 人重新获得访问’，不渲染豁免区", () => {
    const html = renderToString(
      <ConfirmBody impact={impact("gaining")} busy={false} />,
    );
    expect(html).toContain("将有 2 人重新获得从上级继承来的访问");
    expect(html).not.toContain("不受影响（");
  });
});

describe("继承开关仅 doc/canvas；面包屑截断标记", () => {
  it("InheritanceToggle 对 doc 渲染开关，对 table 渲染空", () => {
    const docHtml = renderToString(
      <InheritanceToggle node={node({ id: "d", kind: "doc" })} inheritAncestors={true} editable={true} />,
    );
    expect(docHtml).toContain("继承上级");
    const tableHtml = renderToString(
      <InheritanceToggle node={node({ id: "t", kind: "table" })} inheritAncestors={true} editable={true} />,
    );
    expect(tableHtml.replace(/<!--[\s\S]*?-->/g, "").trim()).toBe("");
  });

  it("BreadcrumbChain：truncatedAbove=true 链首渲染‘上级受限’，false 不渲染", () => {
    const chain = [
      { id: "kb", parentId: null, kind: "kb" as const, resourceType: "kb", resourceId: "kb1", name: "知识库", path: "/kb/", depth: 0 },
      { id: "doc", parentId: "kb", kind: "doc" as const, resourceType: "doc", resourceId: "d1", name: "文档", path: "/kb/doc/", depth: 1 },
    ];
    const cut = renderToString(<BreadcrumbChain data={{ nodeId: "doc", chain, truncatedAbove: true }} />);
    expect(cut).toContain("上级受限");
    expect(cut).toContain("知识库");
    expect(cut).toContain("文档");

    const full = renderToString(<BreadcrumbChain data={{ nodeId: "doc", chain, truncatedAbove: false }} />);
    expect(full).not.toContain("上级受限");
  });
});
