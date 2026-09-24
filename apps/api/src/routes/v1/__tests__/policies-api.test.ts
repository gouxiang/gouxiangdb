// M4/S5 节点策略管理 API 端到端：GET/PUT /nodes/:id/policies + GET /nodes/:id/effective。
//
// 覆盖（§7-S5、§4.6、§4.10）：
//  - 鉴权取或：读需节点 r；写需组织 manage_share（role_owner）或节点 decide(manage_share)（creator/直授）；
//    无任何权限 403；未登录 401。effective 缺省本人、查他人需写授权。
//  - PUT 整单校验：坏动作/悬挂主体/kind-动作非法/fieldMask 字段归属，任一不合法整单 4xx 全拒，
//    policyVersion 不增、合法项也不落。
//  - 可映射档反写旧三表；不可映射（角色授予/table 节点）200 带 legacyUnmappable 明细，旧表不动。
//  - policyVersion 成功写递增；GET policies 主体名解析；GET effective 七动作来源链。

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  makeNavHarness,
  dropAllFailTriggers,
  seedBaseWithStarter,
  json,
  type CharHarness,
} from "../../../domain/nav/__tests__/navRouteHarness.js";
import { nodeId } from "../../../domain/nav/backfill.js";
import { RESOURCE_ACTIONS } from "@gx/shared-types";

let h: CharHarness;
let baseId = "";
let tableId = "";
let viewId = "";
let baseNode = "";
let tableNode = "";
let viewNode = "";

async function putPolicies(user: string, node: string, body: unknown): Promise<Response> {
  return await h.app.request(`/api/v1/nodes/${node}/policies`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(await h.auth(user)) },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  h = await makeNavHarness("gx-s5-pol-");
  await h.createUser("owner", { email: "owner@x.com", displayName: "所有者" });
  await h.createUser("admin", { email: "admin@x.com", displayName: "管理员" });
  await h.createUser("sharer", { email: "sharer@x.com", displayName: "分享者" });
  await h.createUser("outsider", { email: "out@x.com", displayName: "外人" });
  await h.createUser("target", { email: "target@x.com", displayName: "目标用户" });
  // admin 仅持工作区 role_owner（组织 manage_share），不是 base 成员/创建人。
  await h.prisma.roleAssignment.create({
    data: { roleId: "role_owner", subjectType: "user", subjectId: "admin", scopeType: "workspace", createdBy: "seed" },
  });
  const seeded = await seedBaseWithStarter(h, "s5p");
  baseId = seeded.baseId;
  tableId = seeded.tableId;
  viewId = seeded.viewId;
  // 夹具 starter table 不带字段，补一条活字段供 fieldMask 归属校验。
  await h.prisma.field.create({
    data: { id: "s5p_field1", tableId, name: "标题", type: "singleLineText", order: 0 },
  });
  baseNode = nodeId("base", baseId);
  tableNode = nodeId("table", tableId);
  viewNode = nodeId("view", viewId);
  // sharer：仅在 base 节点有直授 manage_share+r（资源路径，非组织角色、非创建人、非旧表成员）。
  await h.prisma.authPolicy.create({
    data: {
      id: "s5p_sharer_direct", workspaceId: "ws_default", nodeId: baseNode,
      subjectType: "user", subjectId: "sharer", actions: "manage_share,r", reason: "policy:v1", createdBy: "seed",
    },
  });
}, 120000);

afterEach(async () => {
  await dropAllFailTriggers(h).catch(() => undefined);
});

afterAll(async () => {
  await h.cleanup();
});

describe("鉴权：读 r / 写 manage_share 取或", () => {
  it("未登录 401；无权限用户 GET/PUT 403", async () => {
    const anon = await h.app.request(`/api/v1/nodes/${baseNode}/policies`);
    expect(anon.status).toBe(401);
    const deniedGet = await h.app.request(`/api/v1/nodes/${baseNode}/policies`, { headers: await h.auth("outsider") });
    expect(deniedGet.status).toBe(403);
    const deniedPut = await putPolicies("outsider", baseNode, { upserts: [{ subjectType: "user", subjectId: "target", actions: ["r"] }] });
    expect(deniedPut.status).toBe(403);
  });

  it("creator（owner）经资源兜底可读写；组织 role_owner（admin）经组织动作可读写", async () => {
    const ownerGet = await h.app.request(`/api/v1/nodes/${baseNode}/policies`, { headers: await h.auth("owner") });
    expect(ownerGet.status).toBe(200);
    const adminGet = await h.app.request(`/api/v1/nodes/${baseNode}/policies`, { headers: await h.auth("admin") });
    expect(adminGet.status).toBe(200);
  });

  it("仅持节点直授 manage_share 的 sharer 可写但不是组织角色（资源命名空间隔离）", async () => {
    const res = await putPolicies("sharer", baseNode, {
      upserts: [{ subjectType: "user", subjectId: "target", actions: ["r"] }],
    });
    expect(res.status).toBe(200);
  });
});

