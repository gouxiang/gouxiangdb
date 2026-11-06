/**
 * 闸门②（licenseSeatGate）headless 单测：
 *  - 不连真库、不起运行时：mock resolveActiveAuth / getLicenseHandles / listSeatUsers；
 *  - computeSuspension 用【真实实现】，确保挂起名单口径（仅 enforce + expired/invalid）被测到；
 *  - 覆盖：off/handles 缺失零拦截、各 verdict 的放行面、挂起命中 403、白名单路径、未认证放行。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { EntitlementView, SeatUser } from "../../domain/license/state.js";

// ---- 固定模块 mock（hoisted）----
const mocks = vi.hoisted(() => ({
  authUserId: null as string | null,
  handles: null as null | { client: { getView: () => Promise<EntitlementView> }; store: { getContact: () => Promise<{ adminEmail: string }> } },
  seatUsers: [] as SeatUser[],
}));

vi.mock("../../domain/org/authState.js", () => ({
  resolveActiveAuth: vi.fn(async () => (mocks.authUserId ? { userId: mocks.authUserId } : null)),
}));

vi.mock("../../domain/license/runtime.js", () => ({
  getLicenseHandles: vi.fn(() => mocks.handles),
}));

vi.mock("../../domain/license/seats.js", async () => {
  const actual = await vi.importActual<typeof import("../../domain/license/seats.js")>("../../domain/license/seats.js");
  return {
    ...actual,
    // 名单算法用真的；只把"读库"换成内存桩。
    listSeatUsers: vi.fn(async () => ({ users: mocks.seatUsers, occupied: mocks.seatUsers.length })),
  };
});

// effectivePath 依赖 config.js（会读 env，测试环境安全），用真实模块；c.req.path 直给逻辑路径。
import { licenseSeatGateMiddleware, invalidateLicenseGateCache, LICENSE_SEAT_SUSPENDED } from "../licenseSeatGate.js";
import { emitLicenseChanged } from "../../domain/license/changes.js";

function makeCtx(path: string, method = "GET") {
  let body: unknown = null;
  let status = 200;
  const c = {
    req: { path, method, header: () => undefined },
    json: (b: unknown, s?: number) => {
      body = b;
      if (s) status = s;
      return new Response("done", { status: s ?? 200 });
    },
    getBody: () => body,
    getStatus: () => status,
  };
  return c;
}

function view(partial: Partial<EntitlementView>): EntitlementView {
  return {
    mode: "enforce",
    verdict: "free",
    seats: 5,
    everCommercial: false,
    ...partial,
  };
}

// 7 个占席用户，u0 最早。商业单 seats=5 -> 挂起时 keep 前 5（u0..u4），suspend u5,u6。
const USERS: SeatUser[] = Array.from({ length: 7 }, (_, i) => ({
  id: `u${i}`,
  createdAt: 1000 + i,
  role: "member",
}));

function handlesFor(v: EntitlementView, adminEmail = "admin@corp.cn") {
  mocks.handles = {
    client: { getView: async () => v },
    store: { getContact: async () => ({ adminEmail }) },
  };
}

beforeEach(() => {
  mocks.authUserId = null;
  mocks.handles = null;
  mocks.seatUsers = [];
  invalidateLicenseGateCache();
});

describe("licenseSeatGate 闸门②", () => {
  it("未认证（无 token）一律放行，不泄漏挂起事实", async () => {
    handlesFor(view({ verdict: "expired", seats: 5, everCommercial: true }));
    mocks.seatUsers = USERS;
    mocks.authUserId = null;
    let nexted = false;
    await licenseSeatGateMiddleware(makeCtx("/api/bases") as never, (async () => { nexted = true; }) as never);
    expect(nexted).toBe(true);
  });

  it("handles 缺失（off/未 boot）：零查询直接放行", async () => {
    mocks.authUserId = "u5";
    mocks.handles = null;
    let nexted = false;
    await licenseSeatGateMiddleware(makeCtx("/api/bases") as never, (async () => { nexted = true; }) as never);
    expect(nexted).toBe(true);
  });

  it("free / grandfathered / licensed / grace 不挂老号，全员放行", async () => {
    mocks.authUserId = "u6";
    mocks.seatUsers = USERS;
    for (const verdict of ["free", "grandfathered", "licensed", "grace"] as const) {
      invalidateLicenseGateCache();
      handlesFor(view({ verdict, seats: verdict === "licensed" || verdict === "grace" ? 10 : 5, everCommercial: verdict !== "free" && verdict !== "grandfathered" }));
      let nexted = false;
      await licenseSeatGateMiddleware(makeCtx("/api/records") as never, (async () => { nexted = true; }) as never);
      expect(nexted, `verdict=${verdict} 应放行`).toBe(true);
    }
  });

  it("verify 档即使 verdict=expired 也不挂人（verify 只通电）", async () => {
    mocks.authUserId = "u6";
    mocks.seatUsers = USERS;
    handlesFor(view({ mode: "verify", verdict: "expired", seats: 5, everCommercial: true }));
    let nexted = false;
    await licenseSeatGateMiddleware(makeCtx("/api/records") as never, (async () => { nexted = true; }) as never);
    expect(nexted).toBe(true);
  });

  it("enforce + expired：名单内（u6）被 403 LICENSE_SEAT_SUSPENDED 并带管理员邮箱", async () => {
    mocks.authUserId = "u6";
    mocks.seatUsers = USERS;
    handlesFor(view({ verdict: "expired", seats: 5, everCommercial: true }), "boss@corp.cn");
    const ctx = makeCtx("/api/records");
    let nexted = false;
    await licenseSeatGateMiddleware(ctx as never, (async () => { nexted = true; }) as never);
    expect(nexted).toBe(false);
    expect(ctx.getStatus()).toBe(403);
    const b = ctx.getBody() as { code: string; contactEmail: string; verdict: string };
    expect(b.code).toBe(LICENSE_SEAT_SUSPENDED);
    expect(b.contactEmail).toBe("boss@corp.cn");
    expect(b.verdict).toBe("expired");
  });

  it("enforce + invalid：名单内 u5 被拦；keep 内 u4 放行", async () => {
    mocks.seatUsers = USERS;
    handlesFor(view({ verdict: "invalid", seats: 5, everCommercial: true }));
    // u5 在 suspend 集
    mocks.authUserId = "u5";
    const ctx5 = makeCtx("/api/bases");
    await licenseSeatGateMiddleware(ctx5 as never, (async () => {}) as never);
    expect(ctx5.getStatus()).toBe(403);
    // u4 在 keep 集（前 5）放行
    invalidateLicenseGateCache();
    mocks.authUserId = "u4";
    let nexted = false;
    await licenseSeatGateMiddleware(makeCtx("/api/bases") as never, (async () => { nexted = true; }) as never);
    expect(nexted).toBe(true);
  });

  it("白名单：挂起用户访问 /api/license/status 与 /api/auth/me 放行", async () => {
    mocks.authUserId = "u6";
    mocks.seatUsers = USERS;
    handlesFor(view({ verdict: "invalid", seats: 5, everCommercial: true }));
    for (const p of ["/api/license/status", "/api/license/feedback", "/api/auth/me", "/api/auth/me/change-password"]) {
      invalidateLicenseGateCache();
      let nexted = false;
      await licenseSeatGateMiddleware(makeCtx(p) as never, (async () => { nexted = true; }) as never);
      expect(nexted, `${p} 应在白名单`).toBe(true);
    }
  });

  it("非 /api 路径不参与闸门", async () => {
    mocks.authUserId = "u6";
    mocks.seatUsers = USERS;
    handlesFor(view({ verdict: "expired", seats: 5, everCommercial: true }));
    let nexted = false;
    await licenseSeatGateMiddleware(makeCtx("/healthz") as never, (async () => { nexted = true; }) as never);
    expect(nexted).toBe(true);
  });

  it("后台心跳变更信号：缓存内 u6 原被挂，emit 后下一请求即时重算放行（不等 10s TTL）", async () => {
    mocks.authUserId = "u6";
    mocks.seatUsers = USERS;
    // 先打一次：enforce+expired，u6 被挂，门缓存记下 suspended 集。
    handlesFor(view({ verdict: "expired", seats: 5, everCommercial: true }));
    const ctx1 = makeCtx("/api/records");
    await licenseSeatGateMiddleware(ctx1 as never, (async () => {}) as never);
    expect(ctx1.getStatus()).toBe(403);

    // 续费信封经后台心跳到达（不改 handles 引用，仅其 getView 返回新值），发布变更信号。
    handlesFor(view({ verdict: "licensed", seats: 10, everCommercial: true }));
    emitLicenseChanged();

    // 同一被挂用户下一请求必须立即放行——证明门缓存被信号即时作废，而非命中旧 suspended 集。
    let nexted = false;
    await licenseSeatGateMiddleware(makeCtx("/api/records") as never, (async () => { nexted = true; }) as never);
    expect(nexted).toBe(true);
  });

  it("吊销方向：licensed 缓存后信号到达，invalid 下一请求即时收敛为 403（无 fail-open 尾巴）", async () => {
    mocks.authUserId = "u6";
    mocks.seatUsers = USERS;
    // licensed：全员放行，门缓存记下空 suspended 集。
    handlesFor(view({ verdict: "licensed", seats: 10, everCommercial: true }));
    let nexted1 = false;
    await licenseSeatGateMiddleware(makeCtx("/api/records") as never, (async () => { nexted1 = true; }) as never);
    expect(nexted1).toBe(true);

    // 吊销信封经后台心跳到达：invalid+seats5，u6 应被挂。发信号后必须立即 403。
    handlesFor(view({ verdict: "invalid", seats: 5, everCommercial: true }));
    emitLicenseChanged();
    const ctx = makeCtx("/api/records");
    let nexted2 = false;
    await licenseSeatGateMiddleware(ctx as never, (async () => { nexted2 = true; }) as never);
    expect(nexted2).toBe(false);
    expect(ctx.getStatus()).toBe(403);
    expect((ctx.getBody() as { verdict: string }).verdict).toBe("invalid");
  });
});
