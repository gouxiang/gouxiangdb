// M4/S7 中断继承 + tree/menu 剪枝端到端夹具（真迁移临时库 + 真 createApp/真 JWT，不 mock auth）。
//
// 拓扑（单 kb + 单 base；物理父链：doc/canvas -> kb；table/view -> base）：
//   kb s7_kb1（owner 建，owner 持 kb owner 成员）
//     doc s7_d_secret   inheritAncestors=0（restricted 边界 K；S7 仅允许手置，继承 PATCH 只开 doc/canvas）
//     doc s7_d_child    物理父 = s7_d_secret（子文档，验证 cutoff）
//     doc s7_d1         A-6 主角：kb 对 s7_direct 无任何来源，仅 doc ACL viewer（双写落 doc 节点 r）
//     doc s7_d_other    同库另一 doc；kb 节点授部门 s7_deptB r（s7_deptBuser 经来源可见）
//     doc s7_d_impact   inherit=1，三源失访对拍节点（授予只挂 kb 节点）
//     doc s7_d2         createdBy=s7_creator，s7_creator 是 kb viewer（关继承 -> exempt creator）
//     canvas s7_c1      inherit=1（kind 白名单：canvas 也可切）
//     doc s7_d_move     物理父 = s7_d_secret（move hint：移出 restricted 子树）
//   base s7_base1 + table s7_t1 + view s7_v1（s7_nobody 无任何来源 -> S6 缺口闭合剪枝对象）
//   L0 groups：s7_g_empty（空容器）、s7_g_a、s7_g_r、s7_g_p
//
// 三源用户（d_impact 失访）：s7_lose_direct(kb user 直授) / s7_lose_dept(deptA 成员,kb 授 deptA) /
//   s7_lose_sub(deptA 子部门 s7_deptA1 成员,kb 授祖先 deptRoot) / s7_lose_role(角色直授) /
//   s7_lose_role2(角色授 deptA) / s7_multi(deptA+角色双源,只计 1) / s7_inactive(停用,剔除)。
// 角色 s7_role_loser 被 kb 节点 subjectType=role 授予 r。
//
// 关键手法：A-6 的"子 direct 有权"用真实旧表通道 PUT /api/kb/docs/:id/acl（kb_doc_acls 行 +
// 同事务 legacy:acl 投影到 doc 节点），故 URL 直达经旧守卫 requireDocAccess 真实 200，
// 引擎侧 doc 节点 r 也成立；kb 节点对该用户零来源（不建 kb_member）。

import type { PrismaClient } from "@prisma/client";
import { makeNavHarness, json } from "../../nav/__tests__/navRouteHarness.js";
import { nodeId } from "../../nav/backfill.js";

export const OWNER = "s7_owner";
export const ADMIN = "s7_admin";
export const DIRECT = "s7_direct";
export const NOBODY = "s7_nobody";

const USERS = [
  [OWNER, "所有者"], [ADMIN, "管理员"], [DIRECT, "直授用户"], [NOBODY, "无来源用户"],
  ["s7_creator", "建文档的人"], ["s7_owner2", "二号所有者"],
  ["s7_lose_direct", "失访直授"], ["s7_lose_dept", "失访部门"], ["s7_lose_sub", "失访子部门"],
  ["s7_lose_role", "失访角色"], ["s7_lose_role2", "失访角色部门"], ["s7_multi", "多源用户"],
  ["s7_deptBuser", "乙部门用户"], ["s7_inactive", "停用用户"], ["s7_gain", "重开恢复用户"],
] as const;

export interface S7Fixture {
  tmpDir: string;
  prisma: PrismaClient;
  call: (method: string, url: string, user: string, body?: unknown) => Promise<Response>;
  ids: {
    kb: string; secret: string; child: string; d1: string; other: string;
    impact: string; d2: string; canvas: string; dMove: string;
    base: string; table: string; view: string;
    gEmpty: string; gA: string; gR: string; gP: string;
  };
  cleanup: () => Promise<void>;
}

