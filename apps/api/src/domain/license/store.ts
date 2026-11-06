/**
 * 授权持久化（零迁移、零新表、零新依赖）：
 *  - KV 复用 app_settings（deploymentId / maxSeen / grandfathered / baseUrls / ever_commercial）；
 *  - dataDir/.license 隐藏文件做第二、三路冗余与加密单据缓存。
 *
 * everCommercial 三路 OR（防"删本地痕迹逃逸到期"，04 状态机关键不变量）：
 *   1) app_settings KV  license.ever_commercial = "1"
 *   2) 隐藏文件         <dataDir>/.license/.ever-commercial
 *   3) 加密单据缓存     <dataDir>/.license/cache.enc 内含可验签的商业单据（含 revoked）
 * 任一路成立即 everCommercial=true。DB 被清或文件被删单路都逃不掉。
 *
 * 加密只承担"静态可读性 + 不被随手改"；防伪造的真正边界是 Ed25519——cache.enc 存的是
 * 原始签名线封（wire 字节），加载后必须重新 verifyAndParseWithRing，绝不因"能解密"就信任。
 *
 * 不直接 import prisma/config（避免模块加载副作用、便于纯内存单测）：KV 与 dataDir 由构造注入，
 * 生产单例在 licenseRuntime 装配时用 prismaKv() + config.dataDir 创建。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { newDeploymentId } from "./fingerprint.js";
import type { WireEnvelope } from "./verify.js";

/** KV 抽象：生产用 app_settings，测试用内存 Map。 */
export interface KvStore {
  getMany(keys: string[]): Promise<Map<string, string>>;
  setMany(entries: Record<string, string>): Promise<void>;
}

export const KV = {
  everCommercial: "license.ever_commercial",
  deploymentId: "license.deployment_id",
  maxSeen: "license.max_seen",
  grandfathered: "license.grandfathered",
  baseUrls: "license.base_urls",
  lastIntervalSec: "license.last_interval_sec",
  adminEmail: "license.admin_email",
  orgName: "license.org_name",
  maxVersion: "license.max_version",
  revoked: "license.revoked_snapshot",
} as const;

/** 吊销快照：仅由验签通过的 revoked 信封写入；正常商业单到达即清。 */
export interface RevokedSnapshot {
  version: number;
  licensedTo: string;
  licenseId: string;
  expiresAt: number;
}

export interface LicenseContact {
  adminEmail: string;
  orgName: string;
}

const EVER_FILE = ".ever-commercial";
const CACHE_FILE = "cache.enc";
const CACHE_KEY_FILE = ".cache-key";
const DEPLOYMENT_FILE = "deployment-id";

interface EncryptedBlob {
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
}

