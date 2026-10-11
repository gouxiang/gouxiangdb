// apps/api/src/domain/update/__tests__/sourceStatic.test.ts
// StaticUpdateSource：直链 / 内网镜像清单源（stub fetch）。
import { describe, expect, it, vi } from "vitest";
import { parseUpdateConfig } from "../../../configUpdate.js";
import { StaticUpdateSource } from "../sourceStatic.js";

const MANIFEST_BODY = JSON.stringify({
  schemaVersion: 1,
  product: "gouxiangdb",
  generatedAt: "2026-10-15T08:00:00Z",
  channels: { "source-bare": { releases: [] } },
});

function cfg(over: Record<string, string> = {}) {
  return parseUpdateConfig({
    GX_UPDATE_SOURCE: "static",
    GX_UPDATE_MANIFEST_URL: "https://mirror.test/update-manifest.json",
    ...over,
  }).config;
}

describe("StaticUpdateSource 公开直链（authed=false）", () => {
  it("不带 Authorization 头也能取清单", async () => {
    const f = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(MANIFEST_BODY, { status: 200 }));
    const src = new StaticUpdateSource(cfg(), false, { fetch: f });
    const parsed = await src.fetchManifest();
    expect(parsed.manifest.channels["source-bare"]).toBeDefined();
    const init = f.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(f.mock.calls[0]![0]).toBe("https://mirror.test/update-manifest.json");
  });

  it("static 源未配清单地址 → UNCONFIGURED，不出网", async () => {
    const f = vi.fn();
    const src = new StaticUpdateSource(cfg({ GX_UPDATE_MANIFEST_URL: "" }), false, { fetch: f });
    await expect(src.fetchManifest()).rejects.toMatchObject({ code: "UPDATE_SOURCE_UNCONFIGURED" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("StaticUpdateSource 私有覆盖地址（authed=true）", () => {
  it("带 token 头；缺 token 时 UNCONFIGURED", async () => {
    const f = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(MANIFEST_BODY));
    const withTok = new StaticUpdateSource(cfg({ GX_UPDATE_TOKEN: "t" }), true, { fetch: f });
    await withTok.fetchManifest();
    const init = f.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("token t");

    const noTok = new StaticUpdateSource(cfg({ GX_UPDATE_TOKEN: "" }), true, { fetch: vi.fn() });
    await expect(noTok.fetchManifest()).rejects.toMatchObject({ code: "UPDATE_SOURCE_UNCONFIGURED" });
  });
});

describe("StaticUpdateSource buildArtifactRequest", () => {
  it("kind=url 直取绝对地址，透传 authed", () => {
    const src = new StaticUpdateSource(cfg(), false);
    const req = src.buildArtifactRequest({
      version: "0.2.3",
      artifact: {
        arch: "any",
        platform: "linux",
        filename: "g.tar.gz",
        sizeBytes: 1,
        sha256: "a".repeat(64),
        download: { kind: "url", url: "https://mirror.test/g.tar.gz" },
        signature: null,
      },
    });
    expect(req).toEqual({ url: "https://mirror.test/g.tar.gz", authed: false });
  });

  it("直链源遇到 release-asset（无法自拼）→ MANIFEST_INVALID", () => {
    const src = new StaticUpdateSource(cfg(), false);
    expect(() =>
      src.buildArtifactRequest({
        version: "0.2.3",
        artifact: {
          arch: "any",
          platform: "linux",
          filename: "g.tar.gz",
          sizeBytes: 1,
          sha256: "a".repeat(64),
          download: { kind: "release-asset", asset: "g.tar.gz" },
          signature: null,
        },
      }),
    ).toThrowError(/绝对下载地址/);
  });
});
