// UpdateService 编排层单测（DESIGN §6.1/§7.3/§4.1 全边界）。
//
// 身份（linux/x64、fnos-fpk）、当前版本、时钟、更新源全部注入：用一个可编排的假 UpdateSource
// 精确控制 manifest / 源错误 / 调用计数，不起 HTTP、不触真网、不读 config 单例。
// HTTP 状态映射/鉴权/审计落盘在 routes/v1 真 app 集成测试里另验。

import { describe, expect, it } from "vitest";
import type { UpdateConfig } from "../../../configUpdate.js";
import type {
  ArtifactManifest,
  ReleaseManifest,
  UpdateManifest,
} from "@gx/shared-types";
import { UpdateService, type UpdateServiceDeps } from "../service.js";
import { UpdateSourceError } from "../types.js";
import type {
  ArtifactRequest,
  BuildArtifactArgs,
  UpdateSource,
} from "../source.js";
import type { ParsedManifest } from "../manifest.js";

const SHA = "a".repeat(64);

function artifact(over: Partial<ArtifactManifest> = {}): ArtifactManifest {
  return {
    arch: "x64",
    platform: "linux",
    filename: "gouxiangdb-0.2.3-x86.fpk",
    sizeBytes: 63_074_943,
    sha256: SHA,
    download: { kind: "release-asset", asset: "gouxiangdb-0.2.3-x86.fpk" },
    signature: null,
    ...over,
  };
}

function release(over: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    version: "0.2.3",
    publishedAt: "2026-10-20T08:00:00.000Z",
    prerelease: false,
    minVersion: null,
    releaseNotes: { format: "text", zh: "修复若干问题", en: null },
    artifacts: [artifact()],
    ...over,
  };
}

function manifest(channels: UpdateManifest["channels"], newerSchema = false): ParsedManifest {
  return {
    manifest: {
      schemaVersion: 1,
      product: "gouxiangdb",
      generatedAt: "2026-10-20T08:00:00.000Z",
      channels,
    },
    newerSchema,
  };
}

/** 可编排假源：按队列返回 manifest / 抛错，并计数 fetchManifest 调用。 */
class FakeSource implements UpdateSource {
  readonly kind = "gitea" as const;
  calls = 0;
  constructor(private readonly produce: () => ParsedManifest) {}
  async fetchManifest(): Promise<ParsedManifest> {
    this.calls += 1;
    return this.produce();
  }
  buildArtifactRequest(_args: BuildArtifactArgs): ArtifactRequest {
    return { url: "http://example.invalid/a.fpk", authed: true };
  }
}

function baseConfig(over: Partial<UpdateConfig> = {}): UpdateConfig {
  return {
    enabled: true,
    source: "gitea",
    giteaBaseUrl: "https://gitea.example",
    repo: "o/r",
    manifestUrl: "",
    token: "t",
    channelOverride: "fnos-fpk",
    allowPrerelease: false,
    timeoutMs: 8000,
    downloadIdleTimeoutMs: 30000,
    cacheTtlMs: 300000,
    ticketTtlMs: 120000,
    ...over,
  };
}

function deps(
  source: UpdateSource,
  over: Partial<UpdateServiceDeps> = {},
): UpdateServiceDeps {
  return {
    env: { GX_UPDATE_CHANNEL: "fnos-fpk" },
    nodeArch: "x64",
    nodePlatform: "linux",
    currentVersion: "0.2.2",
    createSource: () => source,
    ...over,
  };
}

function service(
  source: UpdateSource,
  over: Partial<UpdateServiceDeps> = {},
  cfgOver: Partial<UpdateConfig> = {},
) {
  return new UpdateService(baseConfig(cfgOver), deps(source, over));
}

