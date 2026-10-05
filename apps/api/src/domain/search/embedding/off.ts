// M5/S4 off EmbeddingProvider：出厂默认态，纯 FTS/LIKE，不加载任何网络/原生资源。
//
// 权威依据：M5-implementation-plan §4.4「off：provider 不加载任何网络/原生资源，embed()
// 不被调用（worker 跳过向量步）；检索 = fts/like」、§4.9 降级矩阵。
//
// embed 的防御姿态：off 态下 worker 必须在调用 provider 之前跳过向量步，因此 embed 被调用
// 属于调用方编程错误。这里选择【确定性抛错】而非静默返回空——后者会制造"向量静默缺失"，
// 与覆盖度对账冲突且极难排查。错误信息固定，便于单测钉死与上层捕获。

import type { EmbeddingProvider, EmbeddingHealth } from "./types.js";

/** off 模式不支持嵌入的固定错误（不触网、信息确定，供单测与上层分支匹配）。 */
export const OFF_EMBED_UNSUPPORTED = "embedding provider is off (fts/like only); embed() must not be called";

interface OffProviderOptions {
  /** 仅用于与接口对齐的展示名，默认空串。 */
  model?: string;
}

/** 构造 off provider。构造本身零 IO、零资源加载。 */
export function createOffProvider(opts: OffProviderOptions = {}): EmbeddingProvider {
  return {
    mode: "off",
    model: opts.model ?? "",
    dim: 0,
    batchSize: 0,
    async embed(): Promise<Float32Array[]> {
      // 确定性防御：off 不产生向量。抛错而非静默返回空，强制调用方走"跳过向量步"分支。
      throw new Error(OFF_EMBED_UNSUPPORTED);
    },
    async health(): Promise<EmbeddingHealth> {
      // off 永远健康且绝不触网（无任何 fetch/资源探测）。
      return { ok: true, detail: "off" };
    },
    async dispose(): Promise<void> {
      // 无资源可释放。
    },
  };
}
