// M5/S9 GET /admin/search/status 聚合（M5-implementation-plan §9）。
//
// 只读、零建库：search.db 文件不存在时不打开读写单例（不自举、不产生连接），回零态 index。
// 文件存在则以 readonly 直开读 index_meta/chunks/backlog（与现役 WAL 连接共享同一文件，
// 已提交帧可见），查完即关。coverage 直接复用 searchCoverage 单一真源；embedding 健康读
// EmbeddingConfigStore + cloud provider.health()（health() 只看内部状态，不主动触网）。

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { PrismaClient } from "@prisma/client";
import { META_KEYS, SEARCH_SCHEMA_VERSION } from "./schema.js";
import { classifyVecExtKind, type VecExtKind } from "./vecLoader.js";
import { EmbeddingConfigStore } from "./embeddingConfig.js";
import { createEmbeddingProvider } from "./embedding/cloud.js";
import { computeCoverage, coverageToStatus, type CoverageStatus } from "./searchCoverage.js";
import type { EmbeddingProvider } from "./embedding/types.js";

interface SearchStatus {
  vec: {
    loaded: boolean;
    version: string | null;
    extPathKind: VecExtKind;
  };
  embedding: {
    mode: "off" | "cloud";
    model: string;
    dim: number;
    healthy: boolean;
    detail?: string;
    reindexRequired: boolean;
  };
  index: {
    schemaVersion: number;
    indexedAt: string | null;
    chunks: {
      records: number;
      docs: number;
      canvas: number;
      total: number;
      fieldChunks: number;
      fieldChunksCapped: number;
      fieldChunkCap: number;
    };
    backlog: { pending: number; failed: number; dead: number };
    coverage: CoverageStatus;
    rebuilding: boolean;
  } | null;
}

interface StatusDeps {
  prisma: PrismaClient;
  env: NodeJS.ProcessEnv;
  dataDir: string;
  appDir: string;
  jwtSecret: string;
  /** 测试注入：覆写 search.db 物理路径。 */
  searchPath?: string;
  /** 测试注入 mock cloud（不触外网）。 */
  provider?: EmbeddingProvider | null;
}

function resolveMainDbPath(env: NodeJS.ProcessEnv, prisma: PrismaClient): string {
  const url = env.DATABASE_URL;
  if (url) {
    const raw = url.startsWith("file:") ? url.slice("file:".length) : url;
    const noQuery = raw.split("?")[0] ?? raw;
    return path.isAbsolute(noQuery) ? noQuery : path.resolve(process.cwd(), "prisma", noQuery);
  }
  // 兜底：从 Prisma 活动连接取 datasource（测试注入临时库时通常已设 DATABASE_URL）。
  void prisma;
  return path.join(process.cwd(), "prisma", "dev.db");
}

interface MetaSnapshot {
  schemaVersion: number;
  indexedAt: string | null;
  vecLoaded: boolean;
  vecVersion: string | null;
  embeddingDim: number;
  rebuilding: boolean;
  fieldChunkCap: number;
  cappedRecords: number;
}

function readMeta(db: Database.Database): MetaSnapshot {
  const get = (k: string): string | undefined =>
    (db.prepare("SELECT v FROM index_meta WHERE k=?").get(k) as { v: string } | undefined)?.v;
  return {
    schemaVersion: Number(get(META_KEYS.schemaVersion) ?? SEARCH_SCHEMA_VERSION),
    indexedAt: get(META_KEYS.indexedAt) ?? null,
    vecLoaded: get(META_KEYS.vecLoaded) === "1",
    vecVersion: get(META_KEYS.vecVersion) ?? null,
    embeddingDim: Number(get(META_KEYS.embeddingDim) ?? "0"),
    rebuilding: get(META_KEYS.rebuilding) === "1",
    fieldChunkCap: Number(get(META_KEYS.fieldChunkCap) ?? "0"),
    cappedRecords: Number(get(META_KEYS.cappedRecords) ?? "0"),
  };
}