describe("UpdateService happy / latest", () => {
  it("发现更高版本 -> upgrade DTO（artifact 五字段 + 指引 + 无 download/url 泄漏）", async () => {
    const src = new FakeSource(() =>
      manifest({ "fnos-fpk": { releases: [release()] } }));
    const r = await service(src).check();
    expect(r.verdict).toBe("upgrade");
    expect(r.candidateVersion).toBe("0.2.3");
    expect(r.sourceKind).toBe("gitea");
    const dto = r.dto;
    expect(dto.enabled).toBe(true);
    expect(dto.current).toEqual({
      version: "0.2.2",
      versionUnparseable: false,
      channel: "fnos-fpk",
      arch: "x64",
      platform: "linux",
    });
    expect(dto.newerSchema).toBe(false);
    expect(dto.update).not.toBeNull();
    expect(dto.update).toMatchObject({
      version: "0.2.3",
      eligible: true,
      ineligibleReason: null,
      minVersion: null,
      artifact: {
        arch: "x64",
        platform: "linux",
        filename: "gouxiangdb-0.2.3-x86.fpk",
        sizeBytes: 63_074_943,
        sha256: SHA,
      },
    });
    // DTO 中绝不带下载 URL / 鉴权信息。
    expect(JSON.stringify(dto)).not.toMatch(/http|token|authorization/i);
    expect(dto.update!.manualInstallGuide.kind).toBe("fnos-upload");
    expect(dto.update!.manualInstallGuide.steps).toHaveLength(5);
    expect(dto.update!.manualInstallGuide.steps[0]).toContain("gouxiangdb-0.2.3-x86.fpk");
    expect(dto.update!.manualInstallGuide.preUpgradeNote).toContain("在线备份");
  });

  it("候选不高于当前 -> latest / update=null", async () => {
    const src = new FakeSource(() =>
      manifest({ "fnos-fpk": { releases: [release({ version: "0.2.2" })] } }));
    const r = await service(src).check();
    expect(r.verdict).toBe("latest");
    expect(r.dto.update).toBeNull();
    expect(r.candidateVersion).toBeNull();
  });

  it("候选更低（降级条） -> latest，不提示", async () => {
    const src = new FakeSource(() =>
      manifest({ "fnos-fpk": { releases: [release({ version: "0.2.1" })] } }));
    const r = await service(src).check();
    expect(r.verdict).toBe("latest");
    expect(r.dto.update).toBeNull();
  });

  it("多条目时取相对当前为升级的最高版本（不依赖数组顺序）", async () => {
    const src = new FakeSource(() =>
      manifest({
        "fnos-fpk": {
          releases: [
            release({ version: "0.2.4", artifacts: [artifact({ filename: "f4.fpk" })] }),
            release({ version: "0.2.3", artifacts: [artifact({ filename: "f3.fpk" })] }),
            release({ version: "0.2.5", artifacts: [artifact({ filename: "f5.fpk" })] }),
          ],
        },
      }));
    const r = await service(src).check();
    expect(r.verdict).toBe("upgrade");
    expect(r.dto.update!.version).toBe("0.2.5");
    expect(r.dto.update!.artifact!.filename).toBe("f5.fpk");
  });

  it("数值版本比较：0.10.0 > 0.9.0（非字符串比较）", async () => {
    const src = new FakeSource(() =>
      manifest({ "fnos-fpk": { releases: [release({ version: "0.10.0" })] } }));
    const r = await service(src, { currentVersion: "0.9.5" }).check();
    expect(r.verdict).toBe("upgrade");
    expect(r.dto.update!.version).toBe("0.10.0");
  });
});

describe("UpdateService 预发布", () => {
  it("rc 默认不放行 -> latest", async () => {
    const src = new FakeSource(() =>
      manifest({ "fnos-fpk": { releases: [release({ version: "0.2.3-rc1", prerelease: true })] } }));
    const r = await service(src).check();
    expect(r.verdict).toBe("latest");
    expect(r.dto.update).toBeNull();
  });

  it("allowPrerelease 放行 -> upgrade 到 rc", async () => {
    const src = new FakeSource(() =>
      manifest({ "fnos-fpk": { releases: [release({ version: "0.2.3-rc1", prerelease: true })] } }));
    const r = new UpdateService(
      baseConfig({ allowPrerelease: true }),
      deps(src),
    ).check();
    const x = await r;
    expect(x.verdict).toBe("upgrade");
    expect(x.dto.update!.version).toBe("0.2.3-rc1");
  });

  it("正式版优先：同 x.y.z 正式版高于 rc（数组里 rc 在前）", async () => {
    const src = new FakeSource(() =>
      manifest({
        "fnos-fpk": {
          releases: [
            release({ version: "0.2.3-rc1", prerelease: true }),
            release({ version: "0.2.3" }),
          ],
        },
      }));
    const r = await service(src).check();
    expect(r.verdict).toBe("upgrade");
    expect(r.dto.update!.version).toBe("0.2.3");
  });
});

