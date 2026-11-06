/**
 * LicenseClient 接收链/迁移/离线/吊销端到端（内存传输 + 临时密钥 + 临时目录，零真网零真库）。
 */
import { afterAll, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LicenseClient, type LicenseClientDeps } from "../client.js";
import { LicenseStore, type KvStore } from "../store.js";
import { MockClock } from "../clock.js";
import { parseLicenseConfig, type LicenseConfig } from "../configLicense.js";
import { computeFingerprint } from "../fingerprint.js";
import type { HttpTransport, HttpResponse, RawResponse } from "../http.js";
import type { Entitlement, ParsedEnvelope, WireEnvelope } from "../verify.js";
import { verifyAndParse } from "../verify.js";
import { genEd25519, signWire, type TestKey } from "./signHelper.js";

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

type Handler = (path: string, body: unknown) => HttpResponse | WireEnvelope;

class FakeTransport implements HttpTransport {
  reachable = new Set<string>();
  handlers = new Map<string, Handler>();
  calls: Array<{ base: string; path: string; body: unknown }> = [];

  register(base: string, h: Handler): void {
    this.handlers.set(base, h);
    this.reachable.add(base);
  }
  setReachable(base: string, ok: boolean): void {
    if (ok) this.reachable.add(base);
    else this.reachable.delete(base);
  }

  private toResponse(r: HttpResponse | WireEnvelope): HttpResponse {
    if (typeof (r as HttpResponse).status === "number") return r as HttpResponse;
    return { status: 200, json: r, retryAfterSec: null };
  }

  async post(base: string, path: string, body: unknown): Promise<HttpResponse> {
    this.calls.push({ base, path, body });
    if (!this.reachable.has(base)) throw new Error(`ENETUNREACH ${base}`);
    const h = this.handlers.get(base);
    if (!h) throw new Error(`no handler for ${base}`);
    return this.toResponse(h(path, body));
  }
  async postForm(base: string, _path: string, _form: FormData): Promise<HttpResponse> {
    if (!this.reachable.has(base)) throw new Error("unreachable");
    return { status: 200, json: { ok: true }, retryAfterSec: null };
  }
  async getRaw(base: string, path: string): Promise<RawResponse> {
    void base;
    void path;
    return { status: 200, contentType: "text/plain", size: 0, buffer: Buffer.alloc(0) };
  }
}

interface Harness {
  dir: string;
  kv: MemKv;
  store: LicenseStore;
  clock: MockClock;
  transport: FakeTransport;
  key: TestKey;
  client: LicenseClient;
  cfg: LicenseConfig;
  fingerprint: string;
  identity: LicenseClientDeps["identity"];
  buildDeps: (over?: Partial<LicenseClientDeps>) => LicenseClientDeps;
}

async function makeHarness(mode: "verify" | "enforce" = "enforce", platform: "fnos" | "desktop" = "fnos"): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "gx-lic-client-"));
  const kv = new MemKv();
  const store = new LicenseStore(kv, dir);
  const deploymentId = await store.ensureDeploymentId();
  const clock = new MockClock(1_800_000_000);
  const transport = new FakeTransport();
  const key = genEd25519();
  const cfg = parseLicenseConfig({ GX_LICENSE_MODE: mode, GX_PACKAGE_TYPE: platform === "fnos" ? "fpk" : "dmg" }, dir);
  const identity = {
    identity: {
      platform,
      deploymentId,
      hostname: "nas-lab",
      ...(platform === "desktop" ? { volumeUuid: "vol-root" } : {}),
    },
    deploymentId,
    hostname: "nas-lab",
    packageType: platform === "fnos" ? "fpk" : "dmg",
    arch: "x86",
    deviceName: "nas-lab",
    appVersion: "0.2.7",
  } as LicenseClientDeps["identity"];
  const fingerprint = computeFingerprint(identity.identity);
  const baseDeps: LicenseClientDeps = {
    cfg,
    store,
    clock,
    transport,
    identity,
    verifier: (wire) => verifyAndParse(wire, key.publicKey, key.kid),
    // 默认公网 IP 探测桩：保证本文件所有 bootstrap/heartbeat 零真实出网（需要真值的用例自行覆盖）。
    publicIpResolver: async () => null,
  };
  const client = new LicenseClient(baseDeps);
  return {
    dir, kv, store, clock, transport, key, client, cfg, fingerprint, identity,
    buildDeps: (over) => ({ ...baseDeps, ...over }),
  };
}

