// M5 嵌入配置表单纯函数（无 IO）：表单字符串 → PATCH 请求体，区分首次出域确认；
// apiKey 缺省不进请求（保持）、空串不发、非空随请求覆盖。便于单测二次确认流。
import type { EmbeddingConfigPatch, EmbeddingMode } from "@gx/shared-types";

export interface ConfigForm {
  mode: EmbeddingMode;
  baseURL: string;
  model: string;
  batchSize: string;
  timeoutMs: string;
  fieldChunkCap: string;
  /** 只写密钥输入；空串=不改既有密钥。 */
  apiKey: string;
}

function posInt(s: string): number | undefined {
  const n = Number(s);
  return s.trim() !== "" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * 组装 PATCH 体。
 * - 切到 cloud 时带 confirmCloud（首次 false，被 409 后由调用方以 true 重发）；
 * - apiKey 仅在用户填了非空值时随请求发送（缺省=保持，显式清除走 DELETE 端点）；
 * - 不产出 dim/reindex 字段（出现即 400 EMBEDDING_CONFIG_INVALID）。
 */
export function buildConfigPatch(form: ConfigForm, confirmCloud: boolean): EmbeddingConfigPatch {
  const patch: EmbeddingConfigPatch = {
    mode: form.mode,
    baseURL: form.baseURL.trim(),
    model: form.model.trim(),
    batchSize: posInt(form.batchSize),
    timeoutMs: posInt(form.timeoutMs),
    fieldChunkCap: posInt(form.fieldChunkCap),
  };
  const key = form.apiKey.trim();
  if (key) patch.apiKey = key;
  if (form.mode === "cloud") patch.confirmCloud = confirmCloud;
  return patch;
}
