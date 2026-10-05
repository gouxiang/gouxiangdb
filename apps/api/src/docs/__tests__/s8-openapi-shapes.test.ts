// M4/S8 openapi 增补冻结：真路由响应形状对拍（零 yaml 解析新依赖）。
//
// openapi-contract.test.ts 已做文本结构断言（路径/错误码/信封/无 emoji）。本文件补齐 S8
// 命名 schema（NodePoliciesView/PolicyWriteResult/EffectiveView/VisibleScope/InheritanceImpact）
// 与真实 HTTP 响应的键集合对拍：起真 createApp + 真迁移临时库 + 真 JWT，手写断言键集合，
// 防止文档 schema 与 routes/v1 真实响应漂移（"文档发明字段"硬门禁）。
//
// 造数复用 navRouteHarness（makeNavHarness/seedBaseWithStarter/seedKbWithDocs），不新建夹具。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeNavHarness,
  seedBaseWithStarter,
  seedKbWithDocs,
  json,
  type CharHarness,
} from "../../domain/nav/__tests__/navRouteHarness.js";
import { nodeId } from "../../domain/nav/backfill.js";

let h: CharHarness;
let baseNode = "";
let docNode = "";
let canvasNode = "";
let groupNode = "";

const KEYS = {
  policiesView: ["ancestors", "direct", "inheritAncestors", "node"],
  policyNode: ["id", "inheritAncestors", "kind", "name", "resourceType"],
  policyRow: ["actions", "createdAt", "fieldMask", "id", "reason", "subjectId", "subjectName", "subjectType"],
  writeResult: ["deleted", "legacyUnmappable", "node", "policyVersion", "upserted"],
  writeNode: ["id", "kind", "name", "resourceId", "resourceType"],
  effectiveView: ["actions", "node", "perAction", "policyVersion", "userId"],
  effectiveNode: ["id", "kind", "name", "resourceType"],
  diagSource: ["fallback", "kind", "nodeId", "nodeName", "policyId", "subjectId", "subjectName", "subjectType", "viaAncestor"],
  scope: ["actions", "budget", "count", "evaluated", "kinds", "maskedTableFields", "materialize", "nodeIds", "policyVersion", "resourceIdsByType", "truncated", "userId", "visibleTotal"],
  inheritanceImpact: ["count", "delta", "exempt", "from", "items", "limit", "nodeId", "offset", "to"],
  breadcrumb: ["chain", "nodeId", "truncatedAbove"],
  breadcrumbNode: ["depth", "id", "kind", "name", "parentId", "path", "resourceId", "resourceType"],
} as const;

