/**
 * 授权变更信号 changes：发布/订阅/退订/计数，以及监听者异常隔离。
 * 纯进程内、无 IO。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  emitLicenseChanged,
  onLicenseChanged,
  __resetLicenseChangeSignal,
  __licenseChangeSeq,
} from "../changes.js";

describe("licenseChanges 信号", () => {
  beforeEach(() => {
    __resetLicenseChangeSignal();
  });

  it("订阅者在每次 emit 时被调用，退订后不再收到", () => {
    const a: number[] = [];
    const off = onLicenseChanged(() => a.push(__licenseChangeSeq()));
    emitLicenseChanged();
    emitLicenseChanged();
    off();
    emitLicenseChanged();
    expect(a).toEqual([1, 2]);
  });

  it("多个订阅者都收到；同一函数重复订阅被去重", () => {
    let n = 0;
    const fn = () => {
      n += 1;
    };
    const off1 = onLicenseChanged(fn);
    const off2 = onLicenseChanged(fn);
    emitLicenseChanged();
    expect(n).toBe(1);
    off1();
    off2();
    emitLicenseChanged();
    expect(n).toBe(1);
  });

  it("某个监听者抛错不影响其余监听者与发信号主路径", () => {
    const ok: number[] = [];
    onLicenseChanged(() => {
      throw new Error("boom");
    });
    onLicenseChanged(() => ok.push(__licenseChangeSeq()));
    expect(() => emitLicenseChanged()).not.toThrow();
    expect(ok).toEqual([1]);
  });

  it("与 gate 模块解耦：changes 不 import 任何 middleware", async () => {
    // 静态保证：依赖方向只能是 middleware -> domain，反向 import 会让 runtime/gate 成环。
    const src = (await import("node:fs")).readFileSync(
      new URL("../changes.ts", import.meta.url),
      "utf-8",
    );
    expect(src).not.toMatch(/^\s*import\s[^\n]*middleware/m);
    expect(src).not.toMatch(/from\s["'][^"']*middleware[^"']*["']/);
  });
});
