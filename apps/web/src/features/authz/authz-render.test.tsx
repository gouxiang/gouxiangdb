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
  OrgRoleDTO,
  PolicyRowDTO,
} from "@gx/shared-types";
import { roleGrantBlockReason } from "../../lib/role-policy";

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
// 角色清单驱动「这个主体是不是系统预设角色」的判定（roleGrantBlockReason 的入参）。
let orgRoles: OrgRoleDTO[] = [];

vi.mock("../contacts/contacts-hooks", () => ({
  useOrgRoles: () => ({ data: orgRoles, isLoading: false, isError: false, error: null }),
}));

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

function role(over: Partial<OrgRoleDTO> & { id: string }): OrgRoleDTO {
  return {
    workspaceId: "ws",
    systemKey: null,
    name: over.id,
    description: "",
    isSystem: false,
    immutable: false,
    actions: [],
    createdAt: TS,
    deletedAt: null,
    ...over,
  } as OrgRoleDTO;
}

/** 三枚组织层角色：两枚系统预设（管理员 / 受限成员）+ 一枚自定义。 */
const ADMIN_ROLE = role({ id: "r_admin", name: "管理员", systemKey: "admin", isSystem: true });
const RESTRICTED_ROLE = role({ id: "r_restricted", name: "受限成员", systemKey: "restricted", isSystem: true });
const CUSTOM_ROLE = role({ id: "r_custom", name: "运营小组" });

/** 取出含某段文案的按钮的**属性串**（只看到第一个 ">"）：class 里的 disabled: 前缀不算禁用。 */
function buttonAttrs(html: string, label: string): string {
  const i = html.indexOf(label);
  if (i < 0) throw new Error(`未找到含「${label}」的按钮`);
  const start = html.lastIndexOf("<button", i);
  return html.slice(start, html.indexOf(">", start) + 1);
}
const isBtnDisabled = (html: string, label: string) => /\sdisabled(=|\s)/.test(buttonAttrs(html, label));

beforeEach(() => {
  canManage = false;
  selfActions = [];
  policiesView = view();
  orgRoles = [ADMIN_ROLE, RESTRICTED_ROLE, CUSTOM_ROLE];
});

describe("PermNodeEditor 门控 fail-closed 三态", () => {
  it("默认（门控关）：不渲染保存按钮/主体页签，显只读提示", () => {
    canManage = false;
    const html = renderToString(<PermNodeEditor node={node({ id: "n1", kind: "doc" })} />);
    expect(html).not.toContain("保存权限");
    expect(html).not.toContain(">成员<"); // SubjectPicker 三页签不渲染
    expect(html).toContain("只读视图");
    // 门控关 = 本人不是该节点的管理者（后端 /meta 按 manage_* 动作 / owner 角色下发），
    // 不再是「本环境没开放」——能力位已与权限引擎总门解耦。
    expect(html).toContain("你没有该节点的管理权限");
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

describe("系统预设角色不可赋权（资源授权面板与设置页「权限管理」同一把尺子）", () => {
  // 直接授权行里只有角色主体需要判；actions 置空是为了让 buildPolicyWrite 出一张非空单
  // （actions=[] + original 存在 → 走 deletes），这样「保存权限」是否 disabled 只由本次门控决定，
  // 不会因为「没改动」而本来就灰着——门控一撤这两条就该红。
  const roleRow = (subjectId: string, subjectName: string) =>
    policyRow({ subjectType: "role", subjectId, subjectName, actions: [] });

  it("管理员行：七个勾选框与「保存权限」都禁用，禁用原因 = roleGrantBlockReason 的返回值", () => {
    canManage = true;
    selfActions = ["r", "manage_share"];
    policiesView = view({ direct: [roleRow("r_admin", "管理员")] });
    const html = renderToString(<PermNodeEditor node={node({ id: "t1", kind: "table" })} />);

    const boxes = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    expect(boxes.length).toBe(7);
    expect(boxes.every((b) => b.includes("disabled"))).toBe(true);

    const reason = roleGrantBlockReason(ADMIN_ROLE)!;
    expect(reason).toBeTruthy();
    expect(html).toContain(reason); // 行内说明与 title 同源，不另写一句
    expect(isBtnDisabled(html, "保存权限")).toBe(true);
    expect(buttonAttrs(html, "保存权限")).toContain(`title="${reason}"`);
  });

  it("受限成员行同样禁用，且用的是受限成员自己的那句原因（不与管理员文案混用）", () => {
    canManage = true;
    selfActions = ["r", "manage_share"];
    policiesView = view({ direct: [roleRow("r_restricted", "受限成员")] });
    const html = renderToString(<PermNodeEditor node={node({ id: "t1", kind: "table" })} />);

    const boxes = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    expect(boxes.length).toBe(7);
    expect(boxes.every((b) => b.includes("disabled"))).toBe(true);
    const reason = roleGrantBlockReason(RESTRICTED_ROLE)!;
    expect(reason).not.toBe(roleGrantBlockReason(ADMIN_ROLE));
    expect(buttonAttrs(html, "保存权限")).toContain(`title="${reason}"`);
    expect(isBtnDisabled(html, "保存权限")).toBe(true);
  });

  it("自定义角色行不受影响：七个勾选框可勾、保存按钮可点、不出现预设席位的说明", () => {
    canManage = true;
    selfActions = ["r", "manage_share"];
    policiesView = view({ direct: [roleRow("r_custom", "运营小组")] });
    const html = renderToString(<PermNodeEditor node={node({ id: "t1", kind: "table" })} />);

    const boxes = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    expect(boxes.length).toBe(7);
    expect(boxes.every((b) => !b.includes("disabled"))).toBe(true);
    expect(isBtnDisabled(html, "保存权限")).toBe(false);
    expect(html).not.toContain("由系统写死");
  });

  it("PolicyMatrixRow 传了 grantBlockReason 就整行禁用（纯组件层，不依赖 hook）", () => {
    const reason = roleGrantBlockReason(ADMIN_ROLE)!;
    const blocked = renderToString(
      <PolicyMatrixRow
        row={editableRow}
        nodeKind="table"
        readonly={false}
        grantBlockReason={reason}
        onChange={() => undefined}
        onRemove={() => undefined}
      />,
    );
    const boxes = blocked.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    expect(boxes.length).toBe(7);
    expect(boxes.every((b) => b.includes("disabled") && b.includes(`title="${reason}"`))).toBe(true);
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
