// apps/api/src/domain/update/sourceGithub.ts
// GitHub 公开 Release 更新源（v0.3.1 新增，DESIGN §8.1 公开源分支）。
//
// 与 Gitea 私有源的本质差异（硬约束，违反即坏）：
//   1. 匿名访问：仓是【公开仓】，全程不带 Authorization / 任何 token（authed 恒 false），
//      也不读 cfg.token；公开资产不需要只读 PAT。
//   2. 端点是 GitHub REST：GET https://api.github.com/repos/<owner>/<repo>/releases?per_page=10。
//      GitHub 强制请求带 User-Agent（缺失直接 403），并要求 Accept: application/vnd.github+json。
//   3. ★ 严禁使用 API 返回的 browser_download_url / 任何 url 字段（与 Gitea 同口径，防内网/伪造
//      地址污染；且本文件在类型层面【不声明】这些字段，物理杜绝误用）。资产公网地址一律自拼：
//        https://github.com/<owner>/<repo>/releases/download/<tag>/<assetName>
//   4. 上游错误体绝不透传/入日志/入审计，只记 code（复用 mapUpstreamStatus：403→AUTH、
//      网络失败→UNREACHABLE、清单异常→MANIFEST_INVALID）。
//   5. 仅检查/展示/下载，绝不自动安装。
//
// 选 release 逻辑与 GiteaUpdateSource 同构：取【最新一个带 update-manifest.json 资产】的 release，
// 不用 /releases/latest（排除 prerelease，而 rc 演练需要看到 rc 清单，是否纳入由 service 裁决）。

import type { UpdateConfig } from "../../configUpdate.js";
import { parseUpdateManifest, type ParsedManifest } from "./manifest.js";
import { MANIFEST_ASSET_NAME, tagForVersion } from "./sourceGitea.js";
import {
  fetchUpstream,
  mapUpstreamStatus,
  sourceError,
  type ArtifactRequest,
  type BuildArtifactArgs,
  type FetchLike,
  type UpdateSource,
} from "./source.js";

const GITHUB_API_ROOT = "https://api.github.com";
const GITHUB_DOWNLOAD_ROOT = "https://github.com";
const RELEASE_LIST_LIMIT = 10;
/** GitHub 缺失 UA 会直接 403；固定一个可识别的产品 UA。 */
const USER_AGENT = "gouxiangdb-updater";

interface GithubAsset {
  name?: unknown;
  // 刻意不声明 browser_download_url / url：物理上杜绝误用（约束 3）。
}
interface GithubRelease {
  tag_name?: unknown;
  assets?: unknown;
}

export interface GithubSourceDeps {
  fetch?: FetchLike;
}

export class GithubUpdateSource implements UpdateSource {
  readonly kind = "github" as const;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly cfg: UpdateConfig,
    deps: GithubSourceDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? (globalThis.fetch as FetchLike);
  }

  /** 自拼公开资产 URL（约束 3）：<download root>/<repo>/releases/download/<tag>/<assetName>。 */
  private assetUrl(tag: string, assetName: string): string {
    const repo = this.cfg.repo.replace(/^\/+|\/+$/g, "");
    return `${GITHUB_DOWNLOAD_ROOT}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
  }

  async fetchManifest(signal: AbortSignal): Promise<ParsedManifest> {
    // 1) 匿名取 release 列表（强制 UA + GitHub JSON Accept；不带任何凭证）。
    const listUrl =
      `${GITHUB_API_ROOT}/repos/${this.cfg.repo}/releases?per_page=${RELEASE_LIST_LIMIT}`;
    const listRes = await fetchUpstream(
      this.fetchImpl,
      listUrl,
      {
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
      },
      this.cfg.timeoutMs,
      signal,
    );
    const listErr = mapUpstreamStatus(listRes.status);
    if (listErr) throw sourceError(listErr, "获取更新发布列表失败");
    const releases: unknown = await listRes.json().catch(() => {
      throw sourceError("UPDATE_MANIFEST_INVALID", "更新发布列表响应不是合法 JSON");
    });
    if (!Array.isArray(releases)) {
      throw sourceError("UPDATE_MANIFEST_INVALID", "更新发布列表结构非法");
    }

    // 2) 找最新一个带清单资产的 release（列表默认按新→旧；与 Gitea 源同构）。
    let tag: string | null = null;
    for (const r of releases as GithubRelease[]) {
      if (!r || typeof r !== "object" || typeof r.tag_name !== "string") continue;
      const assets = Array.isArray(r.assets) ? (r.assets as GithubAsset[]) : [];
      const hasManifest = assets.some(
        (a) => a && typeof a === "object" && a.name === MANIFEST_ASSET_NAME,
      );
      if (hasManifest) {
        tag = r.tag_name;
        break;
      }
    }
    if (!tag) {
      throw sourceError("UPDATE_MANIFEST_INVALID", "最新发布缺少 update-manifest.json 资产");
    }

    // 3) 匿名下载清单文本（自拼公网 URL，绝不读 API 的 url 字段；透传外部 signal）。
    const manifestUrl = this.assetUrl(tag, MANIFEST_ASSET_NAME);
    const mRes = await fetchUpstream(
      this.fetchImpl,
      manifestUrl,
      { "User-Agent": USER_AGENT },
      this.cfg.timeoutMs,
      signal,
    );
    const mErr = mapUpstreamStatus(mRes.status);
    if (mErr) throw sourceError(mErr, "下载更新清单失败");
    const text = await mRes.text().catch(() => {
      throw sourceError("UPDATE_SOURCE_UNREACHABLE", "读取更新清单内容失败");
    });

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw sourceError("UPDATE_MANIFEST_INVALID", "更新清单不是合法 JSON");
    }
    // parseUpdateManifest 内部结构级非法会抛 UPDATE_MANIFEST_INVALID。
    return parseUpdateManifest(json);
  }

  buildArtifactRequest({ artifact, version }: BuildArtifactArgs): ArtifactRequest {
    if (artifact.download.kind === "release-asset") {
      // 公开 release 资产：按版本推 tag（与 Gitea 同一 tag 约定 v<version>），自拼匿名 URL。
      const tag = tagForVersion(version);
      return { url: this.assetUrl(tag, artifact.download.asset), authed: false };
    }
    if (artifact.download.kind === "url") {
      // 清单显式给的绝对直链（公开镜像）：同样匿名，不经 API 字段。
      return { url: artifact.download.url, authed: false };
    }
    throw sourceError("UPDATE_MANIFEST_INVALID", "无法解析该更新包的下载位置");
  }
}