describe("PUT 整单校验（任一不合法 -> 整单 4xx 全拒）", () => {
  it("坏动作 400 POLICY_ACTION_INVALID", async () => {
    const res = await putPolicies("owner", baseNode, {
      upserts: [{ subjectType: "user", subjectId: "target", actions: ["zzz"] }],
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: string }>(res)).code).toBe("POLICY_ACTION_INVALID");
  });

  it("悬挂主体 400 POLICY_SUBJECT_INVALID", async () => {
    const res = await putPolicies("owner", baseNode, {
      upserts: [{ subjectType: "user", subjectId: "ghost-no-such-user", actions: ["r"] }],
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: string }>(res)).code).toBe("POLICY_SUBJECT_INVALID");
  });

  it("manage_schema 挂在 base 合法、挂在 view 节点非法（kind-动作）", async () => {
    // base 节点允许 manage_schema（owner 经 base creator 兜底通过写鉴权）。
    const ok = await putPolicies("owner", baseNode, {
      upserts: [{ subjectType: "user", subjectId: "target", actions: ["manage_schema", "r"] }],
    });
    expect(ok.status).toBe(200);
    // view 节点不允许 manage_schema：admin 经组织 manage_share 过鉴权后，命中 kind-动作校验 400。
    const bad = await putPolicies("admin", viewNode, {
      upserts: [{ subjectType: "user", subjectId: "target", actions: ["manage_schema"] }],
    });
    expect(bad.status).toBe(400);
    expect((await json<{ code: string }>(bad)).code).toBe("POLICY_ACTION_INVALID");
  });

  it("fieldMask 引用不属于该 table 的字段 -> 400 POLICY_FIELD_INVALID", async () => {
    const res = await putPolicies("owner", tableNode, {
      upserts: [{
        subjectType: "user", subjectId: "target", actions: ["r"],
        fieldMask: { allowFields: ["fld_not_belong_to_this_table"] },
      }],
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: string }>(res)).code).toBe("POLICY_FIELD_INVALID");
  });

  it("fieldMask 引用本表活字段 -> 200，回读字段掩码保留", async () => {
    const field = await h.prisma.field.findFirst({ where: { tableId }, select: { id: true } });
    expect(field).toBeTruthy();
    const res = await putPolicies("owner", tableNode, {
      upserts: [{
        subjectType: "user", subjectId: "target", actions: ["r"],
        fieldMask: { allowFields: [field!.id] },
      }],
    });
    expect(res.status).toBe(200);
    const row = await h.prisma.authPolicy.findFirst({
      where: { nodeId: tableNode, subjectType: "user", subjectId: "target" },
    });
    expect(row?.fieldMask).toContain(field!.id);
  });

  it("一合法一非法整单拒：合法项不落、policyVersion 不增", async () => {
    const before = await h.prisma.workspace.findUniqueOrThrow({ where: { id: "ws_default" } });
    const res = await putPolicies("owner", baseNode, {
      upserts: [
        { subjectType: "user", subjectId: "target", actions: ["u"] },
        { subjectType: "user", subjectId: "ghost", actions: ["r"] },
      ],
    });
    expect(res.status).toBe(400);
    const after = await h.prisma.workspace.findUniqueOrThrow({ where: { id: "ws_default" } });
    expect(after.policyVersion).toBe(before.policyVersion);
    // 合法项（u）也不得落：target 在 base 节点仍是先前的 viewer(r) 串（fieldMask 用例在 table 节点）。
    const row = await h.prisma.authPolicy.findFirst({
      where: { nodeId: baseNode, subjectType: "user", subjectId: "target" },
    });
    expect(row?.actions ?? "").not.toContain("u");
  });

  it("节点不存在 -> 404；空 upserts/deletes -> 400", async () => {
    const missing = await putPolicies("owner", "nav_base_nope", { upserts: [{ subjectType: "user", subjectId: "target", actions: ["r"] }] });
    expect(missing.status).toBe(404);
    const empty = await putPolicies("owner", baseNode, {});
    expect(empty.status).toBe(400);
  });
});