beforeAll(async () => {
  h = await makeNavHarness("gx-m4-s8-doc-");
  await h.createUser("owner", { email: "owner@x.com", displayName: "所有者" });
  await h.createUser("viewer", { email: "viewer@x.com", displayName: "只读成员" });
  await h.createUser("target", { email: "target@x.com", displayName: "目标用户" });
  await h.prisma.roleAssignment.create({
    data: { roleId: "role_owner", subjectType: "user", subjectId: "owner", scopeType: "workspace", createdBy: "seed" },
  });
  const base = await seedBaseWithStarter(h, "s8doc");
  baseNode = nodeId("base", base.baseId);
  const kb = await seedKbWithDocs(h, "s8doc");
  docNode = nodeId("doc", kb.rootDoc);
  canvasNode = nodeId("canvas", kb.canvas);
  // 一个空 group（inheritance kind 白名单负例 + breadcrumb 正例）。
  const created = await h.app.request("/api/v1/nav/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
    body: JSON.stringify({ name: "s8 分组" }),
  });
  expect(created.status).toBe(201);
  groupNode = (await json<{ id: string }>(created)).id;
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

describe("S8 policies GET/PUT 形状对拍 NodePoliciesView / PolicyWriteResult", () => {
  it("GET policies 200 键集合 = {node{5},inheritAncestors,direct[],ancestors[]}，行键 8 枚", async () => {
    const res = await h.app.request(`/api/v1/nodes/${baseNode}/policies`, { headers: await h.auth("owner") });
    expect(res.status).toBe(200);
    const body = await json<Record<string, unknown>>(res);
    expect(Object.keys(body).sort()).toEqual([...KEYS.policiesView].sort());
    expect(Object.keys(body.node as object).sort()).toEqual([...KEYS.policyNode].sort());
    expect(Array.isArray(body.direct)).toBe(true);
    expect(Array.isArray(body.ancestors)).toBe(true);
    // base 是根层资源节点，无 cutoff 祖先。
    expect((body.ancestors as unknown[]).length).toBe(0);
    expect(typeof body.inheritAncestors).toBe("boolean");
  });

  it("PUT policies 200 键集合 = {node{5},policyVersion,upserted,deleted,legacyUnmappable[]}，node 含 resourceId", async () => {
    const res = await h.app.request(`/api/v1/nodes/${baseNode}/policies`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
      body: JSON.stringify({ upserts: [{ subjectType: "user", subjectId: "target", actions: ["enter"] }] }),
    });
    expect(res.status).toBe(200);
    const body = await json<Record<string, unknown>>(res);
    expect(Object.keys(body).sort()).toEqual([...KEYS.writeResult].sort());
    expect(Object.keys(body.node as object).sort()).toEqual([...KEYS.writeNode].sort());
    expect(body.upserted).toBe(1);
    expect(body.deleted).toBe(0);
    expect(Array.isArray(body.legacyUnmappable)).toBe(true);
    expect(typeof body.policyVersion).toBe("number");
  });

  it("PUT 角色授予 -> legacyUnmappable 明细键 {subjectType,subjectId,reasons[]}，200 非错误", async () => {
    const res = await h.app.request(`/api/v1/nodes/${baseNode}/policies`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
      body: JSON.stringify({ upserts: [{ subjectType: "role", subjectId: "role_viewer", actions: ["enter"] }] }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ legacyUnmappable: Array<Record<string, unknown>> }>(res);
    const item = body.legacyUnmappable.find((x) => x.subjectType === "role");
    expect(item).toBeTruthy();
    expect(Object.keys(item!).sort()).toEqual(["reasons", "subjectId", "subjectType"]);
    expect(Array.isArray(item!.reasons)).toBe(true);
  });

  it("GET 回读：direct 行含 target 且 8 键齐、subjectName 解析", async () => {
    const res = await h.app.request(`/api/v1/nodes/${baseNode}/policies`, { headers: await h.auth("owner") });
    const body = await json<{ direct: Array<Record<string, unknown>> }>(res);
    const row = body.direct.find((r) => r.subjectId === "target");
    expect(row).toBeTruthy();
    expect(Object.keys(row!).sort()).toEqual([...KEYS.policyRow].sort());
    expect(row!.subjectName).toBe("目标用户");
    expect(Array.isArray(row!.actions)).toBe(true);
  });

  it("坏动作 PUT -> 400 POLICY_ACTION_INVALID（错误信封 {error,code}）；节点缺失 -> 404 NODE_NOT_FOUND", async () => {
    const bad = await h.app.request(`/api/v1/nodes/${baseNode}/policies`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
      body: JSON.stringify({ upserts: [{ subjectType: "user", subjectId: "target", actions: ["zzz"] }] }),
    });
    expect(bad.status).toBe(400);
    const badBody = await json<Record<string, unknown>>(bad);
    expect(Object.keys(badBody).sort()).toEqual(["code", "error"]);
    expect(badBody.code).toBe("POLICY_ACTION_INVALID");

    const missing = await h.app.request("/api/v1/nodes/nav_base_nope/policies", { headers: await h.auth("owner") });
    expect(missing.status).toBe(404);
    // assertNodeExists 先于查询：PolicyValidationError POLICY_NODE_NOT_FOUND 原样透传（HTTP 404）。
    expect((await json<{ code: string }>(missing)).code).toBe("POLICY_NODE_NOT_FOUND");
  });

  it("无 r 用户 GET policies -> 403（REST 回落泛 code，无 FORBIDDEN_RESOURCE 特码）；未登录 401", async () => {
    const denied = await h.app.request(`/api/v1/nodes/${baseNode}/policies`, { headers: await h.auth("viewer") });
    expect(denied.status).toBe(403);
    const code = (await json<{ code: string }>(denied)).code;
    expect(["FORBIDDEN", "FORBIDDEN_RESOURCE"]).toContain(code);
    const anon = await h.app.request(`/api/v1/nodes/${baseNode}/policies`);
    expect(anon.status).toBe(401);
  });
});