describe("UpdateService 边界（§7.3）", () => {
  it("unknown 通道 -> latest，且零出网（不调 fetchManifest）", async () => {
    const src = new FakeSource(() => manifest({}));
    const r = await service(src, { env: {} }).check();
    expect(r.dto.current.channel).toBe("unknown");
    expect(r.verdict).toBe("latest");
    expect(r.dto.update).toBeNull();
    expect(src.calls).toBe(0);
  });

  it("当前版本不可解析（0.0.0-dev） -> incomparable + versionUnparseable，零出网", async () => {
    const src = new FakeSource(() =>
      manifest({ "fnos-fpk": { releases: [release()] } }));
    const r = await service(src, { currentVersion: "0.0.0-dev" }).check();
    expect(r.dto.current.versionUnparseable).toBe(true);
    expect(r.verdict).toBe("incomparable");
    expect(r.dto.update).toBeNull();
    expect(src.calls).toBe(0);
  });

  it("清单缺本通道段（仅 desktop-client） -> latest", async () => {
    const src = new FakeSource(() =>
      manifest({ "desktop-client": { releases: [release()] } }));
    const r = await service(src).check();
    expect(r.verdict).toBe("latest");
    expect(r.dto.update).toBeNull();
  });

  it("通道存在但 releases 空 -> UPDATE_MANIFEST_INVALID", async () => {
    const src = new FakeSource(() => manifest({ "fnos-fpk": { releases: [] } }));
    await expect(service(src).check()).rejects.toMatchObject({
      name: "UpdateSourceError",
      code: "UPDATE_MANIFEST_INVALID",
    });
  });

  it("高版本 schema -> newerSchema=true / update=null（弱提示，非错误）", async () => {
    const src = new FakeSource(() => manifest({}, true));
    const r = await service(src).check();
    expect(r.dto.newerSchema).toBe(true);
    expect(r.dto.update).toBeNull();
    expect(r.verdict).toBe("latest");
  });

  it("有更高版本但当前架构无 artifact -> no_artifact / update=null / 带候选版本", async () => {
    const src = new FakeSource(() =>
      manifest({
        "fnos-fpk": { releases: [release({ artifacts: [artifact({ arch: "arm64" })] })] },
      }));
    const r = await service(src, { nodeArch: "x64", nodePlatform: "linux" }).check();
    expect(r.verdict).toBe("no_artifact");
    expect(r.dto.update).toBeNull();
    expect(r.candidateVersion).toBe("0.2.3");
  });

  it("fnos：platform=darwin 即便 arch 匹配也 no_artifact（platform 禁 any）", async () => {
    const src = new FakeSource(() =>
      manifest({ "fnos-fpk": { releases: [release()] } }));
    const r = await service(src, { nodeArch: "x64", nodePlatform: "darwin" }).check();
    expect(r.verdict).toBe("no_artifact");
    expect(r.dto.update).toBeNull();
  });

  it("fnos：artifact.arch=any 不放行（严格相等）", async () => {
    const src = new FakeSource(() =>
      manifest({
        "fnos-fpk": {
          releases: [release({ artifacts: [artifact({ arch: "any" })] })],
        },
      }));
    const r = await service(src).check();
    expect(r.verdict).toBe("no_artifact");
  });

  it("当前版本 < minVersion -> update 非空但 eligible=false/artifact=null/below_min_version", async () => {
    const src = new FakeSource(() =>
      manifest({
        "fnos-fpk": { releases: [release({ minVersion: "0.3.0" })] },
      }));
    const r = await service(src, { currentVersion: "0.2.2" }).check();
    expect(r.verdict).toBe("below_min_version");
    expect(r.candidateVersion).toBe("0.2.3");
    expect(r.dto.update).not.toBeNull();
    expect(r.dto.update).toMatchObject({
      version: "0.2.3",
      eligible: false,
      ineligibleReason: "below_min_version",
      artifact: null,
    });
    // below-min 仍下发指引，filename 用通用占位（步骤 1 不含具体文件名）。
    expect(r.dto.update!.manualInstallGuide.kind).toBe("fnos-upload");
    expect(r.dto.update!.manualInstallGuide.steps[0]).toContain("升级包");
  });

  it("当前版本恰好等于 minVersion -> eligible", async () => {
    const src = new FakeSource(() =>
      manifest({ "fnos-fpk": { releases: [release({ minVersion: "0.2.2" })] } }));
    const r = await service(src).check();
    expect(r.verdict).toBe("upgrade");
    expect(r.dto.update!.eligible).toBe(true);
  });
});

