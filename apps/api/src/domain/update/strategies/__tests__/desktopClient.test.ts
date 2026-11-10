// desktop-client 声明式策略单测：平台+架构双键严格匹配（拒绝 any）、selectRelease 升级裁决、
// 安装指引 kind 与不实现 claimFromEnv（声明式通道不能被本地自认）。
import { describe, expect, it } from "vitest";
import type { ArtifactManifest, ReleaseManifest } from "@gx/shared-types";
import { CHANNEL_DESKTOP_CLIENT } from "../../channel.js";
import { desktopClientStrategy } from "../desktopClient.js";

const SHA = "a".repeat(64);

function artifact(over: Partial<ArtifactManifest> = {}): ArtifactManifest {
  return {
    arch: "arm64",
    platform: "darwin",
    filename: "GouXiang-0.3.1-arm64.dmg",
    sizeBytes: 100,
    sha256: SHA,
    download: { kind: "release-asset", asset: "GouXiang-0.3.1-arm64.dmg" },
    signature: null,
    ...over,
  };
}

function release(over: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    version: "0.3.1",
    publishedAt: "2026-11-01T08:00:00.000Z",
    prerelease: false,
    minVersion: null,
    releaseNotes: { format: "text", zh: "新增 GitHub 更新通道", en: null },
    artifacts: [
      artifact({ platform: "darwin", arch: "arm64", filename: "GouXiang-0.3.1-arm64.dmg" }),
      artifact({ platform: "darwin", arch: "x64", filename: "GouXiang-0.3.1-x64.dmg" }),
      artifact({ platform: "win32", arch: "x64", filename: "GouXiang-0.3.1-x64.msi" }),
      artifact({ platform: "linux", arch: "x64", filename: "GouXiang-0.3.1-x86_64.AppImage" }),
    ],
    ...over,
  };
}

describe("desktopClientStrategy 静态声明", () => {
  it("channelId=desktop-client、remoteDeclarable=true、指引 kind=desktop-installer", () => {
    expect(desktopClientStrategy.channelId).toBe(CHANNEL_DESKTOP_CLIENT);
    expect(desktopClientStrategy.channelId).toBe("desktop-client");
    expect(desktopClientStrategy.remoteDeclarable).toBe(true);
    expect(desktopClientStrategy.installGuideKind).toBe("desktop-installer");
  });

  it("不实现 claimFromEnv（服务端永不能本地自认为桌面通道）", () => {
    expect(desktopClientStrategy.claimFromEnv).toBeUndefined();
  });
});

describe("desktopClientStrategy.resolveArtifact 双键严格匹配", () => {
  const r = release();
  it("darwin/arm64 精确命中 .dmg", () => {
    const a = desktopClientStrategy.resolveArtifact(r, "arm64", "darwin");
    expect(a).not.toBeNull();
    expect(a!.filename).toBe("GouXiang-0.3.1-arm64.dmg");
  });
  it("darwin/x64 与 win32/x64 各自命中不同包", () => {
    expect(desktopClientStrategy.resolveArtifact(r, "x64", "darwin")!.filename).toBe(
      "GouXiang-0.3.1-x64.dmg",
    );
    expect(desktopClientStrategy.resolveArtifact(r, "x64", "win32")!.filename).toBe(
      "GouXiang-0.3.1-x64.msi",
    );
  });
  it("平台或架构不匹配 -> null（不跨平台兜底）", () => {
    expect(desktopClientStrategy.resolveArtifact(r, "arm64", "win32")).toBeNull();
    expect(desktopClientStrategy.resolveArtifact(r, "arm64", "linux")).toBeNull();
  });
  it("artifact.platform=any 拒入（不放行通吃包）", () => {
    const rAny = release({
      artifacts: [artifact({ platform: "any", arch: "arm64" })],
    });
    expect(desktopClientStrategy.resolveArtifact(rAny, "arm64", "darwin")).toBeNull();
  });
  it("artifact.arch=any 拒入（不放行通吃架构）", () => {
    const rAny = release({
      artifacts: [artifact({ platform: "darwin", arch: "any" })],
    });
    expect(desktopClientStrategy.resolveArtifact(rAny, "arm64", "darwin")).toBeNull();
  });
});

