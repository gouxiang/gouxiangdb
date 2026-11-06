/**
 * 时钟防回拨 / 软指纹 / 配置门控纯函数测试。
 */
import { describe, it, expect } from "vitest";
import { effectiveNowSec, PersistedClock, MockClock } from "../clock.js";
import {
  computeFingerprint,
  newDeploymentId,
  simulateNewMachine,
  simulateFnosRebuild,
} from "../fingerprint.js";
import {
  parseLicenseMode,
  parseLicenseConfig,
  licenseNetworkActive,
  DEFAULT_LICENSE_URL,
} from "../configLicense.js";

describe("防回拨时钟", () => {
  it("effectiveNow = max(local, maxSeen)", () => {
    expect(effectiveNowSec(100, 200)).toBe(200);
    expect(effectiveNowSec(300, 200)).toBe(300);
  });

  it("本机时钟回拨不应续命（本机前进也抬高持久水位）", () => {
    let local = 1000;
    const persisted: number[] = [];
    const clock = new PersistedClock(() => local, 0, (s) => persisted.push(s));
    expect(clock.current()).toBe(1000);
    expect(persisted).toContain(1000); // 本机高水位已落盘
    local = 500; // 系统时钟被回拨
    expect(clock.current()).toBe(1000); // 不跟着倒退
  });

  it("服务端校时取更晚者并持久化", () => {
    let local = 1000;
    const persisted: number[] = [];
    const clock = new PersistedClock(() => local, 0, (s) => persisted.push(s));
    clock.observeServerTime(5000);
    expect(persisted).toEqual([5000]);
    local = 2000; // 即便本机时间晚于初始，仍不低于服务端观测值
    expect(clock.current()).toBe(5000);
    // 更早的 serverTime 不回退
    clock.observeServerTime(4000);
    expect(clock.maxSeen()).toBe(5000);
  });

  it("MockClock 快进/回拨/校时语义", () => {
    const c = new MockClock(1000);
    c.advance(100);
    expect(c.current()).toBe(1100);
    c.rollback(500);
    expect(c.rawNow()).toBe(600);
    expect(c.current()).toBe(1100); // 回拨被 maxSeen 顶住
    c.observeServerTime(5000);
    expect(c.current()).toBe(5000);
  });
});

describe("软指纹", () => {
  it("desktop basis 含卷 UUID，缺失用 no-vol", () => {
    const fp1 = computeFingerprint({ platform: "desktop", deploymentId: "d1", hostname: "h1", volumeUuid: "vol-1" });
    const fp2 = computeFingerprint({ platform: "desktop", deploymentId: "d1", hostname: "h1", volumeUuid: "vol-2" });
    expect(fp1).not.toBe(fp2);
    const fpNoVol = computeFingerprint({ platform: "desktop", deploymentId: "d1", hostname: "h1" });
    const fpNoVolExplicit = computeFingerprint({ platform: "desktop", deploymentId: "d1", hostname: "h1", volumeUuid: "no-vol" });
    expect(fpNoVol).toBe(fpNoVolExplicit);
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fnos/docker 不使用卷 UUID（basis 含 persist）", () => {
    const fnos = computeFingerprint({ platform: "fnos", deploymentId: "d", hostname: "h" });
    const docker = computeFingerprint({ platform: "docker", deploymentId: "d", hostname: "h" });
    expect(fnos).not.toBe(docker);
    // 传 volumeUuid 也被忽略，两次结果一致（fpk 重建安全）
    const a = computeFingerprint({ platform: "fnos", deploymentId: "d", hostname: "h", volumeUuid: "v1" });
    const b = computeFingerprint({ platform: "fnos", deploymentId: "d", hostname: "h", volumeUuid: "v2" });
    expect(a).toBe(b);
  });

  it("确定性：同身份同指纹；换机/重建语义", () => {
    const id = { platform: "fnos" as const, deploymentId: newDeploymentId(), hostname: "nas" };
    expect(computeFingerprint(id)).toBe(computeFingerprint(id));
    const nm = simulateNewMachine(id);
    expect(computeFingerprint(nm)).not.toBe(computeFingerprint(id));
    // fpk 重建：卷信息消失，但 deploymentId/hostname 保留 → 指纹不变
    const rebuilt = simulateFnosRebuild(id);
    expect(computeFingerprint(rebuilt)).toBe(computeFingerprint(id));
  });
});

describe("授权配置门控", () => {
  it("parseLicenseMode 严格小写，未知/大写/空回 off", () => {
    expect(parseLicenseMode(undefined)).toBe("off");
    expect(parseLicenseMode("")).toBe("off");
    expect(parseLicenseMode("  ")).toBe("off");
    expect(parseLicenseMode("ON")).toBe("off");
    expect(parseLicenseMode("verify")).toBe("verify");
    expect(parseLicenseMode(" enforce ")).toBe("enforce");
    expect(parseLicenseMode("ENFORCE")).toBe("off");
  });

  it("默认全 fail-safe：off + 内置地址 + 不起心跳", () => {
    const cfg = parseLicenseConfig({});
    expect(cfg.mode).toBe("off");
    expect(cfg.url).toBe(DEFAULT_LICENSE_URL);
    expect(licenseNetworkActive(cfg.mode)).toBe(false);
  });

  it("verify/enforce 起网络；非法数字回默认；平台覆盖严格匹配", () => {
    const cfg = parseLicenseConfig({
      GX_LICENSE_MODE: "verify",
      GX_LICENSE_URL: "  https://lic.example.com  ",
      GX_LICENSE_SEAT_TTL_MS: "1500",
      GX_PACKAGE_TYPE: "fnos",
    });
    expect(cfg.mode).toBe("verify");
    expect(cfg.url).toBe("https://lic.example.com");
    expect(cfg.seatTtlMs).toBe(1500);
    expect(cfg.platformOverride).toBe("fnos");
    expect(licenseNetworkActive(cfg.mode)).toBe(true);

    const bad = parseLicenseConfig({ GX_LICENSE_MODE: "enforce", GX_LICENSE_SEAT_TTL_MS: "-3", GX_LICENSE_PLATFORM: "mac" });
    expect(bad.seatTtlMs).toBe(30000);
    expect(bad.platformOverride).toBeNull();
    expect(licenseNetworkActive("enforce")).toBe(true);
  });
});
