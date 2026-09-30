// M5/S4 EmbeddingProvider 契约与模式解析（cloud/off 两态；local 仅留未来位）。
//
// 权威依据：M5-implementation-plan §4.4（接口与配置表）、§1.7（cloud 单一 OpenAI 兼容契约）。
// 本文件只放接口/类型/纯常量/纯解析：不触网、不读库、不做加解密（加解密在 embeddingConfig.ts）。

import type {
  EmbeddingProviderKind,
  MultimodalEmbedItem,
} from "@gx/shared-types";
//
// 形态纪律（§0.3 C-EMB-1 已裁决：回归 cloud/off，取消 local）：
//   - 本期只实现 offProvider 与 cloudProvider；不引本地推理/transformers/onnx/模型权重。
//   - EmbeddingMode 联合类型刻意不含 "local"；未来加 local = 新增 embedding/local.ts 实现本接口
//     + optionalDependencies，接口/search.db schema/RRF/scope 收敛均不随之改动（ARCH §7.2 未来位）。

/** 嵌入模式：off=纯 FTS/LIKE 不触网；cloud=OpenAI 兼容 /v1/embeddings。未知值保守回 off。 */
export type EmbeddingMode = "off" | "cloud";

/** cloud 批量默认大小（§4.4 配置表）。 */
export const DEFAULT_BATCH_SIZE = 64;
/** cloud 单次请求默认超时（毫秒，GX_EMBEDDING_TIMEOUT_MS 可覆盖）。 */
export const DEFAULT_TIMEOUT_MS = 15000;
/** 单条文本在 provider 边界的防御性截断字符数（按码点；抽文本层在 chunks，本片只兜底，§4.4）。 */
export const MAX_TEXT_CHARS = 8000;
/** cloud 网络错/5xx/超时的最大尝试次数（首次 + 2 次重试 = 3，§4.4）。 */
export const MAX_ATTEMPTS = 3;
/** 单批在飞远端请求并发默认上限（真消费：喂 provider 信号量）。 */
export const DEFAULT_CONCURRENCY = 4;
/** 并发上限：再高只会压垮自建服务与本机，不给无界值。 */
export const CONCURRENCY_MAX = 64;
/** 手动指定的维度允许区间（越界即拒绝，避免写坏 vec 表）。 */
export const DIM_MIN = 1;
export const DIM_MAX = 4096;
/** 重试次数上限（首次 + 退避重试）。 */
export const RETRY_MAX_ATTEMPTS = 10;
/** cloud 重试指数退避基数（毫秒）；1s -> 2s（受上限钳制）。测试可注入更小值。 */
export const DEFAULT_RETRY_BASE_MS = 1000;
/** 退避上限（毫秒），避免长退避堆积。 */
export const MAX_RETRY_DELAY_MS = 8000;
/** 401/403 后连续失败到此阈值即固定 unhealthy（§4.4 与门，health 周期 60s 由 S5/S7 接）。 */
export const AUTH_FAILURE_MARK = "unauthorized";

/**
 * 解析模式字符串：仅 "cloud"（大小写不敏感、去空白）启用 cloud；
 * 其它一切值（undefined/空串/未知/"local"）一律保守回 "off"——宁可不向量化也不意外触网。
 */
export function parseEmbeddingMode(raw: string | undefined): EmbeddingMode {
  return raw?.trim().toLowerCase() === "cloud" ? "cloud" : "off";
}

/**
 * 解析远端服务形态（本次新增）。向后兼容是硬要求：老库根本没有 embedding.provider 键，
 * undefined/空串/未知值一律回 "cloud"（与既有 cloud 行为完全一致），绝不因缺字段报错。
 * 已知值解析大小写不敏感（"Self-Hosted" 认作 self-hosted）。
 */
export function parseEmbeddingProvider(raw: string | undefined): EmbeddingProviderKind {
  const v = raw?.trim().toLowerCase();
  if (v === "openai-compatible" || v === "self-hosted") return v;
  return "cloud";
}

/** 健康探测结果（health() 不抛，失败也返回结构化结论供 status 端点用）。 */
export interface EmbeddingHealth {
  ok: boolean;
  latencyMs?: number;
  detail?: string;
}

/**
 * 嵌入提供者接口（§4.4）。
 * - dim：cloud 为首次成功 embed 的返回长度（0 表示尚未探测）；off 恒 0。model/dim 变更触发 reindex。
 * - embed：返回与入参【等长、同序】（cloud 内部按响应 data[].index 对齐，不假设远端顺序）。
 * - dispose：cloud/off 均 no-op；预留给未来 LocalEmbeddingProvider 终止 Worker。
 */
