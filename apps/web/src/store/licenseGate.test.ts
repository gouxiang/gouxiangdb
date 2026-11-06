// 授权闸门 store 收口单测：apiFetch !res.ok 旁路按 body.code 分流。
import { describe, it, expect, beforeEach } from "vitest";
import {
  LICENSE_SEAT_LIMIT_CODE,
  LICENSE_SEAT_SUSPENDED_CODE,
} from "@gx/shared-types";
import {
  __resetLicenseGateForTests,
  notifyLicenseError,
  useLicenseGateStore,
} from "./licenseGate";

beforeEach(() => {
  __resetLicenseGateForTests();
});

describe("notifyLicenseError", () => {
  it("LICENSE_SEAT_SUSPENDED → 置挂起态（verdict/contactEmail/message）", () => {
    notifyLicenseError({
      error: "商业许可已到期，当前账号暂被挂起…",
      code: LICENSE_SEAT_SUSPENDED_CODE,
      verdict: "expired",
      contactEmail: "admin@x.com",
    });
    const s = useLicenseGateStore.getState();
    expect(s.suspended?.verdict).toBe("expired");
    expect(s.suspended?.contactEmail).toBe("admin@x.com");
    expect(s.suspended?.message).toContain("挂起");
    expect(s.seatLimit).toBeNull();
  });

  it("verdict=invalid 原样保留；contactEmail 空串归 null", () => {
    notifyLicenseError({ code: LICENSE_SEAT_SUSPENDED_CODE, verdict: "invalid", contactEmail: "" });
    expect(useLicenseGateStore.getState().suspended?.verdict).toBe("invalid");
    expect(useLicenseGateStore.getState().suspended?.contactEmail).toBeNull();
  });

  it("LICENSE_SEAT_LIMIT → 置满员文案", () => {
    notifyLicenseError({ error: "免费版最多 5 人…", code: LICENSE_SEAT_LIMIT_CODE });
    const s = useLicenseGateStore.getState();
    expect(s.seatLimit).toContain("5 人");
    expect(s.suspended).toBeNull();
  });

  it("其它错误体（401/404/普通 403/空体/非对象）一律忽略", () => {
    notifyLicenseError({ code: "FORBIDDEN", error: "x" });
    notifyLicenseError(null);
    notifyLicenseError(undefined);
    notifyLicenseError("boom");
    notifyLicenseError({});
    const s = useLicenseGateStore.getState();
    expect(s.suspended).toBeNull();
    expect(s.seatLimit).toBeNull();
  });

  it("clear 动作复位", () => {
    notifyLicenseError({ code: LICENSE_SEAT_LIMIT_CODE, error: "满" });
    useLicenseGateStore.getState().clearSeatLimit();
    expect(useLicenseGateStore.getState().seatLimit).toBeNull();

    notifyLicenseError({ code: LICENSE_SEAT_SUSPENDED_CODE, verdict: "expired" });
    useLicenseGateStore.getState().clearSuspended();
    expect(useLicenseGateStore.getState().suspended).toBeNull();
  });
});
