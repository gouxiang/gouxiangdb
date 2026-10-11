// apps/api/src/domain/update/sourceStatic.ts
// 直链更新源（DESIGN §5.3 GX_UPDATE_MANIFEST_URL，可指客户内网镜像）。
//
// 两种用途（由工厂按 config 决定，service 不感知）：
//   - source=static：清单直链一般是公开镜像，authed=false（GX_UPDATE_TOKEN 可为空）；
//   - source=gitea 但配了 GX_UPDATE_MANIFEST_URL（强制覆盖清单地址）：清单与资产仍属私有，
//     authed=true，带 token 头。
// 资产地址：清单里 download.kind=url 的绝对地址直取；release-asset 在直链源下无法自拼
//（没有 base 语义），判清单非法——直链源必须给绝对 url。

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

export interface StaticSourceDeps {
  fetch?: FetchLike;
}

export class StaticUpdateSource implements UpdateSource {
  readonly kind = "static" as const;
  private readonly fetchImpl: FetchLike;
  private readonly manifestUrl: string;

  constructor(
    private readonly cfg: UpdateConfig,
    /** 直链是否携带 GX_UPDATE_TOKEN（gitea 覆盖清单地址时 true）。 */
    private readonly authed: boolean,
    deps: StaticSourceDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? (globalThis.fetch as FetchLike);
    this.manifestUrl = cfg.manifestUrl;
  }

  async fetchManifest(): Promise<ParsedManifest> {
    if (!this.manifestUrl) {
      // static 源却没给清单地址 = 部署配置不完整（不是网络错误）。
      throw sourceError(
        "UPDATE_SOURCE_UNCONFIGURED",
        "直链更新源未配置清单地址（GX_UPDATE_MANIFEST_URL 为空）",
      );
    }
    if (this.authed && !this.cfg.token) {
      throw sourceError(
        "UPDATE_SOURCE_UNCONFIGURED",
        "更新源尚未配置只读凭证（GX_UPDATE_TOKEN 为空）",
      );
    }

    const headers: Record<string, string> = this.authed
      ? { Authorization: `token ${this.cfg.token}` }
      : {};
    const res = await fetchUpstream(
      this.fetchImpl,
      this.manifestUrl,
      headers,
      this.cfg.timeoutMs,
    );
    const err = mapUpstreamStatus(res.status);
    if (err) throw sourceError(err, "下载更新清单失败");

    const text = await res.text().catch(() => {
      throw sourceError("UPDATE_SOURCE_UNREACHABLE", "读取更新清单内容失败");
    });
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw sourceError("UPDATE_MANIFEST_INVALID", "更新清单不是合法 JSON");
    }
    return parseUpdateManifest(json);
  }

  buildArtifactRequest({ artifact }: BuildArtifactArgs): ArtifactRequest {
    if (artifact.download.kind !== "url") {
      // 直链源不能自拼 release-asset 路径；清单必须给绝对 url。
      throw sourceError(
        "UPDATE_MANIFEST_INVALID",
        "直链更新源的更新包必须提供绝对下载地址",
      );
    }
    return { url: artifact.download.url, authed: this.authed };
  }
}
