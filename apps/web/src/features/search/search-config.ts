// M5 嵌入配置表单纯函数（无 IO）：表单字符串 → PATCH 请求体，区分首次出域确认；
// apiKey 缺省不进请求（保持）、空串不发、非空随请求覆盖。便于单测二次确认流。
//
// 本次补齐远端配置项：provider（服务形态）/ dim（仅自建与兼容档可手填）/ concurrency /
// retryMaxAttempts / retryBaseMs / searchEnabled（总门 db 覆盖）。
// 校验与组装都在纯函数层，组件只负责渲染与转发——无 jsdom 也能锁住"非法值要报错"。
import {
  providerAllowsManualDim,
  type EmbeddingConfigPatch,
  type EmbeddingMode,
  type EmbeddingProviderKind,
  type SearchEnabledOverride,
} from "@gx/shared-types";

export interface ConfigForm {
  mode: EmbeddingMode;
  /** 缺省 cloud（老配置没有该字段时的向后兼容档）。 */
  provider?: EmbeddingProviderKind;
  baseURL: string;
  model: string;
  batchSize: string;
  timeoutMs: string;
  fieldChunkCap: string;
  /** 手填维度；仅自建/兼容档生效。 */
  dim?: string;
  concurrency?: string;
  retryMaxAttempts?: string;
  retryBaseMs?: string;
  /** 检索总门 db 覆盖；缺省 inherit=跟随环境变量。 */
  searchEnabled?: SearchEnabledOverride;
  /** 只写密钥输入；空串=不改既有密钥。 */
  apiKey: string;
}

/** 表单数值字段的取值区间（与后端白名单一致，前后端同一套口径）。 */
export const FORM_RANGES = {
  batchSize: [1, 10000],
  timeoutMs: [1, 600000],
  fieldChunkCap: [1, 1000],
  concurrency: [1, 64],
  retryMaxAttempts: [1, 10],
  retryBaseMs: [1, 600000],
  dim: [1, 4096],
} as const;

function posInt(s: string): number | undefined {
  const n = Number(s);
  return s.trim() !== "" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** 填了但不在区间内 -> 返回 false（空串不算非法，等同"不改"）。 */
function inRange(s: string | undefined, [min, max]: readonly [number, number]): boolean {
  if (s === undefined || s.trim() === "") return true;
  const n = Number(s);
  return Number.isInteger(n) && n >= min && n <= max;
}

/**
 * 保存前的显式校验：返回第一条错误文案，合法返回 null。
 * 为什么必须有它：后端会 400，但纯靠后端报错等于让用户先等一次往返；而数值串非法时
 * buildConfigPatch 会静默丢字段（"改了没生效"更糟），故在提交前拦下并明确说哪一项错了。
 */
export function validateConfigForm(form: ConfigForm): string | null {
  const bad = (label: string, key: keyof typeof FORM_RANGES): string | null =>
    inRange(form[key as keyof ConfigForm] as string | undefined, FORM_RANGES[key])
      ? null
      : `${label}必须是 ${FORM_RANGES[key][0]}..${FORM_RANGES[key][1]} 的整数`;

  const checks: Array<string | null> = [
    bad("批量大小", "batchSize"),
    bad("超时（毫秒）", "timeoutMs"),
    bad("字段索引上限", "fieldChunkCap"),
    bad("并发数", "concurrency"),
    bad("重试次数", "retryMaxAttempts"),
    bad("退避基数（毫秒）", "retryBaseMs"),
  ];
  const provider = form.provider ?? "cloud";
  if (providerAllowsManualDim(provider)) {
    checks.push(bad("向量维度", "dim"));
  }
  return checks.find((c) => c !== null) ?? null;
}

/**
 * 组装 PATCH 体。
 * - 切到 cloud 时带 confirmCloud（首次 false，被 409 后由调用方以 true 重发）；
 * - apiKey 仅在用户填了非空值时随请求发送（缺省=保持，显式清除走 DELETE 端点）；
 * - dim 只在当前服务形态允许手填时才发出（cloud 档发出会被后端 400）；
 * - 永不产出 reindex 字段（出现即 400）。
 */
export function buildConfigPatch(form: ConfigForm, confirmCloud: boolean): EmbeddingConfigPatch {
  const provider = form.provider ?? "cloud";
  const patch: EmbeddingConfigPatch = {
    mode: form.mode,
    provider,
    baseURL: form.baseURL.trim(),
    model: form.model.trim(),
    batchSize: posInt(form.batchSize),
    timeoutMs: posInt(form.timeoutMs),
    fieldChunkCap: posInt(form.fieldChunkCap),
    concurrency: posInt(form.concurrency ?? ""),
    retryMaxAttempts: posInt(form.retryMaxAttempts ?? ""),
    retryBaseMs: posInt(form.retryBaseMs ?? ""),
  };
  // cloud 档维度由 model 元数据决定：不发 dim，避免后端 400。
  if (providerAllowsManualDim(provider)) {
    const d = posInt(form.dim ?? "");
    if (d !== undefined) patch.dim = d;
  }
  if (form.searchEnabled) patch.searchEnabled = form.searchEnabled;
  const key = form.apiKey.trim();
  if (key) patch.apiKey = key;
  if (form.mode === "cloud") patch.confirmCloud = confirmCloud;
  return patch;
}
