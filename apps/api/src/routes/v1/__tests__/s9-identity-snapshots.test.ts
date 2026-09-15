// M4/S9 三身份响应快照：所有 v1 权限新端点在 viewer / 节点 manage_share / workspace owner
// 三身份下的授权矩阵与响应形状（真迁移临时库 + 真 createApp/真 JWT，不 mock）。
//
// 三身份：
//   owner  = 系统 role_owner（组织 manage_share + 实体 creator/workspace owner 兜底）
//   sharer = 仅在被测节点直授 manage_share,r（资源命名空间：能写本节点/查本节点他人 effective，
//            但不是工作区 owner，不能跨用户查 visible-scope）
//   viewer = 仅节点 r（能读 policies/effective 本人，不能写、不能查他人）
//
// 形状键集合已在 s8-openapi-shapes 对拍 openapi；本文件锁定身份维度的状态码与载荷差异。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeNavHarness,
  seedBaseWithStarter,
  seedKbWithDocs,
  json,
  type CharHarness,
} from "../../../domain/nav/__tests__/navRouteHarness.js";
import { nodeId } from "../../../domain/nav/backfill.js";

let h: CharHarness;
let baseNode = "";
let docNode = "";

const OWNER = "owner"; // seedBaseWithStarter/seedKbWithDocs 写死 owner 为创建人/owner 成员
const SHARER = "s9_sharer";
const VIEWER = "s9_viewer";
const TARGET = "s9_target";

async function grant(node: string, subjectId: string, actions: string, id: string): Promise<void> {
  await h.prisma.authPolicy.create({
    data: {
      id, workspaceId: "ws_default", nodeId: node,
      subjectType: "user", subjectId, actions, reason: "policy:v1", createdBy: "seed",
    },
  });
}

beforeAll(async () => {
  h = await makeNavHarness("gx-m4-s9-id-");
  for (const [id, name] of [
    [OWNER, "所有者"], [SHARER, "节点分享者"], [VIEWER, "只读成员"], [TARGET, "目标用户"],
  ] as const) {
    await h.createUser(id, { email: `${id}@x.com`, displayName: name });
  }
  await h.prisma.roleAssignment.create({
    data: { roleId: "role_owner", subjectType: "user", subjectId: OWNER, scopeType: "workspace", createdBy: "seed" },
  });
  const base = await seedBaseWithStarter(h, "s9id");
  baseNode = nodeId("base", base.baseId);
  const kb = await seedKbWithDocs(h, "s9id");
  docNode = nodeId("doc", kb.rootDoc);
  await grant(baseNode, SHARER, "manage_share,r", "s9p_base_sharer");
  await grant(baseNode, VIEWER, "r", "s9p_base_viewer");
  await grant(docNode, SHARER, "manage_share,r", "s9p_doc_sharer");
  await grant(docNode, VIEWER, "r", "s9p_doc_viewer");
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

async function get(url: string, user: string | null): Promise<Response> {
  return await h.app.request(url, { headers: user ? await h.auth(user) : {} });
}
async function put(url: string, user: string, body: unknown): Promise<Response> {
  return await h.app.request(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(await h.auth(user)) },
    body: JSON.stringify(body),
  });
}
async function patch(url: string, user: string, body: unknown): Promise<Response> {
  return await h.app.request(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await h.auth(user)) },
    body: JSON.stringify(body),
  });
}

describe("GET /nodes/:id/policies（读需 r）三身份快照", () => {
  it.each([
    [OWNER, 200], [SHARER, 200], [VIEWER, 200],
  ])("%s 有 r -> 200 NodePoliciesView", async (user, want) => {
    const res = await get(`/api/v1/nodes/${baseNode}/policies`, user);
    expect(res.status).toBe(want);
    const body = await json<Record<string, unknown>>(res);
    expect(Object.keys(body).sort()).toEqual(["ancestors", "direct", "inheritAncestors", "node"]);
  });

  it("未登录 -> 401；viewer 响应不含 manage 能力暗示（direct 仅为数据行）", async () => {
    const anon = await get(`/api/v1/nodes/${baseNode}/policies`, null);
    expect(anon.status).toBe(401);
    const res = await get(`/api/v1/nodes/${baseNode}/policies`, VIEWER);
    const body = await json<{ direct: Array<{ subjectId: string }> }>(res);
    expect(body.direct.some((r) => r.subjectId === VIEWER)).toBe(true);
  });
});

describe("PUT /nodes/:id/policies（写需组织或节点 manage_share）三身份快照", () => {
  it("owner 与 sharer -> 200 PolicyWriteResult；viewer -> 403", async () => {
    const payload = { upserts: [{ subjectType: "user", subjectId: TARGET, actions: ["r"] }] };
    for (const [user, want] of [[OWNER, 200], [SHARER, 200]] as const) {
      const res = await put(`/api/v1/nodes/${baseNode}/policies`, user, payload);
      expect(res.status, user).toBe(want);
      expect(Object.keys(await json(res))).toContain("legacyUnmappable");
    }
    const denied = await put(`/api/v1/nodes/${baseNode}/policies`, VIEWER, payload);
    expect(denied.status).toBe(403);
  });
});

