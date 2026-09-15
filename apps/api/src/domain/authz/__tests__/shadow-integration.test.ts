// M4/S3 shadow 适配层端到端对拍（真迁移临时库 + 真 createApp/真 JWT/真守卫，不 mock auth）：
//   A. shadow：经 reconcile 补投影的回填夹具上，base/kb/doc 三族读(r)/写(u) allow 与非成员 deny 全一致 drift=0；
//   B. 人工 DRIFT_OVERDENY：删掉某成员投影行 -> 旧仍放行(200)、引擎 deny，overDeny=1；
//   C. 人工 DRIFT_OVERALLOW：给非成员在节点插一条 user r 策略 -> 旧仍拒绝(403)、引擎 allow，overAllow=1；
//   D. 引擎抛错（workspace.findUnique 抛错，旧 base 路径不读 workspace）-> 旧响应照常 200，errors=1、不抛出；
//   E. off（默认）：守卫不实例化引擎，auth_policies 零查询（旧行为字节不变）。
// 顺序纪律：对 authPolicy delegate 的 vi.spyOn 会在 restore 后使该 Prisma delegate 方法失效（S0 同款坑），
// 故 off 的 spy 用例放文件最末，不污染前面 shadow 用例；每用例 reset driftRegistry，afterEach 还原 env/spy。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { setupCharHarness, json, type CharHarness } from "../../nav/__tests__/characterization/charHarness.js";
import { driftRegistry } from "../shadow.js";
import { applyAuthzReconcileFixes } from "../reconcile.js";

// 不在顶层静态 import db 单例：等 setupCharHarness 注入临时 DATABASE_URL/globalThis 后再动态 import
//（同 records-keyset/charHarness 纪律），否则 prisma 在临时库注入前求值会绑错库。
let prisma: PrismaClient;
let h: CharHarness;
let baseId: string;
let tableId: string;
let kbId: string;
let docId: string;
let baseNodeId: string;

