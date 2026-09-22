// apps/api/src/routes/v1/org/__tests__/library-scopes-wiring.test.ts
// 「权限管理面板 → 真正生效」的端到端接线测试（真迁移临时库 + 真 createApp + 真 JWT，不 mock 决策）。
//
// 为什么必须有一个这样的测试：权限面板能保存、接口返回 200，都不能证明配置**生效**——
// 配置面（role_library_scope）与裁决面（libraryPolicy → guards）是两处代码，
// 中间断一根线，界面上一切正常而权限纹丝不动，这正是本仓反复出过的"配了不生效的死开关"。
// 本文件只用 HTTP 走完整条链：超级管理员配 → 持有该角色的账号立刻看到/看不到。
//
// 覆盖：
//   ① 未配置 = 什么都看不到（受限成员默认零视野）；
//   ② 配「可见」→ 该角色持有者立刻能看到、且只能看到这一个库；
//   ③ 整份替换清空 → 立刻失去访问（反向验证，防"取消勾选删不掉"）；
//   ④ 指向不存在库/kind 与 id 错配 → 400，且不清空既有授权（写入前校验）；
//   ⑤ 超级管理员不受配置影响，始终进得去（防锁死）；
//   ⑥ 字段权限 hidden 档：读出口（列表/详情）整体缺席，且写不进去。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, json, type OrgHarness } from "./orgHarness.js";

let h: OrgHarness;
let owner: Record<string, string>;
let viewer: Record<string, string>;

const BASE = "base-wire-visible";
const BASE_OTHER = "base-wire-hidden";
const KB = "kb-wire-visible";
const TABLE = "tbl-wire-1";
const F_NAME = "fld-wire-name";
const F_SECRET = "fld-wire-secret";

async function putScopes(roleId: string, items: unknown[]): Promise<Response> {
  return h.app.request("/api/v1/org/library-scopes", {
    method: "PUT",
    headers: { ...owner, "Content-Type": "application/json" },
    body: JSON.stringify({ roleId, items }),
  });
}

async function basesSeenByViewer(): Promise<string[]> {
  const res = await h.app.request("/api/bases", { headers: viewer });
  const body = await json<{ bases: Array<{ id: string }> }>(res);
  return body.bases.map((b) => b.id).sort();
}

beforeAll(async () => {
  h = await setupOrgHarness();
  await h.createUser("u-wire-owner");
  await h.createUser("u-wire-viewer");
  await h.grantSystemRole("u-wire-owner", "owner");
  await h.grantSystemRole("u-wire-viewer", "restricted");
  owner = await h.auth("u-wire-owner");
  viewer = await h.auth("u-wire-viewer");

  await h.prisma.base.create({ data: { id: BASE, name: "接线验收库", createdBy: "u-wire-owner" } });
  await h.prisma.base.create({ data: { id: BASE_OTHER, name: "不该出现的库", createdBy: "u-wire-owner" } });
  await h.prisma.knowledgeBase.create({ data: { id: KB, name: "接线验收知识库", createdBy: "u-wire-owner" } });

  await h.prisma.table.create({
    data: { id: TABLE, baseId: BASE, name: "验收表", primaryFieldId: F_NAME, createdBy: "u-wire-owner" },
  });
  await h.prisma.field.create({ data: { id: F_NAME, tableId: TABLE, name: "名称", type: "singleLineText", order: 0 } });
  await h.prisma.field.create({ data: { id: F_SECRET, tableId: TABLE, name: "密档", type: "singleLineText", order: 1 } });
  await h.prisma.record.create({
    data: {
      tableId: TABLE,
      fields: JSON.stringify({ [F_NAME]: "接线验收记录", [F_SECRET]: "只有该看到的人能看到" }),
      createdBy: "u-wire-owner",
      updatedBy: "u-wire-owner",
    },
  });
});

afterAll(async () => {
  await h.cleanup();
});

