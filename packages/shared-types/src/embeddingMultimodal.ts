// 多模态向量化契约（#563，豆包 doubao-embedding-vision）。
//
// 权威依据：火山方舟官方文档《向量化》—
//   POST {base}/api/v3/embeddings/multimodal
//   body: { model, encoding_format:"float",
//           input: [ {type:"image_url", image_url:{url}}, {type:"text", text} ] }
//   resp: { data: { embedding: number[] } }   （单条；与纯文本 data:[] 数组形态不同）
//
// 设计：纯文本通道（embedding/types.ts EmbeddingProvider.embed）保持不变，
// 本文件只【新增】多模态能力与结构，老视图/老测试行为一字不变。

/** 方舟多模态 input 片段（请求线格式）：图片 或 文本。 */
export interface MultimodalInputPart {
  type: "image_url" | "text";
  /** type=image_url：{ url }，url 可为 https 链接或 data:image/...;base64,... 内联。 */
  image_url?: { url: string };
  /** type=text：文本内容。 */
  text?: string;
}

/** 一个待向量化条目（对应一个 chunk）：文本 + 该条目携带的图片。 */
export interface MultimodalEmbedItem {
  /** 条目文本（图片缺它时也可只按图向量化）。 */
  text: string;
  /** 条目附带图片（dataURL 或可访问 URL），按序内联在文本之前。 */
  images: string[];
}

/** 把一个条目转成方舟多模态 input 片段数组（图片在前、文本在后）。 */
export function toMultimodalInputParts(
  item: MultimodalEmbedItem,
): MultimodalInputPart[] {
  const parts: MultimodalInputPart[] = [];
  for (const url of item.images) {
    parts.push({ type: "image_url", image_url: { url } });
  }
  if (item.text.trim() !== "") {
    parts.push({ type: "text", text: item.text });
  }
  return parts;
}

/**
 * 归一多模态端点：在版本段（/v1、/v3…）之后拼 /embeddings/multimodal。
 * 与纯文本 buildEmbeddingsEndpoint 的区别只是末段：
 *   https://h/api/v3        -> https://h/api/v3/embeddings/multimodal
 *   https://h/v1            -> https://h/v1/embeddings/multimodal
 *   https://h               -> https://h/v1/embeddings/multimodal
 * query/hash 保留在末尾。纯字符串函数，不校验可达性。
 */
export function buildMultimodalEndpoint(baseURL: string): string {
  const raw = baseURL.trim();
  const sep = raw.search(/[?#]/);
  const cut = sep === -1 ? raw.length : sep;
  const pathPart = raw.slice(0, cut).replace(/\/+$/, "");
  const suffix = raw.slice(cut);
  const lastSeg = pathPart.slice(pathPart.lastIndexOf("/") + 1);
  const root = /^v\d+$/.test(lastSeg) ? pathPart : `${pathPart}/v1`;
  return `${root}/embeddings/multimodal${suffix}`;
}

/**
 * 解析多模态响应为一个 Float32Array。
 * 官方形态：{ data: { embedding: number[] } }；
 * 兼容旧数组形态：{ data: [ { embedding: number[] } ] }。
 * 任一形态不符/向量非数值/空 -> 抛错（脏响应不静默，调用方按失败记欠账）。
 */
export function parseMultimodalEmbedding(json: unknown): Float32Array {
  if (!json || typeof json !== "object") {
    throw new Error("multimodal embeddings: response not an object");
  }
  const root = json as { data?: unknown };
  let emb: unknown;
  if (Array.isArray(root.data)) {
    emb = (root.data[0] as { embedding?: unknown } | undefined)?.embedding;
  } else if (root.data && typeof root.data === "object") {
    emb = (root.data as { embedding?: unknown }).embedding;
  }
  if (!Array.isArray(emb) || emb.some((x) => typeof x !== "number")) {
    throw new Error("multimodal embeddings: data.embedding must be number[]");
  }
  return Float32Array.from(emb as number[]);
}

/** 判定一个值是否为可用的图片内联/链接字符串（data:image 或 http(s)）。 */
export function isUsableImageUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const s = value.trim();
  return /^data:image\//.test(s) || /^https?:\/\//.test(s);
}