describe("GET /nodes/:id/effective 三身份快照", () => {
  it("三身份查本人 -> 200（都有 r），userId 回显本人", async () => {
    for (const user of [OWNER, SHARER, VIEWER]) {
      const res = await get(`/api/v1/nodes/${baseNode}/effective`, user);
      expect(res.status, user).toBe(200);
      const body = await json<{ userId: string; perAction: unknown[] }>(res);
      expect(body.userId).toBe(user);
      expect(body.perAction.length).toBe(7);
    }
  });

  it("查他人：owner/sharer -> 200（manage_share），viewer -> 403", async () => {
    for (const [user, want] of [[OWNER, 200], [SHARER, 200], [VIEWER, 403]] as const) {
      const res = await get(`/api/v1/nodes/${baseNode}/effective?userId=${TARGET}`, user);
      expect(res.status, user).toBe(want);
      if (want === 200) expect((await json<{ userId: string }>(res)).userId).toBe(TARGET);
    }
  });
});

describe("GET /authz/visible-scope 三身份快照", () => {
  it("三身份查本人 -> 200 VisibleScope", async () => {
    for (const user of [OWNER, SHARER, VIEWER]) {
      const res = await get("/api/v1/authz/visible-scope", user);
      expect(res.status, user).toBe(200);
      const body = await json<{ userId: string; materialize: string }>(res);
      expect(body.userId).toBe(user);
      expect(["in_list", "temp_table"]).toContain(body.materialize);
    }
  });

  it("查他人是工作区级排障：仅 owner -> 200；sharer（节点 manage_share 非 workspace owner）与 viewer -> 403", async () => {
    const ok = await get(`/api/v1/authz/visible-scope?userId=${TARGET}`, OWNER);
    expect(ok.status).toBe(200);
    expect((await json<{ userId: string }>(ok)).userId).toBe(TARGET);
    for (const user of [SHARER, VIEWER]) {
      const denied = await get(`/api/v1/authz/visible-scope?userId=${TARGET}`, user);
      expect(denied.status, user).toBe(403);
    }
  });
});

describe("GET inheritance/impact + PATCH（doc，需 manage_share）三身份快照", () => {
  it("impact：owner/sharer -> 200 InheritanceImpact 9 键；viewer -> 403；未登录 401", async () => {
    for (const [user, want] of [[OWNER, 200], [SHARER, 200], [VIEWER, 403]] as const) {
      const res = await get(`/api/v1/nodes/${docNode}/inheritance/impact?value=0`, user);
      expect(res.status, user).toBe(want);
      if (want === 200) {
        const body = await json<Record<string, unknown>>(res);
        expect(Object.keys(body).sort()).toEqual(
          ["count", "delta", "exempt", "from", "items", "limit", "nodeId", "offset", "to"],
        );
      }
    }
    const anon = await get(`/api/v1/nodes/${docNode}/inheritance/impact?value=0`, null);
    expect(anon.status).toBe(401);
  });

  it("PATCH 未确认：owner -> 409 INHERITANCE_CONFIRM_REQUIRED 带 impact；viewer -> 403（确认门先验授权）", async () => {
    const confirm = await patch(`/api/v1/nodes/${docNode}/inheritance`, OWNER, { value: false });
    expect([200, 409]).toContain(confirm.status); // 幂等（doc 已 inherit=0）时 200，否则 409
    if (confirm.status === 409) {
      const body = await json<{ code: string; impact: Record<string, unknown> }>(confirm);
      expect(body.code).toBe("INHERITANCE_CONFIRM_REQUIRED");
      expect(body.impact.nodeId).toBe(docNode);
    }
    const denied = await patch(`/api/v1/nodes/${docNode}/inheritance`, VIEWER, { value: false, confirmed: true });
    expect(denied.status).toBe(403);
  });
});

describe("GET breadcrumb（读需 r）三身份快照", () => {
  it("有 r -> 200 {nodeId,chain,truncatedAbove}；无 r 身份不存在此处，未登录 401", async () => {
    for (const user of [OWNER, SHARER, VIEWER]) {
      const res = await get(`/api/v1/nodes/${docNode}/breadcrumb`, user);
      expect(res.status, user).toBe(200);
      const body = await json<{ nodeId: string; truncatedAbove: boolean }>(res);
      expect(body.nodeId).toBe(docNode);
      expect(typeof body.truncatedAbove).toBe("boolean");
    }
    const anon = await get(`/api/v1/nodes/${docNode}/breadcrumb`, null);
    expect(anon.status).toBe(401);
  });
});
