// Branding client 段契约测试（node 环境，vi.stubGlobal fetch，无新增依赖）。
// 锁四件事：
//   ① 上传广告图：POST /api/admin/branding/hero、multipart FormData 字段名 file、
//      鉴权头只带 X-GX-Token（断言不带 Authorization——飞牛网关会吞 Bearer 头），
//      且不注入 Content-Type（boundary 必须由浏览器生成）；
//   ② 上传成功返回 DTO；非 2xx reject ApiError；
//   ③ 公开/管理员读、PATCH、DELETE 的方法与路径正确。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Branding, ApiError } from "../client";
import { useAuthStore } from "../../store/auth";

const DTO = { productName: "构想工作台", copyright: "© {year}", heroUrl: null };

function jsonResponse(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: init?.headers,
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  // 不走持久化：node 无 localStorage 时 persist 落内存，直接写内存态即可
  useAuthStore.setState({ token: "tok-123", user: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Branding.uploadHero（multipart 手写 fetch）", () => {
  it("POST 正确 URL；FormData 字段名 file；带 X-GX-Token 且不带 Authorization；不注入 Content-Type", async () => {
    fetchMock.mockResolvedValue(jsonResponse(DTO));
    const file = new File(["png-bytes"], "hero.png", { type: "image/png" });

    const result = await Branding.uploadHero(file);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/admin/branding/hero");
    expect(init.method).toBe("POST");
    // 不能让 apiFetch 的 application/json 混进 multipart
    expect(init.headers["Content-Type"]).toBeUndefined();
    expect(init.headers["content-type"]).toBeUndefined();
    expect(init.headers["X-GX-Token"]).toBe("tok-123");
    expect(init.headers["Authorization"]).toBeUndefined();
    expect(init.headers["authorization"]).toBeUndefined();
    // 字段名固定为 file（后端 multer 单字段名）
    expect(init.body).toBeInstanceOf(FormData);
    const uploaded = (init.body as FormData).get("file");
    expect(uploaded).toBeInstanceOf(File);
    expect((uploaded as File).name).toBe("hero.png");
    expect(result).toEqual(DTO);
  });

  it("无登录令牌时不产生任何鉴权头（空对象，避免空头触发网关）", async () => {
    useAuthStore.setState({ token: null });
    fetchMock.mockResolvedValue(jsonResponse(DTO));
    await Branding.uploadHero(new File(["x"], "h.jpg", { type: "image/jpeg" }));
    const init = fetchMock.mock.calls[0]![1] as RequestInit & {
      headers: Record<string, string>;
    };
    expect(init.headers).toEqual({});
  });

  it("非 2xx → reject ApiError（status/body 可读），不返回 undefined", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: "文件超过 5MB", code: "PAYLOAD_TOO_LARGE" },
        { status: 413 },
      ),
    );
    await expect(
      Branding.uploadHero(new File(["x"], "big.png", { type: "image/png" })),
    ).rejects.toMatchObject({
      status: 413,
      body: { code: "PAYLOAD_TOO_LARGE" },
    });
    // 类型守卫：reject 的确实是 ApiError
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "bad" }, { status: 400 }),
    );
    await expect(
      Branding.uploadHero(new File(["x"], "bad.gif", { type: "image/gif" })),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("Branding 其余端点（方法/路径/请求体）", () => {
  it("publicConfig：GET /api/auth/branding（匿名公开口）", async () => {
    fetchMock.mockResolvedValue(jsonResponse(DTO));
    await Branding.publicConfig();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/branding");
    expect(init.method).toBeUndefined(); // GET 不显式传 method
  });

  it("adminConfig：GET /api/admin/branding", async () => {
    fetchMock.mockResolvedValue(jsonResponse(DTO));
    await Branding.adminConfig();
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/admin/branding");
  });

  it("update：PATCH /api/admin/branding，body 为 JSON 串", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...DTO, productName: "新名" }));
    await Branding.update({ productName: "新名", copyright: "© x" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/admin/branding");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({
      productName: "新名",
      copyright: "© x",
    });
  });

  it("resetHero：DELETE /api/admin/branding/hero，返回最新 DTO", async () => {
    fetchMock.mockResolvedValue(jsonResponse(DTO));
    const out = await Branding.resetHero();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/admin/branding/hero");
    expect(init.method).toBe("DELETE");
    expect(out).toEqual(DTO);
  });
});