describe("UpdateService 源错误收敛", () => {
  it("UNCONFIGURED / AUTH / UNREACHABLE / TIMEOUT 原样透传 UpdateSourceError", async () => {
    const codes = [
      "UPDATE_SOURCE_UNCONFIGURED",
      "UPDATE_SOURCE_AUTH",
      "UPDATE_SOURCE_UNREACHABLE",
      "UPDATE_SOURCE_TIMEOUT",
    ] as const;
    for (const code of codes) {
      const src = new FakeSource(() => {
        throw new UpdateSourceError(code, "x");
      });
      const svc = service(src);
      await expect(svc.check()).rejects.toMatchObject({ name: "UpdateSourceError", code });
    }
  });

  it("源抛非 UpdateSourceError 不被吞（交由全局 500）", async () => {
    const src = new FakeSource(() => {
      throw new Error("boom");
    });
    await expect(service(src).check()).rejects.toThrow("boom");
  });
});

describe("UpdateService TTL 缓存 / 单飞 / force", () => {
  it("TTL 内第二次检查复用缓存，不重复打源", async () => {
    const src = new FakeSource(() =>
      manifest({ "fnos-fpk": { releases: [release()] } }));
    const svc = service(src, { now: (() => { let t = 1_000_000; return () => new Date(t += 1000); })() });
    await svc.check();
    await svc.check();
    expect(src.calls).toBe(1);
  });

  it("超过 TTL 重新打源", async () => {
    let t = 1_000_000;
    const src = new FakeSource(() =>
      manifest({ "fnos-fpk": { releases: [release()] } }));
    const svc = new UpdateService(baseConfig({ cacheTtlMs: 100 }), {
      ...deps(src),
      now: () => new Date(t),
    });
    await svc.check();
    t += 200;
    await svc.check();
    expect(src.calls).toBe(2);
  });

  it("force=1 旁路缓存立即打源", async () => {
    const src = new FakeSource(() =>
      manifest({ "fnos-fpk": { releases: [release()] } }));
    const svc = service(src);
    await svc.check();
    await svc.check({ force: true });
    expect(src.calls).toBe(2);
  });

  it("同键并发只打一次源（单飞防击穿）", async () => {
    const src = new FakeSource(() =>
      manifest({ "fnos-fpk": { releases: [release()] } }));
    const svc = service(src);
    const [a, b] = await Promise.all([svc.check(), svc.check()]);
    expect(src.calls).toBe(1);
    expect(a.dto.update!.version).toBe(b.dto.update!.version);
  });

  it("源失败不写缓存：下次点击重试", async () => {
    let fail = true;
    const src = new FakeSource(() => {
      if (fail) throw new UpdateSourceError("UPDATE_SOURCE_UNREACHABLE", "x");
      return manifest({ "fnos-fpk": { releases: [release()] } });
    });
    const svc = service(src);
    await expect(svc.check()).rejects.toMatchObject({ code: "UPDATE_SOURCE_UNREACHABLE" });
    fail = false;
    const r = await svc.check();
    expect(r.verdict).toBe("upgrade");
    expect(src.calls).toBe(2);
  });
});

describe("UpdateService 声明通道（remoteDeclarable）", () => {
  it("当前注册表无声明式通道：channel query 传任何值 -> 400 BAD_REQUEST", async () => {
    const src = new FakeSource(() => manifest({}));
    const svc = service(src);
    for (const ch of ["fnos-fpk", "source-bare", "desktop-client", "nope"]) {
      await expect(
        svc.check({ channel: ch, arch: "x64", platform: "linux" }),
      ).rejects.toMatchObject({ status: 400, code: "BAD_REQUEST" });
    }
    // 声明被拒绝不触网。
    expect(src.calls).toBe(0);
  });
});

describe("UpdateService 身份快照（供错误审计）", () => {
  it("返回通道/架构/平台/版本/可解析标记", () => {
    const src = new FakeSource(() => manifest({}));
    const snap = service(src).identitySnapshot();
    expect(snap).toEqual({
      channel: "fnos-fpk",
      arch: "x64",
      platform: "linux",
      currentVersion: "0.2.2",
      versionUnparseable: false,
    });
  });
});
