// 品牌外观后端端到端（真迁移临时库 + 真 createApp 双模块图 + 真 JWT，夹具见 _brandingHarness.ts）。
//
// 覆盖规格 G：匿名默认读/匿名写 401、六身份权限矩阵（manage_* 不放行）、PATCH 校验与 trim 后
// 缓存立即失效、hero 三格式/换格式删旧/gif 拒收/5MB 上限/非 multipart/穿越 400、DELETE 复位、
// 双企业 flag off 仍无条件挂载、审计双事件、installGuide 注入。纯函数单测见
// domain/branding/__tests__/store.test.ts。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { renderFnosUploadGuide } from "../../domain/update/installGuide.js";
import {
  JPEG,
  gifFile,
  imageFile,
  setupBrandingHarness,
  zeroPart,
  type BrandingHarness,
} from "./_brandingHarness.js";

let h: BrandingHarness;

beforeAll(async () => {
  h = await setupBrandingHarness();
}, 120000);

afterAll(async () => {
  await h?.cleanup();
});

beforeEach(async () => {
  await h.resetBranding();
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

async function upload(file: File, userId = "admin"): Promise<Response> {
  const fd = new FormData();
  fd.set("file", file);
  return h.app.request("/api/admin/branding/hero", {
    method: "POST",
    headers: await h.auth(userId),
    body: fd,
  });
}

describe("品牌外观：匿名公开读", () => {
  it("无 KV 时匿名 GET 200 默认 DTO（产品名默认/版权空/heroUrl null）", async () => {
    const res = await h.app.request("/api/auth/branding");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ productName: "构想工作台", copyright: "", heroUrl: null });
  });

  it("匿名写操作一律 401 UNAUTHORIZED", async () => {
    const p = await h.app.request("/api/admin/branding", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productName: "x" }),
    });
    expect(p.status).toBe(401);
    expect((await json<{ code: string }>(p)).code).toBe("UNAUTHORIZED");

    const fd = new FormData();
    fd.set("file", h.pngFile());
    const post = await h.app.request("/api/admin/branding/hero", { method: "POST", body: fd });
    expect(post.status).toBe(401);

    const del = await h.app.request("/api/admin/branding/hero", { method: "DELETE" });
    expect(del.status).toBe(401);
  });
});

describe("品牌外观：PATCH 权限矩阵（只认 super_admin/admin/旧 owner）", () => {
  const cases: Array<[string, number]> = [
    ["owner", 200],       // role_owner -> systemKey=super_admin
    ["admin", 200],       // role_admin -> systemKey=admin
    ["legacy", 200],      // 旧库残留 systemKey="owner"
    ["viewer", 403],      // role_viewer
    ["restricted", 403],  // role_restricted
    ["custom", 403],      // 自定义角色持 manage_share：动作位不放行
  ];
  for (const [userId, expected] of cases) {
    it(`${userId} PATCH -> ${expected}`, async () => {
      const res = await patch(userId, { productName: `品牌-${userId}` });
      expect(res.status, userId).toBe(expected);
      if (expected === 403) {
        expect((await json<{ code: string }>(res)).code).toBe("FORBIDDEN");
      }
    });
  }

  it("非管理员 GET 管理口 403；管理员 200", async () => {
    const denied = await h.app.request("/api/admin/branding", { headers: await h.auth("viewer") });
    expect(denied.status).toBe(403);
    const ok = await h.app.request("/api/admin/branding", { headers: await h.auth("owner") });
    expect(ok.status).toBe(200);
  });
});

describe("品牌外观：PATCH 校验 + 写后缓存立即失效", () => {
  it("trim 生效；PATCH 后匿名 GET 立即读到新名（invalidate 证据）", async () => {
    const res = await patch("owner", { productName: "  蓝奏云  " });
    expect(res.status).toBe(200);
    expect((await json(res)).productName).toBe("蓝奏云");
    const pub = await json<{ productName: string }>(
      await h.app.request("/api/auth/branding"),
    );
    expect(pub.productName).toBe("蓝奏云");
  });

  it("全空格/31 字产品名、121 字版权、空对象、未知键 -> 400 且不落 KV", async () => {
    expect((await patch("admin", { productName: "   " })).status).toBe(400);
    expect((await patch("admin", { productName: "名".repeat(31) })).status).toBe(400);
    expect((await patch("admin", { copyright: "版".repeat(121) })).status).toBe(400);
    expect((await patch("admin", {})).status).toBe(400);
    expect((await patch("admin", { hero: "x" } as unknown as Record<string, unknown>)).status).toBe(400);
    expect(await h.prisma.appSetting.count()).toBe(0);
  });

  it("版权原样存（{year} 交渲染端），空串可保存（前端语义=不渲染版权）", async () => {
    const res = await patch("admin", { copyright: "© {year} 蓝奏云" });
    expect(res.status).toBe(200);
    expect((await json<{ copyright: string }>(res)).copyright).toBe("© {year} 蓝奏云");
    expect((await patch("admin", { copyright: "" })).status).toBe(200);
  });
});

