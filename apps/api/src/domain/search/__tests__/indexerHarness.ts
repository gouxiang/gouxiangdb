// M5/S5 indexer 测试共享夹具：真临时主库（makeNavHarness 迁移）+ 真临时 search.db。
// 不 mock prisma/searchStore；cloud 向量只 mock EmbeddingProvider（不触外网）。

import path from "node:path";
import { makeNavHarness, type CharHarness } from "../../nav/__tests__/navRouteHarness.js";
import { openSearchStore, type SearchStore } from "../searchStore.js";

export interface IndexerHarness extends CharHarness {
  tmpDir: string;
  /** 默认 search.db 路径（openStore 不传 key 时用）。 */
  searchPath: string;
  /** 开一个独立命名的临时 search.db（同 harness 内多用例隔离 worker_lock/派生数据）。 */
  openStore: (key?: string, tryLoadVec?: boolean) => SearchStore;
  /** 取某命名 search.db 的物理路径（check-coverage 直读用）。 */
  searchPathFor: (key?: string) => string;
}

let counter = 0;

export async function makeIndexerHarness(label = "gx-m5-s5-"): Promise<IndexerHarness> {
  const h = await makeNavHarness(label);
  counter += 1;
  const base = (key?: string) =>
    path.join(h.tmpDir, key ? `search-${counter}-${key}.db` : `search-${counter}.db`);
  return {
    ...h,
    searchPath: base(),
    searchPathFor: (key?: string) => base(key),
    openStore(keyOrVec?: string | boolean, maybeVec?: boolean): SearchStore {
      const key = typeof keyOrVec === "string" ? keyOrVec : undefined;
      const tryLoadVec = typeof keyOrVec === "boolean" ? keyOrVec : (maybeVec ?? true);
      return openSearchStore({ filePath: base(key), appDir: process.cwd(), tryLoadVec });
    },
  };
}

export const at = (ms: number) => new Date(Date.parse("2026-05-01T00:00:00.000Z") + ms);

/** 造一个活 base + table + 若干字段，返回 id。 */
export async function seedTable(
  h: CharHarness,
  p: string,
  fields: Array<{ id: string; name: string; type: string; order: number }>,
) {
  const baseId = `${p}_b`;
  const tableId = `${p}_t`;
  await h.prisma.base.create({ data: { id: baseId, name: `${p} 库`, createdBy: "owner" } });
  await h.prisma.table.create({
    data: { id: tableId, baseId, name: `${p} 表`, primaryFieldId: fields[0]?.id ?? "", createdBy: "owner" },
  });
  for (const f of fields) {
    await h.prisma.field.create({
      data: { id: f.id, tableId, name: f.name, type: f.type, order: f.order },
    });
  }
  return { baseId, tableId };
}

export async function seedRecord(
  h: CharHarness,
  tableId: string,
  id: string,
  values: Record<string, unknown>,
) {
  await h.prisma.record.create({
    data: { id, tableId, createdBy: "o", updatedBy: "o", fields: JSON.stringify(values) },
  });
}

export async function enqueue(
  h: CharHarness,
  ev: { entityType: "record" | "doc" | "canvas"; entityId: string; op: "upsert" | "delete"; version?: bigint; status?: string; workerId?: string | null; nextRunAt?: Date; attempts?: number },
) {
  await h.prisma.changeEvent.create({
    data: {
      entityType: ev.entityType,
      entityId: ev.entityId,
      version: ev.version ?? 1n,
      op: ev.op,
      status: ev.status ?? "pending",
      workerId: ev.workerId ?? null,
      attempts: ev.attempts ?? 0,
      nextRunAt: ev.nextRunAt ?? new Date(),
    },
  });
}

/** 一个被调用即失败的 provider（off 模式下证明 embed 绝不被触达）。 */
export function tripwireProvider() {
  return {
    mode: "cloud" as const,
    model: "trip",
    dim: 0,
    batchSize: 64,
    embed: async (): Promise<Float32Array[]> => {
      throw new Error("provider must not be called in off mode");
    },
    health: async () => ({ ok: false }),
    dispose: async () => undefined,
  };
}

/** 可控 mock cloud provider：记录入参文本，按 failTimes 次抛错后成功返回 dim 维向量。 */
export function mockCloudProvider(opts: { dim?: number; failTimes?: number; batchSize?: number } = {}) {
  const dim = opts.dim ?? 3;
  let failLeft = opts.failTimes ?? 0;
  const calls: string[][] = [];
  return {
    mode: "cloud" as const,
    model: "mock-model",
    dim: 0,
    batchSize: opts.batchSize ?? 64,
    calls,
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      calls.push([...texts]);
      if (failLeft > 0) {
        failLeft -= 1;
        throw new Error("mock cloud 5xx");
      }
      return texts.map(() => new Float32Array(dim));
    },
    async health() { return { ok: true }; },
    async dispose() { return undefined; },
  };
}
