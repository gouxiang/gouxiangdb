// M3/S7 openapi.yaml 首版冻结契约对拍（计划 §7-S7、裁决 5/5b）。
//
// 零新依赖（不引 swagger/redoc/openapi-validator/yaml 解析器）：
//   A. 结构断言：直接读 docs/api/openapi.yaml 文本，校验版本/安全方案/全路径/全错误码/
//      无 emoji、无 Unicode 箭头、未偷切 {code:0,data,message} 信封；
//   B. 真路由形状对拍：起真 createApp + 真迁移临时库，对关键端点打真请求，
//      手写断言响应键集合与 openapi schema 描述一致。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, json, type OrgHarness } from "../../routes/v1/org/__tests__/orgHarness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = path.resolve(here, "../../../../../docs/api/openapi.yaml");
const yaml = fs.readFileSync(OPENAPI_PATH, "utf8");

// openapi 文档必须覆盖的路径（server url=/api/v1，故此处为相对路径）。
const REQUIRED_PATHS = [
  "/meta",
  "/auth/invite/accept",
  "/authz/visible-scope",
  "/org/departments",
  "/org/departments/{id}",
  "/org/members",
  "/org/members/invite",
  "/org/members/me/effective-roles",
  "/org/members/{id}",
  "/org/members/{id}/effective-roles",
  "/org/members/{id}/departments",
  "/org/members/{id}/disable",
  "/org/members/{id}/reactivate",
  "/org/roles",
  "/org/roles/{id}",
  "/org/roles/{id}/assignments",
  "/workspaces/current/tree",
  "/workspaces/current/menu",
  "/nav/groups",
  "/nav/groups/{id}",
  "/nodes/{id}/move-impact",
  "/nodes/{id}/move",
  "/nodes/{id}/policies",
  "/nodes/{id}/effective",
  "/nodes/{id}/inheritance/impact",
  "/nodes/{id}/inheritance",
  "/nodes/{id}/breadcrumb",
  // M5/S9 统一检索管理面（六端点；仅 GX_M5_SEARCH on/shadow 挂载）。
  "/admin/reindex",
  "/admin/search/status",
  "/admin/embedding/config",
  "/admin/embedding/api-key/rotate",
  "/admin/embedding/api-key",
];

const REQUIRED_ERROR_CODES = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "HTTP_405",
  "TOO_MANY_REQUESTS",
  "INTERNAL",
  "NAV_CYCLE",
  "NAV_DEPTH_EXCEEDED",
  "NAV_MENU_DEPTH",
  "NAV_NODE_IN_USE",
  "NAV_GROUP_NOT_EMPTY",
  "NAV_RESOURCE_MISSING",
  "MOVE_NEEDS_CONFIRM",
  "INHERITANCE_CONFIRM_REQUIRED",
  "NODE_NOT_INHERITABLE",
  // M4/S8 权限域定名冻结（6 枚去重全集；后两枚为预留码，本期不经 REST 产出）。
  "FORBIDDEN_FIELD",
  "FORBIDDEN_RESOURCE",
  "POLICY_CONFLICT",
  "POLICY_CONDITION_UNSUPPORTED",
  // M4/S5 策略整单写校验细码（PolicyValidationError.code 原样透传）。
  "POLICY_NODE_NOT_FOUND",
  "POLICY_NODE_KIND_INVALID",
  "POLICY_SUBJECT_INVALID",
  "POLICY_ACTION_INVALID",
  "POLICY_FIELD_INVALID",
  "POLICY_BAD_INPUT",
  // M5/S9 统一检索管理面（只增）。
  "SEARCH_UNAVAILABLE",
  "REINDEX_IN_PROGRESS",
  "REINDEX_FAILED",
  "EMBEDDING_CONFIG_INVALID",
  "NEED_CLOUD_CONFIRM",
];