describe("品牌外观：hero 上传/替换/复位通道", () => {
  it("PNG 200，heroUrl 带 ?v=；公开通道匿名可取 image/png + immutable", async () => {
    const res = await upload(h.pngFile());
    expect(res.status).toBe(200);
    const body = await json<{ heroUrl: string }>(res);
    expect(body.heroUrl).toMatch(/^\/uploads\/branding\/hero\.png\?v=\d+$/);
    const pub = await h.app.request(body.heroUrl);
    expect(pub.status).toBe(200);
    expect(pub.headers.get("content-type")).toBe("image/png");
    expect(pub.headers.get("cache-control")).toContain("immutable");
    expect(fs.existsSync(path.join(h.heroDir, "hero.png"))).toBe(true);
  });

  it("换传 jpeg 后 hero.jpg 存在、hero.png 已删（GET png -> 404）", async () => {
    await upload(h.pngFile());
    const res = await upload(imageFile(JPEG, "ad.jpg", "image/jpeg"));
    expect(res.status).toBe(200);
    expect((await json<{ heroUrl: string }>(res)).heroUrl).toContain("hero.jpg");
    expect(fs.existsSync(path.join(h.heroDir, "hero.jpg"))).toBe(true);
    expect(fs.existsSync(path.join(h.heroDir, "hero.png"))).toBe(false);
    expect((await h.app.request("/uploads/branding/hero.png")).status).toBe(404);
  });

  it("gif 拒收；5MB+1B 拒收；非 multipart(JSON) 拒收；失败不留盘", async () => {
    expect((await upload(gifFile())).status).toBe(400);
    expect((await upload(new File([zeroPart(5 * 1024 * 1024 + 1)], "big.png", { type: "image/png" }))).status).toBe(400);
    const jsonPost = await h.app.request("/api/admin/branding/hero", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${h.tokens.get("admin")!}`,
      },
      body: "{}",
    });
    expect(jsonPost.status).toBe(400);
    expect(fs.existsSync(h.heroDir)).toBe(false);
  });

  it("公开通道穿越文件名 -> 400；非白名单扩展名 -> 400", async () => {
    await upload(h.pngFile());
    expect((await h.app.request("/uploads/branding/%2e%2e%2fhero.png")).status).toBe(400);
    fs.mkdirSync(h.heroDir, { recursive: true });
    fs.writeFileSync(path.join(h.heroDir, "hero.gif"), Buffer.from("GIF89a"));
    expect((await h.app.request("/uploads/branding/hero.gif")).status).toBe(400);
  });

  it("DELETE /hero 后 heroUrl 回 null 且文件已删", async () => {
    await upload(h.pngFile());
    const res = await h.app.request("/api/admin/branding/hero", {
      method: "DELETE",
      headers: await h.auth("owner"),
    });
    expect(res.status).toBe(200);
    expect((await json<{ heroUrl: string | null }>(res)).heroUrl).toBeNull();
    expect(fs.existsSync(path.join(h.heroDir, "hero.png"))).toBe(false);
    const pub = await json<{ heroUrl: string | null }>(await h.app.request("/api/auth/branding"));
    expect(pub.heroUrl).toBeNull();
  });
});

describe("品牌外观：双企业 flag off 仍无条件挂载", () => {
  it("off 实例匿名 GET 200；owner PATCH 200（端点不随 /api/v1 摘除）", async () => {
    expect((await h.offApp.request("/api/auth/branding")).status).toBe(200);
    const res = await h.offApp.request("/api/admin/branding", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${h.tokens.get("owner")!}`,
      },
      body: JSON.stringify({ productName: "双flag关" }),
    });
    expect(res.status).toBe(200);
    expect((await json<{ productName: string }>(res)).productName).toBe("双flag关");
  });
});

describe("品牌外观：审计双事件", () => {
  it("audit.logl 含双事件，detail 不落产品名内容（只带字段名/ext/bytes）", async () => {
    await patch("owner", { productName: "审计品牌" });
    await upload(h.pngFile(), "owner");
    const lines = fs.readFileSync(h.auditFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const events = lines.map((r: { event: string }) => r.event);
    expect(events).toContain("branding_update");
    expect(events).toContain("branding_hero_update");
    const upd = lines
      .filter((r: { event: string }) => r.event === "branding_update")
      .find((r: { detail: { fields: string[] } }) => r.detail.fields.includes("productName"));
    expect(upd).toBeTruthy();
    expect(upd.detail).toEqual({ fields: ["productName"] });
    const hero = lines
      .filter((r: { event: string; detail: Record<string, unknown> }) =>
        r.event === "branding_hero_update" && r.detail.ext === "png")
      .at(-1);
    expect(hero).toBeTruthy();
    expect(Object.keys(hero.detail).sort()).toEqual(["bytes", "ext"]);
  });
});

describe("品牌外观：根 JSON 产品名收口（API-only 根处理器）", () => {
  it("默认 name=构想工作台 API；PATCH 后立即反映品牌名（缓存失效）", async () => {
    const before = await h.app.request("/");
    expect(before.status).toBe(200);
    expect((await json<{ name: string }>(before)).name).toBe("构想工作台 API");

    const res = await patch("admin", { productName: "蓝奏云" });
    expect(res.status).toBe(200);
    const after = await h.app.request("/");
    expect((await json<{ name: string }>(after)).name).toBe("蓝奏云 API");
  });
});

describe("品牌外观：installGuide 产品名注入（第三参，缺省默认）", () => {
  it("缺省步骤 5 仍为「构想工作台」；注入名出现在步骤 5；空串回退默认", () => {
    const def = renderFnosUploadGuide("0.2.4", "a.fpk");
    expect(def.kind).toBe("fnos-upload");
    expect(def.steps).toHaveLength(5);
    expect(def.steps[4]).toContain("重新打开构想工作台");
    const custom = renderFnosUploadGuide("0.2.4", "a.fpk", "蓝奏云");
    expect(custom.steps[4]).toContain("重新打开蓝奏云");
    expect(custom.steps[4]).toContain("0.2.4");
    expect(renderFnosUploadGuide("0.2.4", null).steps[0]).toContain("升级包（.fpk）");
    expect(renderFnosUploadGuide("0.2.4", "a.fpk", "   ").steps[4])
      .toContain("重新打开构想工作台");
  });
});