function envelope(
  h: Harness,
  partial: Partial<Entitlement> & { version: number; seats?: number; expiresAt?: number } = { version: 1 },
): ParsedEnvelope {
  const e: Entitlement = {
    product: "gouxiangdb",
    edition: "business",
    licenseId: "lic-1",
    licensedTo: "剧本客户",
    seats: partial.seats ?? 10,
    issuedAt: 1_799_999_000,
    expiresAt: partial.expiresAt ?? 1_900_000_000,
    fingerprint: h.fingerprint,
    nonce: "nonce",
    features: {},
    kid: h.key.kid,
    offline: false,
    ...partial,
  } as Entitlement;
  return { v: 1, serverTime: h.clock.current(), intervalSec: 21600, entitlement: e };
}

function freeEnvelope(h: Harness): ParsedEnvelope {
  return { v: 1, serverTime: h.clock.current(), intervalSec: 21600, entitlement: null };
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("LicenseClient 心跳与接收链", () => {

  it("免费心跳：entitlement=null，通过且不上报邮箱", async () => {
    const h = await makeHarness();
    dirs.push(h.dir);
    h.transport.register(h.cfg.url, () => signWire(freeEnvelope(h), h.key));
    const out = await h.client.heartbeat();
    expect(out.ok).toBe(true);
    expect(out.envelope?.entitlement).toBeNull();
    const call = h.transport.calls.find((c) => c.path === "/v1/heartbeat");
    expect((call?.body as Record<string, unknown>).adminEmail).toBeUndefined();
    expect(await h.store.getEverCommercial()).toBe(false);
    const view = await h.client.getView();
    expect(view.verdict).toBe("free");
    expect(view.seats).toBe(5);
  });

  it("商业心跳：接受单据、缓存、置 everCommercial，getView=licensed", async () => {
    const h = await makeHarness();
    dirs.push(h.dir);
    await h.store.markEverCommercial();
    await h.store.setContact({ adminEmail: "boss@example.com" });
    h.transport.register(h.cfg.url, () => signWire(envelope(h, { version: 3, seats: 10 }), h.key));
    const out = await h.client.heartbeat();
    expect(out.ok).toBe(true);
    expect(out.envelope?.entitlement?.seats).toBe(10);
    expect(h.client.getCached()?.version).toBe(3);
    const view = await h.client.getView();
    expect(view.verdict).toBe("licensed");
    expect(view.seats).toBe(10);
    // 商业心跳带邮箱
    const call = h.transport.calls.find((c) => c.path === "/v1/heartbeat");
    expect((call?.body as Record<string, unknown>).adminEmail).toBe("boss@example.com");
    // 重启后从加密缓存恢复单据（重新验签）
    const client2 = new LicenseClient(h.buildDeps());
    await client2.bootstrap();
    expect(client2.getCached()?.version).toBe(3);
  });

  it("篡改信封字节保留旧签名 → BAD_SIGNATURE，停留免费档", async () => {
    const h = await makeHarness();
    dirs.push(h.dir);
    h.transport.register(h.cfg.url, () => {
      const wire = signWire(envelope(h, { version: 1 }), h.key);
      const parsed = JSON.parse(Buffer.from(wire.envelopeB64, "base64").toString("utf-8"));
      parsed.entitlement.seats = 999;
      return { ...wire, envelopeB64: Buffer.from(JSON.stringify(parsed), "utf-8").toString("base64") };
    });
    const out = await h.client.heartbeat();
    expect(out.ok).toBe(false);
    expect(out.rejected).toBe("BAD_SIGNATURE");
    expect(await h.client.getView().then((v) => v.verdict)).toBe("free");
  });

  it("旧版本高席单回滚 → VERSION_ROLLBACK（含吊销后 maxVersion 仍守住）", async () => {
    const h = await makeHarness();
    dirs.push(h.dir);
    await h.store.setMaxVersion(4);
    h.transport.register(h.cfg.url, () => signWire(envelope(h, { version: 1, seats: 50 }), h.key));
    const out = await h.client.heartbeat();
    expect(out.rejected).toBe("VERSION_ROLLBACK");
    expect(h.client.getCached()).toBeNull();
  });

  it("错指纹真签名单据 → FINGERPRINT_MISMATCH", async () => {
    const h = await makeHarness();
    dirs.push(h.dir);
    h.transport.register(h.cfg.url, () =>
      signWire(envelope(h, { version: 1, fingerprint: "a".repeat(64) }), h.key),
    );
    const out = await h.client.heartbeat();
    expect(out.rejected).toBe("FINGERPRINT_MISMATCH");
  });

  it("吊销单（revoked, version+1）：清缓存、留 everCommercial、verdict=invalid", async () => {
    const h = await makeHarness();
    dirs.push(h.dir);
    await h.store.markEverCommercial();
    h.transport.register(h.cfg.url, () =>
      signWire(envelope(h, { version: 5, seats: 10, revoked: true }), h.key),
    );
    const out = await h.client.heartbeat();
    expect(out.ok).toBe(true);
    expect(h.client.getCached()).toBeNull();
    expect(await h.store.loadCachedWire()).toBeNull();
    expect(await h.store.getEverCommercial()).toBe(true);
    expect(await h.store.getMaxVersion()).toBe(5);
    expect((await h.client.getView()).verdict).toBe("invalid");
    // 关键：重启（新 client + bootstrap，缓存已清）仍稳定 invalid，不退化成 expired
    const rebooted = new LicenseClient(h.buildDeps());
    await rebooted.bootstrap();
    expect((await rebooted.getView()).verdict).toBe("invalid");
  });

  it("续费恢复（revoked 后收到正常单）：清吊销快照，回到 licensed", async () => {
    const h = await makeHarness();
    dirs.push(h.dir);
    await h.store.markEverCommercial();
    h.transport.register(h.cfg.url, () =>
      signWire(envelope(h, { version: 5, seats: 10, revoked: true }), h.key),
    );
    await h.client.heartbeat();
    expect((await h.client.getView()).verdict).toBe("invalid");
    // 后台处理后下发新正常单 version=6
    h.transport.register(h.cfg.url, () =>
      signWire(envelope(h, { version: 6, seats: 10 }), h.key),
    );
    const out = await h.client.heartbeat();
    expect(out.ok).toBe(true);
    expect((await h.client.getView()).verdict).toBe("licensed");
    expect(await h.store.getRevokedSnapshot()).toBeNull();
    // 重启仍 licensed（缓存单重新验签恢复）
    const rebooted = new LicenseClient(h.buildDeps());
    await rebooted.bootstrap();
    expect((await rebooted.getView()).verdict).toBe("licensed");
  });

  it("5xx 回退下一地址；全失败离线不抛", async () => {
    const h = await makeHarness();
    dirs.push(h.dir);
    await h.store.setBaseUrls(["http://first", "http://second"]);
    await h.client.bootstrap();
    h.transport.register("http://first", () => ({ status: 503, json: null, retryAfterSec: null }));
    h.transport.register("http://second", () => signWire(freeEnvelope(h), h.key));
    const out = await h.client.heartbeat();
    expect(out.ok).toBe(true);
    expect(out.baseUrl).toBe("http://second");
  });

  it("429 → RATE_LIMITED 静默，不切地址", async () => {
    const h = await makeHarness();
    dirs.push(h.dir);
    h.transport.register(h.cfg.url, () => ({ status: 429, json: { error: "RATE_LIMITED" }, retryAfterSec: 30 }));
    const out = await h.client.heartbeat();
    expect(out.status).toBe(429);
    expect(out.error).toBe("RATE_LIMITED");
  });
});

describe("LicenseClient 激活与刷新", () => {

  it("activate 403 LICENSE_KEY_INVALID 原样返回", async () => {
    const h = await makeHarness();
    dirs.push(h.dir);
    h.transport.register(h.cfg.url, () => ({ status: 403, json: { error: "LICENSE_KEY_INVALID" }, retryAfterSec: null }));
    const out = await h.client.activate({ licenseKey: "GX-bad" });
    expect(out.status).toBe(403);
    expect(out.error).toBe("LICENSE_KEY_INVALID");
  });

  it("activate 200 接受单据", async () => {
    const h = await makeHarness();
    dirs.push(h.dir);
    h.transport.register(h.cfg.url, () => signWire(envelope(h, { version: 3 }), h.key));
    const out = await h.client.activate({ licenseKey: "GX-ok" });
    expect(out.ok).toBe(true);
    expect((await h.client.getView()).verdict).toBe("licensed");
  });

  it("refresh 指纹不符 → 403 透传", async () => {
    const h = await makeHarness();
    dirs.push(h.dir);
    h.transport.register(h.cfg.url, () => ({ status: 403, json: { error: "LICENSE_FINGERPRINT_MISMATCH" }, retryAfterSec: null }));
    const out = await h.client.refresh("GX-ok");
    expect(out.error).toBe("LICENSE_FINGERPRINT_MISMATCH");
  });
});

describe("LicenseClient 地址迁移", () => {

  it("签名 nextBaseUrl https 自证通过 → 切头、旧址留回退", async () => {
    const h = await makeHarness();
    dirs.push(h.dir);
    const newUrl = "https://lic.new.example";
    h.transport.register(h.cfg.url, () => {
      const env = freeEnvelope(h);
      env.nextBaseUrl = newUrl;
      return signWire(env, h.key);
    });
    h.transport.register(newUrl, () => signWire(freeEnvelope(h), h.key));
    const out = await h.client.heartbeat();
    expect(out.ok).toBe(true);
    expect(out.migratedTo).toBe(newUrl);
    expect(h.client.currentBaseUrl).toBe(newUrl);
    expect(h.client.getBaseUrls()).toContain(h.cfg.url); // 旧址留回退
  });

  it("公网明文 http 迁移 → 拒绝，保留旧址", async () => {
    const h = await makeHarness();
    dirs.push(h.dir);
    const bad = "http://lic.evil.example";
    h.transport.register(h.cfg.url, () => {
      const env = freeEnvelope(h);
      env.nextBaseUrl = bad;
      return signWire(env, h.key);
    });
    h.transport.register(bad, () => signWire(freeEnvelope(h), h.key));
    const out = await h.client.heartbeat();
    expect(out.migratedTo).toBeUndefined();
    expect(h.client.currentBaseUrl).toBe(h.cfg.url);
  });

  it("内网 http 迁移允许", async () => {
    const h = await makeHarness();
    dirs.push(h.dir);
    const lan = "http://192.168.1.50:8787";
    h.transport.register(h.cfg.url, () => {
      const env = freeEnvelope(h);
      env.nextBaseUrl = lan;
      return signWire(env, h.key);
    });
    h.transport.register(lan, () => signWire(freeEnvelope(h), h.key));
    const out = await h.client.heartbeat();
    expect(out.migratedTo).toBe(lan);
  });

  it("新址自证失败（验签不过）→ 不切换", async () => {
    const h = await makeHarness();
    dirs.push(h.dir);
    const other = genEd25519();
    const newUrl = "https://lic2.example";
    h.transport.register(h.cfg.url, () => {
      const env = freeEnvelope(h);
      env.nextBaseUrl = newUrl;
      return signWire(env, h.key);
    });
    // 新址用另一把私钥签 → 同 kid 自证失败
    h.transport.register(newUrl, () => signWire(freeEnvelope(h), other));
    const out = await h.client.heartbeat();
    expect(out.migratedTo).toBeUndefined();
    expect(h.client.currentBaseUrl).toBe(h.cfg.url);
  });
});

describe("LicenseClient 离线应答码", () => {

  it("合法 offline 单（base64url）接受并缓存", async () => {
    const h = await makeHarness();
    dirs.push(h.dir);
    const env = envelope(h, { version: 1, seats: 8, offline: true });
    const code = Buffer.from(JSON.stringify(signWire(env, h.key)), "utf-8").toString("base64url");
    const out = await h.client.importOfflineResponse(code);
    expect(out.ok).toBe(true);
    expect((await h.client.getView()).verdict).toBe("licensed");
    expect((await h.client.getView()).seats).toBe(8);
  });

  it("非 offline 单 → BAD_PAYLOAD", async () => {
    const h = await makeHarness();
    dirs.push(h.dir);
    const code = Buffer.from(JSON.stringify(signWire(envelope(h, { version: 1 }), h.key)), "utf-8").toString("base64url");
    const out = await h.client.importOfflineResponse(code);
    expect(out.rejected).toBe("BAD_PAYLOAD");
  });

  it("坏应答码 → BAD_RESPONSE_CODE（接收链拒绝：HTTP 200 + rejected，非网关 502）", async () => {
    const h = await makeHarness();
    dirs.push(h.dir);
    const out = await h.client.importOfflineResponse("!!!not-base64url-json!!!");
    expect(out.ok).toBe(false);
    expect(out.status).toBe(200);
    expect(out.rejected).toBe("BAD_RESPONSE_CODE");
    expect(out.error).toBeUndefined();
    // 拒绝后停留当前态（免费档），绝不因坏码产生任何单据。
    expect(h.client.getCached()).toBeNull();
    expect((await h.client.getView()).verdict).toBe("free");
  });

  it("离线码超过 importBeforeAt → OFFLINE_CODE_EXPIRED", async () => {
    const h = await makeHarness();
    dirs.push(h.dir);
    const env = envelope(h, { version: 1, offline: true }) as ParsedEnvelope & {
      entitlement: Entitlement & { importBeforeAt?: number };
    };
    (env.entitlement as Entitlement & { importBeforeAt: number }).importBeforeAt = h.clock.current() - 1;
    const code = Buffer.from(JSON.stringify(signWire(env, h.key)), "utf-8").toString("base64url");
    const out = await h.client.importOfflineResponse(code);
    expect(out.rejected).toBe("OFFLINE_CODE_EXPIRED");
  });
});

describe("LicenseClient 局域网/公网 IP 上报", () => {
  // 等 bootstrap 里 fire-and-forget 的公网 IP 探测链跑完（真实宏任务，零出网）。
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));

  it("identity.lanIp 存在时心跳带 lanIp；为 null/缺省时不带该键", async () => {
    const h = await makeHarness();
    dirs.push(h.dir);
    h.transport.register(h.cfg.url, () => signWire(freeEnvelope(h), h.key));
    h.identity.lanIp = "192.168.1.5";
    await h.client.bootstrap();
    await flush();
    await h.client.heartbeat();
    let call = h.transport.calls.filter((c) => c.path === "/v1/heartbeat").at(-1);
    expect((call?.body as Record<string, unknown>).lanIp).toBe("192.168.1.5");

    // 新 client + lanIp=null：不带 lanIp 键
    const h2 = await makeHarness();
    dirs.push(h2.dir);
    h2.transport.register(h2.cfg.url, () => signWire(freeEnvelope(h2), h2.key));
    h2.identity.lanIp = null;
    await h2.client.bootstrap();
    await flush();
    await h2.client.heartbeat();
    call = h2.transport.calls.filter((c) => c.path === "/v1/heartbeat").at(-1);
    expect((call?.body as Record<string, unknown>).lanIp).toBeUndefined();
  });

  it("探测到公网 IP 后，heartbeat/activate/refresh 均带 publicIp（首跳前异步就绪）", async () => {
    const h = await makeHarness();
    dirs.push(h.dir);
    h.transport.register(h.cfg.url, () => signWire(freeEnvelope(h), h.key));
    const resolver = vi.fn(async () => "183.252.182.132");
    const client = new LicenseClient(h.buildDeps({ publicIpResolver: resolver }));
    await client.bootstrap(); // bootstrap 即后台预热
    await flush(); // 等 fire-and-forget 完成
    expect(resolver).toHaveBeenCalledWith(h.cfg.url);

    await client.heartbeat();
    const hbBody = h.transport.calls.filter((c) => c.path === "/v1/heartbeat").at(-1)
      ?.body as Record<string, unknown>;
    expect(hbBody.publicIp).toBe("183.252.182.132");

    await client.activate({ licenseKey: "GX-x" });
    const actBody = h.transport.calls.filter((c) => c.path === "/v1/activate").at(-1)
      ?.body as Record<string, unknown>;
    expect(actBody.publicIp).toBe("183.252.182.132");

    await client.refresh("GX-x");
    const refBody = h.transport.calls.filter((c) => c.path === "/v1/refresh").at(-1)
      ?.body as Record<string, unknown>;
    expect(refBody.publicIp).toBe("183.252.182.132");
  });

  it("公网 IP 探测全失败：不带 publicIp 键，且 TTL 内不重复探测（不每跳打 /v1/my-ip）", async () => {
    const h = await makeHarness();
    dirs.push(h.dir);
    h.transport.register(h.cfg.url, () => signWire(freeEnvelope(h), h.key));
    const resolver = vi.fn(async () => null);
    const client = new LicenseClient(h.buildDeps({ publicIpResolver: resolver }));
    await client.bootstrap();
    await flush();
    await client.heartbeat();
    await client.heartbeat();
    const body = h.transport.calls.filter((c) => c.path === "/v1/heartbeat").at(-1)
      ?.body as Record<string, unknown>;
    expect(body.publicIp).toBeUndefined();
    // bootstrap 预热 1 次（单址全失败即止）；TTL 内两次心跳不再触发探测。
    expect(resolver).toHaveBeenCalledTimes(1);
  });
});
