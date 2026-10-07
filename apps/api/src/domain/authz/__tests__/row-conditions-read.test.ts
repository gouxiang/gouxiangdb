// P1-S8b-2 行级可见行条件（RowConditions）【列表 / 详情 / 写入口】读求值端到端。
// 复用 navRouteHarness 真 app/真库夹具；策略经 PUT /api/v1/nodes/<table>/policies 写入，
// 请求带目标用户真 JWT（不自造鉴权）。引擎永久单一化后 fieldMask 门与行级条件恒生效（无开关）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeNavHarness,
  seedBaseWithStarter,
  json,
  type CharHarness,
} from "../../nav/__tests__/navRouteHarness.js";
import { nodeId } from "../../nav/backfill.js";

let h: CharHarness;
let tableId = "";
let tableNode = "";
let titleFid = "";
let ownerFid = "";

interface ListBody {
  records: Array<{ id: string; fields: Record<string, unknown> }>;
  total: number;
  filteredTotal: number;
}

async function putPolicies(body: unknown): Promise<Response> {
  return await h.app.request(`/api/v1/nodes/${tableNode}/policies`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
    body: JSON.stringify(body),
  });
}

async function listAs(user: string): Promise<ListBody> {
  const res = await h.app.request(`/api/records?tableId=${tableId}&limit=1000`, {
    headers: await h.auth(user),
  });
  expect(res.status).toBe(200);
  return await json<ListBody>(res);
}

async function detailAs(user: string, recordId: string): Promise<Response> {
  return await h.app.request(`/api/records/${recordId}`, { headers: await h.auth(user) });
}

async function patchAs(user: string, recordId: string, fields: Record<string, unknown>): Promise<Response> {
  return await h.app.request(`/api/records/${recordId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await h.auth(user)) },
    body: JSON.stringify({ fields }),
  });
}

async function deleteAs(user: string, recordId: string): Promise<Response> {
  return await h.app.request(`/api/records/${recordId}`, {
    method: "DELETE",
    headers: await h.auth(user),
  });
}

/** owner 身份插一行（建实体阶段 off，不涉引擎）。 */
async function insertRow(fields: Record<string, unknown>, createdBy = "owner"): Promise<string> {
  const res = await h.app.request(`/api/records?tableId=${tableId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
    body: JSON.stringify({ fields }),
  });
  expect(res.status).toBe(201);
  const id = (await json<{ record: { id: string } }>(res)).record.id;
  if (createdBy !== "owner") {
    await h.prisma.record.update({ where: { id }, data: { createdBy } });
  }
  return id;
}

