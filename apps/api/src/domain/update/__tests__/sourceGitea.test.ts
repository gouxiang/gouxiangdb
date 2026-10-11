// apps/api/src/domain/update/__tests__/sourceGitea.test.ts
// Gitea 源测试：stub fetch（不真实出网），锁死 §8.1 实测硬约束。
import { describe, expect, it, vi } from "vitest";
import { parseUpdateConfig } from "../../../configUpdate.js";
import { GiteaUpdateSource, MANIFEST_ASSET_NAME, tagForVersion } from "../sourceGitea.js";
import { UpdateSourceError } from "../types.js";

function cfg(over: Record<string, string> = {}) {
  return parseUpdateConfig({
    GX_UPDATE_TOKEN: "test-token",
    GX_UPDATE_GITEA_BASE_URL: "https://gitea.test",
    GX_UPDATE_REPO: "org/repo",
    GX_UPDATE_TIMEOUT_MS: "1000",
    ...over,
  }).config;
}

const MANIFEST_BODY = JSON.stringify({
  schemaVersion: 1,
  product: "gouxiangdb",
  generatedAt: "2026-10-15T08:00:00Z",
  channels: { "fnos-fpk": { releases: [] } },
});

/** 构造两次调用的 stub：release 列表 + 清单资产。 */
function stubFetch(listBody: unknown, manifestText: string | null, listStatus = 200, manifestStatus = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes("/api/v1/repos/") && u.includes("/releases")) {
      return new Response(typeof listBody === "string" ? listBody : JSON.stringify(listBody), {
        status: listStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(manifestText ?? "", { status: manifestStatus });
  });
  return { f, calls };
}

const releaseWithManifest = (tag = "v0.2.3") => [
  {
    tag_name: tag,
    browser_download_url: "http://192.168.31.88:21350/leak", // 必须永不被使用
    assets: [
      { name: MANIFEST_ASSET_NAME, browser_download_url: "http://192.168.31.88:21350/leak.json" },
      { name: "gouxiangdb-0.2.3-x86.fpk", browser_download_url: "http://192.168.31.88:21350/leak.fpk" },
    ],
  },
];

describe("GiteaUpdateSource.fetchManifest 主链路", () => {
  it("用 /releases 列表找清单资产，再从配置 base 自拼公网 URL 下载", async () => {
    const { f, calls } = stubFetch(releaseWithManifest(), MANIFEST_BODY);
    const src = new GiteaUpdateSource(cfg(), { fetch: f });
    const parsed = await src.fetchManifest();
    expect(parsed.newerSchema).toBe(false);

    // 第 1 跳：API releases（绝不调 /user）。
    expect(calls[0]!.url).toBe("https://gitea.test/api/v1/repos/org/repo/releases?limit=10");
    expect(calls[0]!.url).not.toContain("/user");
    // 第 2 跳：自拼公网 download 路径，不含内网地址。
    expect(calls[1]!.url).toBe("https://gitea.test/org/repo/releases/download/v0.2.3/update-manifest.json");
    expect(calls[1]!.url).not.toContain("192.168.31.88");
    // 鉴权走 header，不放 query。
    const h0 = calls[0]!.init!.headers as Record<string, string>;
    expect(h0.Authorization).toBe("token test-token");
    expect(calls.every((c) => !c.url.includes("access_token"))).toBe(true);
  });

  it("release 列表按新→旧，跳过不带清单资产的 release，取下一个", async () => {
    const list = [
      { tag_name: "v9.9.9", assets: [{ name: "something-else" }] },
      releaseWithManifest("v0.2.3")[0],
    ];
    const { f, calls } = stubFetch(list, MANIFEST_BODY);
    const src = new GiteaUpdateSource(cfg(), { fetch: f });
    await src.fetchManifest();
    expect(calls[1]!.url).toContain("/download/v0.2.3/");
  });

  it("tag 不带 v 也能正确拼接（tagForVersion 补 v）", () => {
    expect(tagForVersion("0.2.3")).toBe("v0.2.3");
    expect(tagForVersion("v0.2.3")).toBe("v0.2.3");
  });
});

