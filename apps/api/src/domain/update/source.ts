// apps/api/src/domain/update/source.ts
// UpdateSource：更新源抽象（DESIGN §3.2、§6.1、§8.1）。service 只依赖本接口，
// 不感知是 Gitea Release 资产还是内网静态直链——新增源 = 新增实现 + config.source 分派。
//
// 本文件只定义接口与共享 HTTP 原语（错误映射、超时），不含具体源地址拼装。

import type { UpdateConfig } from "../../configUpdate.js";
import type { ArtifactManifest } from "@gx/shared-types";
import type { ParsedManifest } from "./manifest.js";
import { UpdateSourceError, type UpdateSourceErrorCode } from "./types.js";

/** 发起一次需要凭证的上游 GET 的最小描述（download 层据此真正发请求并透传 Range）。 */
export interface ArtifactRequest {
  url: string;
  /** 是否需要在请求头带 GX_UPDATE_TOKEN（Gitea 私有资产 true；公网静态直链 false）。 */
  authed: boolean;
}

export interface BuildArtifactArgs {
  artifact: ArtifactManifest;
  /** 该 artifact 所属 release 的 version（release-asset 自拼 tag 路径用）。 */
  version: string;
}

export interface UpdateSource {
  readonly kind: "gitea" | "static" | "github";
  /** 拉取并解析清单；任何失败收敛为 UpdateSourceError（不透传上游响应体）。 */
  fetchManifest(signal: AbortSignal): Promise<ParsedManifest>;
  /** 依据清单 artifact 定位真实下载请求（严禁使用 API 返回的 browser_download_url）。 */
  buildArtifactRequest(args: BuildArtifactArgs): ArtifactRequest;
}

/** 可注入的 fetch 形状（测试用 stub，生产默认 globalThis.fetch）。 */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function sourceError(code: UpdateSourceErrorCode, message: string): UpdateSourceError {
  return new UpdateSourceError(code, message);
}

/**
 * 带超时地执行一次上游 GET，统一状态码 → 领域错误码映射。
 * 不抛裸 fetch 错误、不回传上游响应体（防内网地址泄漏，DESIGN §11 D5）。
 */
export async function fetchUpstream(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    return await fetchImpl(url, {
      headers,
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (err) {
    if (externalSignal?.aborted) {
      // 调用方主动取消（如客户端断开），不包装成源错误，原样抛 AbortError。
      throw err;
    }
    if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      throw sourceError("UPDATE_SOURCE_TIMEOUT", "连接更新服务超时");
    }
    // DNS / 连接拒绝 / TLS 等网络层失败：一律收敛为不可达，错误细节只进服务端日志。
    throw sourceError("UPDATE_SOURCE_UNREACHABLE", "无法连接更新服务");
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

/** 上游响应状态 → 错误（2xx/206 返回 null 表示成功）。 */
export function mapUpstreamStatus(status: number): UpdateSourceErrorCode | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) return "UPDATE_SOURCE_AUTH";
  // 私有仓匿名命中 404 时，调用方应已在「无 token」处提前判 UNCONFIGURED；
  // 走到这里的 404 视为源地址/资源不可达而非鉴权（有 token 仍 404）。
  return "UPDATE_SOURCE_UNREACHABLE";
}

export type { UpdateConfig };
