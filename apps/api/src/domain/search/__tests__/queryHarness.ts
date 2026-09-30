// M5/S7 query 集成测试共享夹具：真迁移主库（setupEngineHarness）+ 真 search.db（可开 vec0）。
// 不 mock prisma/scope/decide/hydrate；cloud 向量只 mock EmbeddingProvider（不触外网）。
// 复用 M4 engineHarness 的用户/角色/部门/nav 节点/fieldMask 策略播种原语，保证 scope 真实。

import {
  setupEngineHarness,
  createUsers,
  createNavNodes,
  createPolicies,
  createDepts,
  addDeptMembership,
  createRole,
  assignRole,
  type EngineHarness,
  type NodeSpec,
  type PolicySpec,
} from "../../authz/__tests__/engineHarness.js";
import { openSearchStore, type SearchStore } from "../searchStore.js";

export interface QueryHarness extends EngineHarness {
  tmpDir: string;
  openStore: (key: string, tryLoadVec?: boolean) => SearchStore;
}

let counter = 0;

export async function makeQueryHarness(label = "gx-m5-s7-query-"): Promise<QueryHarness> {
  const base = await setupEngineHarness(label);
  counter += 1;
  const n = counter;
  return {
    ...base,
    // setupEngineHarness 内部有 tmpDir 但未导出；这里从 DATABASE_URL 推目录（同库目录）。
    get tmpDir() { return process.env.GX_DATA_DIR ?? ""; },
    openStore(key: string, tryLoadVec = false): SearchStore {
      const dir = process.env.GX_DATA_DIR!;
      const path = `${dir}/search-s7-${n}-${key}.db`;
      return openSearchStore({ filePath: path, appDir: process.cwd(), tryLoadVec });
    },
  };
}

export const querySeed = {
  createUsers,
  createNavNodes,
  createPolicies,
  createDepts,
  addDeptMembership,
  createRole,
  assignRole,
};

export type { NodeSpec, PolicySpec };

/** 可控 mock cloud provider：记录入参文本，返回 dim 维向量（可按文本哈希给确定性向量）。 */
export function deterministicCloudProvider(
  opts: { dim?: number; fail?: boolean; multimodal?: boolean } = {},
) {
  const dim = opts.dim ?? 3;
  const calls: string[][] = [];
  const mmCalls: Array<{ text: string; images: string[] }> = [];
  const provider = {
    mode: "cloud" as const,
    model: "mock-model",
    dim: 0,
    batchSize: 64,
    calls,
    mmCalls,
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      calls.push([...texts]);
      if (opts.fail) throw new Error("mock cloud 5xx");
      // 文本首字符码决定 x 分量，制造可区分但确定的向量（仍在白名单收敛测试容忍范围内）。
      return texts.map((t) => {
        const v = new Float32Array(dim);
        v[0] = (t.charCodeAt(0) % 7) / 7;
        return v;
      });
    },
    async health() { return { ok: true }; },
    async dispose() { return undefined; },
  };
  if (opts.multimodal) {
    (provider as unknown as {
      embedMultimodal: (items: readonly { text: string; images: string[] }[]) => Promise<Float32Array[]>;
    }).embedMultimodal = async (items) => {
      for (const it of items) mmCalls.push({ text: it.text, images: [...it.images] });
      if (opts.fail) throw new Error("mock mm 5xx");
      return items.map(() => {
        const v = new Float32Array(dim);
        v[0] = 0.42; // 多模态查询给确定向量
        return v;
      });
    };
  }
  return provider;
}
