// 品牌外观设置处的「访客自主注册」开关端到端（真迁移临时库 + 真 createApp + 真 JWT，
// 夹具与 branding.test.ts 共用 _brandingHarness）。
//
// 拆文件原因：单文件 ≤300 行纪律。覆盖：
//   - DTO 必含 signupOpen；env 未设默认 false；
//   - PATCH signupOpen:true/false 落 KV on/off，stale on 被显式 off 覆盖；
//   - 非布尔 400、仅传该字段不算空对象；非管理员 403；
//   - env GX_ALLOW_PUBLIC_SIGNUP=on 强制旁路（KV off 也压不过）；
//   - 审计复用 branding_update，detail.fields 含字段名但不落开关值。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  setupBrandingHarness,
  type BrandingHarness,
} from "./_brandingHarness.js";

let h: BrandingHarness;
const prevFlag = process.env.GX_ALLOW_PUBLIC_SIGNUP;

beforeAll(async () => {
  h = await setupBrandingHarness();
}, 120000);

afterAll(async () => {
  if (prevFlag === undefined) delete process.env.GX_ALLOW_PUBLIC_SIGNUP;
  else process.env.GX_ALLOW_PUBLIC_SIGNUP = prevFlag;
  await h?.cleanup();
});

beforeEach(async () => {
  await h.resetBranding();
  if (prevFlag === undefined) delete process.env.GX_ALLOW_PUBLIC_SIGNUP;
  else process.env.GX_ALLOW_PUBLIC_SIGNUP = prevFlag;
});

async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function patch(userId: string, body: unknown): Promise<Response> {
  return h.app.request("/api/admin/branding", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${h.tokens.get(userId)!}`,
    },
    body: JSON.stringify(body),
  });
}

async function publicSignupOpen(): Promise<boolean> {
  const body = await json<{ signupOpen: boolean }>(
    await h.app.request("/api/auth/branding"),
  );
  return body.signupOpen;
}

describe("自主注册开关：PATCH 与 KV 落盘", () => {
  it("env 未设默认 false；PATCH true 后管理口/匿名口 GET 均 true，KV 为明确 on", async () => {
    delete process.env.GX_ALLOW_PUBLIC_SIGNUP;
    expect(await publicSignupOpen()).toBe(false);

    const res = await patch("admin", { signupOpen: true });
    expect(res.status).toBe(200);
    expect((await json<{ signupOpen: boolean }>(res)).signupOpen).toBe(true);
    expect(await publicSignupOpen()).toBe(true);

    const row = await h.prisma.appSetting.findUnique({ where: { k: "auth.public_signup" } });
    expect(row?.v).toBe("on");
  });

  it("再 PATCH false 后变 false：stale on 被显式 off 覆盖（不删行不留 on）", async () => {
    expect((await patch("owner", { signupOpen: true })).status).toBe(200);
    const off = await patch("owner", { signupOpen: false });
    expect(off.status).toBe(200);
    expect((await json<{ signupOpen: boolean }>(off)).signupOpen).toBe(false);
    const row = await h.prisma.appSetting.findUnique({ where: { k: "auth.public_signup" } });
    expect(row?.v).toBe("off");
    expect(await publicSignupOpen()).toBe(false);
  });

  it("非布尔值 -> 400；仅传 signupOpen 不算空对象（可独立保存）", async () => {
    expect((await patch("admin", { signupOpen: "true" })).status).toBe(400);
    expect((await patch("admin", { signupOpen: 1 })).status).toBe(400);
    expect((await patch("admin", { signupOpen: null })).status).toBe(400);
    expect((await patch("admin", { signupOpen: true })).status).toBe(200);
  });
});

describe("自主注册开关：权限矩阵与 env 旁路", () => {
  it("viewer/restricted/custom 写 signupOpen -> 403 FORBIDDEN 且不落 KV", async () => {
    for (const userId of ["viewer", "restricted", "custom"]) {
      const res = await patch(userId, { signupOpen: true });
      expect(res.status, userId).toBe(403);
      expect((await json<{ code: string }>(res)).code).toBe("FORBIDDEN");
    }
    const row = await h.prisma.appSetting.findUnique({ where: { k: "auth.public_signup" } });
    expect(row).toBeNull();
  });

  it("env=on 即便 KV 缺行/off，DTO 仍为 true（运维强制旁路压过后台关闭）", async () => {
    process.env.GX_ALLOW_PUBLIC_SIGNUP = "on";
    await h.resetBranding(); // 清 KV + 失效双模块图缓存，确保下面是 env 生效的新鲜读
    expect(await publicSignupOpen()).toBe(true);
    expect((await patch("admin", { signupOpen: false })).status).toBe(200);
    expect(await publicSignupOpen()).toBe(true);
  });

  it("审计复用 branding_update：detail.fields 含 signupOpen，不落开关值", async () => {
    await patch("owner", { signupOpen: true });
    const lines = fs
      .readFileSync(h.auditFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const evt = lines
      .filter((r: { event: string }) => r.event === "branding_update")
      .find((r: { detail: { fields: string[] } }) => r.detail.fields.includes("signupOpen"));
    expect(evt).toBeTruthy();
    expect(evt.detail).toEqual({ fields: ["signupOpen"] });
  });
});
