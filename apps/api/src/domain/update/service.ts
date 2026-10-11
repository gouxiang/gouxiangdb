// apps/api/src/domain/update/service.ts
// UpdateService：更新检查的唯一编排者（DESIGN §3.2 六层抽象的最上层、§6.1、§7.3）。
//
// 职责：识别通道身份 -> 注册表取策略 -> （TTL 缓存/单飞）拉清单 -> 选 release ->
//       判 eligible / 匹配 artifact -> 装配 UpdateStatusDTO。
// 不负责：HTTP / 鉴权 / 审计落盘（路由层）、版本读取（version.ts）、配置解析（configUpdate.ts）。
//
// 边界口径（§7.3，逐字落地）：
//   - 通道 unknown / 注册表无策略 / 清单缺该通道段      -> update=null（latest 态，不报错）；
//   - 通道存在但 releases 空（全非法或本就空）          -> 抛 UPDATE_MANIFEST_INVALID（502）；
//   - 有更高 release 但当前 arch/platform 无匹配 artifact -> update=null，verdict=no_artifact；
//   - 当前版本 < minVersion                          -> update 非空但 eligible=false / artifact=null；
//   - 当前版本不可解析（0.0.0-dev 等）                 -> 不提示升级 + current.versionUnparseable=true；
//   - 高版本 schema                                   -> newerSchema=true、update=null（弱提示，非错误）。
//
// 依赖方向：只依赖 @gx/shared-types、node 内置与同目录模块；config / fetch / 时钟 / 版本全部注入，
// 不直接 import ../../config.js（保持 domain 可在测试中无副作用装配）。

import {
  compareVersions,
  parseVersion,
  type UpdateInfoDTO,
  type UpdateStatusDTO,
} from "@gx/shared-types";
import { VERSION } from "../../version.js";
import { HttpError } from "../../httpError.js";
import type { UpdateConfig } from "../../configUpdate.js";
import { detectChannel } from "./channel.js";
import { createUpdateSource, type SourceDeps } from "./sourceFactory.js";
import type { FetchLike, UpdateSource } from "./source.js";
import type { ParsedManifest } from "./manifest.js";
import { UpdateSourceError } from "./types.js";
import { localStrategy, declarableStrategy } from "./strategies/registry.js";
import type { UpdateStrategy } from "./strategies/types.js";

/** 审计裁决词（§5.5 verdict；服务端内部词汇，测试逐字锁定）。 */
export type UpdateVerdictKind =
  | "upgrade"
  | "latest"
  | "no_artifact"
  | "below_min_version"
  | "incomparable";

/** service 返回给路由的完整结果：响应 DTO + 审计所需的去敏元信息。 */
export interface CheckResult {
  dto: UpdateStatusDTO;
  verdict: UpdateVerdictKind;
  /** 命中的候选版本（无候选为 null）；审计用，禁放 url/token。 */
  candidateVersion: string | null;
  /** 实际使用的更新源种类（gitea/static），审计用。 */
  sourceKind: UpdateSource["kind"];
}

export interface CheckParams {
  /** 远程声明通道（仅 remoteDeclarable；当前注册表无此类通道，路由传值即 400）。 */
  channel?: string;
  arch?: string;
  platform?: string;
  /** ?force=1：旁路 TTL 缓存立即拉源。 */
  force?: boolean;
}

export interface UpdateServiceDeps {
  env?: NodeJS.ProcessEnv;
  nodeArch?: string;
  nodePlatform?: string;
  /** 当前版本（默认 version.ts 的 VERSION 单一真源；测试注入）。 */
  currentVersion?: string;
  now?: () => Date;
  /** 注入桩 fetch（off/缓存计数测试用）；默认源内部走全局 fetch。 */
  fetch?: FetchLike;
  /** 源工厂注入缝（默认 sourceFactory 的 createUpdateSource）。 */
  createSource?: (cfg: UpdateConfig, deps: SourceDeps) => UpdateSource;
}

interface Identity {
  channelId: string;
  arch: string;
  platform: string;
  strategy: UpdateStrategy | null;
}

interface CacheEntry {
  parsed: ParsedManifest;
  fetchedAtMs: number;
  inflight: Promise<ParsedManifest> | null;
}

/** 身份组合上限（channel:arch:platform，§5.4「最多十余条」）；超出淘汰最旧条目。 */
const MAX_CACHE_KEYS = 16;

