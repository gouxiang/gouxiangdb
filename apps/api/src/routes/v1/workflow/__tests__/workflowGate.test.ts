// 刀 B2 工作流 HTTP 面门控契约测试（真迁移临时库 + 真 createApp + 真 JWT，不 mock）。
//
// 与 routes/v1/sync/__tests__/yn0-foundation.test.ts 同纪律：orgHarness 动态 import app，
// 本地 withEnv 在同进程内切 GX_WORKFLOW_ENGINE，验证「恒挂载 + 请求期闸门，off 落 404」。
//
// 覆盖：
//  A. 默认 off：组首闸在任何鉴权/DB 之前 404 WORKFLOW_DISABLED（未登录、带登录都 404，证明门在鉴权前）。
//  B. fail-closed 笔误值（opn）仍 404。
//  C. on：门放行后鉴权独立成第二道（未登录 401）；登录后 GET /defs 200 空分页。
//  D. on happy path：最小合法图建定义 201、坏图 400、发布 204、触发建 pending run 201、runs 查询闭环。
//     全程不启动 runtime、不执行 run（HTTP 测试不进 index.ts main），故只需单 trigger 零边最小图，无需 nav/table。
//  E. 审批裁决路由白名单：非法 decision 在查库前 400；合法 decision 但审批单不存在 -> 域层 404。
//  F. 结构独立：workflow 路由源文件不依赖企业双 flag，只认自己的 workflowEngineEnabled 总门。

import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, json, type OrgHarness } from "../../org/__tests__/orgHarness.js";

let h: OrgHarness;
const BASE = "/api/v1/workflow";
const USER = "wf_user";
// 最小合法图：恰好 1 个 trigger、零边、无 action/approval 节点（graph 校验天然通过，不依赖 nav/表）。
const MIN_GRAPH = JSON.stringify({ nodes: [{ id: "tr", type: "trigger" }], edges: [] });
// 零节点图：parse 通过但 validate 抛 400 WORKFLOW_GRAPH_EMPTY（见 domain/workflow/__tests__/graph.test.ts）。
const EMPTY_GRAPH = JSON.stringify({ nodes: [], edges: [] });

beforeAll(async () => {
  // 刻意不设 GX_WORKFLOW_ENGINE：出厂默认 off，A/B 组直接验证默认姿态。
  h = await setupOrgHarness();
  await h.createUser(USER);
}, 120_000);

afterAll(async () => {
  delete process.env.GX_WORKFLOW_ENGINE;
  await h.cleanup();
});

/** 本地切 env：undefined 则 delete，finally 还原（同 yn0 withEnv）。 */
async function withEnv<K>(key: string, value: string | undefined, fn: () => Promise<K>): Promise<K> {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

async function jsonHeaders(): Promise<Record<string, string>> {
  return { "Content-Type": "application/json", ...(await h.auth(USER)) };
}

describe("A. 默认 off：组首闸在鉴权/DB 之前 404", () => {
  it("未登录 + off -> 404 WORKFLOW_DISABLED（不是 401，证明门在鉴权前）", () =>
    withEnv("GX_WORKFLOW_ENGINE", undefined, async () => {
      const res = await h.app.request(`${BASE}/defs`, { method: "GET" });
      expect(res.status).toBe(404);
      expect((await json<{ code: string }>(res)).code).toBe("WORKFLOW_DISABLED");
    }));

  it("带登录态 + off -> 仍是 404 WORKFLOW_DISABLED", () =>
    withEnv("GX_WORKFLOW_ENGINE", undefined, async () => {
      const res = await h.app.request(`${BASE}/defs`, { method: "GET", headers: await h.auth(USER) });
      expect(res.status).toBe(404);
      expect((await json<{ code: string }>(res)).code).toBe("WORKFLOW_DISABLED");
    }));

  it("off 下写端点同样被首闸短路（POST /defs 404，不触库）", () =>
    withEnv("GX_WORKFLOW_ENGINE", undefined, async () => {
      const res = await h.app.request(`${BASE}/defs`, {
        method: "POST",
        headers: await jsonHeaders(),
        body: JSON.stringify({ name: "x", graph: MIN_GRAPH }),
      });
      expect(res.status).toBe(404);
      expect((await json<{ code: string }>(res)).code).toBe("WORKFLOW_DISABLED");
    }));
});

describe("B. fail-closed：笔误值 opn 仍按关闭处理", () => {
  it("GX_WORKFLOW_ENGINE=opn + 登录 -> 404", () =>
    withEnv("GX_WORKFLOW_ENGINE", "opn", async () => {
      const res = await h.app.request(`${BASE}/defs`, { method: "GET", headers: await h.auth(USER) });
      expect(res.status).toBe(404);
      expect((await json<{ code: string }>(res)).code).toBe("WORKFLOW_DISABLED");
    }));
});

describe("C. on：门放行，鉴权是独立第二道", () => {
  it("on + 未登录 -> 401（门已放行，被 requireActiveUser 拦）", () =>
    withEnv("GX_WORKFLOW_ENGINE", "on", async () => {
      const res = await h.app.request(`${BASE}/defs`, { method: "GET" });
      expect(res.status).toBe(401);
    }));

  it("on + 登录 -> GET /defs 200 空分页 {items:[],total:0}（此用例先于 D 组建定义执行）", () =>
    withEnv("GX_WORKFLOW_ENGINE", "on", async () => {
      const res = await h.app.request(`${BASE}/defs`, { method: "GET", headers: await h.auth(USER) });
      expect(res.status).toBe(200);
      const body = await json<{ items: unknown[]; total: number }>(res);
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.total).toBe(0);
    }));
});