export async function setupS7Fixture(): Promise<S7Fixture> {
  const h = await makeNavHarness("gx-m4-s7-");
  delete process.env.GX_AUTHZ_ENGINE; // 建实体阶段恒 off（引擎不介入）
  for (const [id, name] of USERS) {
    await h.createUser(id, { email: `${id}@x.com`, displayName: name });
  }
  await h.prisma.user.update({ where: { id: "s7_inactive" }, data: { status: "DISABLED" } });
  // owner 持系统 owner；admin 持自定义管理角色（manage_menu + manage_share，非 owner）。
  await h.prisma.roleAssignment.create({
    data: { roleId: "role_owner", subjectType: "user", subjectId: OWNER, scopeType: "workspace", createdBy: "seed" },
  });
  await h.prisma.roleAssignment.create({
    data: { roleId: "role_owner", subjectType: "user", subjectId: "s7_owner2", scopeType: "workspace", createdBy: "seed" },
  });
  await h.prisma.role.create({
    data: { id: "s7_role_admin", workspaceId: "ws_default", name: "导航管理", isSystem: 0, permissions: '["manage_menu","manage_share"]' },
  });
  await h.prisma.role.create({
    data: { id: "s7_role_loser", workspaceId: "ws_default", name: "失访角色", isSystem: 0, permissions: "[]" },
  });
  await h.prisma.roleAssignment.create({
    data: { roleId: "s7_role_admin", subjectType: "user", subjectId: ADMIN, scopeType: "workspace", createdBy: "seed" },
  });

  // ---- 部门（物化 path 手维护）----
  const dept = (id: string, parentId: string | null, path: string): unknown => ({
    id, workspaceId: "ws_default", parentId, path, name: id,
  });
  await h.prisma.department.createMany({ data: [
    dept("s7_deptRoot", null, "/s7_deptRoot/"),
    dept("s7_deptA", "s7_deptRoot", "/s7_deptRoot/s7_deptA/"),
    dept("s7_deptA1", "s7_deptA", "/s7_deptRoot/s7_deptA/s7_deptA1/"),
    dept("s7_deptB", null, "/s7_deptB/"),
  ] as never[] });
  const member = (id: string, departmentId: string): unknown => ({
    id: `dm_${id}`, departmentId, userId: id, isMain: 1,
  });
  await h.prisma.deptMember.createMany({ data: [
    member("s7_lose_dept", "s7_deptA"), member("s7_lose_sub", "s7_deptA1"),
    member("s7_lose_role2", "s7_deptA"), member("s7_multi", "s7_deptA"),
    member("s7_deptBuser", "s7_deptB"), member("s7_gain", "s7_deptB"),
  ] as never[] });

  // ---- 实体：kb 族（定制拓扑，直接 prisma 建后 sync）----
  const kb = "s7_kb1";
  const docs = {
    secret: "s7_d_secret", child: "s7_d_child", d1: "s7_d1", other: "s7_d_other",
    impact: "s7_d_impact", d2: "s7_d2", dMove: "s7_d_move",
  };
  await h.prisma.$transaction([
    h.prisma.knowledgeBase.create({ data: { id: kb, name: "s7 知识库", createdBy: OWNER } }),
    h.prisma.kbMember.create({ data: { id: "s7_km_owner", kbId: kb, userId: OWNER, role: "owner" } }),
    // s7_creator / s7_owner2 是 kb viewer（投影到 kb 节点 r；关继承后靠兜底保留）。
    h.prisma.kbMember.create({ data: { id: "s7_km_creator", kbId: kb, userId: "s7_creator", role: "viewer" } }),
    h.prisma.kbMember.create({ data: { id: "s7_km_owner2", kbId: kb, userId: "s7_owner2", role: "viewer" } }),
    h.prisma.kbDoc.create({ data: { id: docs.secret, kbId: kb, kind: "doc", title: "私密边界", content: "", createdBy: OWNER, updatedBy: OWNER } }),
    h.prisma.kbDoc.create({ data: { id: docs.child, kbId: kb, kind: "doc", title: "边界子文档", content: "", parentId: docs.secret, createdBy: OWNER, updatedBy: OWNER } }),
    h.prisma.kbDoc.create({ data: { id: docs.d1, kbId: kb, kind: "doc", title: "直授子文档", content: "", createdBy: OWNER, updatedBy: OWNER } }),
    h.prisma.kbDoc.create({ data: { id: docs.other, kbId: kb, kind: "doc", title: "部门文档", content: "", createdBy: OWNER, updatedBy: OWNER } }),
    h.prisma.kbDoc.create({ data: { id: docs.impact, kbId: kb, kind: "doc", title: "影响面文档", content: "", createdBy: OWNER, updatedBy: OWNER } }),
    h.prisma.kbDoc.create({ data: { id: docs.d2, kbId: kb, kind: "doc", title: "创作者文档", content: "", createdBy: "s7_creator", updatedBy: "s7_creator" } }),
    h.prisma.kbDoc.create({ data: { id: docs.dMove, kbId: kb, kind: "doc", title: "待移动文档", content: "", parentId: docs.secret, createdBy: OWNER, updatedBy: OWNER } }),
    h.prisma.kbDoc.create({ data: { id: "s7_d_grouped", kbId: kb, kind: "doc", title: "分组内文档", content: "", createdBy: OWNER, updatedBy: OWNER } }),
    h.prisma.kbDoc.create({ data: { id: "s7_c1", kbId: kb, kind: "canvas", title: "画布", content: "[]", createdBy: OWNER, updatedBy: OWNER } }),
    // base + starter table + grid view（NOBODY 对其无任何来源 -> S6 缺口闭合剪枝对象）。
    h.prisma.base.create({ data: { id: "s7_base1", name: "s7 base", createdBy: OWNER } }),
    h.prisma.member.create({ data: { id: "s7_m_owner", baseId: "s7_base1", userId: OWNER, role: "owner" } }),
    h.prisma.table.create({ data: { id: "s7_t1", baseId: "s7_base1", name: "starter", primaryFieldId: "", createdBy: OWNER } }),
    h.prisma.view.create({ data: { id: "s7_v1", tableId: "s7_t1", name: "grid", type: "grid", order: 0, config: "{}" } }),
  ]);
  const seededBase = { baseId: "s7_base1", tableId: "s7_t1", viewId: "s7_v1" };
  const { syncNavFromEntitiesTx } = await import("../../nav/sync.js");
  await h.prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));
  // restricted 边界 + impact/d2 继承开关现状（M3 回填恒 1，这里只把边界节点置 0）。
  await h.prisma.navNode.update({ where: { id: nodeId("doc", docs.secret) }, data: { inheritAncestors: 0 } });

  // ---- groups（经 v1 API，owner manage_menu）----
  const call: S7Fixture["call"] = async (method, url, user, body) => {
    const headers: Record<string, string> = await h.auth(user);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return h.app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  const createGroup = async (name: string): Promise<string> => {
    const res = await call("POST", "/api/v1/nav/groups", OWNER, { name });
    if (res.status !== 201) throw new Error(`group create ${res.status}: ${await res.text()}`);
    return (await json<{ id: string }>(res)).id;
  };
  const gEmpty = await createGroup("空容器");
  const gA = await createGroup("甲分组");
  const gR = await createGroup("受限分组");
  const gP = await createGroup("父分组");

  // gA 非空：把 s7_d_grouped 移入并给 ADMIN 直授 r（on 态该组对 ADMIN 非 dimmed）。
  const groupedNode = nodeId("doc", "s7_d_grouped");
  const moveGrouped = await call("POST", `/api/v1/nodes/${groupedNode}/move`, OWNER, { newParentId: gA, confirmed: true });
  if (moveGrouped.status !== 200) throw new Error(`move grouped ${moveGrouped.status}: ${await moveGrouped.text()}`);
  await h.prisma.authPolicy.create({
    data: {
      id: "s7_p_adm_grouped", workspaceId: "ws_default", nodeId: groupedNode,
      subjectType: "user", subjectId: ADMIN, actions: "r", reason: "s7:seed", createdBy: OWNER,
    },
  });

  // ---- A-6：d1 的 doc ACL（旧表 + 同事务投影到 doc 节点；kb 不给 DIRECT 任何来源）----
  const acl = await call("PUT", `/api/kb/docs/${docs.d1}/acl`, OWNER, { email: `${DIRECT}@x.com`, role: "viewer" });
  if (acl.status !== 200) throw new Error(`acl grant ${acl.status}: ${await acl.text()}`);

  // ---- d_impact 三源授予（只挂 kb 节点，关继承即全失）----
  const kbNode = nodeId("kb", kb);
  const pol = (id: string, subjectType: "user" | "dept" | "role", subjectId: string): unknown => ({
    id, workspaceId: "ws_default", nodeId: kbNode, subjectType, subjectId,
    actions: "r", reason: "s7:seed", createdBy: OWNER,
  });
  await h.prisma.authPolicy.createMany({ data: [
    pol("s7_p_direct", "user", "s7_lose_direct"),
    pol("s7_p_deptroot", "dept", "s7_deptRoot"), // 荫及 deptA/deptA1 子树（deptB 不在树下）
    pol("s7_p_deptb", "dept", "s7_deptB"),
    pol("s7_p_role", "role", "s7_role_loser"),
  ] as never[] });
  await h.prisma.roleAssignment.createMany({ data: [
    { roleId: "s7_role_loser", subjectType: "user", subjectId: "s7_lose_role", scopeType: "workspace", createdBy: "seed" },
    { roleId: "s7_role_loser", subjectType: "user", subjectId: "s7_multi", scopeType: "workspace", createdBy: "seed" },
    { roleId: "s7_role_loser", subjectType: "dept", subjectId: "s7_deptA", scopeType: "workspace", createdBy: "seed" },
  ] });
  // kb viewer 成员（s7_creator/s7_owner2）直建 kbMember 无写点投影双写，按回填同形态补
  // legacy:kb_member 投影行（owner 靠 workspace 兜底即可，无需投影；owner2 需在授予侧才进 exempt）。
  await h.prisma.authPolicy.createMany({ data: [
    {
      id: "s7_p_kb_creator", workspaceId: "ws_default", nodeId: kbNode,
      subjectType: "user", subjectId: "s7_creator", actions: "r,comment",
      fieldMask: null, reason: "legacy:kb_member", createdBy: "seed",
    },
    {
      id: "s7_p_kb_owner2", workspaceId: "ws_default", nodeId: kbNode,
      subjectType: "user", subjectId: "s7_owner2", actions: "r,comment",
      fieldMask: null, reason: "legacy:kb_member", createdBy: "seed",
    },
  ] });
  // d2：s7_gain 靠 kb deptB 授予在"开继承"时可见；d2 关闭后其失访（gaining 对拍用）。
  // s7_creator/s7_owner2 的 kb viewer 投影已由 kbMember 双写落 kb 节点。

  const ids: S7Fixture["ids"] = {
    kb, ...docs, canvas: "s7_c1",
    base: seededBase.baseId, table: seededBase.tableId, view: seededBase.viewId,
    gEmpty: gEmpty, gA, gR, gP,
  };
  return {
    tmpDir: h.tmpDir,
    prisma: h.prisma,
    call,
    ids,
    cleanup: async () => {
      delete process.env.GX_AUTHZ_ENGINE;
      await h.cleanup();
    },
  };
}

/** 菜单插一条 shortcut（owner 操作），返回菜单项 id。 */
export async function insertShortcut(fx: S7Fixture, node: string, id: string, ord: number): Promise<void> {
  const res = await fx.call("PATCH", "/api/v1/workspaces/current/menu", OWNER, {
    operations: [{ op: "insert", id, type: "shortcut", nodeId: node, ord }],
  });
  if (res.status !== 200) throw new Error(`menu insert ${res.status}: ${await res.text()}`);
}

export function nodeRef(
  _ids: S7Fixture["ids"],
  kind: "doc" | "canvas" | "kb" | "base" | "table" | "view",
  rid: string,
): string {
  return nodeId(kind, rid);
}