describe("GiteaUpdateSource 错误映射", () => {
  it("空 token：出网前直接 UNCONFIGURED（0 次调用）", async () => {
    const { f, calls } = stubFetch([], null);
    const src = new GiteaUpdateSource(cfg({ GX_UPDATE_TOKEN: "" }), { fetch: f });
    await expect(src.fetchManifest()).rejects.toMatchObject({ code: "UPDATE_SOURCE_UNCONFIGURED" });
    expect(calls).toHaveLength(0);
  });

  it("上游 401/403 → UPDATE_SOURCE_AUTH", async () => {
    const { f } = stubFetch([], null, 401);
    const src = new GiteaUpdateSource(cfg(), { fetch: f });
    await expect(src.fetchManifest()).rejects.toMatchObject({ code: "UPDATE_SOURCE_AUTH" });
  });

  it("有 token 仍 404 → UPDATE_SOURCE_UNREACHABLE（不当鉴权问题）", async () => {
    const { f } = stubFetch([], null, 404);
    const src = new GiteaUpdateSource(cfg(), { fetch: f });
    await expect(src.fetchManifest()).rejects.toMatchObject({ code: "UPDATE_SOURCE_UNREACHABLE" });
  });

  it("列表无任何带清单的 release → MANIFEST_INVALID", async () => {
    const { f } = stubFetch([{ tag_name: "v1", assets: [] }], null);
    const src = new GiteaUpdateSource(cfg(), { fetch: f });
    await expect(src.fetchManifest()).rejects.toMatchObject({ code: "UPDATE_MANIFEST_INVALID" });
  });

  it("清单不是合法 JSON → MANIFEST_INVALID", async () => {
    const { f } = stubFetch(releaseWithManifest(), "not json{");
    const src = new GiteaUpdateSource(cfg(), { fetch: f });
    await expect(src.fetchManifest()).rejects.toMatchObject({ code: "UPDATE_MANIFEST_INVALID" });
  });

  it("网络层失败（fetch reject）→ UNREACHABLE", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed: ENOTFOUND");
    });
    const src = new GiteaUpdateSource(cfg(), { fetch: f });
    await expect(src.fetchManifest()).rejects.toMatchObject({ code: "UPDATE_SOURCE_UNREACHABLE" });
  });

  it("超时 abort → UPDATE_SOURCE_TIMEOUT", async () => {
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      await new Promise<void>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
      throw new Error("unreachable");
    });
    const src = new GiteaUpdateSource(cfg({ GX_UPDATE_TIMEOUT_MS: "20" }), { fetch: f });
    await expect(src.fetchManifest()).rejects.toMatchObject({ code: "UPDATE_SOURCE_TIMEOUT" });
  });
});

describe("buildArtifactRequest", () => {
  it("release-asset：自拼配置 base 的公网 URL，忽略任何 API 字段", () => {
    const src = new GiteaUpdateSource(cfg());
    const req = src.buildArtifactRequest({
      version: "0.2.3",
      artifact: {
        arch: "x64",
        platform: "linux",
        filename: "gouxiangdb-0.2.3-x86.fpk",
        sizeBytes: 1,
        sha256: "a".repeat(64),
        download: { kind: "release-asset", asset: "gouxiangdb-0.2.3-x86.fpk" },
        signature: null,
      },
    });
    expect(req).toEqual({
      url: "https://gitea.test/org/repo/releases/download/v0.2.3/gouxiangdb-0.2.3-x86.fpk",
      authed: true,
    });
  });

  it("错误码是稳定 code，message 不含 token / 内网 URL", async () => {
    const { f } = stubFetch([], null, 500);
    const src = new GiteaUpdateSource(cfg(), { fetch: f });
    try {
      await src.fetchManifest();
      throw new Error("应失败");
    } catch (e) {
      const err = e as UpdateSourceError;
      expect(err.code).toBe("UPDATE_SOURCE_UNREACHABLE");
      expect(err.message).not.toContain("test-token");
      expect(err.message).not.toContain("192.168");
    }
  });
});
