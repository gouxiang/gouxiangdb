// M4/S4 GET /api/v1/authz/visible-scope 端点契约测试（真库真 JWT，不 mock auth）。
//
// 覆盖：
//   - 未登录 401；
//   - 本人查询 200，契约字段齐全（nodeIds/resourceIdsByType/materialize/count 等）；
//   - 查他人：非 workspace owner 403（fail-closed），owner 200（manage_share 工作区兜底形态）；
//   - 参数校验：budget 非正整数 400；actions 含非法动作 400；kinds 未知值忽略不报错；
//   - budget 截断 -> materialize=temp_table；小结果 in_list；
//   - 旧 /api 不感知本端点（走旧 404 链），端点可用性与任何引擎开关无关。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, json, type OrgHarness } from "../org/__tests__/orgHarness.js";

let h: OrgHarness;
const PATH = "/api/v1/authz/visible-scope";

async function seed(): Promise<void> {
  for (const u of ["vs_owner", "vs_plain", "vs_target"]) await h.createUser(u);
  await h.grantSystemRole("vs_owner", "owner");

  // 多族实体（base/table/kb/doc/canvas）+ 同步 nav 节点；owner 全可见兜底，plain 无任何授权。
  await h.prisma.base.create({ data: { id: "vs_b1", name: "vs base", createdBy: "vs_owner" } });
  await h.prisma.table.create({
    data: { id: "vs_t1", baseId: "vs_b1", name: "vs table", primaryFieldId: "", createdBy: "vs_owner" },
  });
  await h.prisma.knowledgeBase.create({ data: { id: "vs_k1", name: "vs kb", createdBy: "vs_owner" } });
  await h.prisma.kbDoc.create({
    data: { id: "vs_d1", kbId: "vs_k1", kind: "doc", title: "vs doc", createdBy: "vs_owner", updatedBy: "vs_owner" },
  });
  await h.prisma.kbDoc.create({
    data: { id: "vs_c1", kbId: "vs_k1", kind: "canvas", title: "vs canvas", createdBy: "vs_owner", updatedBy: "vs_owner" },
  });
  const { syncNavFromEntitiesTx } = await import("../../../domain/nav/sync.js");
  await h.prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));
}

beforeAll(async () => {
  h = await setupOrgHarness();
  await seed();
}, 120_000);

afterAll(async () => {
  await h.cleanup();
});

async function get(url: string, userId: string | null): Promise<Response> {
  const headers: Record<string, string> = userId ? await h.auth(userId) : {};
  return h.app.request(url, { method: "GET", headers });
}

describe("鉴权", () => {
  it("未登录 401", async () => {
    expect((await get(PATH, null)).status).toBe(401);
  });

  it("本人查询 200：默认 actions=r，契约字段齐全", async () => {
    const res = await get(PATH, "vs_plain");
    expect(res.status).toBe(200);
    const body = await json<Record<string, unknown>>(res);
    expect(body.userId).toBe("vs_plain");
    expect(body.actions).toEqual(["r"]);
    expect(body.kinds).toBeNull();
    expect(body.nodeIds).toEqual([]); // 无任何授权且非 owner/creator
    expect(body.resourceIdsByType).toEqual({});
    expect(body.maskedTableFields).toEqual({});
    expect(body.truncated).toBe(false);
    expect(body.policyVersion).toBe(0);
    expect(body.budget).toBe(5000);
    expect(body.evaluated).toBeGreaterThan(0);
    expect(body.visibleTotal).toBe(0);
    expect(body.materialize).toBe("in_list");
    expect(body.count).toBe(0);
  });

  it("查他人：非 owner 403（资源级授权不提升跨用户诊断权，fail-closed）", async () => {
    const res = await get(`${PATH}?userId=vs_target`, "vs_plain");
    expect(res.status).toBe(403);
    const body = await json<{ error?: string }>(res);
    expect(body.error ?? "").toContain("manage_share");
  });

  it("查他人：workspace owner 200，body.userId 为目标用户", async () => {
    const res = await get(`${PATH}?userId=vs_target`, "vs_owner");
    expect(res.status).toBe(200);
    const body = await json<{ userId: string; visibleTotal: number }>(res);
    expect(body.userId).toBe("vs_target");
    expect(body.visibleTotal).toBe(0);
  });

  it("空 userId 参数回退为本人（200，不触发 403）", async () => {
    const res = await get(`${PATH}?userId=%20%20`, "vs_plain");
    expect(res.status).toBe(200);
    expect((await json<{ userId: string }>(res)).userId).toBe("vs_plain");
  });
});

describe("参数与物化契约", () => {
  it("owner 自查：creator/owner 兜底可见各资源节点；kinds=base 过滤生效", async () => {
    const res = await get(`${PATH}?kinds=base`, "vs_owner");
    expect(res.status).toBe(200);
    const body = await json<{
      nodeIds: string[]; resourceIdsByType: Record<string, string[]>; count: number;
    }>(res);
    expect(body.count).toBe(1);
    expect(body.resourceIdsByType).toEqual({ base: ["vs_b1"] });
    expect(body.nodeIds).toHaveLength(1);
  });

  it("kinds 未知值被忽略（白名单过滤，不 400），已知值正常过滤", async () => {
    const res = await get(`${PATH}?kinds=doc,bogus`, "vs_owner");
    expect(res.status).toBe(200);
    const body = await json<{ count: number; resourceIdsByType: Record<string, string[]> }>(res);
    expect(body.count).toBe(1); // vs_d1；canvas 不混入 doc
    expect(body.resourceIdsByType).toEqual({ doc: ["vs_d1"] });
  });

  it("actions=u 正常；非法动作 400", async () => {
    expect((await get(`${PATH}?actions=u`, "vs_owner")).status).toBe(200);
    const bad = await get(`${PATH}?actions=drop_table`, "vs_owner");
    expect(bad.status).toBe(400);
    expect((await json<{ error?: string }>(bad)).error ?? "").toContain("scope");
  });

  it("budget 非正整数/非数字 400（错误消息带硬上限）", async () => {
    expect((await get(`${PATH}?budget=0`, "vs_owner")).status).toBe(400);
    expect((await get(`${PATH}?budget=-3`, "vs_owner")).status).toBe(400);
    expect((await get(`${PATH}?budget=abc`, "vs_owner")).status).toBe(400);
  });

  it("budget 超大值被收敛到硬上限不报错；budget=1 截断 -> temp_table", async () => {
    const clamped = await get(`${PATH}?budget=999999`, "vs_owner");
    expect(clamped.status).toBe(200);
    expect((await json<{ budget: number }>(clamped)).budget).toBe(20000);

    const tiny = await get(`${PATH}?budget=1&kinds=base,kb,table,view,doc,canvas,group`, "vs_owner");
    expect(tiny.status).toBe(200);
    const body = await json<{ truncated: boolean; materialize: string; count: number; visibleTotal: number }>(tiny);
    expect(body.truncated).toBe(true);
    expect(body.visibleTotal).toBeGreaterThan(1);
    expect(body.count).toBe(1);
    expect(body.materialize).toBe("temp_table");
  });
});

describe("挂载边界", () => {
  it("旧 /api 不提供本端点（404，旧面零影响）", async () => {
    const res = await get("/api/authz/visible-scope", "vs_owner");
    expect(res.status).toBe(404);
  });
});
