// M5/S12 AC-M5-1①②③⑦ 降级矩阵 —— cloud 形态（真迁移/真 app/真 JWT，可控 fetch，零真外网）。
//
//  ① vec0 坏扩展（GX_VEC_EXT_PATH 指向内容错误的文件，dlopen/dlsym 失败）-> vec_unavailable，
//     fts/like 仍 200、主写可写；
//  ② cloud 401（不重试，unhealthy）/网络故障/超时（重试耗尽，连续失败）-> embedding_unhealthy，
//     fts/like 200；
//  ③ dim 不符（stub 回 999 维，现役库 embeddingDim=4）-> dim_mismatch；
//  ⑦ 恢复后向量欠账补齐：cloud 正常时重建/重播，D 类 chunk 重新获得 vec 行（coverage D=0）。
//
// 断言降级不改召回授权：结果只来自 scope 可见集（owner 全可见，本片不重复 AC-M5-2/3 安全对抗）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupS12, searchOnce, type S12World } from "./m5-s12-harness.js";

let w: S12World;

beforeAll(async () => { w = await setupS12({ mode: "cloud", label: "degrade-cloud" }); }, 180000);
afterAll(async () => { await w.cleanup(); });

/** 直读 search.db 的 D 类欠账：cloud 下没有 vec 行的 chunk 数（vec_chunks 是 vec0 虚表，需加载扩展）。 */
async function vectorDebt(): Promise<number> {
  const { searchStore } = await w.modules();
  const s = searchStore.openSearchStore({ filePath: w.searchPath, appDir: process.cwd(), tryLoadVec: true });
  try {
    const hasVec = s.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='vec_chunks'").get() !== undefined;
    if (!hasVec) return -1;
    const row = s.db.prepare(`
      SELECT COUNT(*) AS c FROM chunks ch
      WHERE NOT EXISTS (SELECT 1 FROM vec_chunks v WHERE v.rowid = ch.rowid)`).get() as { c: number };
    return row.c;
  } finally { s.close(); }
}

describe("AC-M5-1③ cloud dim 不符", () => {
  it("embed 回 999 维而库为 4 维：auto 标 dim_mismatch、200 且 FTS 命中正常", async () => {
    await w.seedRecord({ primary: "维度不符唯一词DIMMISMATCH1" });
    expect(w.counts().vec).toBeGreaterThan(0); // 基线：4 维向量行已写
    w.setCloudRule("dim999");
    const r = await searchOnce(w, "DIMMISMATCH1");
    expect(r.status).toBe(200);
    expect(r.body.degraded).toContain("dim_mismatch");
    expect(["fts", "like"]).toContain(r.body.mode);
    expect(r.body.items.length).toBeGreaterThan(0);
    // 主写不受 cloud 故障影响。
    const post = await w.http("/api/records", { method: "POST", headers: await w.auth(), body: JSON.stringify({}) });
    expect([200, 201, 400]).toContain(post.status); // 无 tableId 允许 400，但不 5xx
    w.setCloudRule("controlled");
  });
});

describe("AC-M5-1② cloud 401/网络/超时连续失败", () => {
  it("401 立即 unhealthy：auto 标 embedding_unhealthy、200 FTS 命中、不重试（仅 1 次调用）", async () => {
    await w.seedRecord({ primary: "鉴权故障词AUTHFAIL1" });
    w.embeddingCalls.length = 0;
    w.setCloudRule("http401");
    const r = await searchOnce(w, "AUTHFAIL1");
    expect(r.status).toBe(200);
    expect(r.body.degraded).toContain("embedding_unhealthy");
    expect(r.body.items.length).toBeGreaterThan(0);
    const embedCalls = w.embeddingCalls.filter((c) => c.url.endsWith("/v1/embeddings"));
    expect(embedCalls).toHaveLength(1); // 4xx auth 不重试
    w.setCloudRule("controlled");
  });

  it("网络故障：重试耗尽标 embedding_unhealthy、200；恢复后同查询不再降级", async () => {
    await w.seedRecord({ primary: "网络故障词NETDOWN1" });
    w.setCloudRule("network");
    const r = await searchOnce(w, "NETDOWN1");
    expect(r.status).toBe(200);
    expect(r.body.degraded).toContain("embedding_unhealthy");
    expect(r.body.items.length).toBeGreaterThan(0);
    w.setCloudRule("controlled");
    const ok = await searchOnce(w, "NETDOWN1");
    expect(ok.status).toBe(200);
    expect(ok.body.degraded).toEqual([]);
  }, 30000);

  it("超时（AbortController 触发 AbortError）：重试耗尽 embedding_unhealthy、200", async () => {
    const mods = await w.modules();
    w.setEnv("GX_EMBEDDING_TIMEOUT_MS", "60");
    mods.queryRuntime.resetQueryRuntimeCaches(); // timeoutMs 在 provider 构造时绑定，env 变更需重建
    await w.seedRecord({ primary: "超时故障词TIMEOUT1" });
    w.setCloudRule("timeout");
    const r = await searchOnce(w, "TIMEOUT1");
    expect(r.status).toBe(200);
    expect(r.body.degraded).toContain("embedding_unhealthy");
    expect(r.body.items.length).toBeGreaterThan(0);
    w.setCloudRule("controlled");
    w.setEnv("GX_EMBEDDING_TIMEOUT_MS", "4000");
    mods.queryRuntime.resetQueryRuntimeCaches();
  }, 30000);
});


describe("AC-M5-1⑦ 恢复后向量欠账补齐", () => {
  it("损坏重建后台重播走 cloud provider：重播后 cloud 形态 D 类欠账归零（vec 行补齐）", async () => {
    const rec = await w.seedRecord({ primary: "向量欠账补齐词DEBTBACKFILL1" });
    expect(await vectorDebt()).toBe(0); // 健康基线无欠账

    w.corruptSearchDbMagic();
    const r = await searchOnce(w, "DEBTBACKFILL1");
    expect(r.status).toBe(200);
    expect(r.body.degraded).toContain("search_store_recovering");
    expect(r.body.items.map((i: { entityId: string }) => i.entityId)).toContain(rec.recordId);
    const { recovery } = await w.modules();
    await recovery.currentRepopulation();

    // 重播成功：chunks/fts/vec 全部回来，D=0（每个 chunk 都有对应向量行）。
    const c = w.counts();
    expect(c.chunks).toBeGreaterThan(0);
    expect(c.fts).toBeGreaterThan(0);
    expect(c.vec).toBeGreaterThan(0);
    expect(await vectorDebt()).toBe(0);
  }, 60000);
});
