// apps/api/src/domain/update/__tests__/sourceGithub.test.ts
// GitHub 匿名公开源测试：stub fetch（不真实出网），锁死公开源硬约束——
// 匿名无 Authorization、强制 UA/Accept、自拼 github.com 下载 URL（绝不读 API 的 url 字段）、
// authed 恒 false、403→AUTH、网络失败→UNREACHABLE。
import { describe, expect, it, vi } from "vitest";
import { parseUpdateConfig } from "../../../configUpdate.js";
import { GithubUpdateSource } from "../sourceGithub.js";
import { MANIFEST_ASSET_NAME } from "../sourceGitea.js";
import { UpdateSourceError } from "../types.js";

function cfg(over: Record<string, string> = {}) {
  return parseUpdateConfig({
    GX_UPDATE_SOURCE: "github",
    GX_UPDATE_REPO: "org/repo",
    GX_UPDATE_TIMEOUT_MS: "1000",
    // 刻意不配 token：公开源必须在空凭证下也能工作。
    ...over,
  }).config;
}

const MANIFEST_BODY = JSON.stringify({
  schemaVersion: 1,
  product: "gouxiangdb",
  generatedAt: "2026-11-01T08:00:00Z",
  channels: { "desktop-client": { releases: [] } },
});

/** 两次调用的 stub：release 列表（api.github.com）+ 清单资产（github.com 下载地址）。 */
function stubFetch(listBody: unknown, manifestText: string | null, listStatus = 200, manifestStatus = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes("api.github.com/repos/") && u.includes("/releases")) {
      return new Response(typeof listBody === "string" ? listBody : JSON.stringify(listBody), {
        status: listStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(manifestText ?? "", { status: manifestStatus });
  });
  return { f, calls };
}

const releaseWithManifest = (tag = "v0.3.1") => [
  {
    tag_name: tag,
    // 内网/伪造地址：必须永不被使用（类型层也不声明这些字段）。
    browser_download_url: "http://192.168.31.88:21350/leak",
    url: "https://api.github.com/repos/org/repo/releases/assets/999",
    assets: [
      { name: MANIFEST_ASSET_NAME, browser_download_url: "http://192.168.31.88:21350/leak.json" },
      { name: "GouXiang-0.3.1-arm64.dmg", browser_download_url: "http://192.168.31.88:21350/leak.dmg" },
    ],
  },
];