export interface EmbeddingProvider {
  readonly mode: EmbeddingMode;
  readonly model: string;
  readonly dim: number;
  readonly batchSize: number;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
  /**
   * 多模态向量化（#563）：cloud（doubao-embedding-vision）实现；off 无此方法。
   * 每个 MultimodalEmbedItem（文本 + 图片）返回【一个】向量；不支持时由调用方回退纯文本 embed。
   */
  embedMultimodal?(
    items: readonly MultimodalEmbedItem[],
  ): Promise<Float32Array[]>;
  health(): Promise<EmbeddingHealth>;
  dispose?(): Promise<void>;
}

/** cloud 构造所需的全部配置（由 embeddingConfig 层从 env/app_settings 汇出后提供）。 */
export interface CloudProviderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  batchSize: number;
  timeoutMs: number;
  /** 并发上限（缺省回 DEFAULT_CONCURRENCY）；CloudDeps 同名注入优先，便于测试覆盖。 */
  concurrency?: number;
  /** 最大尝试次数（缺省回 MAX_ATTEMPTS）。 */
  retryMaxAttempts?: number;
  /** 退避基数毫秒（缺省回 DEFAULT_RETRY_BASE_MS）。 */
  retryBaseMs?: number;
}

/** cloud 提供者是否具备启用条件：mode=cloud 且 baseURL/apiKey/model 三者非空白。 */
export function cloudConfigUsable(cfg: Partial<CloudProviderConfig> | undefined): boolean {
  if (!cfg) return false;
  return Boolean(cfg.baseURL?.trim() && cfg.apiKey?.trim() && cfg.model?.trim());
}

/**
 * 归一 baseURL + path（§1.7/§4.4），兼容火山方舟 /api/v3 等版本段：
 *   - 去掉末尾斜杠；
 *   - pathname 末段若是版本段（/v1、/v2、/v3…，正则 /^\/v\d+$/）则原样保留；
 *   - 末段不是版本段（根域名、/api/plan 等）则兜底补 /v1；
 *   - 再拼 /embeddings。
 * 例：
 *   https://h/v1/                       -> https://h/v1/embeddings
 *   https://h                          -> https://h/v1/embeddings
 *   https://ark.../api/v3              -> https://ark.../api/v3/embeddings
 *   https://ark.../api/plan/v3         -> https://ark.../api/plan/v3/embeddings
 * query/hash（?x=1#f）原样保留在末尾。纯字符串函数，不校验可达性。
 */
export function buildEmbeddingsEndpoint(baseURL: string): string {
  const raw = baseURL.trim();
  const sep = raw.search(/[?#]/);
  const cut = sep === -1 ? raw.length : sep;
  const pathPart = raw.slice(0, cut).replace(/\/+$/, "");
  const suffix = raw.slice(cut);
  const lastSeg = pathPart.slice(pathPart.lastIndexOf("/") + 1);
  const root = /^v\d+$/.test(lastSeg) ? pathPart : `${pathPart}/v1`;
  return `${root}/embeddings${suffix}`;
}

/** provider/网络失败的错误分类，驱动重试与 unhealthy 决策。 */
export type EmbedErrorKind = "auth" | "client" | "server" | "timeout" | "network" | "empty";

export class EmbeddingError extends Error {
  readonly kind: EmbedErrorKind;
  readonly status?: number;
  constructor(kind: EmbedErrorKind, message: string, status?: number) {
    super(message);
    this.name = "EmbeddingError";
    this.kind = kind;
    this.status = status;
  }
}

/** 按 HTTP 状态码归类：401/403=auth（不重试）；其余 4xx=client（不重试）；5xx=server（重试）。 */
export function classifyStatus(status: number): EmbedErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status >= 400 && status < 500) return "client";
  return "server";
}

/** 该错误种类是否可重试：仅 server/timeout/network；auth/client 立即失败不重试（§4.4）。 */
export function isRetryableKind(kind: EmbedErrorKind): boolean {
  return kind === "server" || kind === "timeout" || kind === "network";
}

/** 指数退避延迟：第 attempt 次失败后等待（attempt 从 1 起）；base*2^(attempt-1)，上限钳制。 */
export function retryDelayMs(attempt: number, base: number = DEFAULT_RETRY_BASE_MS): number {
  const exp = Math.min(2 ** Math.max(0, attempt - 1), 2 ** 10);
  return Math.min(base * exp, MAX_RETRY_DELAY_MS);
}

/** 防御性截断：按码点截断到 max 字符（Array.from 正确处理代理对，不切半个 emoji）。 */
export function clampText(text: string, max: number = MAX_TEXT_CHARS): string {
  const pts = Array.from(text);
  return pts.length > max ? pts.slice(0, max).join("") : text;
}
