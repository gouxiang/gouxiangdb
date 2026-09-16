// M5/S4 embeddingConfig 单测：纯加解密函数 + 真临时主库 app_settings 持久化（不 mock prisma）。
//
// 覆盖：
//   - AES-256-GCM roundtrip；HKDF 派生确定性/主密钥隔离；空主密钥拒绝；
//   - 落库绝不明文（直接查 app_settings 行）；两次加密 IV 随机（密文不同但都可解）；
//   - 篡改 authTag/密文/版本 -> GCM 校验抛错；
//   - 脱敏只回末 4；fieldChunkCap 正整数门；env 种子默认值；
//   - store 真库读写、db 覆盖 env、env key 回退、空串清除；
//   - JWT_SECRET 轮换：旧密文解不开 -> resolveView 不抛、dbKeyUndecryptable=true、hasKey=false。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNavHarness, type CharHarness } from "../../../nav/__tests__/navRouteHarness.js";
import {
  SETTING_KEYS,
  DEFAULT_FIELD_CHUNK_CAP,
  deriveDataKey,
  encryptSecret,
  decryptSecret,
  maskApiKey,
  validateFieldChunkCap,
  readEnvEmbeddingSeed,
  EmbeddingConfigStore,
} from "../../embeddingConfig.js";

const MASTER_A = "s4-test-master-secret-aaaa";
const MASTER_B = "s4-test-master-secret-bbbb-rotated";
const SECRET = "sk-live-abcdef0123456789";

let h: CharHarness;

beforeAll(async () => {
  h = await makeNavHarness("gx-m5-s4-embcfg-");
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

// ---------------- 纯函数：HKDF 与 AES-256-GCM ----------------

describe("deriveDataKey HKDF-SHA256", () => {
  it("同主密钥派生确定且 32 字节；不同主密钥派生不同；空主密钥拒绝", () => {
    const k1 = deriveDataKey(MASTER_A);
    const k2 = deriveDataKey(MASTER_A);
    expect(k1).toHaveLength(32);
    expect(k1.equals(k2)).toBe(true);
    expect(deriveDataKey(MASTER_B).equals(k1)).toBe(false);
    expect(() => deriveDataKey("")).toThrow();
  });
});

describe("encryptSecret / decryptSecret AES-256-GCM", () => {
  it("roundtrip 解回原文；密文为 v1 版本化四段且不含明文", () => {
    const stored = encryptSecret(SECRET, MASTER_A);
    expect(stored.startsWith("v1:")).toBe(true);
    expect(stored.split(":")).toHaveLength(4);
    expect(stored).not.toContain(SECRET);
    expect(decryptSecret(stored, MASTER_A)).toBe(SECRET);
  });

  it("每次加密 IV 随机：密文不同但都能解回同一明文", () => {
    const a = encryptSecret(SECRET, MASTER_A);
    const b = encryptSecret(SECRET, MASTER_A);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, MASTER_A)).toBe(SECRET);
    expect(decryptSecret(b, MASTER_A)).toBe(SECRET);
  });

  it("主密钥不符（JWT_SECRET 轮换）解密抛 GCM 错，绝不返回错乱明文", () => {
    const stored = encryptSecret(SECRET, MASTER_A);
    expect(() => decryptSecret(stored, MASTER_B)).toThrow();
  });

  it("篡改 authTag 或密文 -> 认证失败抛错", () => {
    const stored = encryptSecret(SECRET, MASTER_A);
    const [ver, iv, tag, ct] = stored.split(":");
    // 翻 base64【首位】：末位可能是 '=' 填充位不改变真实字节；首位必落在第一个真实字节上。
    const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const flipFirst = (s: string) => {
      const idx = B64.indexOf(s[0]);
      const swapped = B64[(idx + 32) % 64];
      return swapped + s.slice(1);
    };
    expect(() => decryptSecret([ver, iv, flipFirst(tag), ct].join(":"), MASTER_A)).toThrow();
    expect(() => decryptSecret([ver, iv, tag, flipFirst(ct)].join(":"), MASTER_A)).toThrow();
  });

  it("版本/段数不符抛错（不把垃圾当密文解密）", () => {
    expect(() => decryptSecret("v2:aa:bb:cc", MASTER_A)).toThrow();
    expect(() => decryptSecret("v1:onlythree", MASTER_A)).toThrow();
  });
});

