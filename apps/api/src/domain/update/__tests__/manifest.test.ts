// apps/api/src/domain/update/__tests__/manifest.test.ts
// parseUpdateManifest 门禁测试（DESIGN §4.1 规则 7、§5.1、§6.1 容错纪律）。
import { describe, expect, it } from "vitest";
import { parseUpdateManifest } from "../manifest.js";
import { UpdateSourceError } from "../types.js";

const validArtifact = {
  arch: "x64",
  platform: "linux",
  filename: "gouxiangdb-0.2.3-x86.fpk",
  sizeBytes: 63074943,
  sha256: "a".repeat(64),
  download: { kind: "release-asset", asset: "gouxiangdb-0.2.3-x86.fpk" },
  signature: null,
};

function release(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "0.2.3",
    publishedAt: "2026-10-15T08:00:00Z",
    prerelease: false,
    minVersion: "0.1.0",
    releaseNotes: { format: "markdown", zh: "正文", en: null },
    artifacts: [validArtifact],
    ...over,
  };
}

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    product: "gouxiangdb",
    generatedAt: "2026-10-15T08:00:00Z",
    channels: { "fnos-fpk": { releases: [release()] } },
    ...over,
  };
}

describe("parseUpdateManifest 结构级门禁", () => {
  it("合法清单解析成功", () => {
    const { manifest: m, newerSchema } = parseUpdateManifest(manifest());
    expect(newerSchema).toBe(false);
    expect(m.product).toBe("gouxiangdb");
    expect(m.channels["fnos-fpk"]?.releases).toHaveLength(1);
  });

  it.each([
    ["根为数组", []],
    ["根为 null", null],
    ["根为字符串", "x"],
    ["缺 schemaVersion", manifest({ schemaVersion: undefined })],
    ["schemaVersion 非整数", manifest({ schemaVersion: 1.5 })],
    ["schemaVersion=0", manifest({ schemaVersion: 0 })],
    ["product 错", manifest({ product: "other" })],
    ["generatedAt 缺", manifest({ generatedAt: "" })],
    ["channels 非对象", manifest({ channels: [] })],
  ])("%s → MANIFEST_INVALID", (_name, input) => {
    expect(() => parseUpdateManifest(input)).toThrow(UpdateSourceError);
    try {
      parseUpdateManifest(input);
    } catch (e) {
      expect((e as UpdateSourceError).code).toBe("UPDATE_MANIFEST_INVALID");
    }
  });

  it("schemaVersion>1：newerSchema=true，通道清空，不报错", () => {
    const r = parseUpdateManifest(manifest({ schemaVersion: 9 }));
    expect(r.newerSchema).toBe(true);
    expect(Object.keys(r.manifest.channels)).toHaveLength(0);
  });
});

describe("前向兼容裁剪", () => {
  it("未知通道段保留（service 按注册表决定用不用），未知顶层字段被裁掉", () => {
    const input = manifest({ futureField: { secret: 1 }, channels: { "fnos-fpk": { releases: [release()] }, "future-channel": { releases: [] } } });
    const { manifest: m } = parseUpdateManifest(input);
    expect((m as unknown as Record<string, unknown>).futureField).toBeUndefined();
    expect(m.channels["future-channel"]).toEqual({ releases: [] });
  });

  it("未知 release/artifact 字段被裁掉", () => {
    const r = release({ weird: 1 });
    (r.artifacts as unknown[])[0] = { ...validArtifact, evil: "x" };
    const { manifest: m } = parseUpdateManifest(manifest({ channels: { "fnos-fpk": { releases: [r] } } }));
    const out = m.channels["fnos-fpk"]!.releases[0]!;
    expect((out as unknown as Record<string, unknown>).weird).toBeUndefined();
    expect((out.artifacts[0] as unknown as Record<string, unknown>).evil).toBeUndefined();
  });
});

describe("release / artifact 级容错（跳过坏条目）", () => {
  it("版本不可解析（含 0.0.0-dev 哨兵）的 release 被跳过", () => {
    const m = manifest({
      channels: { "fnos-fpk": { releases: [release({ version: "0.0.0-dev" }), release({ version: "0.2.4" })] } },
    });
    const out = parseUpdateManifest(m).manifest.channels["fnos-fpk"]!.releases;
    expect(out.map((r) => r.version)).toEqual(["0.2.4"]);
  });

  it("minVersion 非法的 release 被跳过；null 与空串归一为 null", () => {
    const m = manifest({
      channels: {
        "fnos-fpk": {
          releases: [
            release({ version: "0.2.4", minVersion: "nope" }),
            release({ version: "0.2.5", minVersion: null }),
            release({ version: "0.2.6", minVersion: "  " }),
          ],
        },
      },
    });
    const out = parseUpdateManifest(m).manifest.channels["fnos-fpk"]!.releases;
    expect(out.map((r) => [r.version, r.minVersion])).toEqual([
      ["0.2.5", null],
      ["0.2.6", null],
    ]);
  });

  it("坏 artifact 被剔除；release 无任何合法 artifact 时整条跳过", () => {
    const good = { ...validArtifact, arch: "arm64", filename: "a.fpk" };
    const badArch = { ...validArtifact, arch: "mips" };
    const badSha = { ...validArtifact, sha256: "zzz" };
    const badDl = { ...validArtifact, download: { kind: "weird" } };
    const onlyBad = release({ version: "0.2.7", artifacts: [badSha] });
    const mixed = release({
      version: "0.2.8",
      artifacts: [good, badArch, badSha, badDl],
    });
    const m = manifest({ channels: { "fnos-fpk": { releases: [onlyBad, mixed] } } });
    const out = parseUpdateManifest(m).manifest.channels["fnos-fpk"]!.releases;
    expect(out.map((r) => r.version)).toEqual(["0.2.8"]);
    expect(out[0]!.artifacts).toHaveLength(1);
    expect(out[0]!.artifacts[0]!.arch).toBe("arm64");
  });

  it("sha256 大写被归一为小写", () => {
    const art = { ...validArtifact, sha256: "A".repeat(64) };
    const m = manifest({ channels: { "fnos-fpk": { releases: [release({ artifacts: [art] })] } } });
    expect(parseUpdateManifest(m).manifest.channels["fnos-fpk"]!.releases[0]!.artifacts[0]!.sha256).toBe("a".repeat(64));
  });

  it("releaseNotes 形状坏 / artifacts 非数组 → 跳过该 release", () => {
    const m = manifest({
      channels: {
        "fnos-fpk": {
          releases: [
            release({ version: "0.2.8", releaseNotes: { format: "markdown" } }),
            release({ version: "0.2.9", artifacts: "nope" }),
          ],
        },
      },
    });
    expect(parseUpdateManifest(m).manifest.channels["fnos-fpk"]!.releases).toHaveLength(0);
  });

  it("坏通道段被忽略，不影响其它通道", () => {
    const m = manifest({ channels: { "fnos-fpk": { releases: [release()] }, broken: { releases: "x" } } });
    const channels = parseUpdateManifest(m).manifest.channels;
    expect(channels["fnos-fpk"]!.releases).toHaveLength(1);
    expect(channels.broken).toBeUndefined();
  });
});
