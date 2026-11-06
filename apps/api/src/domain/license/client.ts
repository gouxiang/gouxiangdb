/**
 * 授权客户端核心（移植并加固 simulator/virtual-client.ts）：
 * 报到/心跳、手填 key/短码激活、刷新、离线应答码导入、签名信封接收链、
 * version 高水位防回滚（含吊销后）、三冗余缓存、有序地址列表 + nextBaseUrl 签名迁移。
 *
 * 信任边界：只信内置公钥环验签通过的信封字节；信封外明文一律不信；任何失败停留当前态，
 * 由状态机回落免费 5 人档，绝不出现无限版。
 *
 * 不直接 import prisma/global fetch 之外的 IO：store/clock/transport/identity 全部注入，便于纯单测。
 */
import {
  verifyAndParseWithRing,
  validateEntitlementShape,
  acceptEntitlement,
  RejectError,
  type Entitlement,
  type ParsedEnvelope,
  type WireEnvelope,
} from "./verify.js";
import { currentEntitlement, type EntitlementView } from "./state.js";
import type { LicenseConfig } from "./configLicense.js";
import type { LicenseStore, RevokedSnapshot } from "./store.js";
import type { Clock } from "./clock.js";
import type { HttpTransport } from "./http.js";
import { isAllowedLicenseUrl } from "./http.js";
import { computeFingerprint } from "./fingerprint.js";
import type { ResolvedIdentity } from "./deviceIdentity.js";
import { resolvePublicIp } from "./publicIp.js";

/** 公网出口 IP 缓存有效期：10 分钟（过期才再探；全失败也缓存 null，避免每跳打 /v1/my-ip）。 */
const PUBLIC_IP_TTL_MS = 10 * 60 * 1000;

export interface HeartbeatOutcome {
  ok: boolean;
  status: number;
  baseUrl: string;
  envelope: ParsedEnvelope | null;
  error?: string;
  rejected?: string;
  migratedTo?: string;
}

export interface LicenseClientDeps {
  cfg: LicenseConfig;
  store: LicenseStore;
  clock: Clock;
  transport: HttpTransport;
  identity: ResolvedIdentity;
  /** 占席数供给（心跳用）；失败/缺省回 0。不耦合 prisma。 */
  getUsedSeats?: () => Promise<number>;
  /** 验签函数（默认内置公钥环 verifyAndParseWithRing）；测试注入临时密钥环用。 */
  verifier?: (wire: WireEnvelope) => ParsedEnvelope;
  /** 公网出口 IP 探测（默认 resolvePublicIp，走内置 fetch 3s 超时）；测试注入以零出网。 */
  publicIpResolver?: (baseUrl: string) => Promise<string | null>;
}

export class LicenseClient {
  readonly fingerprint: string;
  private cached: Entitlement | null = null;
  private revokedSnap: RevokedSnapshot | null = null;
  private baseUrls: string[] = [];
  private feedbackBadge: { unread: number; open: number } | null = null;
  private publicIp: string | null = null;
  private publicIpAt = 0;
  private publicIpInFlight = false;
  lastError: string | null = null;
  migrationLog: string[] = [];

  constructor(private deps: LicenseClientDeps) {
    this.fingerprint = computeFingerprint(deps.identity.identity);
    // 初始内置引导地址；bootstrap() 后用持久化列表（[当前,上一个,内置]）覆盖。
    this.baseUrls = [deps.cfg.url];
  }

  private get cfg(): LicenseConfig {
    return this.deps.cfg;
  }
  private get store(): LicenseStore {
    return this.deps.store;
  }
  private get clock(): Clock {
    return this.deps.clock;
  }
  private get transport(): HttpTransport {
    return this.deps.transport;
  }
  private verify(wire: WireEnvelope): ParsedEnvelope {
    return this.deps.verifier ? this.deps.verifier(wire) : verifyAndParseWithRing(wire);
  }

  /** 启动：载入持久地址列表、吊销快照与加密缓存单据（缓存必须重新验签+对指纹才采信）。 */
  async bootstrap(): Promise<void> {
    this.baseUrls = await this.store.getBaseUrls(this.cfg.url);
    // 地址列表就绪即后台预热公网 IP（不 await，不拖慢启动/就绪）；心跳里还会按 TTL 兜底再触发。
    this.maybeRefreshPublicIp();
    this.revokedSnap = await this.store.getRevokedSnapshot();
    const wire = await this.store.loadCachedWire();
    if (!wire) return;
    try {
      const env = this.verify(wire);
      validateEntitlementShape(env.entitlement);
      const reject = acceptEntitlement(env, this.fingerprint, await this.store.getMaxVersion());
      if (reject || !env.entitlement || env.entitlement.revoked) return;
      this.cached = env.entitlement;
      if (env.feedback) this.feedbackBadge = env.feedback;
    } catch {
      // 缓存不可信（换钥/损坏/指纹变）：忽略缓存，fail-safe 走免费档，不删 everCommercial。
      this.cached = null;
    }
  }

