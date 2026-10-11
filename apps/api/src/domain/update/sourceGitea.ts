// apps/api/src/domain/update/sourceGitea.ts
// Gitea Release 资产更新源（默认源，DESIGN §8.1 真实实测封板的硬约束）。
//
// ★ 实测硬约束（2026-10-11，真实只读 PAT 8 项实测，违反即坏）：
//   1. 禁止调 /user 端点（该 PAT 无 read:user，会 403）；只用 /repos/* 。
//   2. 私有仓 + 空 token：匿名 /repos/* 一律 404，故空 token 在出网前直接判
//      UPDATE_SOURCE_UNCONFIGURED（面板显示「更新源尚未配置」，而非网络错误）。
//   3. ★ 严禁使用 API 返回的 browser_download_url / 任何 url 字段（实测是内网
//      http://192.168.31.88:21350 地址）；资产公网地址一律用 config.giteaBaseUrl 自拼：
//        <base>/<owner>/<repo>/releases/download/<tag>/<assetName>
//   4. 鉴权只用请求头 Authorization: token <GX_UPDATE_TOKEN>，绝不放 query（会进日志/历史）。
//   5. 上游错误体绝不透传/入日志/入审计，只记 code 与 host。
//
// 取清单：GET /repos/<repo>/releases?limit=10，取【最新一个带 update-manifest.json 资产】
// 的 release。不用 /releases/latest —— 它排除 prerelease，而 S6 演练要能看到 rc 清单
//（清单本身是累积的，是否纳入 rc 候选由 service 按 allowPrerelease 裁决，源层不过滤）。

import type { UpdateConfig } from "../../configUpdate.js";
import { parseUpdateManifest, type ParsedManifest } from "./manifest.js";
import {
  fetchUpstream,
  mapUpstreamStatus,
  sourceError,
  type ArtifactRequest,
  type BuildArtifactArgs,
  type FetchLike,
  type UpdateSource,
} from "./source.js";

export const MANIFEST_ASSET_NAME = "update-manifest.json";
const RELEASE_LIST_LIMIT = 10;

/** release tag 约定：版本 0.2.3 → tag v0.2.3（兼容清单里偶发带前导 v）。 */
export function tagForVersion(version: string): string {
  const v = version.trim();
  return v.startsWith("v") ? v : `v${v}`;
}

interface GiteaAsset {
  name?: unknown;
  // 刻意不声明 browser_download_url / url：物理上杜绝误用（约束 3）。
}
interface GiteaRelease {
  tag_name?: unknown;
  assets?: unknown;
}

function authHeaders(token: string, json: boolean): Record<string, string> {
  const h: Record<string, string> = { Authorization: `token ${token}` };
  if (json) h.Accept = "application/json";
  return h;
}

export interface GiteaSourceDeps {
  fetch?: FetchLike;
}

export class GiteaUpdateSource implements UpdateSource {
  readonly kind = "gitea" as const;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly cfg: UpdateConfig,
    deps: GiteaSourceDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? (globalThis.fetch as FetchLike);
  }

  /** 自拼资产公网 URL（约束 3）：<base>/<repo>/releases/download/<tag>/<assetName>。 */
  private assetUrl(tag: string, assetName: string): string {
    const base = this.cfg.giteaBaseUrl.replace(/\/+$/, "");
    const repo = this.cfg.repo.replace(/^\/+|\/+$/g, "");
    return `${base}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
  }

  async fetchManifest(): Promise<ParsedManifest> {
    const token = this.cfg.token;
    if (!token) {
      throw sourceError(
        "UPDATE_SOURCE_UNCONFIGURED",
        "更新源尚未配置只读凭证（GX_UPDATE_TOKEN 为空）",
      );
    }

    // 1) 取 release 列表（只用 /repos/*，约束 1）。
    const listUrl = `${this.cfg.giteaBaseUrl.replace(/\/+$/, "")}/api/v1/repos/${
      this.cfg.repo
    }/releases?limit=${RELEASE_LIST_LIMIT}`;
    const listRes = await fetchUpstream(
      this.fetchImpl,
      listUrl,
      authHeaders(token, true),
      this.cfg.timeoutMs,
    );
    const listErr = mapUpstreamStatus(listRes.status);
    if (listErr) throw sourceError(listErr, "获取更新发布列表失败");
    const releases: unknown = await listRes.json().catch(() => {
      throw sourceError("UPDATE_MANIFEST_INVALID", "更新发布列表响应不是合法 JSON");
    });
    if (!Array.isArray(releases)) {
      throw sourceError("UPDATE_MANIFEST_INVALID", "更新发布列表结构非法");
    }

    // 2) 找最新一个带清单资产的 release（列表默认按新→旧；rc 期间最新即 prerelease）。
    let tag: string | null = null;
    for (const r of releases as GiteaRelease[]) {
      if (!r || typeof r !== "object" || typeof r.tag_name !== "string") continue;
      const assets = Array.isArray(r.assets) ? (r.assets as GiteaAsset[]) : [];
      const hasManifest = assets.some((a) => a && typeof a === "object" && a.name === MANIFEST_ASSET_NAME);
      if (hasManifest) {
        tag = r.tag_name;
        break;
      }
    }
    if (!tag) {
      throw sourceError("UPDATE_MANIFEST_INVALID", "最新发布缺少 update-manifest.json 资产");
    }

    // 3) 下载清单文本（自拼公网 URL，绝不读 API 的 url 字段）。
    const manifestUrl = this.assetUrl(tag, MANIFEST_ASSET_NAME);
    const mRes = await fetchUpstream(
      this.fetchImpl,
      manifestUrl,
      authHeaders(token, false),
      this.cfg.timeoutMs,
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
    if (artifact.download.kind !== "release-asset") {
      // gitea 源也支持清单里显式给的绝对 url（内网镜像覆盖），但同样不经 API 字段。
      if (artifact.download.kind === "url") {
        return { url: artifact.download.url, authed: true };
      }
      throw sourceError("UPDATE_MANIFEST_INVALID", "无法解析该更新包的下载位置");
    }
    const tag = tagForVersion(version);
    return { url: this.assetUrl(tag, artifact.download.asset), authed: true };
  }
}
