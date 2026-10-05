// cloud 多模态向量化请求（#563）：对每个 MultimodalEmbedItem 发一次方舟 multimodal 请求。
// 官方一个请求的所有 part 合成【一个】向量（data.embedding），故一个 item = 一个 HTTP 请求。
// 从 cloud.ts 拆出以满足单文件 ≤300 行。本文件只发请求/解析，不含 React/DOM。

import {
  parseMultimodalEmbedding,
  toMultimodalInputParts,
  type MultimodalEmbedItem,
} from "@gx/shared-types";
import { EmbeddingError } from "./types.js";

interface MultimodalRequestArgs {
  endpoint: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

/** 发单个多模态请求，返回该 item 的一个向量。坏响应/非 2xx 抛 EmbeddingError。 */
async function requestOne(
  item: MultimodalEmbedItem,
  a: MultimodalRequestArgs,
): Promise<Float32Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), a.timeoutMs);
  try {
    const res = await a.fetchImpl(a.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${a.apiKey}`,
      },
      body: JSON.stringify({
        model: a.model,
        encoding_format: "float",
        input: toMultimodalInputParts(item),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new EmbeddingError(
        res.status === 401 || res.status === 403 ? "auth" : "client",
        `multimodal embeddings HTTP ${res.status} ${detail.slice(0, 200)}`,
        res.status,
      );
    }
    return parseMultimodalEmbedding(await res.json());
  } catch (err) {
    if (err instanceof EmbeddingError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new EmbeddingError("timeout", "multimodal embeddings timeout");
    }
    throw new EmbeddingError(
      "network",
      err instanceof Error ? err.message : "multimodal embeddings network error",
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 批量多模态向量化：逐 item 请求，用简单并发池限制在飞请求数。
 * 任一 item 失败不阻断其它（失败位置给零长向量，由调用方记欠账）。
 */
export async function embedMultimodalBatch(
  items: readonly MultimodalEmbedItem[],
  a: MultimodalRequestArgs,
  concurrency: number,
): Promise<Float32Array[]> {
  const out: Float32Array[] = new Array(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      try {
        out[idx] = await requestOne(items[idx]!, a);
      } catch {
        out[idx] = new Float32Array(0);
      }
    }
  };

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return out;
}
