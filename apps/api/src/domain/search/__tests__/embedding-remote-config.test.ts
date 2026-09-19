// 语义检索远端配置项补齐的 service 层单测：provider 向后兼容 / dimension 分档放行 /
// 并发与重试可写可读 / 检索总门 db 覆盖 / 连通性自检不落库。
//
// 真临时主库（AppSetting 表），零外网：探活用注入 fetch，不触真远端。

import { afterEach, describe, expect, it } from "vitest";
import { makeIndexerHarness, type IndexerHarness } from "./indexerHarness.js";
import { EmbeddingConfigStore, SETTING_KEYS } from "../embeddingConfig.js";
import {
  getEmbeddingConfig,
  patchEmbeddingConfig,
  EmbeddingConfigInvalid,
} from "../adminEmbedding.js";
import { testEmbeddingConnection } from "../embeddingProbe.js";
import { parseEmbeddingProvider } from "../embedding/types.js";
import { resolveSearchGate, parseSearchEnabledOverride, resetSearchGateCache } from "../searchGate.js";

const SECRET = "m5-remote-cfg-secret-atleast16";

describe("远端嵌入配置项（provider / dim / 并发 / 重试 / 总门）", () => {
  let h: IndexerHarness;

  afterEach(async () => {
    resetSearchGateCache();
    await h?.cleanup();
  }, 30_000);

  function deps(env: NodeJS.ProcessEnv = {}) {
    return { prisma: h.prisma, env, jwtSecret: SECRET };
  }

  // ---- provider：向后兼容 ----
  it("老库无 embedding.provider 键 -> GET 回 cloud（不报错、不读出 undefined）", async () => {
    h = await makeIndexerHarness("gx-remote-cfg-legacy-");
    const cfg = await getEmbeddingConfig(deps());
    expect(cfg.provider).toBe("cloud");
    expect(cfg.dimEditable).toBe(false);
  }, 30_000);

  it("库里躺着未知 provider 值 -> 仍按 cloud 处理（保守口径，与 mode 解析同款）", async () => {
    h = await makeIndexerHarness("gx-remote-cfg-unknown-");
    await h.prisma.appSetting.upsert({
      where: { k: SETTING_KEYS.provider },
      create: { k: SETTING_KEYS.provider, v: "totally-unknown-provider" },
      update: { v: "totally-unknown-provider" },
    });
    expect((await getEmbeddingConfig(deps())).provider).toBe("cloud");
    // 纯函数层：缺值/未知值一律 cloud，已知值大小写不敏感。
    expect(parseEmbeddingProvider(undefined)).toBe("cloud");
    expect(parseEmbeddingProvider("")).toBe("cloud");
    expect(parseEmbeddingProvider("Self-Hosted")).toBe("self-hosted");
  }, 30_000);

  it("provider 非法值 -> 400；合法值落库并在 GET 回读", async () => {
    h = await makeIndexerHarness("gx-remote-cfg-provider-");
    await expect(
      patchEmbeddingConfig(deps(), { provider: "local-llm" }),
    ).rejects.toBeInstanceOf(EmbeddingConfigInvalid);
    const r = await patchEmbeddingConfig(deps(), { provider: "self-hosted" });
    expect(r.config.provider).toBe("self-hosted");
    expect(r.config.dimEditable).toBe(true);
    expect(r.reindexRequired).toBe(true); // 形态变更 -> 需显式重建
  }, 30_000);

  // ---- dimension：分档放行 ----
  it("cloud 档仍拒 dim（维度由 model 元数据决定，手填会写坏索引）", async () => {
    h = await makeIndexerHarness("gx-remote-dim-cloud-");
    for (const bad of [{ dim: 768 }, { dimensions: 768 }, { dim: 0 }, { dim: -1 }, { dim: 99999 }]) {
      await expect(patchEmbeddingConfig(deps(), bad)).rejects.toBeInstanceOf(EmbeddingConfigInvalid);
    }
  }, 30_000);

  it("self-hosted / openai-compatible 档接受 dim；非法值明确 400", async () => {
    h = await makeIndexerHarness("gx-remote-dim-ok-");
    await patchEmbeddingConfig(deps(), { provider: "self-hosted" });
    const ok = await patchEmbeddingConfig(deps(), { dim: 1024 });
    expect(ok.config.dimOverride).toBe(1024);
    for (const bad of [{ dim: 0 }, { dim: -8 }, { dim: 4097 }, { dim: 1.5 }, { dim: "768" }]) {
      await expect(patchEmbeddingConfig(deps(), bad)).rejects.toBeInstanceOf(EmbeddingConfigInvalid);
    }
  }, 30_000);

  it("切回 cloud 档自动清掉手填维度（避免残留值与 model 元数据打架）", async () => {
    h = await makeIndexerHarness("gx-remote-dim-clear-");
    await patchEmbeddingConfig(deps(), { provider: "openai-compatible" });
    expect((await patchEmbeddingConfig(deps(), { dim: 512 })).config.dimOverride).toBe(512);
    const back = await patchEmbeddingConfig(deps(), { provider: "cloud" });
    expect(back.config.dimOverride).toBe(0);
    expect(back.config.dimEditable).toBe(false);
  }, 30_000);

  // ---- 并发与重试 ----
  it("concurrency / retry 可写可读；非法值 400（含 0、负数、超界、非整数）", async () => {
    h = await makeIndexerHarness("gx-remote-conc-");
    const r = await patchEmbeddingConfig(deps(), {
      concurrency: 8, retryMaxAttempts: 5, retryBaseMs: 250,
    });
    expect(r.config.concurrency).toBe(8);
    expect(r.config.retryMaxAttempts).toBe(5);
    expect(r.config.retryBaseMs).toBe(250);
    // 刷新后仍在（真落 app_settings，不是只回显）。
    expect((await getEmbeddingConfig(deps())).concurrency).toBe(8);

    for (const bad of [{ concurrency: 0 }, { concurrency: -1 }, { concurrency: 65 }, { concurrency: 2.5 }]) {
      await expect(patchEmbeddingConfig(deps(), bad)).rejects.toBeInstanceOf(EmbeddingConfigInvalid);
    }
    for (const bad of [{ retryMaxAttempts: 0 }, { retryMaxAttempts: 11 }, { retryBaseMs: 0 }]) {
      await expect(patchEmbeddingConfig(deps(), bad)).rejects.toBeInstanceOf(EmbeddingConfigInvalid);
    }
    // 并发/重试不改派生内容 -> 不置重建标记。
    expect(r.reindexRequired).toBe(false);
  }, 30_000);

  // ---- 检索总门 db 覆盖 ----
  it("总门覆盖 on/off/inherit 落库回读；非法值 400", async () => {
    h = await makeIndexerHarness("gx-remote-gate-");
    expect((await getEmbeddingConfig(deps())).searchGate.override).toBe("inherit");
    const off = await patchEmbeddingConfig(deps({ GX_M5_SEARCH: "on" }), { searchEnabled: "off" });
    expect(off.config.searchGate).toMatchObject({ envValue: "on", override: "off", effective: "off", queryAvailable: false });
    const back = await patchEmbeddingConfig(deps({ GX_M5_SEARCH: "on" }), { searchEnabled: "inherit" });
    expect(back.config.searchGate.override).toBe("inherit");
    await expect(
      patchEmbeddingConfig(deps(), { searchEnabled: "yes" }),
    ).rejects.toBeInstanceOf(EmbeddingConfigInvalid);
  }, 30_000);

  it("env=off 时如实标注：路由未挂载，覆盖键此刻无法启用检索", async () => {
    h = await makeIndexerHarness("gx-remote-gate-envoff-");
    const cfg = await getEmbeddingConfig(deps()); // env 空 -> off
    expect(cfg.searchGate.envValue).toBe("off");
    expect(cfg.searchGate.envGateOff).toBe(true);
    expect(cfg.searchGate.queryAvailable).toBe(false);
    expect(cfg.searchGate.workerNeedsRestart).toBe(true);
  }, 30_000);

  it("resolveSearchGate 纯函数：inherit 跟随 env、on/off 覆盖，未知覆盖值回落 inherit", () => {
    expect(resolveSearchGate("shadow", "inherit").effective).toBe("shadow");
    expect(resolveSearchGate("on", "off")).toMatchObject({ effective: "off", queryAvailable: false });
    expect(resolveSearchGate("off", "on")).toMatchObject({ effective: "on", envGateOff: true, queryAvailable: false });
    expect(parseSearchEnabledOverride("ON")).toBe("on");
    expect(parseSearchEnabledOverride("whatever")).toBe("inherit");
  });

  // ---- 启用路径不被空表单卡死 ----
  it("点启用时地址/模型还没填：空串按「未填写」跳过，不 400；畸形值仍 400", async () => {
    h = await makeIndexerHarness("gx-remote-empty-");
    const r = await patchEmbeddingConfig(deps(), { mode: "cloud", confirmCloud: true, baseURL: "", model: "" });
    expect(r.config.mode).toBe("cloud");
    expect(r.config.baseURL).toBe("");
    expect(r.config.model).toBe("");
    for (const bad of [{ baseURL: "not a url" }, { baseURL: "ftp://x.example" }, { baseURL: 123 }, { model: 123 }]) {
      await expect(patchEmbeddingConfig(deps(), bad)).rejects.toBeInstanceOf(EmbeddingConfigInvalid);
    }
  }, 30_000);

  // ---- 连通性自检 ----
  it("探活成功：回 ok/dim/耗时，且绝不回显密钥、绝不落库", async () => {
    h = await makeIndexerHarness("gx-remote-probe-ok-");
    const store = new EmbeddingConfigStore(h.prisma, SECRET);
    await store.setMode("cloud");
    await store.setBaseUrl("https://embedding.example.com/v1");
    await store.setModel("text-embedding-3-small");
    await store.setApiKey("sk-probe-secret-9999");

    const before = await h.prisma.appSetting.findMany();
    let calls = 0;
    const res = await testEmbeddingConnection({
      ...deps(),
      fetchImpl: (async () => {
        calls += 1;
        return { ok: true, status: 200, json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }) };
      }) as unknown as typeof fetch,
    });
    expect(calls).toBe(1); // 只发一次，不做退避重试
    expect(res).toMatchObject({ ok: true, dim: 3, errorKind: null });
    expect(JSON.stringify(res)).not.toContain("sk-probe-secret-9999");
    expect(JSON.stringify(res)).not.toContain("9999");
    const after = await h.prisma.appSetting.findMany();
    expect(after.map((r) => `${r.k}=${r.v}`).sort()).toEqual(before.map((r) => `${r.k}=${r.v}`).sort());
  }, 30_000);

  it("探活失败按类别给中性结论（auth 不重试）；配置不完整时不触网", async () => {
    h = await makeIndexerHarness("gx-remote-probe-fail-");
    const store = new EmbeddingConfigStore(h.prisma, SECRET);
    await store.setMode("cloud");
    await store.setBaseUrl("https://embedding.example.com/v1");
    await store.setModel("m");
    await store.setApiKey("sk-probe-secret-9999");

    let calls = 0;
    const auth = await testEmbeddingConnection({
      ...deps(),
      fetchImpl: (async () => {
        calls += 1;
        return { ok: false, status: 401, json: async () => ({}) };
      }) as unknown as typeof fetch,
    });
    expect(auth).toMatchObject({ ok: false, errorKind: "auth", dim: null });
    expect(calls).toBe(1); // 401 不重试
    expect(auth.detail).toContain("密钥");

    // 未启用云端：不触网（fetch 注入了也绝不该被调用）。
    await store.setMode("off");
    let touched = 0;
    const notConfigured = await testEmbeddingConnection({
      ...deps(),
      fetchImpl: (async () => {
        touched += 1;
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }) as unknown as typeof fetch,
    });
    expect(notConfigured).toMatchObject({ ok: false, errorKind: "config" });
    expect(touched).toBe(0);
  }, 30_000);
});
