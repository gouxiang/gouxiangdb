// M5/S7 query 运行时装配：把真实 prisma/config/store/provider 组装成 query.executeUnifiedSearch
// 所需的 QueryRuntimeDeps。本模块是检索域唯一接触"会拉 db 单例的 authz/org 链"的文件，
// 且只被 routes/v1/search.ts（m5Search!=='off' 才挂载）import；query 纯编排与单测不静态依赖本文件。
//
// 权威依据：M5-implementation-plan.md §4.5/§4.9（降级矩阵）、§6（flag）、§4.10（装配）。
// 不启 worker（S5 默认 off 纪律延续）；只在本模块惰性取 searchStore/构造 provider，import 不连库。

import type { PrismaClient } from "@prisma/client";
import { isUsableImageUrl } from "@gx/shared-types";
import { getSearchStore, resolveSearchDbPath, type SearchStore } from "./searchStore.js";
import { META_KEYS, getMeta, vecChunksExists } from "./schema.js";
import { vecBlob } from "./vecLoader.js";
import { createEmbeddingProvider } from "./embedding/cloud.js";
import type { EmbeddingProvider, EmbeddingMode } from "./embedding/types.js";
import { EmbeddingConfigStore } from "./embeddingConfig.js";
import { resolveVisibleNodeIds } from "../authz/scope.js";
import { resolveSubject } from "../authz/subjects.js";
import { decideMany } from "../authz/engine.js";
import { makeCreatedByResolver, DEFAULT_WORKSPACE } from "../authz/adapter.js";
import { hydrateEntities } from "./queryHydrate.js";
import {
  type QueryRuntimeDeps,
  type QueryVectorGate,
  type VectorQueryOutcome,
  type ScopeLike,
} from "./queryTypes.js";
import type { EntityTypeFilter } from "./queryPlan.js";

interface BuildRuntimeOptions {
  prisma: PrismaClient;
  env: NodeJS.ProcessEnv;
  /** 解析 search.db 路径所需：config.dataDir（prod /var/lib/gouxiangdb，dev apiRoot）。 */
  dataDir: string;
  /** appDir（native/<triplet> 解析用），dev 取 apiRoot。 */
  appDir: string;
  /** JWT 主密钥（embedding apiKey HKDF 解密用）。 */
  jwtSecret: string;
  /** 覆写 searchStore（测试注入临时 store；生产走单例）。 */
  store?: SearchStore;
  /** 覆写 provider（测试 mock，避免触外网）。 */
  provider?: EmbeddingProvider | null;
  workspaceId?: string;
  /**
   * 显式指定 scope 收敛的资源 kind（MCP record.search 按 PAT scope 收窄实体族用）。
   * **不传（非 MCP 调用）= 沿用由 `type` 推导的 kinds，行为逐字节不变**。
   * 注意：这是安全闸——多实体族（type:"all"）时仍可只让 scope 命中其中部分族；
   * 召回三路都 JOIN temp_scope，不在 scopeKinds 内的族在 SQL 层即被排除。
   */
  scopeKinds?: readonly string[];
}

/** 惰性进程级 provider（配置视图每次现算，但 provider 复用——cloud 内部带 health/dim 状态）。 */
let cachedProvider: EmbeddingProvider | null = null;

/** 仅供测试复位。 */
export function resetQueryRuntimeCaches(): void {
  cachedProvider = null;
}

function resolveStore(opts: BuildRuntimeOptions): SearchStore {
  if (opts.store) return opts.store;
  const filePath = resolveSearchDbPath(opts.env, opts.dataDir);
  // GX_VEC_EXT_PATH 运维覆盖在服役读路径同样生效（S12 前仅 reindex 接线，属遗漏）；
  // 未设环境时为 undefined，回落 bundled/node_modules，默认行为零变化。
  const vecExtPath = opts.env.GX_VEC_EXT_PATH?.trim() || undefined;
  return getSearchStore({ filePath, appDir: opts.appDir, ...(vecExtPath ? { vecExtPath } : {}) });
}