beforeAll(async () => {
  h = await makeNavHarness("gx-s8b-read-");
  await h.createUser("owner", { email: "s8br-owner@x.com", displayName: "所有者" });
  await h.createUser("target", { email: "s8br-target@x.com", displayName: "目标用户" });
  await h.createUser("other", { email: "s8br-other@x.com", displayName: "另一用户" });
  // owner 需 workspace role_owner：新库守卫只认角色（legacy member owner 不放大）。
  await h.grantRole("owner");
  const seeded = await seedBaseWithStarter(h, "s8br");
  tableId = seeded.tableId;
  tableNode = nodeId("table", tableId);

  titleFid = "s8br_title";
  ownerFid = "s8br_owner";
  await h.prisma.field.create({
    data: { id: titleFid, tableId, name: "标题", type: "singleLineText", order: 0 },
  });
  await h.prisma.field.create({
    data: { id: ownerFid, tableId, name: "负责人", type: "createdBy", order: 1 },
  });
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

describe("RowConditions 读求值（on 态）", () => {
  let hitId = "";
  let missId = "";
  let otherRowId = "";

  beforeAll(async () => {
    // 建数据阶段保持 off（引擎不介入）；全部插完再翻 on。
    // target 的表级入口：非 creator、非 workspace owner；member editor + role_library_scope
    // 只保证旧守卫放行，行级是否可见由 RowConditions 决定（r 策略带窄条件）。
    await h.prisma.member.create({
      data: { id: "s8br_member_target", baseId: "s8br_b", userId: "target", role: "editor" },
    });
    await h.prisma.role.create({
      data: { id: "s8br_role", workspaceId: "ws_default", name: "s8br", isSystem: 0, permissions: "[]" },
    });
    await h.prisma.roleAssignment.create({
      data: { roleId: "s8br_role", subjectType: "user", subjectId: "target", scopeType: "workspace", createdBy: "seed" },
    });
    await h.prisma.roleLibraryScope.create({
      data: {
        roleId: "s8br_role", libraryKind: "base", libraryId: "s8br_b", canManage: 0, visible: 1,
        config: JSON.stringify({
          tables: { [tableId]: { read: true, create: true, update: true, delete: true } },
          fields: {},
        }),
      },
    });

    hitId = await insertRow({ [titleFid]: "命中行", [ownerFid]: null }, "owner");
    missId = await insertRow({ [titleFid]: "不命中行", [ownerFid]: null }, "other");
    otherRowId = await insertRow({ [titleFid]: "他人负责行", [ownerFid]: null }, "other");
    // 通电后（READY=true，on 为权威）库门位须由 scope 投影提供：补 base 节点聚合位
    // enter（=visible）+ edit_data（表可写并集）。二者非 table 内容动作，故不制造无条件
    // table 宽来源、不干扰本文件用 PUT 写入的带行条件 r/u（行级过滤仍只由那些窄策略决定）。
    await h.prisma.authPolicy.create({
      data: {
        id: "s8br_base_gate", workspaceId: "ws_default", nodeId: nodeId("base", "s8br_b"),
        subjectType: "user", subjectId: "target", actions: "edit_data,enter",
        reason: "test:gate", createdBy: "owner",
      },
    });
  }, 120000);

  it("列表：窄条件只命中部分行，records/filteredTotal 收窄、total 仍为物理总数", async () => {
    const res = await putPolicies({
      upserts: [{
        subjectType: "user",
        subjectId: "target",
        actions: ["r", "u"],
        conditions: {
          version: 1,
          filter: { kind: "condition", fieldId: titleFid, op: "is", value: "命中行" },
        },
      }],
    });
    expect(res.status).toBe(200);

    const body = await listAs("target");
    expect(body.total).toBe(3);
    expect(body.filteredTotal).toBe(1);
    expect(body.records.map((r) => r.id)).toEqual([hitId]);
  });

  it("currentUser：createdBy 人名字段 + dynamic currentUser，只返回属于该用户的行", async () => {
    const res = await putPolicies({
      upserts: [{
        subjectType: "user",
        subjectId: "target",
        actions: ["r", "u"],
        conditions: {
          version: 1,
          filter: {
            kind: "condition", fieldId: ownerFid, op: "is",
            valueType: "dynamic", dynamicValue: "currentUser",
          },
        },
      }],
    });
    expect(res.status).toBe(200);

    // target 自己负责一行：把 hitId 行 createdBy 改为 target（ownerFid 即 createdBy 投影）。
    await h.prisma.record.update({ where: { id: hitId }, data: { createdBy: "target" } });
    const body = await listAs("target");
    expect(body.filteredTotal).toBe(1);
    expect(body.records.map((r) => r.id)).toEqual([hitId]);
    // 还原，避免污染后续用例。
    await h.prisma.record.update({ where: { id: hitId }, data: { createdBy: "owner" } });
  });

  it("宽来源：追加一条不带 conditions 的 r 策略 -> 列表返回全部行", async () => {
    // target 当前窄来源（currentUser）保持不变；另以其 role 挂一条【宽】r 策略
    // （conditions=null，role 是 target 主体展开的命中来源）。
    await h.prisma.authPolicy.create({
      data: {
        id: "s8br_wide", workspaceId: "ws_default", nodeId: tableNode,
        subjectType: "role", subjectId: "s8br_role", actions: "r",
        fieldMask: null, conditions: null, reason: "test:wide", createdBy: "owner",
      },
    });
    const body = await listAs("target");
    expect(body.filteredTotal).toBe(3);
    expect(body.records.map((r) => r.id).sort()).toEqual([hitId, missId, otherRowId].sort());
  });

  it("两条窄来源 OR：互斥条件 -> 返回并集", async () => {
    await h.prisma.authPolicy.delete({ where: { id: "s8br_wide" } });
    const res = await putPolicies({
      upserts: [{
        subjectType: "user",
        subjectId: "target",
        actions: ["r", "u"],
        conditions: {
          version: 1,
          filter: { kind: "condition", fieldId: titleFid, op: "is", value: "命中行" },
        },
      }],
    });
    expect(res.status).toBe(200);
    // 第二条窄 r 来源（role）：只放 title=不命中行。
    await h.prisma.authPolicy.create({
      data: {
        id: "s8br_narrow2", workspaceId: "ws_default", nodeId: tableNode,
        subjectType: "role", subjectId: "s8br_role", actions: "r",
        fieldMask: null,
        conditions: JSON.stringify({
          version: 1,
          filter: { kind: "condition", fieldId: titleFid, op: "is", value: "不命中行" },
        }),
        reason: "test:narrow2", createdBy: "owner",
      },
    });
    const body = await listAs("target");
    expect(body.filteredTotal).toBe(2);
    expect(body.records.map((r) => r.id).sort()).toEqual([hitId, missId].sort());
  });

  it("详情：命中行 200；不命中行 404", async () => {
    const ok = await detailAs("target", hitId);
    expect(ok.status).toBe(200);
    const bad = await detailAs("target", otherRowId);
    expect(bad.status).toBe(404);
  });

  it("PATCH：命中行成功；不命中行 403 且行未改", async () => {
    const ok = await patchAs("target", hitId, { [titleFid]: "命中行-改" });
    expect(ok.status).toBe(200);
    const afterHit = await h.prisma.record.findUniqueOrThrow({ where: { id: hitId } });
    expect(JSON.parse(afterHit.fields as string)[titleFid]).toBe("命中行-改");

    const bad = await patchAs("target", otherRowId, { [titleFid]: "被篡改" });
    expect(bad.status).toBe(403);
    const afterOther = await h.prisma.record.findUniqueOrThrow({ where: { id: otherRowId } });
    expect(JSON.parse(afterOther.fields as string)[titleFid]).toBe("他人负责行");
  });

  it("DELETE：命中行成功；不命中行 403 且行未删", async () => {
    // missId 标题"不命中行"命中 OR 的第二条窄来源 -> 可删。
    const ok = await deleteAs("target", missId);
    expect(ok.status).toBe(200);
    const gone = await h.prisma.record.findFirst({ where: { id: missId, deletedAt: null } });
    expect(gone).toBeNull();

    // 恢复 missId（撤销软删），保持夹具数据完整。
    await h.prisma.record.update({ where: { id: missId }, data: { deletedAt: null } });

    // otherRowId 不命中任一来源 -> 403 且仍存在。
    const bad = await deleteAs("target", otherRowId);
    expect(bad.status).toBe(403);
    const still = await h.prisma.record.findFirst({ where: { id: otherRowId, deletedAt: null } });
    expect(still).not.toBeNull();
  });
});
