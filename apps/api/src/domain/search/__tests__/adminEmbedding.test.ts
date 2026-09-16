// M5/S9 embedding 配置 service 单测：JWT_SECRET 轮换致旧密文不可解不 500（§9 硬点）、
// PATCH 两步标记与字段白名单。真临时主库（AppSetting 表），无 search.db 依赖、零外网。

import { afterEach, describe, expect, it } from "vitest";
import { makeIndexerHarness, type IndexerHarness } from "./indexerHarness.js";
import { EmbeddingConfigStore } from "../embeddingConfig.js";
import {
  getEmbeddingConfig,
  patchEmbeddingConfig,
  rotateApiKey,
  clearApiKey,
  EmbeddingConfigInvalid,
  NeedCloudConfirm,
} from "../adminEmbedding.js";

const SECRET_A = "m5-s9-cfg-secret-A-atleast16";
const SECRET_B = "m5-s9-cfg-secret-B-rotated-16";

describe("M5/S9 EmbeddingConfigService（JWT 轮换不 500 + 两步纪律）", () => {
  let h: IndexerHarness;

  afterEach(async () => {
    await h?.cleanup();
  });

  function deps(secret = SECRET_A) {
    return { prisma: h.prisma, env: {}, jwtSecret: secret };
  }

  it("旧密文在新 JWT_SECRET 下 GET 回 configured:false/source:none，绝不抛错", async () => {
    h = await makeIndexerHarness("gx-m5-s9-cfg-rot-");
    // 用 SECRET_A 加密落库。
    const storeA = new EmbeddingConfigStore(h.prisma, SECRET_A);
    await storeA.setApiKey("rotated-secret-value-4242");
    expect(await storeA.getApiKey()).toBe("rotated-secret-value-4242");

    // 密钥轮换为 SECRET_B：GET 不 500，回落未配置。
    const cfg = await getEmbeddingConfig(deps(SECRET_B));
    expect(cfg.apiKey).toEqual({ configured: false, source: "none", maskedLast4: null });
  });

  it("PATCH dim/dimensions/reindex 入参 -> EmbeddingConfigInvalid", async () => {
    h = await makeIndexerHarness("gx-m5-s9-cfg-dim-");
    for (const body of [{ dim: 8 }, { dimensions: 8 }, { reindex: true }]) {
      await expect(patchEmbeddingConfig(deps(), body)).rejects.toBeInstanceOf(EmbeddingConfigInvalid);
    }
  });

  it("off->cloud 缺 confirmCloud -> NeedCloudConfirm；带确认后 reindexRequired=true", async () => {
    h = await makeIndexerHarness("gx-m5-s9-cfg-cloud-");
    await expect(patchEmbeddingConfig(deps(), { mode: "cloud" })).rejects.toBeInstanceOf(NeedCloudConfirm);
    const r = await patchEmbeddingConfig(deps(), {
      mode: "cloud", confirmCloud: true, baseURL: "https://e.example/v1", model: "m", apiKey: "k-1234",
    });
    expect(r.config.mode).toBe("cloud");
    expect(r.reindexRequired).toBe(true);
    expect(r.keyRotated).toBe(true);
    expect(r.config.apiKey).toMatchObject({ configured: true, source: "db", maskedLast4: "1234" });
  });

  it("cloud->off 不需确认；baseURL/batch/timeout 变更不置 reindexRequired，model 变更才置", async () => {
    h = await makeIndexerHarness("gx-m5-s9-cfg-off-");
    await patchEmbeddingConfig(deps(), {
      mode: "cloud", confirmCloud: true, baseURL: "https://e.example/v1", model: "m1", apiKey: "k-1234",
    });
    const back = await patchEmbeddingConfig(deps(), { mode: "off" });
    expect(back.config.mode).toBe("off");
    // 已无待重建（新库：off 不产生向量，模式回退本身不改派生 FTS）；mode 变更仍标记。
    expect(back.reindexRequired).toBe(true);

    const onlyConn = await patchEmbeddingConfig(deps(), { batchSize: 16, timeoutMs: 8000 });
    expect(onlyConn.changed).toEqual(expect.arrayContaining(["batchSize", "timeoutMs"]));
    // 一旦已被标记，连接类字段不清标记；用全新库验证连接类字段不【主动】置标记。
    const h2 = await makeIndexerHarness("gx-m5-s9-cfg-conn-");
    const fresh = await patchEmbeddingConfig(
      { prisma: h2.prisma, env: {}, jwtSecret: SECRET_A },
      { baseURL: "https://x.example/v1", batchSize: 16, timeoutMs: 8000 },
    );
    expect(fresh.changed.sort()).toEqual(["baseURL", "batchSize", "timeoutMs"]);
    expect(fresh.reindexRequired).toBe(false);
    await h2.cleanup();
  });

  it("rotate 加密落库；clear 清 db 回 none（不回明文）", async () => {
    h = await makeIndexerHarness("gx-m5-s9-cfg-key-");
    const st = await rotateApiKey(deps(), { apiKey: "xyz-secret-7788" });
    expect(st).toMatchObject({ configured: true, source: "db", maskedLast4: "7788" });
    const cipher = await h.prisma.appSetting.findUnique({ where: { k: "embedding.api_key_cipher" } });
    expect(cipher?.v.startsWith("v1:")).toBe(true);
    expect(cipher?.v).not.toContain("xyz-secret-7788");
    const cleared = await clearApiKey(deps());
    expect(cleared).toEqual({ configured: false, source: "none", maskedLast4: null });
    expect(await h.prisma.appSetting.findUnique({ where: { k: "embedding.api_key_cipher" } })).toBeNull();
  });

  it("fieldChunkCap 越界、坏 URL、非正整数 -> EmbeddingConfigInvalid", async () => {
    h = await makeIndexerHarness("gx-m5-s9-cfg-val-");
    for (const body of [
      { fieldChunkCap: 0 }, { fieldChunkCap: 1001 },
      { baseURL: "gopher://x" }, { baseURL: "not url" },
      { batchSize: 0 }, { timeoutMs: -2 },
    ]) {
      await expect(patchEmbeddingConfig(deps(), body)).rejects.toBeInstanceOf(EmbeddingConfigInvalid);
    }
  });
});
