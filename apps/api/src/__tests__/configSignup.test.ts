// 0.1.7 公开注册开关 GX_ALLOW_PUBLIC_SIGNUP 解析（纯函数单测，不建库不发请求）。
//
// 语义铁律：未设置 = 开放（0.1.6 及更早行为零变更）；仅显式 off/false/0（大小写不敏感、
// 忽略首尾空白）判关闭；其余任何值一律开放（未知值不 fail-closed，避免一次笔误锁死注册）。

import { describe, expect, it } from "vitest";
import { publicSignupOpen } from "../configSignup.js";

describe("publicSignupOpen", () => {
  it("未设置 / 空字符串一律开放（完全向后兼容）", () => {
    expect(publicSignupOpen({})).toBe(true);
    expect(publicSignupOpen({ GX_ALLOW_PUBLIC_SIGNUP: undefined })).toBe(true);
    expect(publicSignupOpen({ GX_ALLOW_PUBLIC_SIGNUP: "" })).toBe(true);
  });

  it("off / false / 0 判关闭，且大小写与首尾空白不敏感", () => {
    for (const closed of ["off", "OFF", "Off", " off ", "false", "FALSE", "0", " 0\t"]) {
      expect(publicSignupOpen({ GX_ALLOW_PUBLIC_SIGNUP: closed }), closed).toBe(false);
    }
  });

  it("其余值（on/1/true/未知词）一律开放", () => {
    for (const open of ["on", "1", "true", "yes", "open", "OFFF", "offx"]) {
      expect(publicSignupOpen({ GX_ALLOW_PUBLIC_SIGNUP: open }), open).toBe(true);
    }
  });
});
