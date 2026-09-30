// 视图每用户个性化（#561）端到端：真 createApp / 真 JWT / 真迁移临时库。
//
// 覆盖：
//  - 未自定义用户跟随视图默认 filters；
//  - PUT/PATCH /views/:id/prefs 覆盖自己的 filters，两用户互不影响；
//  - 自定义固化后视图默认变更不影响该用户；
//  - DELETE 重置：重新跟随默认且随后续默认变化；
//  - ViewDTO.userPrefs：列表默认 null、单视图详情按当前用户带出；
//  - 非成员 403；非法 body（坏 filters / 坏形状）400；
//  - 管理员强制 filters 与用户 filters AND；管理员 hiddenFieldIds 裁字段。

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
}

type PrefsResp = { userPrefs: { filters: unknown; search: string; version: number } };

function cond(value: string) {
  return { kind: "condition", fieldId: titleId, op: "is", value };
}

async function req(
  userId: string,
  method: "PUT" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<Response> {
  return await h.app.request(`/api/views/${viewId}/prefs`, {
    method,
    headers: { "Content-Type": "application/json", ...(await h.auth(userId)) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function list(userId: string): Promise<ListBody> {
  const res = await h.app.request(
    `/api/records?tableId=${tableId}&viewId=${viewId}`,
    { headers: await h.auth(userId) },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as ListBody;
}

/** 列表中标题列的取值集合。 */
function titles(body: ListBody): Set<unknown> {
  return new Set(body.records.map((r) => r.fields[titleId]));
}

beforeAll(async () => {
  h = await makeNavHarness("gx-view-prefs-");
  await h.createUser("owner", { email: "vp-owner@x.com", displayName: "所有者" });
  await h.createUser("viewer", { email: "vp-viewer@x.com", displayName: "阅读者" });
  await h.createUser("outsider", { email: "vp-outsider@x.com", displayName: "外人" });
  h.grantRole("owner", "role_owner");
  await h.prisma.roleAssignment.create({
    data: { roleId: "role_viewer", subjectType: "user", subjectId: "viewer", scopeType: "workspace", createdBy: "seed" },
  });

  const seeded = await seedBaseWithStarter(h, "vp");
  tableId = seeded.tableId;
  viewId = seeded.viewId;

  await h.prisma.roleLibraryScope.upsert({
    where: { roleId_libraryKind_libraryId: { roleId: "role_viewer", libraryKind: "base", libraryId: seeded.baseId } },
    create: { roleId: "role_viewer", libraryKind: "base", libraryId: seeded.baseId, visible: 1, canManage: 0, canShare: 0 },
    update: { visible: 1, canManage: 0 },
  });

  const title = await h.prisma.field.create({
    data: { tableId, name: "标题", type: "singleLineText", order: 0 },
  });
  titleId = title.id;
  const status = await h.prisma.field.create({
    data: { tableId, name: "状态", type: "singleLineText", order: 1 },
  });
  statusId = status.id;
  await h.prisma.table.update({ where: { id: tableId }, data: { primaryFieldId: titleId } });

  for (const t of ["A1", "A2", "A3"]) {
    await h.prisma.record.create({
      data: {
        tableId,
        createdBy: "owner",
        updatedBy: "owner",
        fields: JSON.stringify({ [titleId]: t, [statusId]: `s-${t}` }),
      },
    });
  }

  // 视图默认 filters：只看 A1（未自定义用户跟随此默认）。
  await h.prisma.view.update({
    where: { id: viewId },
    data: { config: JSON.stringify({ filters: cond("A1") }) },
  });
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

describe("个性化生命周期", () => {
  it("未自定义：owner 与 viewer 都跟随视图默认（只看 A1）", async () => {
    expect(titles(await list("owner"))).toEqual(new Set(["A1"]));
    expect(titles(await list("viewer"))).toEqual(new Set(["A1"]));
  });

  it("viewer PUT 自己的 filters（A2）；owner 仍跟随默认 A1，两用户互不影响", async () => {
    const res = await req("viewer", "PUT", { prefs: { filters: cond("A2") } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PrefsResp;
    expect(body.userPrefs.version).toBe(1);
    expect(body.userPrefs.filters).toEqual(cond("A2"));

    expect(titles(await list("viewer"))).toEqual(new Set(["A2"]));
    expect(titles(await list("owner"))).toEqual(new Set(["A1"]));
  });

  it("PATCH 合并语义：只改 search，filters 保留为 A2", async () => {
    const res = await req("viewer", "PATCH", { prefs: { search: "关键字" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PrefsResp;
    expect(body.userPrefs.search).toBe("关键字");
    expect(body.userPrefs.filters).toEqual(cond("A2"));
    // 每用户仅一行：重复写不产生第二条。
    const n = await h.prisma.viewUserPref.count({ where: { viewId, userId: "viewer" } });
    expect(n).toBe(1);
  });

  it("自定义固化：视图默认改为 A3 后，viewer 仍看 A2，未自定义的 owner 跟到 A3", async () => {
    // 上一例写入的 search 是独立使用态键：显式清空，避免它参与列表过滤（legacy 路径
    // 在无 search 查询参数时使用 config.search）。filters 仍保留 A2。
    await req("viewer", "PATCH", { prefs: { search: "" } });

    await h.prisma.view.update({
      where: { id: viewId },
      data: { config: JSON.stringify({ filters: cond("A3") }) },
    });
    expect(titles(await list("owner"))).toEqual(new Set(["A3"]));
    expect(titles(await list("viewer"))).toEqual(new Set(["A2"]));
  });

  it("DELETE 重置：viewer 删除偏好后跟随默认 A3", async () => {
    const res = await req("viewer", "DELETE");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(titles(await list("viewer"))).toEqual(new Set(["A3"]));

    // 行不存在再 DELETE 仍 200（幂等重置）。
    expect((await req("viewer", "DELETE")).status).toBe(200);
  });

  it("重置后重新跟随：默认改回 A1，viewer 与 owner 都看 A1", async () => {
    await h.prisma.view.update({
      where: { id: viewId },
      data: { config: JSON.stringify({ filters: cond("A1") }) },
    });
    expect(titles(await list("viewer"))).toEqual(new Set(["A1"]));
    expect(titles(await list("owner"))).toEqual(new Set(["A1"]));
  });
});

describe("ViewDTO.userPrefs", () => {
  it("列表接口：未自定义用户视图带 userPrefs=null", async () => {
    const res = await h.app.request(`/api/views?tableId=${tableId}`, {
      headers: await h.auth("viewer"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { views: Array<{ userPrefs: unknown }> };
    expect(body.views).toHaveLength(1);
    expect(body.views[0]!.userPrefs).toBeNull();
  });

  it("详情接口：自定义后带当前用户偏好；另一用户仍为 null", async () => {
    await req("viewer", "PUT", { prefs: { rowHeight: "tall" } });

    const resV = await h.app.request(`/api/views/${viewId}`, { headers: await h.auth("viewer") });
    const vBody = (await resV.json()) as { view: { userPrefs: { rowHeight: string } | null } };
    expect(vBody.view.userPrefs?.rowHeight).toBe("tall");

    const resO = await h.app.request(`/api/views/${viewId}`, { headers: await h.auth("owner") });
    const oBody = (await resO.json()) as { view: { userPrefs: unknown } };
    expect(oBody.view.userPrefs).toBeNull();
  });
});

describe("鉴权与参数", () => {
  it("非成员 PUT prefs -> 403，且未写任何行", async () => {
    const res = await req("outsider", "PUT", { prefs: { filters: cond("A1") } });
    expect(res.status).toBe(403);
    const n = await h.prisma.viewUserPref.count({ where: { userId: "outsider" } });
    expect(n).toBe(0);
  });

  it("视图不存在 -> 404", async () => {
    const res = await h.app.request("/api/views/nope/prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
      body: JSON.stringify({ prefs: {} }),
    });
    expect(res.status).toBe(404);
  });

  it("非法 filters -> 400，偏好不被写坏", async () => {
    const res = await req("owner", "PUT", { prefs: { filters: { kind: "bogus" } } });
    expect(res.status).toBe(400);
    const row = await h.prisma.viewUserPref.findUnique({
      where: { viewId_userId: { viewId, userId: "owner" } },
    });
    expect(row).toBeNull();
  });

  it("外层缺 prefs / 键类型错误 -> 400", async () => {
    expect((await req("owner", "PUT", {})).status).toBe(400);
    expect((await req("owner", "PUT", { prefs: { rowHeight: "huge" } })).status).toBe(400);
    expect((await req("owner", "PUT", { prefs: { sorts: [{ fieldId: "f" }] } })).status).toBe(400);
  });
});

describe("管理员强制层与用户层叠加", () => {
  it("管理员 filters 与用户 filters AND：交集行；冲突时 0 行", async () => {
    // 管理员强制：标题 is A1。
    const adminRes = await h.app.request(`/api/views/${viewId}/admin`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
      body: JSON.stringify({ adminConfig: { filters: cond("A1") } }),
    });
    expect(adminRes.status).toBe(200);

    // viewer 自定义 filters：标题 isNotEmpty（对 A1 成立）-> AND 后 A1。
    await req("viewer", "PUT", {
      prefs: {
        filters: { kind: "condition", fieldId: titleId, op: "isNotEmpty" },
      },
    });
    expect(titles(await list("viewer"))).toEqual(new Set(["A1"]));

    // viewer filters 改为 A2，与管理员 A1 冲突 -> 0 行。
    await req("viewer", "PUT", { prefs: { filters: cond("A2") } });
    expect((await list("viewer")).records).toHaveLength(0);
  });

  it("管理员 hiddenFieldIds：状态字段不进可见 fields，用户偏好无法恢复它", async () => {
    const adminRes = await h.app.request(`/api/views/${viewId}/admin`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
      body: JSON.stringify({
        adminConfig: { filters: null, hiddenFieldIds: [statusId] },
      }),
    });
    expect(adminRes.status).toBe(200);

    // viewer 尝试用自己的偏好（行高/排序等使用态）无法恢复字段可见性 ——
    // 字段范围由管理员层与权限决定，个性化不含字段范围键。
    const body = await list("viewer");
    const ids = body.fields.map((f) => f.id);
    expect(ids).toContain(titleId);
    expect(ids).not.toContain(statusId);
  });
});
