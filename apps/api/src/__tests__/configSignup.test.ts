// 企业部署口径：公开注册开关 GX_ALLOW_PUBLIC_SIGNUP 解析（纯函数单测，不建库不发请求）。
//
// 语义铁律（fail-closed）：未设置 / 空值 / 无法识别的值一律关闭；
// 仅显式 on/true/1（大小写不敏感、忽略首尾空白）判开放。
// 为什么未知值也 fail-closed：把拼错的配错（如 "opne"）解读成「开放」会让任意访客自助注册
// 进企业工作区——企业平台的账号统一由管理员建立或邀请（invite_users / create_users），
// 自注册不是必需路径；误关闭的代价只是一条明确的 403 SIGNUP_CLOSED，运维一眼可定位。
// 空库首账号引导不受影响：auth.ts 只在 userCount>0 时才用本开关挡注册。

import { describe, expect, it } from "vitest";
import { publicSignupOpen } from "../configSignup.js";

describe("publicSignupOpen（fail-closed）", () => {
  it("未设置 / 空字符串一律关闭", () => {
    expect(publicSignupOpen({})).toBe(false);
    expect(publicSignupOpen({ GX_ALLOW_PUBLIC_SIGNUP: undefined })).toBe(false);
    expect(publicSignupOpen({ GX_ALLOW_PUBLIC_SIGNUP: "" })).toBe(false);
  });

  it("on / true / 1 判开放，且大小写与首尾空白不敏感", () => {
    for (const open of ["on", "ON", "On", " on ", "true", "TRUE", "1", " 1\t"]) {
      expect(publicSignupOpen({ GX_ALLOW_PUBLIC_SIGNUP: open }), open).toBe(true);
    }
  });

  it("其余值（off/false/0/yes/open/笔误词）一律关闭", () => {
    for (const closed of ["off", "OFF", " off ", "false", "FALSE", "0", " 0\t", "yes", "open", "opne", "onn", "2", " truex "]) {
      expect(publicSignupOpen({ GX_ALLOW_PUBLIC_SIGNUP: closed }), closed).toBe(false);
    }
  });
});