describe("D. on happy path：定义->发布->触发->运行查询闭环", () => {
  it("建定义 201 / 坏图 400 / 发布 204 / 触发 201 建 pending run / runs 与 run 详情可查", () =>
    withEnv("GX_WORKFLOW_ENGINE", "on", async () => {
      const headers = await jsonHeaders();

      // 坏图：路由形状校验通过后交域层 validate，零节点 -> 400 WORKFLOW_GRAPH_EMPTY，不落库。
      const bad = await h.app.request(`${BASE}/defs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "坏图", graph: EMPTY_GRAPH }),
      });
      expect(bad.status).toBe(400);
      expect((await json<{ code: string }>(bad)).code).toBe("WORKFLOW_GRAPH_EMPTY");

      // 最小合法图建定义 -> 201 {id}。
      const created = await h.app.request(`${BASE}/defs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "审批流", graph: MIN_GRAPH }),
      });
      expect(created.status).toBe(201);
      const def = await json<{ id: string }>(created);
      expect(typeof def.id).toBe("string");
      expect(def.id.length).toBeGreaterThan(0);

      // 名称缺失 -> 路由层 400 WORKFLOW_NAME_EMPTY。
      const noName = await h.app.request(`${BASE}/defs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ graph: MIN_GRAPH }),
      });
      expect(noName.status).toBe(400);
      expect((await json<{ code: string }>(noName)).code).toBe("WORKFLOW_NAME_EMPTY");

      // 发布 draft -> 204。
      const publish = await h.app.request(`${BASE}/defs/${def.id}/publish`, { method: "POST", headers });
      expect(publish.status).toBe(204);

      // 重复发布非 draft -> 域层 409 WORKFLOW_DEF_NOT_DRAFT。
      const republish = await h.app.request(`${BASE}/defs/${def.id}/publish`, { method: "POST", headers });
      expect(republish.status).toBe(409);
      expect((await json<{ code: string }>(republish)).code).toBe("WORKFLOW_DEF_NOT_DRAFT");

      // 触发已发布定义 -> 201 {id}，建一条 pending run（runtime 未启动，停留 pending）。
      const triggered = await h.app.request(`${BASE}/defs/${def.id}/trigger`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(triggered.status).toBe(201);
      const run = await json<{ id: string }>(triggered);
      expect(typeof run.id).toBe("string");

      // GET /runs：含刚建的 pending 运行。
      const runsRes = await h.app.request(`${BASE}/runs`, { method: "GET", headers });
      expect(runsRes.status).toBe(200);
      const runsPage = await json<{ items: Array<{ id: string; status: string }>; total: number }>(runsRes);
      expect(runsPage.total).toBe(1);
      expect(runsPage.items).toHaveLength(1);
      expect(runsPage.items[0].id).toBe(run.id);
      expect(runsPage.items[0].status).toBe("pending");

      // GET /runs/:id：{run, approvals}，最小图无审批节点故 approvals 为空数组。
      const detailRes = await h.app.request(`${BASE}/runs/${run.id}`, { method: "GET", headers });
      expect(detailRes.status).toBe(200);
      const detail = await json<{ run: { id: string; status: string }; approvals: unknown[] }>(detailRes);
      expect(detail.run.id).toBe(run.id);
      expect(detail.run.status).toBe("pending");
      expect(Array.isArray(detail.approvals)).toBe(true);
      expect(detail.approvals).toHaveLength(0);

      // 不存在的 run -> 域层 404 WORKFLOW_RUN_NOT_FOUND。
      const missing = await h.app.request(`${BASE}/runs/nope`, { method: "GET", headers });
      expect(missing.status).toBe(404);
      expect((await json<{ code: string }>(missing)).code).toBe("WORKFLOW_RUN_NOT_FOUND");
    }));
});

describe("E. 审批裁决路由白名单", () => {
  it("非法 decision 在查库前被路由挡 400；合法 decision 但审批单不存在 -> 域层 404", () =>
    withEnv("GX_WORKFLOW_ENGINE", "on", async () => {
      const headers = await jsonHeaders();

      const invalid = await h.app.request(`${BASE}/approvals/a1/decide`, {
        method: "POST",
        headers,
        body: JSON.stringify({ decision: "maybe" }),
      });
      expect(invalid.status).toBe(400);
      expect((await json<{ code: string }>(invalid)).code).toBe("WORKFLOW_APPROVAL_INVALID");

      const notFound = await h.app.request(`${BASE}/approvals/nope/decide`, {
        method: "POST",
        headers,
        body: JSON.stringify({ decision: "approved" }),
      });
      expect(notFound.status).toBe(404);
      expect((await json<{ code: string }>(notFound)).code).toBe("WORKFLOW_APPROVAL_NOT_FOUND");
    }));
});

describe("F. 结构独立于企业双 flag", () => {
  it("workflow 路由源文件不 import 企业 flag，只认 workflowEngineEnabled 总门", async () => {
    const src = await fs.promises.readFile(new URL("../index.ts", import.meta.url), "utf8");
    expect(src).not.toContain("enterpriseOrg");
    expect(src).not.toContain("enterpriseNav");
    expect(src).toContain("workflowEngineEnabled");
    expect(src).toContain("WORKFLOW_DISABLED");
  });
});