export class UpdateService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly nodeArch: string;
  private readonly nodePlatform: string;
  private readonly currentVersion: string;
  private readonly now: () => Date;
  private readonly source: UpdateSource;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly cfg: UpdateConfig,
    deps: UpdateServiceDeps = {},
  ) {
    this.env = deps.env ?? process.env;
    this.nodeArch = deps.nodeArch ?? process.arch;
    this.nodePlatform = deps.nodePlatform ?? process.platform;
    this.currentVersion = deps.currentVersion ?? VERSION;
    this.now = deps.now ?? (() => new Date());
    const sourceDeps: SourceDeps = deps.fetch ? { fetch: deps.fetch } : {};
    this.source = deps.createSource
      ? deps.createSource(cfg, sourceDeps)
      : createUpdateSource(cfg, sourceDeps);
  }

  /**
   * 执行一次更新检查。源层错误以 UpdateSourceError 原样抛给路由（映射 502/504）；
   * 参数身份非法抛 HttpError(400)。
   */
  async check(params: CheckParams = {}): Promise<CheckResult> {
    const identity = this.resolveIdentity(params);
    const current = {
      version: this.currentVersion,
      versionUnparseable: !parseVersion(this.currentVersion).valid,
      channel: identity.channelId,
      arch: identity.arch,
      platform: identity.platform,
    };
    const checkedAt = this.now().toISOString();

    const strategy = identity.strategy;
    // unknown 通道（注册表无策略）：不拉源、不报错（§7.3）。裸机/开发环境未配通道时这样
    // 既无意义出网，也避免未配 token 被误报成 502——面板显示「未识别的部署方式」+ latest。
    if (!strategy) {
      return this.result(
        { enabled: true, current, update: null, checkedAt, newerSchema: false },
        "latest",
        null,
      );
    }

    // 当前版本不可解析（0.0.0-dev 等哨兵/被改坏的注入值）：fail-safe，不提示任何升级，
    // 也不拉源（§4.1 规则 6）——开发兜底版本下触网毫无意义且可能在无 token 时误报。
    if (current.versionUnparseable) {
      return this.result(
        { enabled: true, current, update: null, checkedAt, newerSchema: false },
        "incomparable",
        null,
      );
    }

    const parsed = await this.fetchManifest(params.force === true, identity);

    // 高版本清单：弱提示 + 不报错（parse 层已把 channels 裁为空）。
    if (parsed.newerSchema) {
      return this.result(
        { enabled: true, current, update: null, checkedAt, newerSchema: true },
        "latest",
        null,
      );
    }

    // 清单缺该通道段：latest 态，不报错（§7.3 / §4.1 规则 10）。
    const segment = parsed.manifest.channels[strategy.channelId];
    if (!segment) {
      return this.result(
        { enabled: true, current, update: null, checkedAt, newerSchema: false },
        "latest",
        null,
      );
    }
    // 通道存在但 releases 空（结构层净化后一条合法条目都没有）= 清单不可用（§7.3）。
    if (segment.releases.length === 0) {
      throw new UpdateSourceError(
        "UPDATE_MANIFEST_INVALID",
        `更新清单通道 ${strategy.channelId} 内无合法发布条目`,
      );
    }

    const release = strategy.selectRelease({
      channelSegment: segment,
      currentVersion: this.currentVersion,
      allowPrerelease: this.cfg.allowPrerelease,
    });
    if (!release) {
      return this.result(
        { enabled: true, current, update: null, checkedAt, newerSchema: false },
        "latest",
        null,
      );
    }

    // minVersion 门槛：仍告知有新版，但不给 artifact / 下载（§4.1 规则 8）。
    const minVersion = release.minVersion ?? "0.0.0";
    const minCmp = compareVersions(this.currentVersion, minVersion);
    if (minCmp !== null && minCmp < 0) {
      const update: UpdateInfoDTO = {
        version: release.version,
        publishedAt: release.publishedAt,
        releaseNotes: { format: release.releaseNotes.format, zh: release.releaseNotes.zh },
        minVersion: release.minVersion,
        eligible: false,
        ineligibleReason: "below_min_version",
        artifact: null,
        manualInstallGuide: strategy.renderInstallGuide({
          version: release.version,
          filename: null,
        }),
      };
      return this.result(
        { enabled: true, current, update, checkedAt, newerSchema: false },
        "below_min_version",
        release.version,
      );
    }

    const artifact = strategy.resolveArtifact(release, identity.arch, identity.platform);
    if (!artifact) {
      // 有更高版本但当前架构/平台没有可下载包：发布事故可见，latest 态不报错（§7.3）。
      return this.result(
        { enabled: true, current, update: null, checkedAt, newerSchema: false },
        "no_artifact",
        release.version,
      );
    }

    const update: UpdateInfoDTO = {
      version: release.version,
      publishedAt: release.publishedAt,
      releaseNotes: { format: release.releaseNotes.format, zh: release.releaseNotes.zh },
      minVersion: release.minVersion,
      eligible: true,
      ineligibleReason: null,
      artifact: {
        arch: artifact.arch,
        platform: artifact.platform,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
      },
      manualInstallGuide: strategy.renderInstallGuide({
        version: release.version,
        filename: artifact.filename,
      }),
    };
    return this.result(
      { enabled: true, current, update, checkedAt, newerSchema: false },
      "upgrade",
      release.version,
    );
  }

  // -- 内部 -----------------------------------------------------------------

  /**
   * 身份快照（供路由在源错误时也能写出有意义的审计：通道/架构/平台/当前版本）。
   * 参数通道声明非法时与 check() 同样抛 HttpError(400)。
   */
  identitySnapshot(params: CheckParams = {}): {
    channel: string;
    arch: string;
    platform: string;
    currentVersion: string;
    versionUnparseable: boolean;
  } {
    const id = this.resolveIdentity(params);
    return {
      channel: id.channelId,
      arch: id.arch,
      platform: id.platform,
      currentVersion: this.currentVersion,
      versionUnparseable: !parseVersion(this.currentVersion).valid,
    };
  }

  private result(
    dto: UpdateStatusDTO,
    verdict: UpdateVerdictKind,
    candidateVersion: string | null,
  ): CheckResult {
    return { dto, verdict, candidateVersion, sourceKind: this.source.kind };
  }

  /**
   * 解析请求身份：声明通道（仅 declarable，当前必 400）或本地探测。
   * channelOverride 经 env 注入（GX_UPDATE_CHANNEL），探测层做注册表合法性裁决。
   */
  private resolveIdentity(params: CheckParams): Identity {
    if (params.channel !== undefined) {
      const strategy = declarableStrategy(params.channel);
      if (!strategy) {
        throw new HttpError(400, "请求参数有误：不支持的更新通道声明", "BAD_REQUEST");
      }
      return {
        channelId: strategy.channelId,
        arch: params.arch ?? this.nodeArch,
        platform: params.platform ?? this.nodePlatform,
        strategy,
      };
    }
    const detected = detectChannel({
      env: this.env,
      nodeArch: this.nodeArch,
      nodePlatform: this.nodePlatform,
    });
    return {
      channelId: detected.channelId,
      arch: detected.arch,
      platform: detected.platform,
      strategy: localStrategy(detected.channelId),
    };
  }

  private cacheKey(id: Identity): string {
    return `${id.channelId}|${id.arch}|${id.platform}`;
  }

  /**
   * 取清单：TTL 内直接复用；同键并发复用同一个 in-flight Promise（单飞防击穿）；
   * force 旁路缓存但刷新结果仍回填。任何源错误不写缓存（下次点击可重试）。
   */
  private async fetchManifest(force: boolean, id: Identity): Promise<ParsedManifest> {
    const key = this.cacheKey(id);
    const nowMs = this.now().getTime();

    if (!force) {
      const hit = this.cache.get(key);
      if (hit) {
        if (hit.inflight) return hit.inflight;
        if (nowMs - hit.fetchedAtMs < this.cfg.cacheTtlMs) return hit.parsed;
        this.cache.delete(key);
      }
    }

    // force（或缓存失效）：占位 in-flight。若旧条目在途（仅可能由上一个 force 造成），
    // 其落地回调按 generation 校验，不会覆盖本次新条目（见 settle 内 key 身份比对）。
    const entry: CacheEntry = { parsed: null as unknown as ParsedManifest, fetchedAtMs: 0, inflight: null };
    const promise = this.source.fetchManifest(new AbortController().signal).then(
      (parsed) => {
        const cur = this.cache.get(key);
        if (cur !== entry) return parsed; // 已被更新的 force 取代：不污染新条目
        entry.parsed = parsed;
        entry.fetchedAtMs = this.now().getTime();
        entry.inflight = null;
        this.evictIfNeeded();
        return parsed;
      },
      (err: unknown) => {
        if (this.cache.get(key) === entry) this.cache.delete(key);
        throw err;
      },
    );
    entry.inflight = promise;
    this.cache.set(key, entry);
    this.evictIfNeeded();
    return promise;
  }

  /** 有界 Map：超上限淘汰最旧且非在途的条目（§5.4）。 */
  private evictIfNeeded(): void {
    while (this.cache.size > MAX_CACHE_KEYS) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) return;
      const entry = this.cache.get(oldest);
      // 最旧条目在途则跳过它找下一个；全都在途（极端）就允许临时超限，等其落地后再回收。
      if (entry?.inflight) {
        let removed = false;
        for (const [k, e] of this.cache) {
          if (!e.inflight) {
            this.cache.delete(k);
            removed = true;
            break;
          }
        }
        if (!removed) return;
      } else {
        this.cache.delete(oldest);
      }
    }
  }
}
