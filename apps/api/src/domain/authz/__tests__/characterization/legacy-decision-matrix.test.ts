// M4/S0 决策 characterization golden：权限核心模型（二）之后的现状。
//
// 旧版锁的是"base 五角色 × 八操作"与"kb 成员角色 × doc ACL 取较高"——这两套判定
// 【已被本次重构整体退出放行链】（members.role / kb_members.role / kb_doc_acls 三张旧表
// 不再参与放行，见 domain/authz/libraryPolicy.ts 的注释）。留着旧断言等于给新模型上锁，
// 故本文件改为锁两件事：
//   1. 旧三表确实不再放行（配了也没用，且入口已摘除，不会出现"配了没用"的开关）；
//   2. 库/表/字段放行只有一个来源：角色 × 库（role_library_scope），逐表逐字段勾选。
// 第三个 describe（匿名分享零授权查询）与软删文案不受模型影响，原样保留。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KB_CONTENT_KEY } from "@gx/shared-types";
import { setupCharHarness, json, type CharHarness } from "../../../nav/__tests__/characterization/charHarness.js";

let h: CharHarness;
const LEGACY_ROLES = ["owner", "creator", "editor", "commenter", "viewer"] as const;

beforeAll(async () => {
  h = await setupCharHarness("gx-m4-decision-");
  for (const r of LEGACY_ROLES) await h.createUser(`bu_${r}`);
  await h.createUser("bu_none");
  await h.grantRole("bu_owner"); // 硬规则 B：只有超级管理员/管理员建得起库
  // 显式超时：setupCharHarness 内含 prisma migrate deploy，机器高负载时很容易超过
  // vitest 默认 10s 的 hook 超时，整个文件会被判 Failed Suite 而一条用例都跑不到。
}, 120000);
afterAll(() => h.cleanup());

