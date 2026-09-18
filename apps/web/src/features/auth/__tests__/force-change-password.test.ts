// 首次登录强制改密——守卫判定与改密页校验的纯逻辑单测。
// 真机链路（登录 → 改密 → 进主界面）要后端 + 数据库，跑不了；这里锁的是能确定的部分：
// 守卫什么时候把人挡去 /change-password、什么时候放行。
import { describe, it, expect } from "vitest";
import type { UserDTO } from "@gx/shared-types";
import { shouldForceChangePassword, CHANGE_PASSWORD_PATH } from "../force-change-guard";
import { validateNewPassword } from "../ForceChangePassword";

function user(mustChangePassword?: boolean): UserDTO {
  return {
    id: "u_1",
    email: "admin@example.com",
    displayName: "初始管理员",
    username: null,
    phone: null,
    avatarUrl: null,
    bio: null,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: null,
    mustChangePassword,
  } as UserDTO;
}

describe("shouldForceChangePassword（改密守卫）", () => {
  it("标记 true 且在业务路由 → 重定向", () => {
    expect(shouldForceChangePassword(user(true), "/")).toBe(true);
    expect(shouldForceChangePassword(user(true), "/base/b_1")).toBe(true);
    expect(shouldForceChangePassword(user(true), "/kb")).toBe(true);
  });

  it("改密页路径常量（与 App.tsx 里新增的路由一致）", () => {
    expect(CHANGE_PASSWORD_PATH).toBe("/change-password");
  });

  it("标记 true 但已在改密页 → 放行（否则自跳死循环）", () => {
    expect(shouldForceChangePassword(user(true), "/change-password")).toBe(false);
  });

  it("标记 false / 未标记 / 未登录 → 放行", () => {
    expect(shouldForceChangePassword(user(false), "/")).toBe(false);
    expect(shouldForceChangePassword(user(undefined), "/")).toBe(false);
    expect(shouldForceChangePassword(null, "/")).toBe(false);
  });
});

describe("validateNewPassword（改密页本地校验）", () => {
  it("正常输入通过", () => {
    expect(validateNewPassword("初始密码", "newpass123", "newpass123")).toBeNull();
  });

  it("必填项缺失", () => {
    expect(validateNewPassword("", "newpass123", "newpass123")).toBe("请输入当前密码");
    expect(validateNewPassword("初始密码", "", "")).toBe("请输入新密码");
  });

  it("长度边界与后端 zod 的 8~72 对齐", () => {
    expect(validateNewPassword("初始密码", "1234567", "1234567")).toBe("新密码至少 8 位");
    expect(validateNewPassword("初始密码", "x".repeat(73), "x".repeat(73))).toBe(
      "新密码不超过 72 位",
    );
    expect(validateNewPassword("初始密码", "12345678", "12345678")).toBeNull();
    expect(validateNewPassword("初始密码", "x".repeat(72), "x".repeat(72))).toBeNull();
  });

  it("两次新密码不一致", () => {
    expect(validateNewPassword("初始密码", "newpass123", "newpass124")).toBe(
      "两次输入的新密码不一致",
    );
  });
});
