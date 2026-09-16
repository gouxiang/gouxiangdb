// M5/S4 cloud EmbeddingProvider：OpenAI 兼容单一契约（全局 fetch，不引 SDK）。
//
// 权威依据：M5-implementation-plan §1.7（POST {baseURL}/v1/embeddings，Bearer，按 data[].index
// 对齐，dim 取首响应，不暴露 dimensions/MRL、不做非兼容 adapter）、§4.4（退避/超时/信号量/空与超长）、
// §4.9（cloud 401/403/超时/连续失败 -> embedding_unhealthy，FTS 不阻断主写）。
//
// 失败语义：
//   - 5xx/网络错/超时：指数退避最多 MAX_ATTEMPTS 次（1s->2s，上限钳制），仍失败抛 EmbeddingError；
//   - 4xx（含 401/403）：不重试立即抛；401/403 同时置 unhealthy（health() 转 false）；
//   - 空输入/全空白：不发任何 HTTP 请求，按位返回空向量；超长单条在边界截断到 MAX_TEXT_CHARS。

import {
  type EmbeddingProvider,
  type EmbeddingHealth,
  type CloudProviderConfig,
  type EmbedErrorKind,
  EmbeddingError,
  buildEmbeddingsEndpoint,
  classifyStatus,
  isRetryableKind,
  retryDelayMs,
  clampText,
  cloudConfigUsable,
  MAX_ATTEMPTS,
  MAX_TEXT_CHARS,
} from "./types.js";
import { createOffProvider } from "./off.js";

/** 仅本文件需要的注入依赖（测试替换 fetch/sleep/时钟，不触真外网）。 */
export interface CloudDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  retryBaseMs?: number;
  /** 单批 HTTP 的最大并发（信号量），默认 4。 */
  concurrency?: number;
}

interface RemoteItem {
  index: number;
  embedding: unknown;
}

