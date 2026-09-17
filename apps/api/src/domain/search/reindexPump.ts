// M5 reindex / S12 损坏重播共用的活实体枚举、上下文装配与单实体灌库原语。
//
// 全量双库切换（reindex.ts runFull）、单实体原地（runSingle）、S12 隔离坏库后向新建空库的
// 后台重播（repopulateActiveStore）三条写库路径共用本文件，保证派生口径只有一份真源：
// 都走 extractEntity -> applyUpsert/deleteDerived（与 S5 indexer 灌库完全一致）。

import type { PrismaClient } from "@prisma/client";
import type { SearchStore } from "./searchStore.js";
import { extractEntity, type ExtractedEntity } from "./entityExtract.js";
import { applyUpsert, deleteDerived } from "./indexerDerive.js";
import { FIELD_CHUNK_CAP } from "./chunks.js";
import { EmbeddingConfigStore } from "./embeddingConfig.js";
import { createEmbeddingProvider } from "./embedding/cloud.js";
import type { EmbeddingProvider, EmbeddingMode } from "./embedding/types.js";
import { DEFAULT_WORKSPACE } from "../authz/adapter.js";
import type { ReindexDeps, ReindexEntityType } from "./reindexTypes.js";

export interface LiveEntityRef {
  entityType: ReindexEntityType;
  entityId: string;
  version: bigint;
}

/** 枚举全量活实体（确定性顺序）；不依赖事件史（§5.4 直接扫主库）。 */
export async function listLiveEntities(prisma: PrismaClient): Promise<LiveEntityRef[]> {
  const out: LiveEntityRef[] = [];
  const records = await prisma.record.findMany({
    where: { deletedAt: null },
    select: { id: true, updatedAt: true },
    orderBy: { createdAt: "asc" },
  });
  for (const r of records) {
    out.push({ entityType: "record", entityId: r.id, version: BigInt(new Date(r.updatedAt).getTime()) });
  }
  const docs = await prisma.kbDoc.findMany({
    where: { deletedAt: null },
    select: { id: true, kind: true, contentVersion: true },
    orderBy: { createdAt: "asc" },
  });
  for (const d of docs) {
    if (d.kind !== "doc" && d.kind !== "canvas") continue;
    out.push({ entityType: d.kind, entityId: d.id, version: BigInt(d.contentVersion) });
  }
  return out;
}

export interface ReindexContext {
  prisma: PrismaClient;
  store: SearchStore;
  mode: EmbeddingMode;
  provider: EmbeddingProvider | null;
  cap: number;
  workspaceId: string;
  now?: () => Date;
}

/** 装配 store + 配置视图 + cloud provider（复刻 queryRuntime 的配置口径，不改冻结文件）。 */
export async function buildContext(
  d: ReindexDeps,
  prisma: PrismaClient,
  store: SearchStore,
): Promise<ReindexContext> {
  const cfgStore = new EmbeddingConfigStore(prisma, d.jwtSecret);
  const view = await cfgStore.resolveView(d.env);
  let mode: EmbeddingMode = "off";
  let provider: EmbeddingProvider | null = null;
  if (d.provider !== undefined) {
    if (d.provider && d.provider.mode === "cloud") { mode = "cloud"; provider = d.provider; }
  } else if (view.mode === "cloud") {
    const apiKey = await cfgStore.getApiKey().catch(() => null);
    const candidate = createEmbeddingProvider("cloud", {
      baseURL: view.baseURL,
      apiKey: apiKey ?? d.env.GX_EMBEDDING_API_KEY?.trim() ?? "",
      model: view.model,
      batchSize: view.batchSize,
      timeoutMs: view.timeoutMs,
    });
    // createEmbeddingProvider 在配置不齐时回落 off provider；只在确为 cloud 时采用。
    if (candidate.mode === "cloud") { mode = "cloud"; provider = candidate; }
  }
  return {
    prisma, store, mode, provider,
    cap: view.fieldChunkCap || FIELD_CHUNK_CAP,
    workspaceId: d.workspaceId ?? DEFAULT_WORKSPACE,
    now: d.now,
  };
}

/** 抽一个实体当前活内容并灌入 ctx.store（删除/upsert 两态共用 applyUpsert/deleteDerived）。 */
export async function pumpOne(ctx: ReindexContext, ref: LiveEntityRef): Promise<{
  chunks: number; vec: number; debt: number;
}> {
  const entity: ExtractedEntity = await extractEntity(ctx.prisma, ref, ctx.cap);
  if (!entity.present) {
    const removed = deleteDerived(ctx.store, ref.entityType, ref.entityId);
    return { chunks: removed, vec: 0, debt: 0 };
  }
  const s = await applyUpsert(ctx.store, entity, {
    workspaceId: ctx.workspaceId, mode: ctx.mode, provider: ctx.provider, now: ctx.now,
  });
  return { chunks: s.chunksWritten, vec: s.vecWritten, debt: s.vecDebt };
}
