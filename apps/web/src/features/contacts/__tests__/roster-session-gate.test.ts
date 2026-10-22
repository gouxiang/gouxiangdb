// apps/web/src/features/contacts/__tests__/roster-session-gate.test.ts
// 匿名公开分享页不得发起私有组织名册请求（P0：否则 401 → 全局拦截器硬跳 /login，
// 公开表的成员列把整页带崩）。
//
// 两层保障：
//   A) 纯判定 hasRosterSession：匿名（无本地 token、非已登录远端节点）→ false。
//   B) 源码守卫：useOrgMembers 的 useInfiniteQuery 必须带 enabled: hasSession，
//      确保门控真正接到了 TanStack Query（而非只算出来没用）。
// node 环境无 React 渲染器，行为级的「不发请求」由 enabled 语义 + 此守卫共同保证。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { hasRosterSession } from "../contacts-hooks";

describe("hasRosterSession：私有名册接口的会话门控", () => {
  it("匿名访客（无本地 token、非远端登录）→ false，名册查询应禁用", () => {
    expect(hasRosterSession(null, false)).toBe(false);
    expect(hasRosterSession("", false)).toBe(false);
  });

  it("本地已登录（gx-auth 有 token）→ true", () => {
    expect(hasRosterSession("jwt-abc", false)).toBe(true);
  });

  it("桌面壳已登录远端节点（无本地 token）→ true", () => {
    expect(hasRosterSession(null, true)).toBe(true);
  });
});

describe("源码守卫：useOrgMembers 匿名禁用接线", () => {
  const src = readFileSync(new URL("../contacts-hooks.ts", import.meta.url), "utf8");

  it("读取本地 token 与远端会话并合成 hasSession", () => {
    expect(src).toContain("useAuthStore((s) => s.token)");
    expect(src).toContain("useRemoteSessionActive()");
    expect(src).toContain("hasRosterSession(localToken, remoteActive)");
  });

  it("useInfiniteQuery 带 enabled: hasSession（匿名不发 /api/v1/org/members）", () => {
    expect(src).toMatch(/enabled:\s*hasSession/);
  });
});
