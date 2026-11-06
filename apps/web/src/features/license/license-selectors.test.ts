// 授权闸门选择器纯函数穷举：七态 verdict × available × suspended。
import { describe, it, expect } from "vitest";
import type { LicenseStatusDTO } from "@gx/shared-types";
import {
  bannerCopy,
  deriveGate,
  formatExpiryDate,
  seatFull,
  seatPercent,
  suspendedCopy,
} from "./license-selectors";

function status(over: Partial<LicenseStatusDTO> = {}): LicenseStatusDTO {
  return {
    available: true,
    mode: "enforce",
    verdict: "licensed",
    verdictLabel: "商业版已授权",
    seats: 5,
    usedSeats: 1,
    isAdmin: false,
    adminEmail: null,
    orgName: null,
    licensedTo: null,
    expiresAt: null,
    version: 1,
    everCommercial: true,
    fingerprintShort: "abc",
    baseUrl: "https://license.example",
    online: true,
    lastHeartbeatAt: 1_760_000_000_000,
    lastAttemptAt: 1_760_000_000_000,
    syncing: false,
    deploymentId: null,
    platform: null,
    feedback: { unread: 0, open: 0 },
    ...over,
  };
}

describe("deriveGate", () => {
  it("off / available=false / view=null：不挂起、无横幅", () => {
    expect(deriveGate(null, null)).toEqual({ suspended: false, banner: null });
    expect(deriveGate(status({ available: false, verdict: "bypassed" }), null)).toEqual({
      suspended: false,
      banner: null,
    });
  });

  it("grace：琥珀横幅但不挂起", () => {
    const g = deriveGate(
      status({ verdict: "grace", verdictLabel: "商业版·宽限期" }),
      null,
    );
    expect(g.suspended).toBe(false);
    expect(g.banner?.tone).toBe("warning");
    expect(g.banner?.verdict).toBe("grace");
  });

  it("expired/invalid：警示横幅", () => {
    for (const v of ["expired", "invalid"] as const) {
      const g = deriveGate(status({ verdict: v, verdictLabel: v }), null);
      expect(g.suspended).toBe(false);
      expect(g.banner?.tone).toBe("danger");
      expect(g.banner?.verdict).toBe(v);
    }
  });

  it("expired 且被闸门 403 置了 suspended：全屏挂起、无横幅（不双层提示）", () => {
    const g = deriveGate(
      status({ verdict: "expired", verdictLabel: "商业版已到期" }),
      { verdict: "expired" },
    );
    expect(g.suspended).toBe(true);
    expect(g.banner).toBeNull();
  });

  it("licensed/free/grandfathered/bypassed：无任何提示", () => {
    for (const v of ["licensed", "free", "grandfathered", "bypassed"] as const) {
      expect(deriveGate(status({ verdict: v }), null)).toEqual({
        suspended: false,
        banner: null,
      });
    }
  });

  it("suspended 优先于一切（即使 view 是 licensed，也先信任业务请求的 403 事实）", () => {
    const g = deriveGate(status({ verdict: "licensed" }), { verdict: "expired" });
    expect(g.suspended).toBe(true);
  });
});

describe("bannerCopy", () => {
  it("grace 提示续费宽限", () => {
    const text = bannerCopy({ tone: "warning", verdict: "grace", verdictLabel: "商业版·宽限期" }, null);
    expect(text).toContain("宽限期");
  });
  it("expired 带联系邮箱", () => {
    const text = bannerCopy({ tone: "danger", verdict: "expired", verdictLabel: "商业版已到期" }, "a@b.com");
    expect(text).toContain("a@b.com");
  });
});

describe("suspendedCopy", () => {
  it("优先用后端文案，其次按 verdict 兜底", () => {
    expect(suspendedCopy("expired", "后端文案")).toBe("后端文案");
    expect(suspendedCopy("expired", null)).toContain("数据与账号");
    expect(suspendedCopy("invalid", null)).toContain("授权已停用");
  });
});

describe("席位派生", () => {
  it("seats=null（不限席位）返回 null / 不满", () => {
    expect(seatPercent(null, 99)).toBeNull();
    expect(seatFull(null, 99)).toBe(false);
  });
  it("百分比四舍五入并封顶 100", () => {
    expect(seatPercent(5, 2)).toBe(40);
    expect(seatPercent(5, 8)).toBe(100);
    expect(seatFull(5, 5)).toBe(true);
    expect(seatFull(5, 4)).toBe(false);
  });
});

describe("formatExpiryDate", () => {
  it("epoch 秒本地化 YYYY-MM-DD；null/0/非法不渲染", () => {
    expect(formatExpiryDate(0)).toBeNull();
    expect(formatExpiryDate(null)).toBeNull();
    const d = formatExpiryDate(1760000000);
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