async function call(method: string, url: string, userId: string | null, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = userId ? await h.auth(userId) : {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return h.app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function status(method: string, url: string, userId: string | null, body?: unknown): Promise<number> {
  return (await call(method, url, userId, body)).status;
}

describe("旧三表不再参与放行（members.role / kb_members.role / kb_doc_acls）", () => {
  let baseId: string;
  let tableId: string;

  beforeAll(async () => {
    const res = await call("POST", "/api/bases", "bu_owner", { name: "M4 决策库" });
    baseId = (await json<{ base: { id: string } }>(res)).base.id;
    const t = await call("GET", `/api/tables?baseId=${baseId}`, "bu_owner");
    tableId = (await json<{ tables: Array<{ id: string }> }>(t)).tables[0]!.id;
    // 旧三表照旧写满五档成员行——它们仍是导航引擎的投影源，但对放行为零。
    for (const r of LEGACY_ROLES.filter((x) => x !== "owner")) {
      await h.prisma.member.create({ data: { baseId, userId: `bu_${r}`, role: r } });
    }
  });

  it.each(LEGACY_ROLES.filter((r) => r !== "owner"))("%s 成员行不再授予任何库权限 -> 403 FORBIDDEN", async (r) => {
    const res = await call("GET", `/api/tables?baseId=${baseId}`, `bu_${r}`);
    expect(res.status).toBe(403);
    expect((await json<{ code: string }>(res)).code).toBe("FORBIDDEN");
    expect(await status("POST", `/api/records?tableId=${tableId}`, `bu_${r}`, { fields: {} })).toBe(403);
  });

  it("唯一真来源：给角色配上「角色 × 库」视野后，同一批用户立刻可见可写", async () => {
    await h.prisma.role.create({
      data: { id: "dm_role_scope", workspaceId: "ws_default", name: "决策档", isSystem: 0, permissions: "[]" },
    });
    for (const r of LEGACY_ROLES.filter((x) => x !== "owner")) {
      await h.prisma.roleAssignment.create({
        data: { roleId: "dm_role_scope", subjectType: "user", subjectId: `bu_${r}`, scopeType: "workspace", createdBy: "seed" },
      });
    }
    await h.prisma.roleLibraryScope.create({
      data: {
        roleId: "dm_role_scope", libraryKind: "base", libraryId: baseId, canManage: 0, visible: 1,
        config: JSON.stringify({
          tables: { [tableId]: { read: true, create: true, update: true, delete: false } },
          fields: {},
        }),
      },
    });
    // 与成员档无关：五个人拿的是同一枚角色，结果必须完全一致。
    for (const r of LEGACY_ROLES.filter((x) => x !== "owner")) {
      expect(await status("GET", `/api/tables?baseId=${baseId}`, `bu_${r}`)).toBe(200);
      expect(await status("POST", `/api/records?tableId=${tableId}`, `bu_${r}`, { fields: {} })).toBe(201);
    }
  });

  it("无来源用户 403 且 code=FORBIDDEN；无 token 401", async () => {
    const res = await call("GET", `/api/tables?baseId=${baseId}`, "bu_none");
    expect(res.status).toBe(403);
    expect((await json<{ code: string }>(res)).code).toBe("FORBIDDEN");
    expect((await call("GET", `/api/tables?baseId=${baseId}`, null)).status).toBe(401);
  });
});

describe("知识库：文档一律跟随知识库的角色配置，单篇 ACL 不再放行", () => {
  let kbId: string;
  let docId: string;

  beforeAll(async () => {
    await h.createUser("ku_member");
    await h.createUser("ku_acl_only");
    const res = await call("POST", "/api/kb", "bu_owner", { name: "M4 决策知识库" });
    kbId = (await json<{ knowledgeBase: { id: string } }>(res)).knowledgeBase.id;
    // 旧 kb_members 行（owner 成员）与单篇 ACL 行照旧写入，均不再参与放行。
    await h.prisma.kbMember.create({ data: { kbId, userId: "ku_member", role: "editor" } });
    const d = await call("POST", `/api/kb/${kbId}/docs`, "bu_owner", { kind: "doc", title: "ACL 文档" });
    docId = (await json<{ doc: { id: string } }>(d)).doc.id;
    await h.prisma.kbDocAcl.create({ data: { docId, userId: "ku_acl_only", role: "editor" } });
    await h.prisma.kbDocAcl.create({ data: { docId, userId: "ku_member", role: "viewer" } });
  });

  it("只有 kb 成员行 / 只有 editor ACL，都进不去：一律 403 FORBIDDEN", async () => {
    for (const u of ["ku_member", "ku_acl_only"]) {
      const res = await call("GET", `/api/kb/docs/${docId}`, u);
      expect(res.status).toBe(403);
      expect((await json<{ code: string }>(res)).code).toBe("FORBIDDEN");
    }
  });

  it("给角色配 kb 视野后：只读档 canEdit=false，勾了 content 写动作才 canEdit=true", async () => {
    await h.prisma.role.create({
      data: { id: "dm_role_kb_ro", workspaceId: "ws_default", name: "kb 只读", isSystem: 0, permissions: "[]" },
    });
    await h.prisma.role.create({
      data: { id: "dm_role_kb_rw", workspaceId: "ws_default", name: "kb 可写", isSystem: 0, permissions: "[]" },
    });
    for (const [u, roleId] of [["ku_member", "dm_role_kb_ro"], ["ku_acl_only", "dm_role_kb_rw"]] as const) {
      await h.prisma.roleAssignment.create({
        data: { roleId, subjectType: "user", subjectId: u, scopeType: "workspace", createdBy: "seed" },
      });
    }
    await h.prisma.roleLibraryScope.createMany({
      data: [
        { roleId: "dm_role_kb_ro", libraryKind: "kb", libraryId: kbId, canManage: 0, visible: 1 },
        { roleId: "dm_role_kb_rw", libraryKind: "kb", libraryId: kbId, canManage: 0, visible: 1,
          config: JSON.stringify({
            tables: { [KB_CONTENT_KEY]: { read: true, create: true, update: true, delete: false } },
            fields: {},
          }) },
      ],
    });
    const ro = await call("GET", `/api/kb/docs/${docId}`, "ku_member");
    expect(ro.status).toBe(200);
    expect((await json<{ doc: { canEdit: boolean } }>(ro)).doc.canEdit).toBe(false);
    expect(await status("PUT", `/api/kb/docs/${docId}/content`, "ku_member", { content: "x" })).toBe(403);

    const rw = await call("GET", `/api/kb/docs/${docId}`, "ku_acl_only");
    expect(rw.status).toBe(200);
    expect((await json<{ doc: { canEdit: boolean } }>(rw)).doc.canEdit).toBe(true);
    expect(await status("PUT", `/api/kb/docs/${docId}/content`, "ku_acl_only", { content: "y" })).toBe(200);
  });

  it("软删文档 404「文档不存在或已删除」；软删知识库 404「知识库不存在」", async () => {
    await h.prisma.kbDoc.update({ where: { id: docId }, data: { deletedAt: new Date(), deletedBy: "bu_owner" } });
    const r1 = await call("GET", `/api/kb/docs/${docId}`, "bu_owner");
    expect(r1.status).toBe(404);
    expect((await json<{ error: string }>(r1)).error).toBe("文档不存在或已删除");
    await h.prisma.kbDoc.update({ where: { id: docId }, data: { deletedAt: null, deletedBy: null } });
    await h.prisma.knowledgeBase.update({ where: { id: kbId }, data: { deletedAt: new Date() } });
    const r2 = await call("GET", `/api/kb/${kbId}`, "bu_owner");
    expect(r2.status).toBe(404);
    expect((await json<{ error: string }>(r2)).error).toBe("知识库不存在");
  });
});

describe("匿名 public resolveShare 不查成员/ACL/auth_policies", () => {
  let editorToken: string;
  let viewerToken: string;
  let childId: string;
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeAll(async () => {
    // 开库级「允许分享」总闸：本 describe 验证的是「匿名通道不查成员/ACL/auth_policies」，
    // 不是总闸行为。总闸关着会被 shareLinkLookup 先拦成 403「该知识库已关闭分享」，用例就
    // 断言不到它声称要验证的东西。第三条用例尤其如此——它本就期望 403，但期望的是档位判定的
    // 「只读」，而不是总闸文案，不开总闸就永远走不到那一步。
    const kb = await h.prisma.knowledgeBase.create({ data: { name: "公开库", createdBy: "bu_owner", shareEnabled: 1 } });
    const root = await h.prisma.kbDoc.create({
      data: { id: "m4share_root", kbId: kb.id, kind: "doc", title: "分享根", content: "r", createdBy: "bu_owner", updatedBy: "bu_owner" },
    });
    childId = (await h.prisma.kbDoc.create({
      data: { kbId: kb.id, kind: "doc", title: "子文档", content: "c", parentId: root.id, createdBy: "bu_owner", updatedBy: "bu_owner" },
    })).id;
    await h.prisma.kbDoc.update({ where: { id: root.id }, data: { shareEnabled: true, shareToken: "tok-editor", shareRole: "editor", shareIncludeChildren: true } });
    const vRoot = await h.prisma.kbDoc.create({
      data: { kbId: kb.id, kind: "doc", title: "只读根", content: "v", createdBy: "bu_owner", updatedBy: "bu_owner" },
    });
    await h.prisma.kbDoc.update({ where: { id: vRoot.id }, data: { shareEnabled: true, shareToken: "tok-viewer", shareRole: "viewer" } });
    editorToken = "tok-editor";
    viewerToken = "tok-viewer";
  });

  beforeEach(() => {
    // 匿名通道经 db.js 同一 prisma 单例；spy 三类旧授权表的全部读方法。
    for (const delegate of ["kbMember", "kbDocAcl", "authPolicy"] as const) {
      for (const m of ["findUnique", "findFirst", "findMany", "count"] as const) {
        const spy = vi.spyOn((h.prisma as unknown as Record<string, Record<string, unknown>>)[delegate]!, m as never);
        spies.push(spy as never);
      }
    }
  });
  afterEach(() => { vi.restoreAllMocks(); spies.length = 0; });

  function assertNoAuthzQuery() {
    const total = spies.reduce((n, s) => n + s.mock.calls.length, 0);
    expect(total).toBe(0);
  }

  it("spy 反证：直接查 kbMember 会被计数（证明上面零计数非 spy 失效）", async () => {
    await h.prisma.kbMember.findUnique({ where: { kbId_userId: { kbId: "x", userId: "y" } } } as never);
    const total = spies.reduce((n, s) => n + s.mock.calls.length, 0);
    expect(total).toBeGreaterThan(0);
  });

  it("GET 根：200 且零成员/ACL/policy 查询", async () => {
    const res = await h.app.request(`/api/public/s/${editorToken}`);
    expect(res.status).toBe(200);
    assertNoAuthzQuery();
  });

  it("GET 级联子文档 200；范围外 doc 404，均零授权查询", async () => {
    expect((await h.app.request(`/api/public/s/${editorToken}/doc/${childId}`)).status).toBe(200);
    assertNoAuthzQuery();
    const out = await h.app.request(`/api/public/s/${editorToken}/doc/${"doc_out_of_range_xx"}`);
    expect(out.status).toBe(404);
  });

  // 产品口径变更（M7）：分享链接对外只读，匿名写整体关闭。原用例断言 editor 分享可匿名 200 改写
  // 正文，与新口径相反，故改为断言两档分享一律 403，并强证正文/updatedBy 未被改动。
  it("匿名编辑已关闭：editor / viewer 分享一律 403「只读」，正文未改且零授权查询", async () => {
    const before = await h.prisma.kbDoc.findUniqueOrThrow({ where: { id: childId } });
    const deniedEditor = await h.app.request(`/api/public/s/${editorToken}/doc/${childId}/content`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "anon", baseUpdatedAt: new Date().toISOString() }),
    });
    expect(deniedEditor.status).toBe(403);
    expect((await json<{ error: string }>(deniedEditor)).error).toContain("只读");
    assertNoAuthzQuery();
    const deniedViewer = await h.app.request(`/api/public/s/${viewerToken}/doc/x/content`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "z", baseUpdatedAt: new Date().toISOString() }),
    });
    expect(deniedViewer.status).toBe(403);
    const after = await h.prisma.kbDoc.findUniqueOrThrow({ where: { id: childId } });
    expect(after.content).toBe(before.content);
    expect(after.updatedBy).toBe(before.updatedBy);
  });
});
