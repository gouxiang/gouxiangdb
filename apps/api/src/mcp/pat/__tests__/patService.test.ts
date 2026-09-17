// M6/S1 patService 集成测试（真迁移临时库）：创建/列表/吊销/本人限定/lastUsedAt 节流 +
// 停用联动（同事务吊销）/重新激活不恢复/删除用户级联清行/认证判定（假时钟）。
//
// 夹具复用 M4 engineHarness（真迁移 + globalThis.__gx_prisma 后动态 import db.js 消费者）。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupEngineHarness, createUsers, type EngineHarness } from "../../../domain/authz/__tests__/engineHarness.js";
import { evaluateTokenState, hashToken } from "../tokens.js";

let h: EngineHarness;
let svc: typeof import("../patService.js");
let lifecycle: typeof import("../../../domain/org/lifecycle.js");

const U1 = "u1", U2 = "u2", U3 = "u3";

async function ensureUsers(): Promise<void> {
  for (const id of [U1, U2, U3]) {
    await h.prisma.user.upsert({
      where: { id },
      update: { status: "ACTIVE", disabledAt: null, tokenVersion: 0 },
      create: { id, email: `${id}@x.com`, displayName: id, passwordHash: "x", status: "ACTIVE", workspaceId: "ws_default" },
    });
  }
}

