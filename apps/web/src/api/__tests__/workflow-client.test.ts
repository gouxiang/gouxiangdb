// 工作流引擎前端契约层 client 段测试（#1309 刀 C1，纯 node 环境，vi.stubGlobal fetch，无 jsdom、无新依赖）。
//
// 锁五件事：
//   ① WorkflowApi 六个 apiFetch 方法的 URL/方法/请求体/query 与后端 8 端点逐字对齐，
//      鉴权统一 X-GX-Token（断言不带 Authorization——飞牛网关吞 Bearer）；
//   ② 两个 204 无体端点（publishDef/decideApproval）手写 fetch：res.ok 时绝不读体，
//      !ok 才读错误信封并抛 ApiError（apiFetch 的成功分支无条件 res.json() 会对空体 SyntaxError）；
//   ③ 非 2xx 一律 reject ApiError（status/body.code 可读）；
//   ④ 探针 probeWorkflowEngine 的双条件判定：仅 404 + WORKFLOW_DISABLED 收 false，
//      业务 404/5xx 一律 rethrow、绝不静默假装引擎关闭；模块级缓存随节点切换失效；
//   ⑤ isWorkflowNotEnabledError 守卫的真假分支。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  WorkflowApi,
  ApiError,
  probeWorkflowEngine,
  isWorkflowNotEnabledError,
} from "../client";
import { useAuthStore } from "../../store/auth";
import { dataSourceResolver } from "../../node/datasource";
import type { ActiveDataSource } from "../../node/datasource";

const REMOTE: ActiveDataSource = {
  nodeId: "abcdef012345",
  kind: "remote",
  baseURL: "http://remote.example:3001",
  token: "remote-jwt",
  wsOrigin: "ws://remote.example:3001",
};

const PREFIX = "/api/v1/workflow";

function jsonResponse(body: unknown, init?: { status?: number }) {
  return new Response(JSON.stringify(body), { status: init?.status ?? 200 });
}

/** 手写 fetch 的非 ok 分支要读 res.json() 与 res.headers.get()，用 plain object 精确模拟。 */
function errorResponse(status: number, code: string, error = "bad") {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ error, code }),
    headers: { get: () => null },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  // 恒 local 起点；node 无 localStorage，persist 落内存，直接写内存态。
  dataSourceResolver.setActive(null);
  useAuthStore.setState({ token: "tok-123", user: null });
});

afterEach(() => {
  dataSourceResolver.setActive(null);
  vi.unstubAllGlobals();
});

// ───────────────────────── 六个 apiFetch 方法 ─────────────────────────

