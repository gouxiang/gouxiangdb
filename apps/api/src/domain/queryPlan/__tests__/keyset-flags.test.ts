// M1/S7：keyset 开关与 offset 窗口解析（默认保守，未知值回退）。
import { describe, it, expect, afterEach } from "vitest";
import {
  resolveKeysetMode,
  keysetPagingActive,
  resolveOffsetWindowPages,
  DEFAULT_OFFSET_WINDOW_PAGES,
  resolveSidecarReadMode,
  resolveSidecarWriteEnabled,
} from "../flags.js";

const KEYS = ["GX_M1_KEYSET", "GX_M1_SIDECAR_READ", "GX_M1_SIDECAR", "GX_M1_OFFSET_WINDOW"];

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe("resolveKeysetMode", () => {
  it("未设置/空/未知值 → off（默认保守）", () => {
    delete process.env.GX_M1_KEYSET;
    expect(resolveKeysetMode()).toBe("off");
    process.env.GX_M1_KEYSET = "";
    expect(resolveKeysetMode()).toBe("off");
    process.env.GX_M1_KEYSET = "ONN";
    expect(resolveKeysetMode()).toBe("off");
    process.env.GX_M1_KEYSET = "yes";
    expect(resolveKeysetMode()).toBe("off");
  });

  it("on/shadow 大小写宽容识别", () => {
    process.env.GX_M1_KEYSET = "ON";
    expect(resolveKeysetMode()).toBe("on");
    process.env.GX_M1_KEYSET = "Shadow";
    expect(resolveKeysetMode()).toBe("shadow");
  });
});

describe("keysetPagingActive（读×keyset 双闸门）", () => {
  it("默认全未设置 → false", () => {
    expect(keysetPagingActive()).toBe(false);
  });

  it("keyset=on 但 read 未 on → false（keyset 不得绕过读灰度）", () => {
    process.env.GX_M1_KEYSET = "on";
    expect(keysetPagingActive()).toBe(false);
    process.env.GX_M1_SIDECAR_READ = "shadow";
    expect(keysetPagingActive()).toBe(false);
  });

  it("read=on 但 keyset 非 on → false", () => {
    process.env.GX_M1_SIDECAR_READ = "on";
    process.env.GX_M1_KEYSET = "shadow";
    expect(keysetPagingActive()).toBe(false);
    process.env.GX_M1_KEYSET = "off";
    expect(keysetPagingActive()).toBe(false);
  });

  it("read=on + keyset=on + 写侧在维护 → true；写侧停（GX_M1_SIDECAR=off）→ false", () => {
    process.env.GX_M1_SIDECAR_READ = "on";
    process.env.GX_M1_KEYSET = "on";
    expect(keysetPagingActive()).toBe(true);
    process.env.GX_M1_SIDECAR = "off";
    expect(keysetPagingActive()).toBe(false);
    expect(resolveSidecarWriteEnabled()).toBe(false);
    expect(resolveSidecarReadMode()).toBe("on"); // read 标志本身仍解析为 on
  });
});

describe("resolveOffsetWindowPages", () => {
  it("默认 5 页", () => {
    expect(resolveOffsetWindowPages()).toBe(DEFAULT_OFFSET_WINDOW_PAGES);
    expect(DEFAULT_OFFSET_WINDOW_PAGES).toBe(5);
  });

  it("合法正整数覆盖；非法/0/负回退默认", () => {
    process.env.GX_M1_OFFSET_WINDOW = "3";
    expect(resolveOffsetWindowPages()).toBe(3);
    for (const v of ["0", "-1", "abc", "1.5", ""]) {
      process.env.GX_M1_OFFSET_WINDOW = v;
      expect(resolveOffsetWindowPages()).toBe(DEFAULT_OFFSET_WINDOW_PAGES);
    }
  });
});
