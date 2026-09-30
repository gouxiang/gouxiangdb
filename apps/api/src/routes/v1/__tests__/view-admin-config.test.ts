// 视图管理员配置层（#560）端到端：真 createApp / 真 JWT / 真迁移临时库。
//
// 覆盖：
//  - 无 schema 权限者（role_viewer + visible/canManage=0）PATCH /views/:id/admin -> 403；
//  - 有权者写 adminConfig 后 GET view.adminConfig 正确回读（缺键补齐 + 合并）；
//  - 列表：管理员 hiddenFieldIds 令该字段在 fields/allFields 中不出现；
//  - 列表：管理员 filters 与用户 config.filters 做 AND（交集行）；
//  - body 非法（坏 filters / 错类型）-> 400。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeNavHarness,
  seedBaseWithStarter,
  type CharHarness,
} from "../../../domain/nav/__tests__/navRouteHarness.js";

let h: CharHarness;
let tableId = "";
let viewId = "";
let titleId = "";
let statusId = "";

interface ListBody {
  records: Array<{ id: string; fields: Record<string, unknown> }>;
  fields: Array<{ id: string }>;
  allFields: Array<{ id: string }>;
}

async function patchAdmin(userId: string, body: unknown): Promise<Response> {
  return await h.app.request(`/api/views/${viewId}/admin`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await h.auth(userId)) },
    body: JSON.stringify(body),
  });
}