  /**
   * fire-and-forget 预热/刷新公网出口 IP。同步返回、绝不阻塞 listen/就绪/心跳组包、绝不抛错：
   * TTL 内（含上次全失败缓存的 null）或已有探测在途时直接返回；否则后台逐地址短超时探测，
   * 本次心跳仍用旧值（首次为无）组包，下一跳起带新值。由 runtime 启动后与每轮心跳调用。
   */
  maybeRefreshPublicIp(): void {
    if (this.publicIpInFlight) return;
    if (this.publicIpAt > 0 && Date.now() - this.publicIpAt < PUBLIC_IP_TTL_MS) return;
    this.publicIpInFlight = true;
    void this.refreshPublicIpOnce();
  }

  private async refreshPublicIpOnce(): Promise<void> {
    try {
      const resolver = this.deps.publicIpResolver ?? ((b: string) => resolvePublicIp(b));
      let ip: string | null = null;
      // 逐冗余地址尝试，首个返回合法 IPv4 即用；全失败保持 null（仍刷新时间戳以受 TTL 约束）。
      for (const url of this.baseUrls) {
        ip = await resolver(url);
        if (ip) break;
      }
      this.publicIp = ip;
    } catch {
      // resolver 内部已吞错，这里再兜底，保证后台探测永不冒泡。
      this.publicIp = null;
    } finally {
      this.publicIpAt = Date.now();
      this.publicIpInFlight = false;
    }
  }

  /**
   * 状态机输入单据：内存缓存优先；否则若有吊销快照（只可能由验签 revoked 信封写入），
   * 还原一张 revoked 单据使 verdict 稳定为 invalid（expiresAt 等仅占位，revoked 分支优先）。
   */
  private effectiveEntitlement(): Entitlement | null {
    if (this.cached) return this.cached;
    const s = this.revokedSnap;
    if (!s) return null;
    return {
      product: "gouxiangdb",
      edition: "business",
      licenseId: s.licenseId,
      licensedTo: s.licensedTo,
      seats: 5,
      issuedAt: 0,
      expiresAt: s.expiresAt,
      fingerprint: this.fingerprint,
      nonce: "revoked-snapshot",
      features: {},
      version: s.version,
      kid: "",
      offline: false,
      revoked: true,
    };
  }

  getCached(): Entitlement | null {
    return this.cached;
  }
  getFeedbackBadge(): { unread: number; open: number } | null {
    return this.feedbackBadge;
  }
  clearFeedbackBadge(): void {
    this.feedbackBadge = null;
  }
  get currentBaseUrl(): string {
    return this.baseUrls[0] ?? this.cfg.url;
  }
  /** 本机部署标识（/status 与离线申请码用）。 */
  get deploymentId(): string {
    return this.deps.identity.deploymentId;
  }
  /** 平台字面量（darwin/linux/win32…，/status 与离线申请码用）。 */
  get platform(): string {
    return this.deps.identity.identity.platform;
  }
  /** 应用版本（离线申请码 clientVersion 用）。 */
  get appVersion(): string {
    return this.deps.identity.appVersion;
  }
  getBaseUrls(): string[] {
    return [...this.baseUrls];
  }

  /** 装配状态机视图（两道闸门与 UI 的唯一出口）。 */
  async getView(): Promise<EntitlementView> {
    const [everCommercial, grandfathered] = await Promise.all([
      this.store.getEverCommercial(),
      this.store.getGrandfathered(),
    ]);
    return currentEntitlement({
      mode: this.cfg.mode,
      entitlement: this.effectiveEntitlement(),
      now: this.clock.current(),
      everCommercial,
      grandfathered,
    });
  }

  private baseFields(): Record<string, unknown> {
    const id = this.deps.identity;
    const fields: Record<string, unknown> = {
      fingerprint: this.fingerprint,
      deploymentId: id.deploymentId,
      platform: id.identity.platform,
      packageType: id.packageType,
      deviceName: id.deviceName,
      arch: id.arch,
      appVersion: id.appVersion,
    };
    // 拿不到则不带该键（不发空字符串/null），与服务端契约一致。
    if (id.lanIp) fields.lanIp = id.lanIp;
    if (this.publicIp) fields.publicIp = this.publicIp;
    return fields;
  }

