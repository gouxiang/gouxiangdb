// M4/S5 旧三表 -> auth_policies 投影：权限核心模型（二）之后还剩下什么。
//
// 原文件测的是"成员/ACL 六个写点各自双写"，这六个 HTTP 入口【已全部下线】：
//   取消逐库逐人授权 -> POST/DELETE /api/bases/:id/members、POST /api/kb/:kbId/members 摘除；
//   取消单篇文档授权 -> PUT /api/kb/docs/:docId/acl 摘除。
// 授权维度收归「角色 × 库」后，旧三表只剩【建库那一刻的一次性投影】（owner 成员行 ->
// base 节点 legacy:member 策略行，仍在 withWriteTx 内同事务完成），故本文件改为锁这
// 一件事，外加锁死"六个写点不会再长回来"（不许留配了不生效的入口）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNavHarness, type CharHarness } from "../../../domain/nav/__tests__/navRouteHarness.js";
import { nodeId } from "../../../domain/nav/backfill.js";
import { json } from "../../../domain/nav/__tests__/characterization/charHarness.js";

let h: CharHarness;

async function call(method: string, url: string, user: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = await h.auth(user);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return h.app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

beforeAll(async () => {
  h = await makeNavHarness("gx-s5-dual-");
  await h.createUser("owner");
  await h.createUser("bm1", { email: "bm1@example.com" });
  await h.grantRole("owner"); // 硬规则 B：建库只给超级管理员/管理员
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

describe("建库同事务投影（旧三表唯一存活的写点）", () => {
  it("owner 成员行与 base 节点 legacy:member 策略行同生；同库再补超级管理员/管理员视野行", async () => {
    const res = await call("POST", "/api/bases", "owner", { name: "s5 投影库" });
    expect(res.status).toBe(201);
    const baseId = (await json<{ base: { id: string } }>(res)).base.id;

    const member = await h.prisma.member.findFirstOrThrow({ where: { baseId, userId: "owner" } });
    const pol = await h.prisma.authPolicy.findUniqueOrThrow({ where: { id: `pol_legacy_member_${member.id}` } });
    expect(pol.nodeId).toBe(nodeId("base", baseId));
    expect(pol.reason).toBe("legacy:member");
    expect(pol.subjectId).toBe("owner");

    // 新模型：建库同事务给超级管理员/管理员各补一条「角色 × 库」视野（管理权唯一来源）。
    const scopes = await h.prisma.roleLibraryScope.findMany({
      where: { libraryKind: "base", libraryId: baseId },
      orderBy: { roleId: "asc" },
    });
    expect(scopes.map((s) => s.roleId)).toEqual(["role_admin", "role_owner"]);
    for (const s of scopes) {
      expect(s.canManage).toBe(1);
      expect(s.visible).toBe(1);
    }
  });

  it("建知识库同事务补「角色 × 知识库」视野行", async () => {
    const res = await call("POST", "/api/kb", "owner", { name: "s5 投影知识库" });
    expect(res.status).toBe(201);
    const kbId = (await json<{ knowledgeBase: { id: string } }>(res)).knowledgeBase.id;
    const scopes = await h.prisma.roleLibraryScope.findMany({
      where: { libraryKind: "kb", libraryId: kbId },
      orderBy: { roleId: "asc" },
    });
    expect(scopes.map((s) => s.roleId)).toEqual(["role_admin", "role_owner"]);
  });
});

describe("六个旧写点已下线（防止再长出配了不生效的入口）", () => {
  it("base/kb 成员增删、单文档 ACL 授予一律 404", async () => {
    const res = await call("POST", "/api/bases", "owner", { name: "s5 下线库" });
    const baseId = (await json<{ base: { id: string } }>(res)).base.id;
    expect((await call("POST", `/api/bases/${baseId}/members`, "owner", { email: "bm1@example.com", role: "viewer" })).status).toBe(404);
    expect((await call("PATCH", `/api/bases/${baseId}/members/bm1`, "owner", { role: "editor" })).status).toBe(404);
    expect((await call("DELETE", `/api/bases/${baseId}/members/bm1`, "owner")).status).toBe(404);

    const kbRes = await call("POST", "/api/kb", "owner", { name: "s5 下线知识库" });
    const kbId = (await json<{ knowledgeBase: { id: string } }>(kbRes)).knowledgeBase.id;
    expect((await call("POST", `/api/kb/${kbId}/members`, "owner", { email: "bm1@example.com", role: "viewer" })).status).toBe(404);
    const doc = await call("POST", `/api/kb/${kbId}/docs`, "owner", { kind: "doc", title: "d" });
    const docId = (await json<{ doc: { id: string } }>(doc)).doc.id;
    expect((await call("PUT", `/api/kb/docs/${docId}/acl`, "owner", { email: "bm1@example.com", role: "editor" })).status).toBe(404);
  });
});
