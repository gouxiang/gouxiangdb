// 首次部署超级管理员「强制改密」闸门端到端（真迁移临时库 + 真 app + 真 hono/jwt，不 mock auth）。
//
// 部署链路用 init-admin 脚本建的首个超级管理员带 mustChangePassword=true，登录后必须只能改密：
//   ① 普通用户（false）带令牌请求业务接口不被拦；
//   ② true 时业务接口 403 + code=PASSWORD_CHANGE_REQUIRED；
//   ③ true 时白名单 GET /api/auth/me 仍 200 且带出 mustChangePassword=true（前端据此渲染改密页）；
//   ④ 改密成功后闸门解除，业务接口恢复（含 authStateCache 失效——不失效则仍被拦）。
//
// 本文件显式开 GX_AUTH_STATE_TTL_MS=60000 启用鉴权状态缓存：否则默认零缓存会旁路
// authStateCache，断言④在"忘记调 invalidateAuthState"时也照样通过，等于没覆盖。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupOrgHarness, json, type OrgHarness } from "./orgHarness.js";

let h: OrgHarness;
let PASSWORD_CHANGE_REQUIRED = "";

beforeAll(async () => {
  // 必须在 setupOrgHarness（动态 import app -> 首次求值 config）之前设置，否则不生效。
  process.env.GX_AUTH_STATE_TTL_MS = "60000";
  h = await setupOrgHarness();
  ({ PASSWORD_CHANGE_REQUIRED } = await import("../../../../middleware/mustChangePassword.js"));
}, 120000);
afterAll(async () => {
  await h.cleanup();
});
beforeEach(async () => {
  await h.reset();
});

async function setMustChangePassword(userId: string, v: boolean): Promise<void> {
  await h.prisma.user.update({ where: { id: userId }, data: { mustChangePassword: v } });
}

async function mustChangeOf(userId: string): Promise<boolean | undefined> {
  const row = await h.prisma.user.findUnique({
    where: { id: userId },
    select: { mustChangePassword: true },
  });
  return row?.mustChangePassword;
}

describe("强制改密闸门（init-admin 首登）", () => {
  it("① 直接建的用户 mustChangePassword=false，带令牌 GET /api/bases 不被闸门拦", async () => {
    await h.createUser("u1");
    expect(await mustChangeOf("u1")).toBe(false);

    const res = await h.app.request("/api/bases", { headers: await h.auth("u1") });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
  });

  it("② 置 true 后 GET /api/bases -> 403 PASSWORD_CHANGE_REQUIRED", async () => {
    await h.createUser("u2");
    await setMustChangePassword("u2", true);

    const res = await h.app.request("/api/bases", { headers: await h.auth("u2") });
    expect(res.status).toBe(403);
    const body = await json<{ error: string; code: string }>(res);
    expect(body.code).toBe(PASSWORD_CHANGE_REQUIRED);
    expect(body.code).toBe("PASSWORD_CHANGE_REQUIRED");
  });

  it("③ 同状态下 GET /api/auth/me 仍 200 且 user.mustChangePassword=true（白名单）", async () => {
    await h.createUser("u3");
    await setMustChangePassword("u3", true);

    const res = await h.app.request("/api/auth/me", { headers: await h.auth("u3") });
    expect(res.status).toBe(200);
    const body = await json<{ user: { id: string; mustChangePassword: boolean } }>(res);
    expect(body.user.id).toBe("u3");
    expect(body.user.mustChangePassword).toBe(true);
  });

  it("④ 改密成功后闸门解除（含 authStateCache 失效）：GET /api/bases 恢复非 403", async () => {
    await h.createUser("u4");
    await setMustChangePassword("u4", true);
    const headers = await h.auth("u4");

    // 改密前：闸门生效（顺带把 mustChangePassword=true 写入 authStateCache）
    const before = await h.app.request("/api/bases", { headers });
    expect(before.status).toBe(403);

    const cp = await h.app.request("/api/auth/me/change-password", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: "password123", newPassword: "new-password-123" }),
    });
    expect(cp.status).toBe(200);
    expect(await mustChangeOf("u4")).toBe(false);

    // 改密后：不 bump tokenVersion，同一令牌仍可用，且闸门已解除（缓存已失效才会读到 false）
    const after = await h.app.request("/api/bases", { headers });
    expect(after.status).not.toBe(403);
    expect(after.status).toBe(200);
  });
});