describe("S7 openapi.yaml 结构冻结", () => {
  it("文件存在且为 OpenAPI 3.0.3 / info.version 1.0.0", () => {
    expect(yaml.startsWith("openapi: 3.0.3")).toBe(true);
    expect(yaml).toMatch(/version: 1\.0\.0/);
  });

  it("声明 bearer JWT 安全方案且全局默认要求登录", () => {
    expect(yaml).toContain("type: http");
    expect(yaml).toContain("scheme: bearer");
    expect(yaml).toContain("bearerFormat: JWT");
    expect(yaml).toMatch(/security:\s*\n\s*- bearerAuth: \[\]/);
    // 公开邀请端点显式摘除安全方案。
    expect(yaml).toContain("security: []");
  });

  it.each(REQUIRED_PATHS)("覆盖路径 %s", (p) => {
    expect(yaml).toContain(`  ${p}:`);
  });

  it.each(REQUIRED_ERROR_CODES)("错误码全集含 %s", (code) => {
    expect(yaml).toContain(code);
  });

  it("写实错误信封 {error, code}，未偷切 {code:0,data,message}", () => {
    expect(yaml).toMatch(/required: \[error, code\]/);
    expect(yaml).not.toContain("code: 0");
    expect(yaml).not.toMatch(/^\s+data:\s*$/m);
  });

  it("五枚组织动作与七类 nav kind 均在枚举内", () => {
    for (const a of ["manage_departments", "manage_members", "manage_roles", "manage_menu", "manage_share"]) {
      expect(yaml).toContain(a);
    }
    for (const k of ["base", "kb", "table", "view", "doc", "canvas", "group"]) {
      expect(yaml).toContain(k);
    }
    for (const s of ["alive", "soft_dangling", "broken"]) {
      expect(yaml).toContain(s);
    }
  });

  it("文档无 emoji 与 Unicode 箭头（ASCII -> 也不使用）", () => {
    expect(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u.test(yaml)).toBe(false);
  });

  it("S5 policies/effective 三端点形状在文档内且 legacyUnmappable 不在错误码表", () => {
    for (const p of ["/nodes/{id}/policies", "/nodes/{id}/effective"]) {
      expect(yaml).toContain(p);
    }
    // 七枚资源动作与三源 + owner_fallback 来源类型均在文档。
    for (const a of ["r", "c", "u", "d", "comment", "manage_share", "manage_schema"]) {
      expect(yaml).toContain(a);
    }
    for (const k of ["direct", "dept", "role", "owner_fallback", "policyVersion", "fieldMask"]) {
      expect(yaml).toContain(k);
    }
    // legacyUnmappable 是 200 成功载荷，绝不能进入 Error.code 枚举（错误码表不含该项）。
    const errorEnumMatch = yaml.match(/code:\s*\n\s*type: string\s*\n\s*enum:\s*\n((?:\s*- .*\n)+)/);
    expect(errorEnumMatch).not.toBeNull();
    expect(errorEnumMatch![1]).not.toContain("legacyUnmappable");
    // 但作为成功响应字段必须被文档化（S8 提取为 LegacyUnmappableItem 组件，类型为数组）。
    expect(yaml).toMatch(/legacyUnmappable:\s*(?:\n\s*type: array|\{ type: array)/);
  });
});

describe("S7 真路由响应形状对拍", () => {
  let h: OrgHarness;
  let g1 = "";
  let g2 = "";

  beforeAll(async () => {
    h = await setupOrgHarness();
    await h.createUser("owner");
    await h.grantSystemRole("owner", "owner");

    const create = async (body: unknown): Promise<string> => {
      const res = await h.app.request("/api/v1/nav/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(201);
      return (await json<{ id: string }>(res)).id;
    };
    g1 = await create({ name: "分组一" });
    g2 = await create({ name: "分组二" });
  }, 120000);

  afterAll(async () => {
    await h.cleanup();
  });

  it("GET tree 根层分块 = {workspaceId,navVersion,items[],truncated}，节点键齐", async () => {
    const res = await h.app.request("/api/v1/workspaces/current/tree?parentId=root&maxDepth=2", {
      headers: await h.auth("owner"),
    });
    expect(res.status).toBe(200);
    const body = await json<Record<string, unknown>>(res);
    expect(Object.keys(body).sort()).toEqual(["items", "navVersion", "truncated", "workspaceId"]);
    expect(body.workspaceId).toBe("ws_default");
    expect(typeof body.navVersion).toBe("number");
    expect(body.truncated).toBe(false);
    expect(Array.isArray(body.items)).toBe(true);
    const node = (body.items as Array<Record<string, unknown>>).find((n) => n.id === g1);
    expect(node).toBeTruthy();
    expect(Object.keys(node!).sort()).toEqual(
      ["createdAt", "deletedAt", "depth", "iconName", "id", "isSystem", "kind", "name", "ord", "parentId", "path", "resourceId", "resourceType", "updatedAt", "workspaceId"].sort(),
    );
    expect(node!.kind).toBe("group");
  });

  it("GET menu = {workspaceId,menuVersion,items[]}", async () => {
    const res = await h.app.request("/api/v1/workspaces/current/menu", { headers: await h.auth("owner") });
    expect(res.status).toBe(200);
    const body = await json<Record<string, unknown>>(res);
    expect(Object.keys(body).sort()).toEqual(["items", "menuVersion", "workspaceId"]);
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("POST groups 201 = {id}；PATCH = {id}", async () => {
    const res = await h.app.request(`/api/v1/nav/groups/${g2}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
      body: JSON.stringify({ name: "分组二改名" }),
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ id: g2 });
  });

  it("GET move-impact = MoveImpact 六键（M4/S7 三源口径；空 group 无内容 -> 人数 0、hint false）", async () => {
    const res = await h.app.request(`/api/v1/nodes/${g1}/move-impact?newParentId=${g2}`, {
      headers: await h.auth("owner"),
    });
    expect(res.status).toBe(200);
    const body = await json<Record<string, unknown>>(res);
    expect(Object.keys(body).sort()).toEqual(
      ["affectedUserCount", "newParentId", "nodeId", "shortcutCount", "subtreeItemCount", "willBreakInheritanceHint"].sort(),
    );
    expect(body.nodeId).toBe(g1);
    expect(body.newParentId).toBe(g2);
    expect(body.subtreeItemCount).toBe(0); // 空 group 无 table/doc/canvas 内容
    expect(body.affectedUserCount).toBe(0); // 三源对称差：无内容节点即无人受影响
    expect(body.shortcutCount).toBe(0);
    expect(body.willBreakInheritanceHint).toBe(false); // 不跨越 inheritAncestors=0 边界
  });

  it("POST move 未 confirmed -> 409 {error,code:MOVE_NEEDS_CONFIRM,impact}，节点不动", async () => {
    const res = await h.app.request(`/api/v1/nodes/${g1}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
      body: JSON.stringify({ newParentId: g2 }),
    });
    expect(res.status).toBe(409);
    const body = await json<Record<string, unknown>>(res);
    expect(body.code).toBe("MOVE_NEEDS_CONFIRM");
    expect(typeof body.error).toBe("string");
    const impact = body.impact as Record<string, unknown>;
    expect(Object.keys(impact).sort()).toEqual(
      ["affectedUserCount", "newParentId", "nodeId", "shortcutCount", "subtreeItemCount", "willBreakInheritanceHint"].sort(),
    );
  });

  it("PATCH menu 整单 = {menuVersion,applied,itemIds}，项可回读", async () => {
    const res = await h.app.request("/api/v1/workspaces/current/menu", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
      body: JSON.stringify({ operations: [{ op: "insert", type: "container", label: "新容器", ord: 0 }] }),
    });
    expect(res.status).toBe(200);
    const body = await json<Record<string, unknown>>(res);
    expect(Object.keys(body).sort()).toEqual(["applied", "itemIds", "menuVersion"]);
    expect(body.applied).toBe(1);
    expect(Array.isArray(body.itemIds)).toBe(true);
    expect((body.itemIds as unknown[]).length).toBeGreaterThan(0);
  });

  it("PATCH menu 坏 shortcut nodeId -> 409 NAV_RESOURCE_MISSING 且整单不落", async () => {
    const before = await h.app.request("/api/v1/workspaces/current/menu", { headers: await h.auth("owner") });
    const beforeBody = await json<{ items: unknown[] }>(before);
    const res = await h.app.request("/api/v1/workspaces/current/menu", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
      body: JSON.stringify({ operations: [{ op: "insert", type: "shortcut", nodeId: "nav_missing_xxx" }] }),
    });
    expect(res.status).toBe(409);
    const body = await json<Record<string, unknown>>(res);
    expect(body.code).toBe("NAV_RESOURCE_MISSING");
    expect(typeof body.error).toBe("string");
    const after = await h.app.request("/api/v1/workspaces/current/menu", { headers: await h.auth("owner") });
    const afterBody = await json<{ items: unknown[] }>(after);
    expect(afterBody.items.length).toBe(beforeBody.items.length);
  });

  it("GET meta = {apiVersion,enterpriseOrg,auth{userId,status,workspaceId}}", async () => {
    const res = await h.app.request("/api/v1/meta", { headers: await h.auth("owner") });
    expect(res.status).toBe(200);
    const body = await json<Record<string, unknown>>(res);
    expect(body.apiVersion).toBe("v1");
    expect(body.enterpriseOrg).toBe(true);
    expect(Object.keys(body.auth as object).sort()).toEqual(["status", "userId", "workspaceId"]);
  });

  it("GET org/members 分页 = {items,total,page,limit,hasMore}", async () => {
    const res = await h.app.request("/api/v1/org/members?page=1&limit=20", { headers: await h.auth("owner") });
    expect(res.status).toBe(200);
    const body = await json<Record<string, unknown>>(res);
    expect(Object.keys(body).sort()).toEqual(["hasMore", "items", "limit", "page", "total"]);
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("无 token -> 401 {error, code:UNAUTHORIZED}", async () => {
    const res = await h.app.request("/api/v1/meta");
    expect(res.status).toBe(401);
    const body = await json<Record<string, unknown>>(res);
    expect(typeof body.error).toBe("string");
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("S7 inheritance impact/PATCH：group 非 doc/canvas -> 400 NODE_NOT_INHERITABLE（kind 白名单真路由）", async () => {
    const impact = await h.app.request(`/api/v1/nodes/${g1}/inheritance/impact?value=0`, {
      headers: await h.auth("owner"),
    });
    expect(impact.status).toBe(400);
    expect((await json<{ code: string }>(impact)).code).toBe("NODE_NOT_INHERITABLE");
    const patch = await h.app.request(`/api/v1/nodes/${g1}/inheritance`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
      body: JSON.stringify({ value: false, confirmed: true }),
    });
    expect(patch.status).toBe(400);
    expect((await json<{ code: string }>(patch)).code).toBe("NODE_NOT_INHERITABLE");
  });

  it("S7 breadcrumb：group 200 = {nodeId,chain[],truncatedAbove}；未登录 401", async () => {
    const res = await h.app.request(`/api/v1/nodes/${g1}/breadcrumb`, { headers: await h.auth("owner") });
    expect(res.status).toBe(200);
    const body = await json<Record<string, unknown>>(res);
    expect(Object.keys(body).sort()).toEqual(["chain", "nodeId", "truncatedAbove"]);
    expect(body.nodeId).toBe(g1);
    expect(Array.isArray(body.chain)).toBe(true);
    const chain = body.chain as Array<Record<string, unknown>>;
    expect(chain[0]?.id).toBe(g1);
    for (const n of chain) {
      expect(Object.keys(n).sort()).toEqual(
        ["depth", "id", "kind", "name", "parentId", "path", "resourceId", "resourceType"].sort(),
      );
    }
    expect(body.truncatedAbove).toBe(false);
    const anon = await h.app.request(`/api/v1/nodes/${g1}/breadcrumb`);
    expect(anon.status).toBe(401);
  });
});
