// POST /admin/embedding/test-connection 探活 service：按【当前已保存】配置发一次真实请求。
//
// 纪律：
//   - 只探活，不落库：不写任何 app_settings、不写 search.db、不改 provider 内部健康态之外的东西；
//   - 不回凭据：响应只有 ok/latency/dim/中性结论，绝不回显 apiKey（连末 4 位都不回）；
//   - 快进快出：并发 1、只尝试 1 次（不重试）、超时钳到 8s —— 点一下按钮不该等几十秒；
//   - 不发无效请求：模式 off 或 baseURL/model/apiKey 缺一，直接回"配置不完整"，不触网。

import type { PrismaClient } from "@prisma/client";
import type { EmbeddingConnectionTestResult } from "@gx/shared-types";
import { EmbeddingConfigStore } from "./embeddingConfig.js";
import { createCloudProvider } from "./embedding/cloud.js";
import { EmbeddingError, type EmbedErrorKind } from "./embedding/types.js";

/** 探活文本（单条、极短，只为换回一个真实向量与耗时）。 */
const PROBE_TEXT = "连接自检";
/** 多模态探活用 1x1 PNG（极小，只为验证 vision 端点可用并拿到真实维度）。 */
const PROBE_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
/** 探活超时上限：配置里填 60s 也不让按钮等 60s。 */
const PROBE_TIMEOUT_CAP_MS = 8000;

interface ProbeDeps {
  prisma: PrismaClient;
  env: NodeJS.ProcessEnv;
  jwtSecret: string;
  /** 测试注入：覆写 fetch，不触真外网。 */
  fetchImpl?: typeof fetch;
}

/** 失败类别 -> 中性中文结论（不含实现细节，不含凭据）。 */
function probeDetail(kind: EmbedErrorKind | "config"): string {
  switch (kind) {
    case "auth":
      return "连接被拒绝：密钥无效或没有权限（401/403）";
    case "timeout":
      return "连接超时：服务未在限定时间内响应";
    case "network":
      return "连不上服务：地址不可达或网络不通";
    case "client":
      return "服务拒绝了请求：请检查服务地址与模型名称";
    case "server":
      return "服务返回错误：远端内部故障";
    case "config":
      return "配置不完整，未发起连接";
    default:
      return "连接失败";
  }
}

function fail(kind: EmbedErrorKind | "config", latencyMs: number): EmbeddingConnectionTestResult {
  return { ok: false, latencyMs, dim: null, detail: probeDetail(kind), errorKind: kind };
}

export async function testEmbeddingConnection(d: ProbeDeps): Promise<EmbeddingConnectionTestResult> {
  const store = new EmbeddingConfigStore(d.prisma, d.jwtSecret);
  const view = await store.resolveView(d.env);
  if (view.mode !== "cloud") {
    return fail("config", 0);
  }
  const apiKey = (await store.getApiKey().catch(() => null)) ?? d.env.GX_EMBEDDING_API_KEY?.trim() ?? "";
  if (!view.baseURL.trim() || !apiKey || !view.model.trim()) {
    return fail("config", 0);
  }

  const provider = createCloudProvider(
    {
      baseURL: view.baseURL,
      apiKey,
      model: view.model,
      batchSize: 1,
      timeoutMs: Math.min(view.timeoutMs, PROBE_TIMEOUT_CAP_MS),
      concurrency: view.concurrency,
      retryMaxAttempts: view.retryMaxAttempts,
      retryBaseMs: view.retryBaseMs,
    },
    // 探活不做退避重试：maxAttempts=1 + retryBaseMs=0，失败立即给结论。
    { concurrency: 1, maxAttempts: 1, retryBaseMs: 0, ...(d.fetchImpl ? { fetchImpl: d.fetchImpl } : {}) },
  );

  const t0 = Date.now();
  try {
    // vision 多模态模型：纯文本端点可能不支持，优先用多模态探活（图+文）拿真实维度。
    const isVision = /vision/i.test(view.model);
    if (isVision && provider.embedMultimodal) {
      await provider.embedMultimodal([{ text: PROBE_TEXT, images: [PROBE_IMAGE] }]);
    } else {
      await provider.embed([PROBE_TEXT]);
    }
    const dim = provider.dim || null;
    return {
      ok: true,
      latencyMs: Date.now() - t0,
      dim,
      detail: dim ? `连接正常，返回维度 ${dim}` : "连接正常，但未返回维度",
      errorKind: null,
    };
  } catch (err) {
    const kind: EmbedErrorKind = err instanceof EmbeddingError ? err.kind : "network";
    return fail(kind, Date.now() - t0);
  }
}