function countChunks(db: Database.Database) {
  const byType = db
    .prepare("SELECT entityType, COUNT(*) AS n FROM chunks GROUP BY entityType")
    .all() as Array<{ entityType: string; n: number }>;
  const map = new Map(byType.map((r) => [r.entityType, r.n]));
  const total = (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
  const fieldChunks = (
    db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE chunkKind='field'").get() as { n: number }
  ).n;
  return {
    records: map.get("record") ?? 0,
    docs: map.get("doc") ?? 0,
    canvas: map.get("canvas") ?? 0,
    total,
    fieldChunks,
  };
}

async function backlog(prisma: PrismaClient) {
  const rows = await prisma.changeEvent.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  const m = new Map(rows.map((r) => [r.status, r._count._all]));
  return {
    pending: (m.get("pending") ?? 0) + (m.get("processing") ?? 0),
    failed: m.get("failed") ?? 0,
    dead: m.get("dead") ?? 0,
  };
}

/**
 * 组装 §9 status。search.db 缺失 -> index=null（不建库）；存在 -> 只读聚合 + coverage A-F。
 */
export async function buildSearchStatus(d: StatusDeps): Promise<SearchStatus> {
  const cfgStore = new EmbeddingConfigStore(d.prisma, d.jwtSecret);
  const view = await cfgStore.resolveView(d.env);
  const reindexRequired = await cfgStore.isReindexRequired();

  const searchPath = d.searchPath
    ?? (d.env.GX_SEARCH_DB_PATH?.trim()
      || path.join(path.dirname(resolveMainDbPath(d.env, d.prisma)), "search.db"));

  // provider（cloud 才构造；测试可注入）。health() 不主动触网。
  let provider: EmbeddingProvider | null = null;
  if (d.provider !== undefined) {
    provider = d.provider;
  } else if (view.mode === "cloud") {
    const apiKey = await cfgStore.getApiKey().catch(() => null);
    provider = createEmbeddingProvider("cloud", {
      baseURL: view.baseURL,
      apiKey: apiKey ?? d.env.GX_EMBEDDING_API_KEY?.trim() ?? "",
      model: view.model,
      batchSize: view.batchSize,
      timeoutMs: view.timeoutMs,
      concurrency: view.concurrency,
      retryMaxAttempts: view.retryMaxAttempts,
      retryBaseMs: view.retryBaseMs,
    });
    if (provider.mode !== "cloud") provider = null; // 配置不齐回落 off
  }

  const extPathKind = classifyVecExtKind(d.env.GX_VEC_EXT_PATH, d.appDir);

  let index: SearchStatus["index"] = null;
  let vecLoaded = false;
  let vecVersion: string | null = null;
  let indexDim = 0;
  if (fs.existsSync(searchPath)) {
    const db = new Database(searchPath, { readonly: true, fileMustExist: true });
    try {
      const meta = readMeta(db);
      vecLoaded = meta.vecLoaded;
      vecVersion = meta.vecVersion;
      indexDim = meta.embeddingDim;
      const counts = countChunks(db);
      const coverage = computeCoverage({
        mainDbPath: resolveMainDbPath(d.env, d.prisma),
        searchDbPath: searchPath,
        mode: view.mode,
      });
      index = {
        schemaVersion: meta.schemaVersion,
        indexedAt: meta.indexedAt,
        chunks: {
          ...counts,
          fieldChunksCapped: meta.cappedRecords,
          fieldChunkCap: view.fieldChunkCap || meta.fieldChunkCap,
        },
        backlog: await backlog(d.prisma),
        coverage: coverageToStatus(coverage),
        rebuilding: meta.rebuilding,
      };
    } finally {
      db.close();
    }
  }

  // embedding 健康/维度：off 无外部依赖即健康；cloud 读 provider.health() 与探测维度。
  let healthy = true;
  let detail: string | undefined;
  if (view.mode === "cloud") {
    if (provider) {
      const h = await provider.health();
      healthy = h.ok;
      detail = h.detail;
    } else {
      healthy = false;
      detail = "cloud 配置不完整（baseURL/apiKey/model）";
    }
  }
  const dim = indexDim || provider?.dim || 0;
  const dimMismatch = Boolean(
    view.mode === "cloud" && provider && provider.dim > 0 && indexDim > 0 && provider.dim !== indexDim,
  );

  return {
    vec: { loaded: vecLoaded, version: vecVersion, extPathKind },
    embedding: {
      mode: view.mode,
      model: view.model,
      dim,
      healthy,
      ...(detail ? { detail } : {}),
      reindexRequired: reindexRequired || dimMismatch,
    },
    index,
  };
}