describe("M6/S1 patService", () => {
  beforeAll(async () => {
    h = await setupEngineHarness("gx-m6-s1-pat-");
    await createUsers(h.prisma, [{ id: U1 }, { id: U2 }, { id: U3 }]);
    svc = await import("../patService.js");
    lifecycle = await import("../../../domain/org/lifecycle.js");
  }, 120000);

  afterAll(async () => {
    await h?.cleanup();
  });

  beforeEach(async () => {
    svc.__resetLastUsedThrottle();
    await h.prisma.personalAccessToken.deleteMany({});
    await ensureUsers();
  });

  it("create：返回明文一次；库内只存 sha256 + 前 14 字符前缀（不可认证）", async () => {
    const { pat, plaintext } = await svc.createPat(U1, {
      name: "cursor-工作机", scopes: ["record:read", "doc:read"], expiresInDays: 90,
    });
    expect(plaintext.startsWith("gxpat_")).toBe(true);
    expect(pat.tokenPrefix).toBe(plaintext.slice(0, 14));
    expect(pat.expiresAt).not.toBeNull();
    const row = await h.prisma.personalAccessToken.findUniqueOrThrow({ where: { id: pat.id } });
    expect(row.tokenHash).toBe(hashToken(plaintext));
    expect(row.tokenPrefix).toBe(plaintext.slice(0, 14));
    expect(row.scopes).toBe(JSON.stringify(["record:read", "doc:read"]));
    // 明文随机段（第 14 位之后）绝不出现在库内任何列
    const secretTail = plaintext.slice(14);
    expect(JSON.stringify(row)).not.toContain(secretTail);
  });

  it("create：expiresInDays=null -> expiresAt 为 null（永不过期）", async () => {
    const { pat } = await svc.createPat(U1, { name: "forever", scopes: ["record:read"], expiresInDays: null });
    expect(pat.expiresAt).toBeNull();
  });

  it("list：仅本人；返回对象键集合固定（无 token/tokenHash）", async () => {
    await svc.createPat(U1, { name: "a", scopes: ["record:read"], expiresInDays: 90 });
    await svc.createPat(U1, { name: "b", scopes: ["doc:read"], expiresInDays: null });
    await svc.createPat(U2, { name: "other", scopes: ["record:read"], expiresInDays: 90 });
    const list = await svc.listPats(U1);
    // 按 createdAt desc 排序；同毫秒创建时并列次序不保证 -> 用集合断言（且严格只含本人 2 条）
    expect(list.map((p) => p.name).sort()).toEqual(["a", "b"]);
    expect(list).toHaveLength(2);
    expect(Object.keys(list[0]!).sort()).toEqual(
      ["createdAt", "expiresAt", "id", "lastUsedAt", "name", "revokedAt", "scopes", "tokenPrefix"],
    );
  });

  it("revoke：本人可吊销且幂等（二次 false 不覆盖原时间）；非本人 patId -> false", async () => {
    const { pat } = await svc.createPat(U1, { name: "x", scopes: ["record:read"], expiresInDays: 90 });
    expect(await svc.revokePat(U2, pat.id)).toBe(false); // 他人 -> 不生效
    expect(await svc.revokePat(U1, pat.id)).toBe(true);
    const after = await h.prisma.personalAccessToken.findUniqueOrThrow({ where: { id: pat.id } });
    const revokedAt = after.revokedAt;
    expect(revokedAt).not.toBeNull();
    expect(await svc.revokePat(U1, pat.id)).toBe(false); // 幂等：不覆盖
    expect((await h.prisma.personalAccessToken.findUniqueOrThrow({ where: { id: pat.id } })).revokedAt).toEqual(revokedAt);
    expect((await svc.listPats(U1))[0]!.revokedAt).toBe(revokedAt!.toISOString());
  });

  it("认证查库：hash 命中取行；错 hash 取不到（边缘走 dummy 等长比较，见 tokens 单测）", async () => {
    const { plaintext } = await svc.createPat(U1, { name: "auth", scopes: ["record:read"], expiresInDays: 90 });
    const hit = await svc.findByTokenHash(hashToken(plaintext));
    expect(hit?.userId).toBe(U1);
    expect(hit?.scopes).toBe(JSON.stringify(["record:read"]));
    expect(await svc.findByTokenHash(hashToken("gxpat_wrong"))).toBeNull();
  });

  it("停用联动（C-4）：disableUser 同事务批量吊销其全部 PAT，且认证判定为 revoked", async () => {
    const a = await svc.createPat(U1, { name: "a", scopes: ["record:read"], expiresInDays: 90 });
    const b = await svc.createPat(U1, { name: "b", scopes: ["doc:write"], expiresInDays: null });
    await lifecycle.disableUser(U2, U1); // 他人停用 u1
    const rows = await h.prisma.personalAccessToken.findMany({ where: { userId: U1 } });
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.revokedAt).not.toBeNull();
    // 认证判定：吊销优先（tokenHash 已是摘要，直接查库，不再二次 hash）
    const stored = await h.prisma.personalAccessToken.findUniqueOrThrow({ where: { id: a.pat.id } });
    const hit = await svc.findByTokenHash(stored.tokenHash);
    expect(evaluateTokenState({ revokedAt: hit!.revokedAt, expiresAt: hit!.expiresAt }, new Date())).toBe("revoked");
    // 用户态亦已 DISABLED（认证边缘据此拒）
    expect((await h.prisma.user.findUniqueOrThrow({ where: { id: U1 } })).status).toBe("DISABLED");
    expect(b.pat.id).toBeTruthy();
  });

  it("重新激活不恢复（C-4）：revokedAt 保持非空", async () => {
    const { pat } = await svc.createPat(U1, { name: "a", scopes: ["record:read"], expiresInDays: 90 });
    await lifecycle.disableUser(U2, U1);
    await lifecycle.reactivateUser(U2, U1);
    expect((await h.prisma.user.findUniqueOrThrow({ where: { id: U1 } })).status).toBe("ACTIVE");
    expect((await h.prisma.personalAccessToken.findUniqueOrThrow({ where: { id: pat.id } })).revokedAt).not.toBeNull();
  });

  it("删除用户 -> PAT 行级联消失（FK ON DELETE CASCADE）", async () => {
    await svc.createPat(U3, { name: "c", scopes: ["record:read"], expiresInDays: 90 });
    expect(await h.prisma.personalAccessToken.count({ where: { userId: U3 } })).toBe(1);
    await h.prisma.user.delete({ where: { id: U3 } });
    expect(await h.prisma.personalAccessToken.count({ where: { userId: U3 } })).toBe(0);
  });

  it("lastUsedAt 节流：60s 内同 patId 只落库一次；超窗再落", async () => {
    const { pat } = await svc.createPat(U1, { name: "t", scopes: ["record:read"], expiresInDays: 90 });
    const t0 = new Date("2026-06-01T00:00:00.000Z");
    expect(await svc.touchLastUsed(pat.id, t0)).toBe(true);
    expect(await svc.touchLastUsed(pat.id, new Date(t0.getTime() + 30_000))).toBe(false); // 节流
    expect((await h.prisma.personalAccessToken.findUniqueOrThrow({ where: { id: pat.id } })).lastUsedAt?.toISOString())
      .toBe(t0.toISOString());
    const t1 = new Date(t0.getTime() + 61_000);
    expect(await svc.touchLastUsed(pat.id, t1)).toBe(true); // 超窗
    expect((await h.prisma.personalAccessToken.findUniqueOrThrow({ where: { id: pat.id } })).lastUsedAt?.toISOString())
      .toBe(t1.toISOString());
  });

  it("过期判定（假时钟）：expiresAt 已过 -> expired", async () => {
    const { pat, plaintext } = await svc.createPat(U1, { name: "e", scopes: ["record:read"], expiresInDays: 30 }, new Date("2026-01-01T00:00:00Z"));
    const hit = await svc.findByTokenHash(hashToken(plaintext));
    expect(hit!.id).toBe(pat.id);
    expect(evaluateTokenState({ revokedAt: hit!.revokedAt, expiresAt: hit!.expiresAt }, new Date("2026-01-30T00:00:00Z"))).toBe("ok");
    expect(evaluateTokenState({ revokedAt: hit!.revokedAt, expiresAt: hit!.expiresAt }, new Date("2026-02-15T00:00:00Z"))).toBe("expired");
  });
});