  private async heartbeatBody(includeContact: boolean): Promise<Record<string, unknown>> {
    let used = 0;
    try {
      used = this.deps.getUsedSeats ? await this.deps.getUsedSeats() : 0;
    } catch {
      used = 0;
    }
    const body: Record<string, unknown> = { ...this.baseFields(), usedSeats: used };
    if (includeContact) {
      const c = await this.store.getContact();
      const id = this.deps.identity;
      if (c.adminEmail) body.adminEmail = c.adminEmail;
      if (c.orgName) body.orgName = c.orgName;
      body.hostname = id.hostname;
    }
    return body;
  }

  /** 核心常驻通道：地址列表逐个尝试，5xx/网络错回退下一址。 */
  async heartbeat(): Promise<HeartbeatOutcome> {
    // TTL 过期则后台顺带预热公网 IP（不 await，本跳用旧值/无值，下跳起带新值），绝不阻塞组包。
    this.maybeRefreshPublicIp();
    const everCommercial = await this.store.getEverCommercial();
    const body = await this.heartbeatBody(everCommercial);
    const ack: Record<string, string> = {};
    if (this.cached) ack["x-license-ack"] = String(this.cached.version);

    let lastErr = "no address";
    for (const url of this.baseUrls) {
      try {
        const res = await this.transport.post(url, "/v1/heartbeat", body, ack);
        if (res.status >= 500) {
          lastErr = `HTTP ${res.status}`;
          continue;
        }
        if (res.status === 429) {
          // 静默退避，不打扰用户，不切换地址。
          return { ok: false, status: 429, baseUrl: url, envelope: null, error: "RATE_LIMITED" };
        }
        if (res.status !== 200) {
          const err = (res.json as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
          return { ok: false, status: res.status, baseUrl: url, envelope: null, error: err };
        }
        const outcome = await this.ingest(res.json as WireEnvelope, url);
        return outcome;
      } catch (e) {
        lastErr = (e as Error).message;
        continue;
      }
    }
    this.lastError = lastErr;
    return { ok: false, status: 0, baseUrl: this.currentBaseUrl, envelope: null, error: lastErr };
  }

  /** 手填 licenseKey 或短配对码激活（只打当前址）。 */
  async activate(params: { licenseKey?: string; pairCode?: string }): Promise<HeartbeatOutcome> {
    const c = await this.store.getContact();
    const id = this.deps.identity;
    const body = {
      ...params,
      ...this.baseFields(),
      hostname: id.hostname,
      adminEmail: c.adminEmail,
      orgName: c.orgName,
    };
    const url = this.currentBaseUrl;
    try {
      const res = await this.transport.post(url, "/v1/activate", body);
      if (res.status !== 200) {
        return { ok: false, status: res.status, baseUrl: url, envelope: null, error: (res.json as { error?: string } | null)?.error };
      }
      return await this.ingest(res.json as WireEnvelope, url);
    } catch (e) {
      return { ok: false, status: 0, baseUrl: url, envelope: null, error: (e as Error).message };
    }
  }

  /** 授权页「立即刷新」（带 licenseKey）。 */
  async refresh(licenseKey: string): Promise<HeartbeatOutcome> {
    const body = { licenseKey, ...this.baseFields() };
    const url = this.currentBaseUrl;
    try {
      const res = await this.transport.post(url, "/v1/refresh", body);
      if (res.status !== 200) {
        return { ok: false, status: res.status, baseUrl: url, envelope: null, error: (res.json as { error?: string } | null)?.error };
      }
      return await this.ingest(res.json as WireEnvelope, url);
    } catch (e) {
      return { ok: false, status: 0, baseUrl: url, envelope: null, error: (e as Error).message };
    }
  }

  /** 离线应答码导入：base64url(wire JSON)，走同一验签接收链，且必须 offline 单、未过导入截止。 */
  importOfflineResponse(responseCode: string): Promise<HeartbeatOutcome> {
    return this.ingestEncoded(responseCode.trim(), true);
  }

  private async ingestEncoded(code: string, offline: boolean): Promise<HeartbeatOutcome> {
    let wire: WireEnvelope;
    try {
      wire = JSON.parse(Buffer.from(code, "base64url").toString("utf-8")) as WireEnvelope;
    } catch {
      // 坏应答码（非 base64url-JSON）本质是"接收链无法采信的单据"，与验签/指纹/回滚拒绝同口径：
      // HTTP 200 + rejected，前端按 rejected 提示并停留当前免费档；而非当网络/网关错回 502。
      return { ok: false, status: 200, baseUrl: this.currentBaseUrl, envelope: null, rejected: "BAD_RESPONSE_CODE" };
    }
    return this.ingest(wire, this.currentBaseUrl, offline);
  }

  /**
   * 统一接收链（02 §5，顺序不可变）：
   * 选钥(kid)→字节验签→v/结构→指纹→version 高水位→落缓存/校时/迁移。
   * 任何拒绝/异常都返回 rejected/error，停留当前态（免费 5），绝不无限。
   */
  private async ingest(wire: WireEnvelope, viaUrl: string, offline = false): Promise<HeartbeatOutcome> {
    let env: ParsedEnvelope;
    try {
      env = this.verify(wire);
    } catch (e) {
      return { ok: false, status: 200, baseUrl: viaUrl, envelope: null, rejected: (e as RejectError).code ?? "BAD_SIGNATURE" };
    }
    if (env.v !== 1) {
      return { ok: false, status: 200, baseUrl: viaUrl, envelope: env, rejected: "BAD_PAYLOAD" };
    }
    try {
      validateEntitlementShape(env.entitlement);
    } catch (e) {
      return { ok: false, status: 200, baseUrl: viaUrl, envelope: env, rejected: (e as RejectError).code };
    }
    const maxVersion = await this.store.getMaxVersion();
    const reject = acceptEntitlement(env, this.fingerprint, maxVersion);
    if (reject) {
      return { ok: false, status: 200, baseUrl: viaUrl, envelope: env, rejected: reject.code };
    }
    const e = env.entitlement;
    if (offline) {
      if (!e?.offline) return { ok: false, status: 200, baseUrl: viaUrl, envelope: env, rejected: "BAD_PAYLOAD" };
      const importBeforeAt = Number((e as unknown as { importBeforeAt?: unknown }).importBeforeAt);
      if (Number.isFinite(importBeforeAt) && this.clock.current() > importBeforeAt) {
        return { ok: false, status: 200, baseUrl: viaUrl, envelope: env, rejected: "OFFLINE_CODE_EXPIRED" };
      }
    }

    // —— 全部通过，应用信封 ——
    this.clock.observeServerTime(env.serverTime);
    if (env.intervalSec > 0) await this.store.setLastIntervalSec(env.intervalSec);
    this.feedbackBadge = env.feedback ?? null;

    let migratedTo: string | undefined;
    if (e) {
      await this.store.setMaxVersion(e.version);
      if (e.revoked) {
        // 吊销：清商业单据缓存，everCommercial 保留，回落免费 5（invalid 态）。
        // 写吊销快照，使重启后 verdict 仍稳定为 invalid（不退化成 expired）。
        await this.store.clearCommercialCache();
        await this.store.setRevokedSnapshot({
          version: e.version,
          licensedTo: e.licensedTo,
          licenseId: e.licenseId,
          expiresAt: e.expiresAt,
        });
        this.revokedSnap = {
          version: e.version,
          licensedTo: e.licensedTo,
          licenseId: e.licenseId,
          expiresAt: e.expiresAt,
        };
        this.cached = null;
      } else {
        // 正常商业单（含续费/换绑恢复）：清吊销快照、缓存单据、置位 everCommercial。
        await this.store.clearRevokedSnapshot();
        this.revokedSnap = null;
        await this.store.saveCachedWire(wire);
        this.cached = e;
      }
    }

    if (env.nextBaseUrl && env.nextBaseUrl !== viaUrl) {
      migratedTo = await this.tryMigrate(env.nextBaseUrl);
    }
    return { ok: true, status: 200, baseUrl: viaUrl, envelope: env, migratedTo };
  }

  /**
   * 签名地址迁移（09）：只接受 https/内网白名单 http；向新址发验证心跳（不带邮箱），
   * 必须同 kid 验签通过才切到列表头，旧址留作回退；失败保留旧址。
   */
  private async tryMigrate(newUrl: string): Promise<string | undefined> {
    if (!isAllowedLicenseUrl(newUrl, this.cfg.httpLanWhitelist)) {
      this.migrationLog.push(`拒绝迁移 ${newUrl}: scheme 不允许`);
      return undefined;
    }
    try {
      const probeBody = {
        fingerprint: this.fingerprint,
        deploymentId: this.deps.identity.deploymentId,
        platform: this.deps.identity.identity.platform,
        arch: this.deps.identity.arch,
        appVersion: this.deps.identity.appVersion,
        usedSeats: 0, // 探测心跳不携带邮箱/席位细节，只做同 kid 自证
      };
      const res = await this.transport.post(newUrl, "/v1/heartbeat", probeBody);
      if (res.status !== 200) throw new Error(`probe HTTP ${res.status}`);
      const env = this.verify(res.json as WireEnvelope); // 同 kid 自证
      if (env.intervalSec > 0) await this.store.setLastIntervalSec(env.intervalSec);
      this.baseUrls = [newUrl, ...this.baseUrls.filter((u) => u !== newUrl)].slice(0, 3);
      await this.store.setBaseUrls(this.baseUrls);
      this.migrationLog.push(`已迁移 ${newUrl}（同 kid 自证通过）`);
      return newUrl;
    } catch (e) {
      this.migrationLog.push(`迁移失败保留旧址: ${(e as Error).message}`);
      return undefined;
    }
  }
}