describe("maskApiKey / validateFieldChunkCap / env 种子", () => {
  it("脱敏只回末 4；短串不泄露；绝不等于明文", () => {
    expect(maskApiKey(SECRET)).toBe(`****${SECRET.slice(-4)}`);
    expect(maskApiKey(SECRET)).not.toContain(SECRET.slice(0, -4));
    expect(maskApiKey("ab")).toBe("****");
    expect(maskApiKey("abc")).toBe("****");
  });

  it("fieldChunkCap 仅收 [1,1000] 整数", () => {
    expect(validateFieldChunkCap(50)).toBe(50);
    expect(() => validateFieldChunkCap(0)).toThrow();
    expect(() => validateFieldChunkCap(-1)).toThrow();
    expect(() => validateFieldChunkCap(1001)).toThrow();
    expect(() => validateFieldChunkCap(1.5)).toThrow();
  });

  it("env 种子默认值：off/64/15000/fieldChunkCap=50；cloud 可解析；非法正整数回落默认", () => {
    const d = readEnvEmbeddingSeed({});
    expect(d).toMatchObject({ mode: "off", baseURL: "", apiKey: "", model: "",
      batchSize: 64, timeoutMs: 15000, fieldChunkCap: DEFAULT_FIELD_CHUNK_CAP });
    const c = readEnvEmbeddingSeed({ GX_EMBEDDING_MODE: " Cloud ", GX_EMBEDDING_BASE_URL: " https://h ",
      GX_EMBEDDING_BATCH_SIZE: "128", GX_SEARCH_FIELD_CHUNK_CAP: "80" });
    expect(c.mode).toBe("cloud");
    expect(c.baseURL).toBe("https://h");
    expect(c.batchSize).toBe(128);
    expect(c.fieldChunkCap).toBe(80);
    const bad = readEnvEmbeddingSeed({ GX_EMBEDDING_BATCH_SIZE: "0", GX_EMBEDDING_TIMEOUT_MS: "x",
      GX_SEARCH_FIELD_CHUNK_CAP: "99999" });
    expect(bad.batchSize).toBe(64);
    expect(bad.timeoutMs).toBe(15000);
    expect(bad.fieldChunkCap).toBe(DEFAULT_FIELD_CHUNK_CAP);
  });
});

// ---------------- 真库：app_settings 持久化与视图合并 ----------------