describe("库视野配置真的会改变谁能看到哪个库", () => {
  it("① 未配置：受限成员一个库都看不到", async () => {
    expect(await basesSeenByViewer()).toEqual([]);
  });

  it("② 配「可见」后立刻生效，且只放开配过的那一个", async () => {
    const res = await putScopes("role_restricted", [
      { libraryKind: "base", libraryId: BASE, visible: true, canManage: false, config: { tables: {}, fields: {} } },
    ]);
    expect(res.status).toBe(200);
    expect(await basesSeenByViewer()).toEqual([BASE]);

    // 同一个角色下没配的知识库也不可见（证明放开是逐库的，不是"配了任意一个就全开"）
    const kbRes = await h.app.request("/api/kb", { headers: viewer });
    const kbBody = await json<{ knowledgeBases: Array<{ id: string }> }>(kbRes);
    expect(kbBody.knowledgeBases.map((k) => k.id)).toEqual([]);
  });

  it("③ 整份替换清空后立刻失去访问", async () => {
    const res = await putScopes("role_restricted", []);
    expect(res.status).toBe(200);
    expect(await basesSeenByViewer()).toEqual([]);
  });

  it("④ 指向不存在/错配的库：400 且不清空既有授权", async () => {
    // 先配一条有效授权
    expect((await putScopes("role_restricted", [
      { libraryKind: "base", libraryId: BASE, visible: true, canManage: false, config: { tables: {}, fields: {} } },
    ])).status).toBe(200);
    expect(await basesSeenByViewer()).toEqual([BASE]);

    const bad = await putScopes("role_restricted", [
      { libraryKind: "base", libraryId: "no-such-library", visible: true, canManage: false, config: {} },
    ]);
    expect(bad.status).toBe(400);

    // kb 的 id 配成 base：同样是"库不存在"，必须在事务前就挡掉
    const mismatch = await putScopes("role_restricted", [
      { libraryKind: "base", libraryId: KB, visible: true, canManage: false, config: {} },
    ]);
    expect(mismatch.status).toBe(400);

    // 校验失败发生在写事务之前，既有授权必须原封不动（否则一次手滑就清空整个角色的权限）
    expect(await basesSeenByViewer()).toEqual([BASE]);
  });

  it("⑤ 超级管理员不受配置影响（防锁死）", async () => {
    const res = await h.app.request("/api/bases", { headers: owner });
    const body = await json<{ bases: Array<{ id: string }> }>(res);
    expect(body.bases.map((b) => b.id).sort()).toEqual([BASE, BASE_OTHER].sort());

    const kbRes = await h.app.request("/api/kb", { headers: owner });
    const kbBody = await json<{ knowledgeBases: Array<{ id: string }> }>(kbRes);
    expect(kbBody.knowledgeBases.map((k) => k.id)).toContain(KB);
  });

  it("⑥ 字段权限 hidden：读出口缺席、写不进", async () => {
    const res = await putScopes("role_restricted", [
      {
        libraryKind: "base",
        libraryId: BASE,
        visible: true,
        canManage: false,
        config: {
          tables: { [TABLE]: { read: true, create: true, update: true, delete: false } },
          fields: { [TABLE]: { [F_SECRET]: "hidden" } },
        },
      },
    ]);
    expect(res.status).toBe(200);

    const list = await h.app.request(`/api/records?tableId=${TABLE}`, { headers: viewer });
    const listBody = await json<{
      fields: Array<{ id: string }>;
      allFields: Array<{ id: string }>;
      records: Array<{ id: string; fields: Record<string, unknown> }>;
    }>(list);
    expect(listBody.fields.map((f) => f.id)).not.toContain(F_SECRET);
    expect(listBody.allFields.map((f) => f.id)).not.toContain(F_SECRET);
    expect(listBody.records).toHaveLength(1);
    expect(Object.keys(listBody.records[0]!.fields)).not.toContain(F_SECRET);
    expect(listBody.records[0]!.fields[F_NAME]).toBe("接线验收记录");

    const detail = await h.app.request(`/api/records/${listBody.records[0]!.id}`, { headers: viewer });
    const detailBody = await json<{ record: { fields: Record<string, unknown> } }>(detail);
    expect(Object.keys(detailBody.record.fields)).not.toContain(F_SECRET);

    // 写侧：单条与批量两条通道都不得绕过（批量通道此前完全没挂字段闸）
    const patch = await h.app.request(`/api/records/${listBody.records[0]!.id}`, {
      method: "PATCH",
      headers: { ...viewer, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { [F_SECRET]: "偷偷改" } }),
    });
    expect(patch.status).toBe(403);

    const bulk = await h.app.request("/api/records/bulk-update", {
      method: "POST",
      headers: { ...viewer, "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [listBody.records[0]!.id], fields: { [F_SECRET]: "偷偷改" } }),
    });
    expect(bulk.status).toBe(403);

    // 超级管理员读同一张表，密档照常可见（只减不增：该看到的人不受影响）
    const ownerList = await h.app.request(`/api/records?tableId=${TABLE}`, { headers: owner });
    const ownerBody = await json<{ fields: Array<{ id: string }> }>(ownerList);
    expect(ownerBody.fields.map((f) => f.id)).toContain(F_SECRET);
  });
});