async function call(method: string, url: string, userId: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = await h.auth(userId);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return h.app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

beforeAll(async () => {
  delete process.env.GX_AUTHZ_ENGINE; // 默认 off
  h = await setupCharHarness("gx-m4-shadow-");
  prisma = (await import("../../../db.js")).prisma;
  for (const u of ["sh_owner", "sh_editor", "sh_viewer", "sh_stranger"]) await h.createUser(u);

  const b = await call("POST", "/api/bases", "sh_owner", { name: "shadow base" });
  baseId = (await json<{ base: { id: string } }>(b)).base.id;
  await h.prisma.member.create({ data: { baseId, userId: "sh_editor", role: "editor" } });
  await h.prisma.member.create({ data: { baseId, userId: "sh_viewer", role: "viewer" } });
  const t = await call("GET", `/api/tables?baseId=${baseId}`, "sh_owner");
  tableId = (await json<{ tables: Array<{ id: string }> }>(t)).tables[0]!.id;

  const k = await call("POST", "/api/kb", "sh_owner", { name: "shadow kb" });
  kbId = (await json<{ knowledgeBase: { id: string } }>(k)).knowledgeBase.id;
  await h.prisma.kbMember.create({ data: { kbId, userId: "sh_viewer", role: "viewer" } });
  const d = await call("POST", `/api/kb/${kbId}/docs`, "sh_owner", { kind: "doc", title: "d" });
  docId = (await json<{ doc: { id: string } }>(d)).doc.id;
  await h.prisma.kbDocAcl.create({ data: { docId, userId: "sh_editor", role: "viewer" } });

  // 建资源写点已同事务同步 nav 节点；reconcile 把当前旧三表活行投影到 auth_policies（等价升级后状态）。
  const fixes = await applyAuthzReconcileFixes(h.prisma);
  expect(fixes.created).toBeGreaterThan(0);
  baseNodeId = (await h.prisma.navNode.findUniqueOrThrow({
    where: { workspaceId_resourceType_resourceId: { workspaceId: "ws_default", resourceType: "base", resourceId: baseId } },
    select: { id: true },
  })).id;
}, 120000);

afterAll(async () => {
  delete process.env.GX_AUTHZ_ENGINE;
  await h.cleanup();
});

beforeEach(() => {
  driftRegistry.reset();
});

afterEach(() => {
  delete process.env.GX_AUTHZ_ENGINE;
  vi.restoreAllMocks();
});

describe("shadow：回填夹具三族对拍 0 drift", () => {
  beforeEach(() => { process.env.GX_AUTHZ_ENGINE = "shadow"; });

  it("base r（owner/editor/viewer + 非成员）、base u（editor 建记录）、kb r、doc r 全一致", async () => {
    expect((await call("GET", `/api/tables?baseId=${baseId}`, "sh_owner")).status).toBe(200);
    expect((await call("GET", `/api/tables?baseId=${baseId}`, "sh_editor")).status).toBe(200);
    expect((await call("GET", `/api/tables?baseId=${baseId}`, "sh_viewer")).status).toBe(200);
    // 编辑动作 u：editor 投影含 c/u/d -> 引擎 allow，旧 201。
    expect((await call("POST", `/api/records?tableId=${tableId}`, "sh_editor", { fields: {} })).status).toBe(201);
    // kb 容器 r：viewer 成员。
    expect((await call("GET", `/api/kb/${kbId}`, "sh_viewer")).status).toBe(200);
    // doc 内容 r：sh_editor 凭 viewer ACL（doc 节点投影）。
    expect((await call("GET", `/api/kb/docs/${docId}`, "sh_editor")).status).toBe(200);
    // doc 内容 u：viewer ACL 旧拒 403，引擎投影无 u 亦 deny，一致。
    expect((await call("PUT", `/api/kb/docs/${docId}/content`, "sh_editor", { content: "x" })).status).toBe(403);
    // 非成员：旧 403，引擎无 allow（非 owner/creator、无投影）亦 deny，一致。
    expect((await call("GET", `/api/tables?baseId=${baseId}`, "sh_stranger")).status).toBe(403);

    const s = driftRegistry.snapshot();
    expect(s.overDeny).toBe(0);
    expect(s.overAllow).toBe(0);
    expect(s.errors).toBe(0);
    expect(s.unresolvedNode).toBe(0);
    expect(s.compared).toBeGreaterThan(0);
  });
});

describe("shadow：人工制造漂移，旧结果仍为准", () => {
  beforeEach(() => { process.env.GX_AUTHZ_ENGINE = "shadow"; });

  it("DRIFT_OVERDENY：删 editor 投影行 -> 旧仍 200，引擎更严计 1", async () => {
    await h.prisma.authPolicy.deleteMany({
      where: { nodeId: baseNodeId, subjectType: "user", subjectId: "sh_editor" },
    });
    const res = await call("GET", `/api/tables?baseId=${baseId}`, "sh_editor");
    expect(res.status).toBe(200); // 旧成员表为准，未被引擎误拒
    const s = driftRegistry.snapshot();
    expect(s.overDeny).toBe(1);
    expect(s.overAllow).toBe(0);
  });

  it("DRIFT_OVERALLOW：给非成员插 r 策略 -> 旧仍 403，引擎更宽计 1（零容忍分类）", async () => {
    await h.prisma.authPolicy.create({
      data: {
        id: "pol_test_overallow_stranger", workspaceId: "ws_default", nodeId: baseNodeId,
        subjectType: "user", subjectId: "sh_stranger", actions: "r", createdBy: "test",
      },
    });
    const res = await call("GET", `/api/tables?baseId=${baseId}`, "sh_stranger");
    expect(res.status).toBe(403); // 旧成员表为准，引擎越权结论不放行
    const s = driftRegistry.snapshot();
    expect(s.overAllow).toBe(1);
    expect(s.overDeny).toBe(0);
  });
});

describe("shadow：引擎故障不影响旧响应", () => {
  it("引擎 workspace 版本查询抛错 -> 旧守卫照常 200，记 errors=1、不抛出", async () => {
    process.env.GX_AUTHZ_ENGINE = "shadow";
    // 旧 base 守卫链路不读 workspaces；引擎 resolveVersion 必读 -> 只在对拍侧抛错。
    vi.spyOn(prisma.workspace, "findUnique").mockRejectedValue(new Error("engine boom"));
    const res = await call("GET", `/api/tables?baseId=${baseId}`, "sh_owner");
    expect(res.status).toBe(200);
    const s = driftRegistry.snapshot();
    expect(s.errors).toBe(1);
    expect(s.overDeny + s.overAllow).toBe(0);
  });
});

// 放最后：vi.spyOn Prisma delegate 在 restore 后会使该 delegate 方法失效，避免污染上面用例。
describe("off（默认）：旧行为不变，引擎零接入", () => {
  it("守卫路径不查 auth_policies（shadow 适配不实例化引擎）", async () => {
    process.env.GX_AUTHZ_ENGINE = "off";
    const delegates = h.prisma as unknown as Record<string, Record<string, unknown>>;
    const spies = ["findUnique", "findFirst", "findMany", "count"].map((m) =>
      vi.spyOn(delegates.authPolicy!, m as never) as unknown as ReturnType<typeof vi.fn>,
    );
    const res = await call("GET", `/api/tables?baseId=${baseId}`, "sh_viewer");
    expect(res.status).toBe(200);
    expect(spies.reduce((n, s) => n + s.mock.calls.length, 0)).toBe(0);
    expect(driftRegistry.snapshot().compared).toBe(0);
  });
});
