/**
 * LicenseStore 三冗余 + 加密缓存 + KV 持久化测试（内存 KV + 临时目录，零真库）。
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LicenseStore, KV, type KvStore } from "../store.js";

class MemKv implements KvStore {
  map = new Map<string, string>();
  async getMany(keys: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const k of keys) if (this.map.has(k)) out.set(k, this.map.get(k) as string);
    return out;
  }
  async setMany(entries: Record<string, string>): Promise<void> {
    for (const [k, v] of Object.entries(entries)) this.map.set(k, v);
  }
}

let dir: string;
let kv: MemKv;
let store: LicenseStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gx-license-"));
  kv = new MemKv();
  store = new LicenseStore(kv, dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("deploymentId", () => {
  it("首启生成 UUID 并 KV+文件双写，再启稳定", async () => {
    const id1 = await store.ensureDeploymentId();
    expect(id1).toMatch(/^[0-9a-f-]{36}$/);
    expect(kv.map.get(KV.deploymentId)).toBe(id1);
    expect(existsSync(join(dir, ".license", "deployment-id"))).toBe(true);
    // 新 store 实例（模拟重启）：同 KV 同目录 → 同 id
    const store2 = new LicenseStore(kv, dir);
    expect(await store2.ensureDeploymentId()).toBe(id1);
  });
});

describe("everCommercial 三路 OR", () => {
  it("初始 false", async () => {
    expect(await store.getEverCommercial()).toBe(false);
  });

  it("markEverCommercial 同时落 KV 与隐藏文件", async () => {
    await store.markEverCommercial();
    expect(kv.map.get(KV.everCommercial)).toBe("1");
    expect(existsSync(join(dir, ".license", ".ever-commercial"))).toBe(true);
    expect(await store.getEverCommercial()).toBe(true);
  });

  it("清掉 KV 仍可由隐藏文件判真（第二路）", async () => {
    await store.markEverCommercial();
    kv.map.delete(KV.everCommercial);
    expect(await store.getEverCommercial()).toBe(true);
  });

  it("清掉文件仍可由 KV 判真（第一路）", async () => {
    await store.markEverCommercial();
    rmSync(join(dir, ".license", ".ever-commercial"), { force: true });
    expect(await store.getEverCommercial()).toBe(true);
  });

  it("存在加密商业缓存即判真（第三路），即便 KV/文件都丢", async () => {
    await store.saveCachedWire({ envelopeB64: "YQ==", signature: "Yg==", kid: "da469cd3" });
    kv.map.delete(KV.everCommercial);
    rmSync(join(dir, ".license", ".ever-commercial"), { force: true });
    expect(await store.getEverCommercial()).toBe(true);
  });
});

describe("加密缓存", () => {
  it("存进去能解出原 wire（GCM）", async () => {
    const wire = { envelopeB64: "ZW52", signature: "c2ln", kid: "da469cd3" };
    await store.saveCachedWire(wire);
    const back = await store.loadCachedWire();
    expect(back).toEqual(wire);
  });

  it("缓存文件被篡改（GCM tag 失败）→ null（fail-safe）", async () => {
    await store.saveCachedWire({ envelopeB64: "ZW52", signature: "c2ln", kid: "da469cd3" });
    const cachePath = join(dir, ".license", "cache.enc");
    const blob = JSON.parse(readFileSync(cachePath, "utf-8"));
    blob.data = Buffer.from("tampered").toString("base64");
    writeFileSync(cachePath, JSON.stringify(blob));
    expect(await store.loadCachedWire()).toBeNull();
  });

  it("clearCommercialCache 删缓存但保留 everCommercial", async () => {
    await store.saveCachedWire({ envelopeB64: "ZW52", signature: "c2ln", kid: "da469cd3" });
    await store.clearCommercialCache();
    expect(await store.loadCachedWire()).toBeNull();
    expect(await store.getEverCommercial()).toBe(true); // KV+文件仍在
  });

  it("密钥文件丢失 → 缓存不可解（null），不崩溃", async () => {
    await store.saveCachedWire({ envelopeB64: "ZW52", signature: "c2ln", kid: "da469cd3" });
    rmSync(join(dir, ".license", ".cache-key"), { force: true });
    expect(await store.loadCachedWire()).toBeNull();
  });
});

describe("maxSeen / grandfathered / baseUrls", () => {
  it("maxSeen 单调不降", async () => {
    await store.setMaxSeen(5000);
    await store.setMaxSeen(4000);
    expect(await store.getMaxSeen()).toBe(5000);
    await store.setMaxSeen(6000);
    expect(await store.getMaxSeen()).toBe(6000);
  });

  it("grandfathered 一次性写入后不再改判", async () => {
    expect(await store.setGrandfatheredOnce(true)).toBeUndefined();
    expect(await store.getGrandfathered()).toBe(true);
    await store.setGrandfatheredOnce(false); // 已写过，忽略
    expect(await store.getGrandfathered()).toBe(true);
  });

  it("baseUrls 去重、截断 ≤3、损坏回落默认", async () => {
    await store.setBaseUrls(["a", "b", "a", "c", "d"]);
    expect(await store.getBaseUrls("builtin")).toEqual(["a", "b", "c"]);
    expect(await new LicenseStore(new MemKv(), dir).getBaseUrls("builtin")).toEqual(["builtin"]);
    kv.map.set(KV.baseUrls, "not-json");
    expect(await store.getBaseUrls("builtin")).toEqual(["builtin"]);
  });

  it("intervalSec 非法回落", async () => {
    expect(await store.getLastIntervalSec(21600)).toBe(21600);
    await store.setLastIntervalSec(60);
    expect(await store.getLastIntervalSec(21600)).toBe(60);
  });
});
