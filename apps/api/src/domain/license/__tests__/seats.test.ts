/**
 * seats 纯函数：软挂起触发面 + 新增账号闸预算。
 * 占席读取（listSeatUsers，查 Prisma）在 #1189 路由/中间件集成测试里用真库验证。
 */
import { describe, it, expect } from "vitest";
import { computeSuspension, canAddSeat, seatAddBlockReason } from "../seats.js";
import type { EntitlementView, SeatUser } from "../state.js";

function view(over: Partial<EntitlementView>): EntitlementView {
  return {
    mode: "enforce",
    verdict: "licensed",
    seats: 10,
    everCommercial: true,
    ...over,
  };
}

function users(n: number, adminAt: number[] = []): SeatUser[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `u${i + 1}`,
    createdAt: i + 1,
    role: adminAt.includes(i + 1) ? "admin" : "member",
  }));
}

describe("computeSuspension 触发面", () => {
  it("off/bypassed 永不挂人", () => {
    expect(computeSuspension(view({ mode: "off", verdict: "bypassed", seats: Infinity }), users(9)).suspended.size).toBe(0);
  });

  it("verify 档即便 expired/invalid 也只提示不挂人", () => {
    expect(computeSuspension(view({ mode: "verify", verdict: "expired", seats: 5 }), users(9)).suspended.size).toBe(0);
    expect(computeSuspension(view({ mode: "verify", verdict: "invalid", seats: 5 }), users(9)).suspended.size).toBe(0);
  });

  it("licensed / grace 全员可用不挂人", () => {
    expect(computeSuspension(view({ verdict: "licensed", seats: 3 }), users(10)).suspended.size).toBe(0);
    expect(computeSuspension(view({ verdict: "grace", seats: 3 }), users(10)).suspended.size).toBe(0);
  });

  it("free / grandfathered 不挂老号（只拦新增）", () => {
    expect(computeSuspension(view({ verdict: "free", seats: 5, everCommercial: false }), users(9)).suspended.size).toBe(0);
    expect(computeSuspension(view({ verdict: "grandfathered", seats: 5, everCommercial: false }), users(9)).suspended.size).toBe(0);
  });

  it("enforce + expired/invalid：回落 5，挂超额（管理员保底由 suspendList 向量保证）", () => {
    const s1 = computeSuspension(view({ verdict: "expired", seats: 5 }), users(7));
    expect(s1.suspended.size).toBe(2);
    expect(s1.verdict).toBe("expired");
    const s2 = computeSuspension(view({ verdict: "invalid", seats: 5 }), users(10));
    expect(s2.suspended.size).toBe(5);
  });
});

describe("canAddSeat 新增账号闸", () => {
  it("bypassed 无限", () => {
    expect(canAddSeat(view({ mode: "off", verdict: "bypassed", seats: Infinity }), 9999)).toBe(true);
  });

  it("free/grandfathered/expired/invalid 受 5 人约束", () => {
    for (const verdict of ["free", "grandfathered", "expired", "invalid"] as const) {
      const v = view({ verdict, seats: 5, everCommercial: verdict === "free" || verdict === "grandfathered" ? false : true });
      expect(canAddSeat(v, 4)).toBe(true);
      expect(canAddSeat(v, 5)).toBe(false);
    }
  });

  it("licensed/grace 受单据 seats 约束", () => {
    expect(canAddSeat(view({ verdict: "licensed", seats: 10 }), 9)).toBe(true);
    expect(canAddSeat(view({ verdict: "licensed", seats: 10 }), 10)).toBe(false);
    expect(canAddSeat(view({ verdict: "grace", seats: 10 }), 10)).toBe(false);
  });

  it("verify 档名额仍按 seats 计（canAddSeat 只是名额函数）", () => {
    expect(canAddSeat(view({ mode: "verify", verdict: "free", seats: 5, everCommercial: false }), 5)).toBe(false);
  });
});

describe("seatAddBlockReason 闸门①（仅 enforce 真拦，06）", () => {
  it("off/verify 永不拦新增（即便超额）", () => {
    expect(seatAddBlockReason(view({ mode: "off", verdict: "bypassed", seats: Infinity }), 9999)).toBeNull();
    expect(seatAddBlockReason(view({ mode: "verify", verdict: "free", seats: 5, everCommercial: false }), 5)).toBeNull();
    expect(seatAddBlockReason(view({ mode: "verify", verdict: "expired", seats: 5 }), 5)).toBeNull();
  });

  it("enforce + free 触顶 → FREE_FULL；未满放行", () => {
    const v = view({ verdict: "free", seats: 5, everCommercial: false });
    expect(seatAddBlockReason(v, 4)).toBeNull();
    expect(seatAddBlockReason(v, 5)).toBe("FREE_FULL");
  });

  it("enforce + grandfathered 触顶 → GRANDFATHERED", () => {
    const v = view({ verdict: "grandfathered", seats: 5, everCommercial: false });
    expect(seatAddBlockReason(v, 5)).toBe("GRANDFATHERED");
  });

  it("enforce + expired/invalid/grace/licensed 触顶 → COMMERCIAL_FULL", () => {
    expect(seatAddBlockReason(view({ verdict: "expired", seats: 5 }), 5)).toBe("COMMERCIAL_FULL");
    expect(seatAddBlockReason(view({ verdict: "invalid", seats: 5 }), 5)).toBe("COMMERCIAL_FULL");
    expect(seatAddBlockReason(view({ verdict: "grace", seats: 10 }), 10)).toBe("COMMERCIAL_FULL");
    expect(seatAddBlockReason(view({ verdict: "licensed", seats: 10 }), 10)).toBe("COMMERCIAL_FULL");
    expect(seatAddBlockReason(view({ verdict: "licensed", seats: 10 }), 9)).toBeNull();
  });
});