/** 向量门：把 mode/配置/vec0/dim/embed 成败归一为一个 blob 或降级理由（§4.9）。 */
function makeVectorGate(
  store: SearchStore,
  mode: EmbeddingMode,
  provider: EmbeddingProvider | null,
): QueryVectorGate {
  return {
    async embedQuery(req): Promise<VectorQueryOutcome> {
      // 配置态：mode=off、或 cloud 缺配置回落到的 off provider -> 不走向量，不算 degraded。
      if (mode !== "cloud" || !provider || provider.mode !== "cloud") return { ok: false };
      // vec0 扩展不可用 -> vec_unavailable（强制 vector 据此回退关键词并标注）。
      if (!store.vecAvailable) return { ok: false, reason: "vec_unavailable" };
      // 向量虚表尚未建（cloud 已开但尚无实体完成向量化）：无向量可搜，非故障，安静跳过。
      if (!vecChunksExists(store.db)) return { ok: false };
      const images = (req.images ?? []).filter((u) => isUsableImageUrl(u));
      // 以图搜图：带可用图片且 provider 实现了多模态方法 -> 走多模态向量化（图文合一个向量）；
      // 带图但 provider 无多模态能力 -> 安静退回纯文本（不构成故障，不标 degraded）。
      const multimodal = images.length > 0 && provider.embedMultimodal;
      try {
        const vectors = multimodal
          ? await provider.embedMultimodal!([{ text: req.text, images }])
          : await provider.embed([req.text]);
        const v = vectors.find((x) => x && x.length > 0);
        if (!v || v.length === 0) return { ok: false, reason: "embedding_unhealthy" };
        // dim 必须与 vec_chunks 建表维度一致（model 变更未 reindex），否则拒向量路（AC-M5-6）。
        const expected = Number(getMeta(store.db, META_KEYS.embeddingDim) ?? "0");
        if (expected > 0 && v.length !== expected) return { ok: false, reason: "dim_mismatch" };
        return { ok: true, blob: vecBlob(v) };
      } catch {
        // cloud 401/403/5xx/超时/网络：FTS/LIKE 正常服役，仅标 embedding_unhealthy（§4.9）。
        return { ok: false, reason: "embedding_unhealthy" };
      }
    },
  };
}

/** 为单次请求构造检索依赖（scope/decide/hydrate 闭包绑定 userId+type）。 */
export async function buildQueryRuntime(
  userId: string,
  type: EntityTypeFilter,
  opts: BuildRuntimeOptions,
): Promise<{ deps: QueryRuntimeDeps; store: SearchStore }> {
  const store = resolveStore(opts);
  const workspaceId = opts.workspaceId ?? DEFAULT_WORKSPACE;

  // embedding 配置视图（db 覆盖 env；cloud 需显式配置+key，否则 createEmbeddingProvider 回落 off=配置态）。
  let mode: EmbeddingMode = "off";
  let provider: EmbeddingProvider | null = opts.provider === undefined ? cachedProvider : opts.provider;
  if (opts.provider === undefined) {
    const cfgStore = new EmbeddingConfigStore(opts.prisma, opts.jwtSecret);
    const view = await cfgStore.resolveView(opts.env);
    mode = view.mode;
    if (mode === "cloud") {
      // resolveView 不回明文 key；cloud provider 需 apiKey，另取（失败/无 key -> off 配置态）。
      const apiKey = await cfgStore.getApiKey().catch(() => null);
      provider = createEmbeddingProvider("cloud", {
        baseURL: view.baseURL,
        apiKey: apiKey ?? opts.env.GX_EMBEDDING_API_KEY?.trim() ?? "",
        model: view.model,
        batchSize: view.batchSize,
        timeoutMs: view.timeoutMs,
        concurrency: view.concurrency,
        retryMaxAttempts: view.retryMaxAttempts,
        retryBaseMs: view.retryBaseMs,
      });
      cachedProvider = provider;
    } else {
      provider = null;
      cachedProvider = null;
    }
  } else {
    mode = provider?.mode === "cloud" ? "cloud" : "off";
  }

  // scope kinds：显式 scopeKinds（MCP 按 PAT scope 收窄）优先；否则沿用 type 推导（非 MCP 默认，零变化）。
  const kinds = opts.scopeKinds ? [...new Set(opts.scopeKinds)] : typeKinds(type);
  const deps: QueryRuntimeDeps = {
    store: { db: store.db, vecAvailable: store.vecAvailable, filePath: store.filePath },
    vector: mode === "cloud" ? makeVectorGate(store, mode, provider) : null,

    resolveScope: async (): Promise<ScopeLike> => {
      const s = await resolveVisibleNodeIds(opts.prisma, userId, {
        actions: ["r"], kinds, workspaceId,
      });
      return {
        nodeIds: s.nodeIds,
        truncated: s.truncated,
        policyVersion: s.policyVersion,
        maskedTableFields: s.maskedTableFields,
      };
    },

    decideNodeIds: async (nodeIds: string[]): Promise<ReadonlySet<string>> => {
      if (nodeIds.length === 0) return new Set();
      const subject = await resolveSubject(userId, opts.prisma);
      const results = await decideMany(
        {
          client: opts.prisma,
          workspaceId,
          resolveCreatedBy: makeCreatedByResolver(opts.prisma),
        },
        subject,
        nodeIds,
        "r",
      );
      return new Set(results.filter((r) => r.decision.allowed).map((r) => r.node.id));
    },

    hydrate: (refs, masked) => hydrateEntities(opts.prisma, refs, masked),
  };

  return { deps, store };
}

/** record->table、doc->doc、canvas->canvas 的 scope kinds 映射；all 不传（§4.5 步骤 2）。 */
function typeKinds(type: EntityTypeFilter): string[] | undefined {
  if (type === "record") return ["table"];
  if (type === "doc") return ["doc"];
  if (type === "canvas") return ["canvas"];
  return undefined;
}