/** 最小信号量：限制同时在飞的批请求数（cloud 向量化不压垮远端/本机）。 */
class Semaphore {
  private running = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.running += 1;
  }
  release(): void {
    this.running -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

export interface CloudProvider extends EmbeddingProvider {
  /** 最近一次失败类别（auth/server/timeout/network/client）；null=尚无失败。 */
  readonly lastErrorKind: EmbedErrorKind | null;
  /** 401/403 后固定 unhealthy；恢复（后续成功）自动复位。 */
  readonly unhealthy: boolean;
}

export function createCloudProvider(cfg: CloudProviderConfig, deps: CloudDeps = {}): CloudProvider {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retryBase = deps.retryBaseMs ?? 1000;
  const sem = new Semaphore(Math.max(1, deps.concurrency ?? 4));
  const endpoint = buildEmbeddingsEndpoint(cfg.baseURL);

  let dim = 0;
  let unhealthy = false;
  let lastErrorKind: EmbedErrorKind | null = null;

  /** 单批请求：超时控制 + 按错误类别退避重试；返回按 data[].index 对齐的向量数组。 */
  async function requestBatch(batchTexts: readonly string[]): Promise<Float32Array[]> {
    const body = JSON.stringify({ model: cfg.model, input: batchTexts, encoding_format: "float" });
    let lastErr: EmbeddingError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      try {
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${cfg.apiKey}`,
          },
          body,
          signal: controller.signal,
        });
        if (!res.ok) {
          const kind = classifyStatus(res.status);
          lastErr = new EmbeddingError(kind, `embeddings HTTP ${res.status}`, res.status);
          if (kind === "auth") {
            unhealthy = true;
            lastErrorKind = kind;
            throw lastErr; // 401/403 不重试
          }
          if (!isRetryableKind(kind)) throw lastErr; // 其余 4xx 不重试
          throw lastErr; // 5xx 落入下方重试
        }
        const json = (await res.json()) as { data?: RemoteItem[] };
        const aligned = alignResponse(json, batchTexts.length);
        if (aligned.length > 0 && dim === 0) dim = aligned[0].length;
        unhealthy = false; // 成功即恢复
        return aligned;
      } catch (err) {
        const kind = err instanceof EmbeddingError ? err.kind : mapFetchError(err);
        lastErr = err instanceof EmbeddingError ? err : new EmbeddingError(kind, errorMessage(err));
        lastErrorKind = lastErr.kind;
        if (lastErr.kind === "auth" || !isRetryableKind(lastErr.kind) || attempt === MAX_ATTEMPTS) {
          // 401/403 立即 unhealthy；server/timeout/network 重试耗尽（连续失败）同样 unhealthy（§4.9）。
          if (lastErr.kind === "auth" || (isRetryableKind(lastErr.kind) && attempt === MAX_ATTEMPTS)) {
            unhealthy = true;
          }
          throw lastErr;
        }
        await sleep(retryDelayMs(attempt, retryBase));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr ?? new EmbeddingError("network", "embeddings request failed");
  }

  return {
    mode: "cloud",
    model: cfg.model,
    batchSize: cfg.batchSize,
    get dim() {
      return dim;
    },
    get unhealthy() {
      return unhealthy;
    },
    get lastErrorKind() {
      return lastErrorKind;
    },

    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      const out: Float32Array[] = new Array(texts.length);
      // 空文本占位（不发远端）；仅非空白项进入远端批次。
      const jobs: Array<{ globalIdx: number; text: string }> = [];
      for (let i = 0; i < texts.length; i += 1) {
        const raw = texts[i] ?? "";
        if (raw.trim().length === 0) {
          out[i] = new Float32Array(0);
        } else {
          jobs.push({ globalIdx: i, text: clampText(raw, MAX_TEXT_CHARS) });
        }
      }
      if (jobs.length === 0) return out; // 全空：零请求

      const chunks: Array<typeof jobs> = [];
      for (let i = 0; i < jobs.length; i += cfg.batchSize) chunks.push(jobs.slice(i, i + cfg.batchSize));

      await Promise.all(chunks.map(async (chunk) => {
        await sem.acquire();
        try {
          const vectors = await requestBatch(chunk.map((j) => j.text));
          chunk.forEach((job, localIdx) => {
            out[job.globalIdx] = vectors[localIdx] ?? new Float32Array(0);
          });
        } finally {
          sem.release();
        }
      }));
      return out;
    },

    async health(): Promise<EmbeddingHealth> {
      if (unhealthy) {
        return { ok: false, detail: lastErrorKind ?? "unhealthy" };
      }
      return { ok: true, latencyMs: undefined, detail: dim > 0 ? `dim=${dim}` : "configured" };
    },

    async dispose(): Promise<void> {
      // 全局 fetch 无连接句柄需显式释放。
    },
  };
}

/** 把 fetch 层异常（Abort/TypeError 网络错）映射为错误种类。 */
function mapFetchError(err: unknown): EmbedErrorKind {
  if (err instanceof Error && err.name === "AbortError") return "timeout";
  return "network";
}

/**
 * 按模式与配置选择 provider（§4.4/§4.9）：
 * mode=cloud 且 baseURL/apiKey/model 齐备才构造 cloud provider；
 * 否则回 off provider——这是【配置态】而非降级（status 可见但非 degraded），且不触网。
 */
export function createEmbeddingProvider(
  mode: "off" | "cloud",
  cfg: Partial<CloudProviderConfig> | undefined,
  deps: CloudDeps = {},
): EmbeddingProvider {
  if (mode === "cloud" && cloudConfigUsable(cfg)) {
    return createCloudProvider(cfg as CloudProviderConfig, deps);
  }
  return createOffProvider();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 按 OpenAI 兼容响应 data[].index 重排到请求顺序（远端可能乱序，禁止默认同序）。
 * 校验 data 存在、index 在界内、embedding 为等长数值数组；任一不满足抛错（脏响应不静默）。
 */
export function alignResponse(json: { data?: RemoteItem[] }, expected: number): Float32Array[] {
  const data = json.data;
  if (!Array.isArray(data)) throw new EmbeddingError("server", "embeddings response missing data[]");
  const out: Float32Array[] = new Array(expected);
  let width = -1;
  for (const item of data) {
    if (typeof item?.index !== "number" || item.index < 0 || item.index >= expected) {
      throw new EmbeddingError("server", `embeddings response bad index: ${String(item?.index)}`);
    }
    const emb = item.embedding;
    if (!Array.isArray(emb) || emb.some((x) => typeof x !== "number")) {
      throw new EmbeddingError("server", "embeddings response embedding must be number[]");
    }
    const vec = Float32Array.from(emb as number[]);
    if (width === -1) width = vec.length;
    else if (vec.length !== width) throw new EmbeddingError("server", "embeddings response ragged vectors");
    out[item.index] = vec;
  }
  for (let i = 0; i < expected; i += 1) {
    if (!out[i]) throw new EmbeddingError("server", `embeddings response missing index ${i}`);
  }
  return out;
}
