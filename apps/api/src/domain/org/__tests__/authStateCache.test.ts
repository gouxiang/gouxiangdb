// M2/S2 authStateCache 纯单元测试：仅 TTL>0 使用；TTL 惰性过期、invalidate、LRU 上限 5000。

import { describe, expect, it } from "vitest";
import { createAuthStateCache, type AuthStateRow } from "../authStateCache.js";

function row(userId: string, patch: Partial<AuthStateRow> = {}): AuthStateRow {
  return { userId, status: "ACTIVE", tokenVersion: 0, workspaceId: "ws_default", ...patch };
}

describe("createAuthStateCache", () => {
  it("未写入 -> null", () => {
    const c = createAuthStateCache();
    expect(c.get("u1")).toBeNull();
    expect(c.size).toBe(0);
  });

  it("TTL 内命中返回状态行副本；过期 -> null", async () => {
    const c = createAuthStateCache();
    c.set(row("u1", { tokenVersion: 2 }), 10_000);
    const got = c.get("u1");
    expect(got?.tokenVersion).toBe(2);
    expect(got).not.toBeNull();
    // 返回副本：改返回值不污染缓存
    (got as AuthStateRow).status = "DISABLED";
    expect(c.get("u1")?.status).toBe("ACTIVE");

    c.set(row("u2"), 20);
    await new Promise((r) => setTimeout(r, 40));
    expect(c.get("u2")).toBeNull();
  });

  it("ttlMs<=0 的 set 被忽略（零缓存旁路保证由调用方 + 此处双重保证）", () => {
    const c = createAuthStateCache();
    c.set(row("u1"), 0);
    expect(c.size).toBe(0);
    expect(c.get("u1")).toBeNull();
  });

  it("invalidate 立即移除；clear 清空", () => {
    const c = createAuthStateCache();
    c.set(row("u1"), 60_000);
    c.set(row("u2"), 60_000);
    c.invalidate("u1");
    expect(c.get("u1")).toBeNull();
    expect(c.get("u2")).not.toBeNull();
    c.clear();
    expect(c.size).toBe(0);
  });

  it("容量上限 5000：超出淘汰最旧未访问项", () => {
    const c = createAuthStateCache();
    for (let i = 0; i < 5005; i++) c.set(row(`u${i}`), 60_000);
    expect(c.size).toBe(5000);
    // u0..u4 为最旧五项，应已被淘汰；u5004 仍在。
    expect(c.get("u0")).toBeNull();
    expect(c.get("u4")).toBeNull();
    expect(c.get("u5004")).not.toBeNull();
  });

  it("get 命中提升为最近使用，LRU 不淘汰热键", () => {
    const c = createAuthStateCache();
    for (let i = 0; i < 5000; i++) c.set(row(`u${i}`), 60_000);
    c.get("u0"); // 触热 u0
    c.set(row("u5000"), 60_000); // 超 1 -> 淘汰当前最旧（u1，而非 u0）
    expect(c.get("u0")).not.toBeNull();
    expect(c.get("u1")).toBeNull();
  });
});