function constantEq(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export class LicenseStore {
  private readonly dir: string;

  constructor(
    private readonly kv: KvStore,
    dataDir: string,
  ) {
    this.dir = join(dataDir, ".license");
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  private file(name: string): string {
    return join(this.dir, name);
  }

  private readFileSafe(name: string): string | null {
    try {
      return readFileSync(this.file(name), "utf-8");
    } catch {
      return null;
    }
  }

  private writeFileLocked(name: string, contents: string | Buffer): void {
    this.ensureDir();
    writeFileSync(this.file(name), contents, { mode: 0o600 });
    try {
      chmodSync(this.file(name), 0o600);
    } catch {
      /* 某些平台不支持 chmod，不影响主路径 */
    }
  }

  // ---- deploymentId（KV 主、文件镜像，任一在即稳定；都无则生成并双写）----
  async ensureDeploymentId(): Promise<string> {
    const rows = await this.kv.getMany([KV.deploymentId]);
    const kvId = rows.get(KV.deploymentId)?.trim();
    const fileId = this.readFileSafe(DEPLOYMENT_FILE)?.trim();
    const id = kvId || fileId || newDeploymentId();
    if (!kvId) await this.kv.setMany({ [KV.deploymentId]: id });
    if (!fileId || !constantEq(fileId, id)) {
      try {
        this.writeFileLocked(DEPLOYMENT_FILE, id);
      } catch {
        /* 文件镜像 best-effort，KV 已持久 */
      }
    }
    return id;
  }

  // ---- everCommercial 三路 OR ----
  async getEverCommercial(): Promise<boolean> {
    const rows = await this.kv.getMany([KV.everCommercial]);
    if (rows.get(KV.everCommercial) === "1") return true;
    const file = this.readFileSafe(EVER_FILE);
    if (file !== null && file.trim() === "1") return true;
    // 第三路：存在可解密的缓存（内含商业单据，含 revoked）即曾经商业。
    const wire = await this.loadCachedWire();
    return wire !== null;
  }

  /** 置位 everCommercial（KV 必成；文件 best-effort）。幂等。 */
  async markEverCommercial(): Promise<void> {
    await this.kv.setMany({ [KV.everCommercial]: "1" });
    try {
      this.writeFileLocked(EVER_FILE, "1\n");
    } catch {
      /* KV 已落，文件是冗余 */
    }
  }

  // ---- maxSeen 防回拨水位 ----
  async getMaxSeen(): Promise<number> {
    const rows = await this.kv.getMany([KV.maxSeen]);
    const n = Number(rows.get(KV.maxSeen));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  async setMaxSeen(sec: number): Promise<void> {
    const cur = await this.getMaxSeen();
    if (sec > cur) await this.kv.setMany({ [KV.maxSeen]: String(Math.floor(sec)) });
  }

  // ---- grandfathered 一次性快照（升级前 >5 人老团队）----
  async getGrandfathered(): Promise<boolean> {
    const rows = await this.kv.getMany([KV.grandfathered]);
    return rows.get(KV.grandfathered) === "1";
  }

  async setGrandfatheredOnce(v: boolean): Promise<void> {
    const rows = await this.kv.getMany([KV.grandfathered]);
    if (!rows.has(KV.grandfathered)) {
      await this.kv.setMany({ [KV.grandfathered]: v ? "1" : "0" });
    }
  }

  // ---- 地址列表 [当前,上一个,内置] ≤3 ----
  async getBaseUrls(fallback: string): Promise<string[]> {
    const rows = await this.kv.getMany([KV.baseUrls]);
    try {
      const arr = JSON.parse(rows.get(KV.baseUrls) ?? "[]");
      if (Array.isArray(arr)) {
        const urls = arr.filter((x): x is string => typeof x === "string" && x.length > 0);
        if (urls.length > 0) return urls.slice(0, 3);
      }
    } catch {
      /* 损坏回落默认 */
    }
    return [fallback];
  }

  async setBaseUrls(urls: string[]): Promise<void> {
    const uniq = [
      ...new Set(
        urls
          .filter((u): u is string => typeof u === "string")
          .map((u) => u.trim())
          .filter(Boolean),
      ),
    ].slice(0, 3);
    await this.kv.setMany({ [KV.baseUrls]: JSON.stringify(uniq) });
  }

  // ---- intervalSec（心跳调度用，信封给的建议值）----
  async getLastIntervalSec(fallback: number): Promise<number> {
    const rows = await this.kv.getMany([KV.lastIntervalSec]);
    const n = Number(rows.get(KV.lastIntervalSec));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  }

  async setLastIntervalSec(sec: number): Promise<void> {
    await this.kv.setMany({ [KV.lastIntervalSec]: String(Math.floor(sec)) });
  }

  /**
   * 已成功应用的单据版本高水位（单调不降）。
   * 关键：即使吊销清掉了单据缓存，maxVersion 仍保留——否则旧的高席位真签名单据可在吊销后重放
   *（version 比"空缓存"高即被接受）。接收链以此为准判 VERSION_ROLLBACK。
   */
  async getMaxVersion(): Promise<number> {
    const rows = await this.kv.getMany([KV.maxVersion]);
    const n = Number(rows.get(KV.maxVersion));
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  async setMaxVersion(version: number): Promise<void> {
    const cur = await this.getMaxVersion();
    if (version > cur) await this.kv.setMany({ [KV.maxVersion]: String(Math.floor(version)) });
  }

  /**
   * 吊销快照。仅由验签通过的 revoked 信封写入；正常商业单到达时由 client 清除。
   * 作用：清掉加密单据缓存后，重启仍能稳定还原 verdict=invalid（而不是退化成 expired）。
   */
  async getRevokedSnapshot(): Promise<RevokedSnapshot | null> {
    const rows = await this.kv.getMany([KV.revoked]);
    const raw = rows.get(KV.revoked);
    if (!raw) return null;
    try {
      const o = JSON.parse(raw) as RevokedSnapshot;
      if (
        typeof o.version === "number" &&
        typeof o.licensedTo === "string" &&
        typeof o.licenseId === "string" &&
        typeof o.expiresAt === "number"
      ) {
        return o;
      }
      return null;
    } catch {
      return null;
    }
  }

  async setRevokedSnapshot(s: RevokedSnapshot): Promise<void> {
    await this.kv.setMany({ [KV.revoked]: JSON.stringify(s) });
  }

  async clearRevokedSnapshot(): Promise<void> {
    const rows = await this.kv.getMany([KV.revoked]);
    if (rows.has(KV.revoked)) await this.kv.setMany({ [KV.revoked]: "" });
  }

  // ---- 自报联系信息（仅商业心跳携带，隐私分级）----
  async getContact(): Promise<LicenseContact> {
    const rows = await this.kv.getMany([KV.adminEmail, KV.orgName]);
    return {
      adminEmail: rows.get(KV.adminEmail) ?? "",
      orgName: rows.get(KV.orgName) ?? "",
    };
  }

  async setContact(contact: Partial<LicenseContact>): Promise<void> {
    const entries: Record<string, string> = {};
    if (contact.adminEmail !== undefined) entries[KV.adminEmail] = contact.adminEmail.trim();
    if (contact.orgName !== undefined) entries[KV.orgName] = contact.orgName.trim();
    if (Object.keys(entries).length > 0) await this.kv.setMany(entries);
  }

  // ---- 加密签名线封缓存 ----
  private loadCacheKey(create: boolean): Buffer | null {
    const raw = this.readFileSafe(CACHE_KEY_FILE);
    if (raw) {
      const buf = Buffer.from(raw.trim(), "base64");
      if (buf.length === 32) return buf;
    }
    if (!create) return null;
    const key = randomBytes(32);
    this.writeFileLocked(CACHE_KEY_FILE, key.toString("base64"));
    return key;
  }

  /**
   * 保存签名线封：AES-256-GCM 加密原始 wire 字节，同时置位 everCommercial。
   * 只在收到"带 entitlement 的验签信封"后由 client 调用。
   */
  async saveCachedWire(wire: WireEnvelope): Promise<void> {
    const key = this.loadCacheKey(true);
    if (!key) throw new Error("license cache key unavailable");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const plain = Buffer.from(JSON.stringify(wire), "utf-8");
    const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
    const blob: EncryptedBlob = {
      alg: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: enc.toString("base64"),
    };
    this.writeFileLocked(CACHE_FILE, JSON.stringify(blob));
    await this.markEverCommercial();
  }

  /** 解密缓存线封；不存在/密钥丢失/篡改（GCM tag 失败）一律返回 null（fail-safe）。 */
  async loadCachedWire(): Promise<WireEnvelope | null> {
    if (!existsSync(this.file(CACHE_FILE))) return null;
    try {
      const key = this.loadCacheKey(false);
      if (!key) return null;
      const blob = JSON.parse(readFileSync(this.file(CACHE_FILE), "utf-8")) as EncryptedBlob;
      if (blob.alg !== "aes-256-gcm" || !blob.iv || !blob.tag || !blob.data) return null;
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
      decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(blob.data, "base64")),
        decipher.final(),
      ]);
      const wire = JSON.parse(plain.toString("utf-8")) as WireEnvelope;
      if (typeof wire.envelopeB64 !== "string" || typeof wire.signature !== "string" || typeof wire.kid !== "string") {
        return null;
      }
      return wire;
    } catch {
      return null;
    }
  }

  /** 吊销/失效：清商业单据缓存，但保留 everCommercial（KV+文件不动）。 */
  async clearCommercialCache(): Promise<void> {
    try {
      if (existsSync(this.file(CACHE_FILE))) rmSync(this.file(CACHE_FILE));
    } catch {
      /* best-effort */
    }
  }
}