describe("GithubUpdateSource.fetchManifest 主链路", () => {
  it("匿名：全程不带 Authorization，且强制 User-Agent + GitHub Accept", async () => {
    const { f, calls } = stubFetch(releaseWithManifest(), MANIFEST_BODY);
    const src = new GithubUpdateSource(cfg(), { fetch: f });
    await src.fetchManifest(new AbortController().signal);

    // 第 1 跳：GitHub REST releases 列表，per_page=10。
    expect(calls[0]!.url).toBe("https://api.github.com/repos/org/repo/releases?per_page=10");
    const h0 = calls[0]!.init!.headers as Record<string, string>;
    expect(h0.Accept).toBe("application/vnd.github+json");
    expect(h0["User-Agent"]).toBe("gouxiangdb-updater");
    // 匿名硬约束：任何一跳都不带 Authorization，也不走 query token。
    expect(calls.every((c) => !(c.init!.headers as Record<string, string>).Authorization)).toBe(true);
    expect(calls.every((c) => !c.url.includes("access_token") && !c.url.includes("token="))).toBe(true);
  });

  it("用自拼 github.com 下载地址取清单，绝不使用 API 返回的内网 url 字段", async () => {
    const { f, calls } = stubFetch(releaseWithManifest(), MANIFEST_BODY);
    const src = new GithubUpdateSource(cfg(), { fetch: f });
    const parsed = await src.fetchManifest(new AbortController().signal);
    expect(parsed.newerSchema).toBe(false);

    expect(calls[1]!.url).toBe(
      "https://github.com/org/repo/releases/download/v0.3.1/update-manifest.json",
    );
    // 物理杜绝内网/API 地址。
    expect(calls.every((c) => !c.url.includes("192.168.31.88"))).toBe(true);
    expect(calls.every((c) => !c.url.includes("/releases/assets/"))).toBe(true);
    // 第二跳（清单下载）同样强制 UA，且仍匿名。
    const h1 = calls[1]!.init!.headers as Record<string, string>;
    expect(h1["User-Agent"]).toBe("gouxiangdb-updater");
    expect(h1.Authorization).toBeUndefined();
  });

  it("release 列表按新→旧，跳过不带清单资产的 release，取下一个", async () => {
    const list = [
      { tag_name: "v9.9.9", assets: [{ name: "something-else" }] },
      releaseWithManifest("v0.3.1")[0],
    ];
    const { f, calls } = stubFetch(list, MANIFEST_BODY);
    const src = new GithubUpdateSource(cfg(), { fetch: f });
    await src.fetchManifest(new AbortController().signal);
    expect(calls[1]!.url).toContain("/download/v0.3.1/");
  });

  it("外部 AbortSignal 被透传（调用方取消不被包装成源错误）", async () => {
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      await new Promise<void>((_res, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
      throw new Error("unreachable");
    });
    const src = new GithubUpdateSource(cfg(), { fetch: f });
    const ac = new AbortController();
    const p = src.fetchManifest(ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("GithubUpdateSource 错误映射", () => {
  it("上游 403（缺 UA/限流/禁用）→ UPDATE_SOURCE_AUTH", async () => {
    const { f } = stubFetch([], null, 403);
    const src = new GithubUpdateSource(cfg(), { fetch: f });
    await expect(src.fetchManifest(new AbortController().signal)).rejects.toMatchObject({
      code: "UPDATE_SOURCE_AUTH",
    });
  });

  it("有响应但 404 → UPDATE_SOURCE_UNREACHABLE", async () => {
    const { f } = stubFetch([], null, 404);
    const src = new GithubUpdateSource(cfg(), { fetch: f });
    await expect(src.fetchManifest(new AbortController().signal)).rejects.toMatchObject({
      code: "UPDATE_SOURCE_UNREACHABLE",
    });
  });

  it("网络层失败（fetch reject）→ UNREACHABLE", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed: ENOTFOUND");
    });
    const src = new GithubUpdateSource(cfg(), { fetch: f });
    await expect(src.fetchManifest(new AbortController().signal)).rejects.toMatchObject({
      code: "UPDATE_SOURCE_UNREACHABLE",
    });
  });

  it("列表无任何带清单的 release → MANIFEST_INVALID", async () => {
    const { f } = stubFetch([{ tag_name: "v1", assets: [] }], null);
    const src = new GithubUpdateSource(cfg(), { fetch: f });
    await expect(src.fetchManifest(new AbortController().signal)).rejects.toMatchObject({
      code: "UPDATE_MANIFEST_INVALID",
    });
  });

  it("清单不是合法 JSON → MANIFEST_INVALID", async () => {
    const { f } = stubFetch(releaseWithManifest(), "not json{");
    const src = new GithubUpdateSource(cfg(), { fetch: f });
    await expect(src.fetchManifest(new AbortController().signal)).rejects.toMatchObject({
      code: "UPDATE_MANIFEST_INVALID",
    });
  });

  it("错误 message 不含内网 URL/凭证（错误体不透传）", async () => {
    const { f } = stubFetch([], null, 500);
    const src = new GithubUpdateSource(cfg(), { fetch: f });
    try {
      await src.fetchManifest(new AbortController().signal);
      throw new Error("应失败");
    } catch (e) {
      const err = e as UpdateSourceError;
      expect(err.code).toBe("UPDATE_SOURCE_UNREACHABLE");
      expect(err.message).not.toContain("192.168");
    }
  });
});

describe("GithubUpdateSource.buildArtifactRequest", () => {
  it("release-asset：自拼匿名 github.com URL，authed 恒 false（忽略任何 API 字段）", () => {
    const src = new GithubUpdateSource(cfg());
    const req = src.buildArtifactRequest({
      version: "0.3.1",
      artifact: {
        arch: "arm64",
        platform: "darwin",
        filename: "GouXiang-0.3.1-arm64.dmg",
        sizeBytes: 1,
        sha256: "a".repeat(64),
        download: { kind: "release-asset", asset: "GouXiang-0.3.1-arm64.dmg" },
        signature: null,
      },
    });
    expect(req).toEqual({
      url: "https://github.com/org/repo/releases/download/v0.3.1/GouXiang-0.3.1-arm64.dmg",
      authed: false,
    });
  });

  it("version 已带 v 前缀不重复添加；url 直链同样 authed=false", () => {
    const src = new GithubUpdateSource(cfg());
    const assetReq = src.buildArtifactRequest({
      version: "v0.3.1",
      artifact: {
        arch: "x64",
        platform: "win32",
        filename: "GouXiang-0.3.1-x64.msi",
        sizeBytes: 1,
        sha256: "b".repeat(64),
        download: { kind: "release-asset", asset: "GouXiang-0.3.1-x64.msi" },
        signature: null,
      },
    });
    expect(assetReq.url).toBe(
      "https://github.com/org/repo/releases/download/v0.3.1/GouXiang-0.3.1-x64.msi",
    );
    expect(assetReq.authed).toBe(false);

    const urlReq = src.buildArtifactRequest({
      version: "0.3.1",
      artifact: {
        arch: "x64",
        platform: "linux",
        filename: "GouXiang-0.3.1-x86_64.AppImage",
        sizeBytes: 1,
        sha256: "c".repeat(64),
        download: { kind: "url", url: "https://mirror.example.com/GouXiang.AppImage" },
        signature: null,
      },
    });
    expect(urlReq).toEqual({
      url: "https://mirror.example.com/GouXiang.AppImage",
      authed: false,
    });
  });

  it("kind 常量为 github", () => {
    expect(new GithubUpdateSource(cfg()).kind).toBe("github");
  });
});