describe("WorkflowApi 写/读方法（经 apiFetch，X-GX-Token 鉴权）", () => {
  it("createDef：POST /defs，body 为 JSON 串，带写超时 signal，返回 {id}", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "def-1" }));
    const input = { name: "  新流程  ", graph: '{"nodes":[],"edges":[]}', triggerType: "manual" as const };

    const out = await WorkflowApi.createDef(input);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${PREFIX}/defs`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(input);
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["X-GX-Token"]).toBe("tok-123");
    expect(init.headers["Authorization"]).toBeUndefined();
    // WRITE_TIMEOUT_MS 接线：apiFetch 为此请求挂了 AbortController。
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(out).toEqual({ id: "def-1" });
  });

  it("listDefs 无参：GET /defs 不带 query，GET 不显式传 method", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], total: 0 }));
    await WorkflowApi.listDefs();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${PREFIX}/defs`);
    expect(init.method).toBeUndefined();
    expect(init.headers["X-GX-Token"]).toBe("tok-123");
  });

  it("listDefs 带参：page/limit 进 query", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], total: 0 }));
    await WorkflowApi.listDefs({ page: 2, limit: 20 });
    expect(fetchMock.mock.calls[0]![0]).toBe(`${PREFIX}/defs?page=2&limit=20`);
  });

  it("getDef：GET /defs/:id，id 经 encodeURIComponent（空格转 %20）", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "def 1" }));
    await WorkflowApi.getDef("def 1");
    expect(fetchMock.mock.calls[0]![0]).toBe(`${PREFIX}/defs/def%201`);
  });

  it("triggerDef 默认空体：POST /defs/:id/trigger，body 字面量 {}", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "run-1" }));
    await WorkflowApi.triggerDef("def-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${PREFIX}/defs/def-1/trigger`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("triggerDef 带体：entityType/entityId/input 原样透传", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "run-2" }));
    const body = { entityType: "table", entityId: "rec-9", input: { q: 1 } };
    await WorkflowApi.triggerDef("def-1", body);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual(body);
  });

  it("listRuns 全参：defId/page/limit 按序进 query", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], total: 0 }));
    await WorkflowApi.listRuns({ defId: "d-9", page: 2, limit: 20 });
    expect(fetchMock.mock.calls[0]![0]).toBe(`${PREFIX}/runs?defId=d-9&page=2&limit=20`);
  });

  it("listRuns：空串 defId 被 qs 跳过（等价后端 trim 归一 undefined）", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], total: 0 }));
    await WorkflowApi.listRuns({ defId: "", page: 1 });
    expect(fetchMock.mock.calls[0]![0]).toBe(`${PREFIX}/runs?page=1`);
  });

  it("getRun：GET /runs/:id，返回 {run,approvals} 由调用方消费", async () => {
    const detail = { run: { id: "run-1" }, approvals: [] };
    fetchMock.mockResolvedValue(jsonResponse(detail));
    const out = await WorkflowApi.getRun("run-1");
    expect(fetchMock.mock.calls[0]![0]).toBe(`${PREFIX}/runs/run-1`);
    expect(out).toEqual(detail);
  });

  it("非 2xx：reject ApiError，status/body.code 可读", async () => {
    fetchMock.mockResolvedValue(errorResponse(400, "WORKFLOW_GRAPH_INVALID"));
    await expect(WorkflowApi.createDef({ name: "x", graph: "{bad" })).rejects.toMatchObject({
      status: 400,
      body: { code: "WORKFLOW_GRAPH_INVALID" },
    });
  });
});

// ───────────────────────── 两个 204 手写 fetch ─────────────────────────