describe("desktopClientStrategy.selectRelease", () => {
  const segment = { releases: [release()] };
  it("相对当前为升级 -> 取该 release", () => {
    const picked = desktopClientStrategy.selectRelease({
      channelSegment: segment,
      currentVersion: "0.3.0",
      allowPrerelease: false,
    });
    expect(picked).not.toBeNull();
    expect(picked!.version).toBe("0.3.1");
  });
  it("无更高版本 -> null", () => {
    expect(
      desktopClientStrategy.selectRelease({
        channelSegment: segment,
        currentVersion: "0.3.1",
        allowPrerelease: false,
      }),
    ).toBeNull();
  });
  it("rc 默认不放行；allowPrerelease 后放行", () => {
    const rcSeg = { releases: [release({ version: "0.3.2-rc1", prerelease: true })] };
    expect(
      desktopClientStrategy.selectRelease({
        channelSegment: rcSeg,
        currentVersion: "0.3.1",
        allowPrerelease: false,
      }),
    ).toBeNull();
    expect(
      desktopClientStrategy.selectRelease({
        channelSegment: rcSeg,
        currentVersion: "0.3.1",
        allowPrerelease: true,
      })!.version,
    ).toBe("0.3.2-rc1");
  });
  it("多候选取最高版本（不依赖数组顺序）", () => {
    const seg = {
      releases: [
        release({ version: "0.3.2", artifacts: [artifact({ filename: "b.dmg" })] }),
        release({ version: "0.3.4", artifacts: [artifact({ filename: "d.dmg" })] }),
        release({ version: "0.3.3", artifacts: [artifact({ filename: "c.dmg" })] }),
      ],
    };
    expect(
      desktopClientStrategy.selectRelease({
        channelSegment: seg,
        currentVersion: "0.3.0",
        allowPrerelease: false,
      })!.version,
    ).toBe("0.3.4");
  });
  it("通道段缺失/空 -> null", () => {
    expect(
      desktopClientStrategy.selectRelease({
        channelSegment: undefined,
        currentVersion: "0.3.0",
        allowPrerelease: false,
      }),
    ).toBeNull();
    expect(
      desktopClientStrategy.selectRelease({
        channelSegment: { releases: [] },
        currentVersion: "0.3.0",
        allowPrerelease: false,
      }),
    ).toBeNull();
  });
});

describe("desktopClientStrategy.renderInstallGuide", () => {
  it("kind=desktop-installer，步骤为纯中文有序且含目标版本/文件名", () => {
    const guide = desktopClientStrategy.renderInstallGuide({
      version: "0.3.1",
      filename: "GouXiang-0.3.1-arm64.dmg",
      productName: "构想工作台",
    });
    expect(guide.kind).toBe("desktop-installer");
    expect(guide.steps.length).toBeGreaterThan(1);
    expect(guide.steps[0]).toContain("GouXiang-0.3.1-arm64.dmg");
    expect(guide.steps.some((s) => s.includes("0.3.1"))).toBe(true);
    // 禁嵌 HTML。
    expect(guide.steps.join("")).not.toMatch(/<[a-z]+[\s>]/i);
    expect(guide.preUpgradeNote.length).toBeGreaterThan(0);
  });
  it("filename=null 用通用占位，不输出 undefined", () => {
    const guide = desktopClientStrategy.renderInstallGuide({
      version: "0.3.1",
      filename: null,
      productName: "构想工作台",
    });
    expect(guide.steps[0]).toContain(".dmg/.msi");
    expect(guide.steps.join("")).not.toContain("undefined");
  });
});