async function list(userId: string, extra = ""): Promise<ListBody> {
  const res = await h.app.request(
    `/api/records?tableId=${tableId}&viewId=${viewId}${extra}`,
    { headers: await h.auth(userId) },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as ListBody;
}

beforeAll(async () => {
  h = await makeNavHarness("gx-view-admin-");
  await h.createUser("owner", { email: "va-owner@x.com", displayName: "所有者" });
  await h.createUser("viewer", { email: "va-viewer@x.com", displayName: "阅读者" });
  h.grantRole("owner", "role_owner");
  await h.prisma.roleAssignment.create({
    data: { roleId: "role_viewer", subjectType: "user", subjectId: "viewer", scopeType: "workspace", createdBy: "seed" },
  });

  const seeded = await seedBaseWithStarter(h, "va");
  tableId = seeded.tableId;
  viewId = seeded.viewId;

  // 让 viewer 能进库但无管理权限。
  await h.prisma.roleLibraryScope.upsert({
    where: { roleId_libraryKind_libraryId: { roleId: "role_viewer", libraryKind: "base", libraryId: seeded.baseId } },
    create: { roleId: "role_viewer", libraryKind: "base", libraryId: seeded.baseId, visible: 1, canManage: 0, canShare: 0 },
    update: { visible: 1, canManage: 0 },
  });

  // starter view.config 是 "{}"；补两个业务字段并把主字段换掉。
  const title = await h.prisma.field.create({
    data: { tableId, name: "标题", type: "singleLineText", order: 0 },
  });
  titleId = title.id;
  const status = await h.prisma.field.create({
    data: { tableId, name: "状态", type: "singleLineText", order: 1 },
  });
  statusId = status.id;
  await h.prisma.table.update({ where: { id: tableId }, data: { primaryFieldId: titleId } });

  const rows: Array<[string, string]> = [
    ["A1", "open"],
    ["A2", "closed"],
    ["A3", "open"],
  ];
  for (const [t, s] of rows) {
    await h.prisma.record.create({
      data: {
        tableId,
        createdBy: "owner",
        updatedBy: "owner",
        fields: JSON.stringify({ [titleId]: t, [statusId]: s }),
      },
    });
  }
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

describe("PATCH /api/views/:viewId/admin", () => {
  it("无 schema 权限者 -> 403", async () => {
    const res = await patchAdmin("viewer", { adminConfig: { hiddenFieldIds: [statusId] } });
    expect(res.status).toBe(403);
    // 未写入。
    const row = await h.prisma.view.findUniqueOrThrow({ where: { id: viewId } });
    expect(row.adminConfig).toBeNull();
  });

  it("视图不存在 -> 404", async () => {
    const res = await h.app.request("/api/views/nope/admin", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
      body: JSON.stringify({ adminConfig: {} }),
    });
    expect(res.status).toBe(404);
  });

  it("有权者写入并回读：缺键补齐、version=1", async () => {
    const res = await patchAdmin("owner", { adminConfig: { hiddenFieldIds: [statusId] } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { view: { adminConfig: Record<string, unknown> } };
    expect(body.view.adminConfig).toMatchObject({
      version: 1,
      hiddenFieldIds: [statusId],
      fieldOrder: [],
      filters: null,
      coverFieldId: null,
    });
    // GET 回读一致。
    const res2 = await h.app.request(`/api/views/${viewId}`, { headers: await h.auth("owner") });
    const view2 = (await res2.json()) as { view: { adminConfig: Record<string, unknown> } };
    expect(view2.view.adminConfig.hiddenFieldIds).toEqual([statusId]);
  });

  it("二次写入按字段合并（不清空既有 hiddenFieldIds）", async () => {
    const res = await patchAdmin("owner", { adminConfig: { coverFieldId: titleId } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { view: { adminConfig: Record<string, unknown> } };
    expect(body.view.adminConfig.hiddenFieldIds).toEqual([statusId]);
    expect(body.view.adminConfig.coverFieldId).toBe(titleId);
  });

  it("非法 filters -> 400", async () => {
    const before = await h.prisma.view.findUniqueOrThrow({ where: { id: viewId } });
    const res = await patchAdmin("owner", { adminConfig: { filters: { kind: "bogus" } } });
    expect(res.status).toBe(400);
    const after = await h.prisma.view.findUniqueOrThrow({ where: { id: viewId } });
    expect(after.adminConfig).toBe(before.adminConfig);
  });

  it("类型错误 / 外层缺 adminConfig -> 400", async () => {
    expect((await patchAdmin("owner", { adminConfig: { fieldOrder: "x" } })).status).toBe(400);
    expect((await patchAdmin("owner", {})).status).toBe(400);
  });
});

describe("列表合成 resolveViewConfig", () => {
  it("管理员 hiddenFieldIds：该字段不出现在可见 fields（allFields 为全量元数据，视图隐藏不裁剪它）", async () => {
    // 当前 adminConfig.hiddenFieldIds=[statusId]（由前序用例）。
    const body = await list("owner");
    const visibleIds = body.fields.map((f) => f.id);
    const allIds = body.allFields.map((f) => f.id);
    expect(visibleIds).toContain(titleId);
    expect(visibleIds).not.toContain(statusId);
    // allFields 是表结构元数据全集：视图级隐藏不裁它（字段权限掩码才裁），保持既有口径。
    expect(allIds).toContain(statusId);
  });

  it("管理员 filters 与用户 filters AND：只回交集行", async () => {
    // 清掉隐藏以免干扰；管理员 filter：标题 is A1。
    await patchAdmin("owner", {
      adminConfig: {
        hiddenFieldIds: [],
        filters: { kind: "condition", fieldId: titleId, op: "is", value: "A1" },
      },
    });
    // 用户层 filter：标题 isNotEmpty 对 A1 成立（AND 后仍是 A1）。
    await h.prisma.view.update({
      where: { id: viewId },
      data: {
        config: JSON.stringify({
          filters: { kind: "condition", fieldId: titleId, op: "isNotEmpty" },
        }),
      },
    });
    let body = await list("owner");
    expect(body.records).toHaveLength(1);
    expect(body.records[0]!.fields[titleId]).toBe("A1");

    // 用户 filter 与管理员冲突：用户要求标题 is A2，管理员要求 A1 -> AND 后 0 行。
    await h.prisma.view.update({
      where: { id: viewId },
      data: {
        config: JSON.stringify({
          filters: { kind: "condition", fieldId: titleId, op: "is", value: "A2" },
        }),
      },
    });
    body = await list("owner");
    expect(body.records).toHaveLength(0);
  });
});