describe("S8 effective 形状对拍 EffectiveView / DiagSource", () => {
  it("GET effective 缺省本人 = {node{4},userId,actions[],policyVersion,perAction[5]}；source 9 键齐", async () => {
    const res = await h.app.request(`/api/v1/nodes/${baseNode}/effective`, { headers: await h.auth("owner") });
    expect(res.status).toBe(200);
    const body = await json<Record<string, unknown>>(res);
    expect(Object.keys(body).sort()).toEqual([...KEYS.effectiveView].sort());
    expect(Object.keys(body.node as object).sort()).toEqual([...KEYS.effectiveNode].sort());
    expect(body.userId).toBe("owner");
    const perAction = body.perAction as Array<Record<string, unknown>>;
    // base 库节点只呈现 5 枚合法位（enter/edit_data/manage_share/manage_schema/manage_table）。
    expect(perAction.length).toBe(5);
    for (const pa of perAction) {
      expect(Object.keys(pa).sort()).toEqual(["action", "allowed", "sources"]);
      expect(typeof pa.allowed).toBe("boolean");
      for (const s of pa.sources as Array<Record<string, unknown>>) {
        expect(Object.keys(s).sort()).toEqual([...KEYS.diagSource].sort());
      }
    }
  });
});

describe("S8 visible-scope 形状对拍 VisibleScope（含 materialize 物化契约，不暴露 sql）", () => {
  it("GET visible-scope 本人 13 键；materialize in_list/temp_table；无 sql/expectsTempTable 泄漏", async () => {
    const res = await h.app.request("/api/v1/authz/visible-scope", { headers: await h.auth("owner") });
    expect(res.status).toBe(200);
    const body = await json<Record<string, unknown>>(res);
    expect(Object.keys(body).sort()).toEqual([...KEYS.scope].sort());
    expect(["in_list", "temp_table"]).toContain(body.materialize);
    expect(body).not.toHaveProperty("sql");
    expect(body).not.toHaveProperty("expectsTempTable");
    expect(typeof body.count).toBe("number");
    expect(body.count).toBe((body.nodeIds as unknown[]).length);
  });

  it("非 owner 查他人 -> 403；非法 actions token -> 400", async () => {
    const denied = await h.app.request("/api/v1/authz/visible-scope?userId=target", { headers: await h.auth("viewer") });
    expect(denied.status).toBe(403);
    const bad = await h.app.request("/api/v1/authz/visible-scope?actions=zzz", { headers: await h.auth("owner") });
    expect(bad.status).toBe(400);
  });
});

describe("S8 inheritance impact/breadcrumb 形状对拍 InheritanceImpact / NodeBreadcrumb", () => {
  it("doc impact 200 = 9 键（不含 willBreakInheritanceHint），items/exempt 为数组", async () => {
    const res = await h.app.request(`/api/v1/nodes/${docNode}/inheritance/impact?value=0`, { headers: await h.auth("owner") });
    expect(res.status).toBe(200);
    const body = await json<Record<string, unknown>>(res);
    expect(Object.keys(body).sort()).toEqual([...KEYS.inheritanceImpact].sort());
    expect(body).not.toHaveProperty("willBreakInheritanceHint");
    expect(typeof body.count).toBe("number");
    expect(Array.isArray(body.items)).toBe(true);
    expect(Array.isArray(body.exempt)).toBe(true);
  });

  it("canvas 同样可切（kind 白名单）；group -> 400 NODE_NOT_INHERITABLE", async () => {
    const canvas = await h.app.request(`/api/v1/nodes/${canvasNode}/inheritance/impact?value=0`, { headers: await h.auth("owner") });
    expect(canvas.status).toBe(200);
    const group = await h.app.request(`/api/v1/nodes/${groupNode}/inheritance/impact?value=0`, { headers: await h.auth("owner") });
    expect(group.status).toBe(400);
    expect((await json<{ code: string }>(group)).code).toBe("NODE_NOT_INHERITABLE");
  });

  it("breadcrumb 200 = {nodeId,chain[],truncatedAbove}；链节点 8 键；未登录 401", async () => {
    const res = await h.app.request(`/api/v1/nodes/${docNode}/breadcrumb`, { headers: await h.auth("owner") });
    expect(res.status).toBe(200);
    const body = await json<Record<string, unknown>>(res);
    expect(Object.keys(body).sort()).toEqual([...KEYS.breadcrumb].sort());
    for (const n of body.chain as Array<Record<string, unknown>>) {
      expect(Object.keys(n).sort()).toEqual([...KEYS.breadcrumbNode].sort());
    }
    expect(typeof body.truncatedAbove).toBe("boolean");
    const anon = await h.app.request(`/api/v1/nodes/${docNode}/breadcrumb`);
    expect(anon.status).toBe(401);
  });
});