describe("EmbeddingConfigStore 真临时主库", () => {
  it("setApiKey 加密落库：app_settings 行绝不明文含 key，但 getApiKey 解回原文", async () => {
    const store = new EmbeddingConfigStore(h.prisma, MASTER_A);
    await store.setApiKey(SECRET);
    const row = await h.prisma.appSetting.findUnique({ where: { k: SETTING_KEYS.apiKeyCipher } });
    expect(row).not.toBeNull();
    expect(row!.v.startsWith("v1:")).toBe(true);
    expect(row!.v).not.toContain(SECRET);
    expect(await store.getApiKey()).toBe(SECRET);
  });

  it("两次写入 IV 随机：库中密文变化", async () => {
    const store = new EmbeddingConfigStore(h.prisma, MASTER_A);
    await store.setApiKey(`${SECRET}-one`);
    const c1 = (await h.prisma.appSetting.findUnique({ where: { k: SETTING_KEYS.apiKeyCipher } }))!.v;
    await store.setApiKey(`${SECRET}-one`);
    const c2 = (await h.prisma.appSetting.findUnique({ where: { k: SETTING_KEYS.apiKeyCipher } }))!.v;
    expect(c1).not.toBe(c2);
  });

  it("空串 setApiKey 等价清除；deleteApiKey 后 getApiKey=null", async () => {
    const store = new EmbeddingConfigStore(h.prisma, MASTER_A);
    await store.setApiKey(SECRET);
    expect(await store.getApiKey()).toBe(SECRET);
    await store.setApiKey("   ");
    expect(await store.getApiKey()).toBeNull();
    await store.setApiKey(SECRET);
    await store.deleteApiKey();
    expect(await store.getApiKey()).toBeNull();
  });

  it("db 标量覆盖 env；无 db 时回落 env；fieldChunkCap 默认 50", async () => {
    const store = new EmbeddingConfigStore(h.prisma, MASTER_A);
    const envCloud = { GX_EMBEDDING_MODE: "cloud", GX_EMBEDDING_BASE_URL: "https://env",
      GX_EMBEDDING_MODEL: "env-model" } as NodeJS.ProcessEnv;
    const fromEnv = await store.resolveView(envCloud);
    expect(fromEnv).toMatchObject({ mode: "cloud", baseURL: "https://env", model: "env-model" });
    expect(fromEnv.fieldChunkCap).toBe(DEFAULT_FIELD_CHUNK_CAP);

    await store.setMode("off");
    await store.setBaseUrl("https://db");
    await store.setModel("db-model");
    await store.setFieldChunkCap(80);
    const fromDb = await store.resolveView(envCloud);
    expect(fromDb).toMatchObject({ mode: "off", baseURL: "https://db", model: "db-model", fieldChunkCap: 80 });
  });

  it("脱敏视图：db key 只回 hasKey/keySource=db/maskedKey 末4，回传体无明文", async () => {
    const store = new EmbeddingConfigStore(h.prisma, MASTER_A);
    await store.setApiKey(SECRET);
    const view = await store.resolveView({});
    expect(view.hasKey).toBe(true);
    expect(view.keySource).toBe("db");
    expect(view.maskedKey).toBe(`****${SECRET.slice(-4)}`);
    expect(view.dbKeyUndecryptable).toBe(false);
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });

  it("无 db key 时 env key 回退：keySource=env、脱敏 env key", async () => {
    const store = new EmbeddingConfigStore(h.prisma, MASTER_A);
    await store.deleteApiKey();
    const view = await store.resolveView({ GX_EMBEDDING_API_KEY: `env-${SECRET}` } as NodeJS.ProcessEnv);
    expect(view.hasKey).toBe(true);
    expect(view.keySource).toBe("env");
    expect(view.maskedKey).toBe(`****${SECRET.slice(-4)}`);
    expect(view.dbKeyUndecryptable).toBe(false);
  });

  it("JWT_SECRET 轮换：旧密文解不开 -> resolveView 不抛、dbKeyUndecryptable=true、hasKey=false", async () => {
    const writer = new EmbeddingConfigStore(h.prisma, MASTER_A);
    await writer.setApiKey(SECRET);
    // 轮换后用新主密钥构造的 store：视图层优雅回落，绝不 500。
    const rotated = new EmbeddingConfigStore(h.prisma, MASTER_B);
    const view = await rotated.resolveView({});
    expect(view.dbKeyUndecryptable).toBe(true);
    expect(view.hasKey).toBe(false);
    expect(view.keySource).toBe("none");
    expect(view.maskedKey).toBeNull();
    // 但写入校验场景 getApiKey 仍显式失败（不静默吞成空串）。
    await expect(rotated.getApiKey()).rejects.toThrow();
  });

  it("轮换后若 env 仍提供 key：标记不可解但回退 env，hasKey=true/keySource=env", async () => {
    const view = await new EmbeddingConfigStore(h.prisma, MASTER_B)
      .resolveView({ GX_EMBEDDING_API_KEY: `env-${SECRET}` } as NodeJS.ProcessEnv);
    expect(view.dbKeyUndecryptable).toBe(true);
    expect(view.hasKey).toBe(true);
    expect(view.keySource).toBe("env");
  });
});
