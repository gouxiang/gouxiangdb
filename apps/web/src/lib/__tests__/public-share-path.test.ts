// apps/web/src/lib/__tests__/public-share-path.test.ts
// 公开分享路径判定 isPublicSharePathname：401 拦截器据此对匿名公开页豁免硬跳 /login。
// 纯字符串运算（node 环境即可），重点覆盖根部署与子路径部署两种 base。

import { describe, it, expect } from "vitest";
import { isPublicSharePathname } from "../base";

describe("isPublicSharePathname：根部署 base=\"\"", () => {
  it("命中公开分享三类路由", () => {
    expect(isPublicSharePathname("/s/tok", "")).toBe(true);
    expect(isPublicSharePathname("/s/tok/t/tbl1", "")).toBe(true);
    expect(isPublicSharePathname("/s/tok/doc/d1", "")).toBe(true);
  });

  it("/share/:token（登录后加入页）不算匿名公开", () => {
    expect(isPublicSharePathname("/share/tok", "")).toBe(false);
  });

  it("其它业务页 / 登录页不命中", () => {
    expect(isPublicSharePathname("/login", "")).toBe(false);
    expect(isPublicSharePathname("/bases/b1", "")).toBe(false);
    expect(isPublicSharePathname("/", "")).toBe(false);
  });

  it("段边界严格：/s 本身或 /something 不被前缀误伤", () => {
    expect(isPublicSharePathname("/s", "")).toBe(false);
    expect(isPublicSharePathname("/settings", "")).toBe(false);
  });
});

describe("isPublicSharePathname：子路径部署 base=/app/gouxiangdb", () => {
  it("剥掉部署前缀后仍命中公开页（含尾斜杠 base 形态）", () => {
    expect(isPublicSharePathname("/app/gouxiangdb/s/tok/t/t1", "/app/gouxiangdb")).toBe(true);
    expect(isPublicSharePathname("/app/gouxiangdb/s/tok", "/app/gouxiangdb/")).toBe(true);
  });

  it("子路径下登录页 / 加入页不命中", () => {
    expect(isPublicSharePathname("/app/gouxiangdb/login", "/app/gouxiangdb")).toBe(false);
    expect(isPublicSharePathname("/app/gouxiangdb/share/tok", "/app/gouxiangdb")).toBe(false);
  });
});
