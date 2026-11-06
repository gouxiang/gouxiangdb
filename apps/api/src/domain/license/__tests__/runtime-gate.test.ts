/**
 * runtime 门控：off 零副作用、verify/enforce 才装配。
 * 不跑真实网络/真库：off 分支在创建 store/transport 之前短路；非 off 的装配用注入困难，
 * 故这里只严格验证 off（最高频、最关键的"逐字节同今天"姿态）。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LicenseRuntime } from "../runtime.js";
import { parseLicenseConfig } from "../configLicense.js";

describe("LicenseRuntime 门控", () => {
  it("off（默认）：start 返回 false，无句柄、状态 not running、无当前址", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gx-rt-"));
    const rt = new LicenseRuntime(parseLicenseConfig({}, dir));
    const ok = await rt.start();
    expect(ok).toBe(false);
    expect(rt.handles()).toBeNull();
    const s = rt.status();
    expect(s.running).toBe(false);
    expect(s.mode).toBe("off");
    expect(s.baseUrl).toBeNull();
    rt.stop();
  });

  it("off：triggerSoon/stop 无副作用不抛", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gx-rt-"));
    const rt = new LicenseRuntime(parseLicenseConfig({ GX_LICENSE_MODE: "off" }, dir));
    await rt.start();
    expect(() => rt.triggerSoon()).not.toThrow();
    expect(() => rt.stop()).not.toThrow();
  });

  it("非法 mode 值回 off（fail-safe）", () => {
    const cfg = parseLicenseConfig({ GX_LICENSE_MODE: "ENFORCE" }, ".");
    expect(cfg.mode).toBe("off");
  });
});