describe("publishDef / decideApproval（204 无体，手写 fetch）", () => {
  it("publishDef 成功 204：POST 正确 URL，ok 时绝不读体，resolve undefined", async () => {
    const jsonSpy = vi.fn();
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: jsonSpy });

    await expect(WorkflowApi.publishDef("def-1")).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${PREFIX}/defs/def-1/publish`);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["X-GX-Token"]).toBe("tok-123");
    expect(init.headers["Authorization"]).toBeUndefined();
    expect(jsonSpy).not.toHaveBeenCalled(); // 204 空体一读 json 就 SyntaxError
  });

  it("publishDef 非 draft → 409 WORKFLOW_DEF_NOT_DRAFT：读错误信封并抛 ApiError", async () => {
    fetchMock.mockResolvedValue(errorResponse(409, "WORKFLOW_DEF_NOT_DRAFT"));
    await expect(WorkflowApi.publishDef("def-1")).rejects.toMatchObject({
      status: 409,
      body: { code: "WORKFLOW_DEF_NOT_DRAFT" },
    });
  });

  it("decideApproval 成功 204：POST approvals/:id/decide，body 含 decision/comment，ok 不读体", async () => {
    const jsonSpy = vi.fn();
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: jsonSpy });

    await expect(
      WorkflowApi.decideApproval("ap-1", { decision: "approved", comment: "同意" }),
    ).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${PREFIX}/approvals/ap-1/decide`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ decision: "approved", comment: "同意" });
    expect(init.headers["X-GX-Token"]).toBe("tok-123");
    expect(init.headers["Authorization"]).toBeUndefined();
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it("decideApproval 非法 decision → 400 WORKFLOW_APPROVAL_INVALID：抛 ApiError", async () => {
    fetchMock.mockResolvedValue(errorResponse(400, "WORKFLOW_APPROVAL_INVALID"));
    await expect(
      WorkflowApi.decideApproval("ap-1", { decision: "approved" }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

// 401 全局收口：handleUnauthorized 有 3s 模块级去重，fake timers 在用例后推进复位，
// 避免相邻用例互相吞掉（同 client-datasource.test.ts S2-7 范式）。
describe("204 端点 401 走全局登出收口", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.advanceTimersByTime(3_100);
    vi.useRealTimers();
  });

  it("decideApproval 401：仍抛 ApiError 且 local 登录态被清（token 置 null）", async () => {
    fetchMock.mockResolvedValue(errorResponse(401, "UNAUTHORIZED"));
    await expect(
      WorkflowApi.decideApproval("ap-1", { decision: "rejected" }),
    ).rejects.toMatchObject({ status: 401 });
    expect(useAuthStore.getState().token).toBeNull();
  });
});

// ───────────────────────── 探针与守卫 ─────────────────────────

describe("isWorkflowNotEnabledError 双条件守卫", () => {
  it("404 + WORKFLOW_DISABLED 才为 true", () => {
    expect(isWorkflowNotEnabledError(new ApiError(404, { code: "WORKFLOW_DISABLED" }))).toBe(true);
  });
  it("业务 404（定义不存在）不为 true", () => {
    expect(isWorkflowNotEnabledError(new ApiError(404, { code: "WORKFLOW_DEF_NOT_FOUND" }))).toBe(false);
  });
  it("5xx / 无 code / 非 ApiError 均为 false", () => {
    expect(isWorkflowNotEnabledError(new ApiError(500, { code: "INTERNAL" }))).toBe(false);
    expect(isWorkflowNotEnabledError(new ApiError(404, {}))).toBe(false);
    expect(isWorkflowNotEnabledError(new Error("network"))).toBe(false);
    expect(isWorkflowNotEnabledError(null)).toBe(false);
  });
});

describe("probeWorkflowEngine 探针", () => {
  // workflowFlagCache 是 client.ts 模块级缓存；同节点连续用例 nodeId 不变不会自动重置。
  // 每条用例先抖动到 remote 再回 local，制造两次 nodeId 变化，确定性把缓存清回 null。
  beforeEach(() => {
    dataSourceResolver.__setActiveForTest(REMOTE);
    dataSourceResolver.setActive(null);
  });

  it("200 → true，且同节点第二次命中缓存不再发请求", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ items: [], total: 0 })));
    await expect(probeWorkflowEngine()).resolves.toBe(true);
    await expect(probeWorkflowEngine()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe(`${PREFIX}/defs`);
  });

  it("404 WORKFLOW_DISABLED（总门 off）→ false", async () => {
    fetchMock.mockResolvedValue(errorResponse(404, "WORKFLOW_DISABLED"));
    await expect(probeWorkflowEngine()).resolves.toBe(false);
  });

  it("业务 404（WORKFLOW_DEF_NOT_FOUND）rethrow，且不缓存 false——下一次仍重新发请求", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(404, "WORKFLOW_DEF_NOT_FOUND"));
    await expect(probeWorkflowEngine()).rejects.toMatchObject({
      status: 404,
      body: { code: "WORKFLOW_DEF_NOT_FOUND" },
    });
    // 缓存未被污染：改回 200 后应再次发请求并得到 true。
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [], total: 0 }));
    await expect(probeWorkflowEngine()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("500 rethrow，绝不静默回退成引擎关闭", async () => {
    fetchMock.mockResolvedValue(errorResponse(500, "INTERNAL"));
    await expect(probeWorkflowEngine()).rejects.toBeInstanceOf(ApiError);
  });

  it("切到远端节点后模块缓存失效，重新探活且打到远端绝对地址", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ items: [], total: 0 })));
    await probeWorkflowEngine(); // local 首探
    dataSourceResolver.__setActiveForTest(REMOTE);
    await probeWorkflowEngine(); // 节点变化 → 重探
    const remoteCalls = fetchMock.mock.calls.filter(
      (c) => c[0] === "http://remote.example:3001/api/v1/workflow/defs",
    ).length;
    expect(remoteCalls).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