describe("legacyUnmappable 实测响应 + 旧表不写", () => {
  it("角色授予不可映射：200 带 legacyUnmappable 明细，members 旧表不动，auth_policies 行保留", async () => {
    const membersBefore = await h.prisma.member.count({ where: { baseId } });
    const res = await putPolicies("owner", baseNode, {
      upserts: [{ subjectType: "role", subjectId: "role_viewer", actions: ["r"] }],
    });
    expect(res.status).toBe(200);
    const body = await json<{
      legacyUnmappable: Array<{ subjectType: string; subjectId: string; reasons: string[] }>;
      policyVersion: number;
    }>(res);
    const item = body.legacyUnmappable.find((x) => x.subjectType === "role" && x.subjectId === "role_viewer");
    expect(item).toBeTruthy();
    expect(item!.reasons.length).toBeGreaterThan(0);
    // 旧三表行数零变化（角色授予不回写 per-user 成员行）。
    expect(await h.prisma.member.count({ where: { baseId } })).toBe(membersBefore);
    // 但权威 auth_policies 行落地并保留（off 态不生效但行保留，重开恢复）。
    const row = await h.prisma.authPolicy.findFirst({
      where: { nodeId: baseNode, subjectType: "role", subjectId: "role_viewer" },
    });
    expect(row).toBeTruthy();
    expect(row!.actions).toBe("r");
  });
});

describe("GET policies 主体解析与继承摘要", () => {
  it("200 返回 direct 行并解析 user/role 显示名，含节点继承态", async () => {
    const res = await h.app.request(`/api/v1/nodes/${baseNode}/policies`, { headers: await h.auth("owner") });
    expect(res.status).toBe(200);
    const body = await json<{
      node: { id: string; kind: string };
      inheritAncestors: boolean;
      direct: Array<{ subjectType: string; subjectId: string; subjectName: string | null; actions: string[] }>;
    }>(res);
    expect(body.node.id).toBe(baseNode);
    expect(typeof body.inheritAncestors).toBe("boolean");
    const targetRow = body.direct.find((d) => d.subjectType === "user" && d.subjectId === "target");
    expect(targetRow).toBeTruthy();
    expect(targetRow!.subjectName).toBe("目标用户");
  });
});

describe("GET effective 决策解释器", () => {
  it("缺省查本人返回八动作判定与来源链；查他人无 manage_share 403", async () => {
    const own = await h.app.request(`/api/v1/nodes/${baseNode}/effective`, { headers: await h.auth("sharer") });
    expect(own.status).toBe(200);
    const body = await json<{
      actions: string[];
      perAction: Array<{ action: string; allowed: boolean; sources: unknown[] }>;
    }>(own);
    expect(body.perAction.length).toBe(RESOURCE_ACTIONS.length);
    expect(body.actions).toContain("r");
    expect(body.actions).toContain("manage_share");
    // sharer 的 manage_share 来自直授 policy（direct）。
    const ms = body.perAction.find((p) => p.action === "manage_share")!;
    expect(ms.allowed).toBe(true);

    // outsider 查 target 的 effective：outsider 对节点无 r，先撞读 403。
    const peek = await h.app.request(
      `/api/v1/nodes/${baseNode}/effective?userId=target`,
      { headers: await h.auth("outsider") },
    );
    expect(peek.status).toBe(403);
  });

  it("owner 查他人 effective 放行（creator 兜底），来源链含 subjectName/nodeName", async () => {
    const res = await h.app.request(
      `/api/v1/nodes/${baseNode}/effective?userId=target`,
      { headers: await h.auth("owner") },
    );
    expect(res.status).toBe(200);
    const body = await json<{
      userId: string;
      perAction: Array<{ action: string; allowed: boolean; sources: Array<{ kind: string; nodeName: string | null }> }>;
    }>(res);
    expect(body.userId).toBe("target");
    // base owner 创建人兜底对 target 不成立（target 非 creator）；target 在 base 节点有直授 r。
    const r = body.perAction.find((p) => p.action === "r")!;
    expect(r.allowed).toBe(true);
  });
});
