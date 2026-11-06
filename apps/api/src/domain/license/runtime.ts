/**
 * 授权心跳运行时（编排 + 生命周期 + 门控），范式对齐 replicaSyncRuntime：
 *  - 默认关门控：mode=off 时 start() 第一道闸直接返回 false——不建 timer、不建身份、不出网、
 *    不查库，逐字节同今天；
 *  - 单 timer（自调度 setTimeout 跟随信封 intervalSec）+ inFlight 防重入；
 *  - 每轮独立 try/catch，网络/解析失败只记 lastError，绝不冒泡炸宿主，下轮重试；
 *  - 登录/init-admin 可 triggerSoon() 非阻塞补一次。
 */
import { parseLicenseConfig, licenseNetworkActive, type LicenseConfig } from "./configLicense.js";
import { prismaKv } from "./kv.js";
import { LicenseStore } from "./store.js";
import { PersistedClock } from "./clock.js";
import { FetchHttpTransport } from "./http.js";
import { resolveDeviceIdentity } from "./deviceIdentity.js";
import { LicenseClient } from "./client.js";
import { FeedbackChannel } from "./feedback.js";
import { listSeatUsers, invalidateSeatCache, snapshotGrandfatheredOnce } from "./seats.js";
import { emitLicenseChanged } from "./changes.js";
import { VERSION } from "../../version.js";
import type { HeartbeatOutcome } from "./client.js";

export interface LicenseRuntimeStatus {
  mode: LicenseConfig["mode"];
  running: boolean;
  lastRunAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  baseUrl: string | null;
  inFlight: boolean;
}

export interface RuntimeHandles {
  client: LicenseClient;
  feedback: FeedbackChannel;
  store: LicenseStore;
  cfg: LicenseConfig;
  /** 运行时健康只读出口（/status 透出在线/离网、最近心跳时间用）。 */
  health: () => LicenseRuntimeStatus;
  /** 可等待的立即同步（/sync 用）：跑一次心跳并回成败；未启用返回 null。 */
  pulse: () => Promise<HeartbeatOutcome | null>;
}

/**
 * 在线新鲜度判定：最近一次【成功】心跳落在「平台默认间隔 ×1.5 + 60s 宽限」窗口内即在线，
 * 否则离网。从未成功过（lastOkAt=null）一律离网。信封自定义 interval 由 tick 跟随，但
 * /status 无状态读取，用平台默认间隔估算窗口足够稳健（失败会持续重试，离网很快可观测）。
 */
export function isHeartbeatFresh(
  lastOkAt: number | null,
  cfg: LicenseConfig,
  now: number = Date.now(),
): boolean {
  if (lastOkAt == null) return false;
  const intervalSec =
    cfg.platformOverride === "desktop" ? cfg.intervalDesktopSec : cfg.intervalServerSec;
  const windowMs = (intervalSec * 1.5 + 60) * 1000;
  return now - lastOkAt <= windowMs;
}

export class LicenseRuntime {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private stopped = false;
  private lastRunAt: number | null = null;
  private lastOkAt: number | null = null;
  private lastError: string | null = null;
  private client: LicenseClient | null = null;
  private feedback: FeedbackChannel | null = null;
  private store: LicenseStore | null = null;

  constructor(private readonly cfg: LicenseConfig) {}

  async start(): Promise<boolean> {
    if (!licenseNetworkActive(this.cfg.mode)) return false; // off：零副作用
    if (this.client) return true;

    const store = new LicenseStore(prismaKv, this.cfg.dataDir);
    this.store = store;
    const clock = new PersistedClock(
      () => Math.floor(Date.now() / 1000),
      await store.getMaxSeen(),
      (sec) => {
        void store.setMaxSeen(sec);
      },
    );
    const identity = await resolveDeviceIdentity(this.cfg, store, process.env, VERSION);
    const transport = new FetchHttpTransport(this.cfg.requestTimeoutMs);
    const client = new LicenseClient({
      cfg: this.cfg,
      store,
      clock,
      transport,
      identity,
      getUsedSeats: async () => (await listSeatUsers()).occupied,
    });
    await client.bootstrap();
    this.client = client;
    this.feedback = new FeedbackChannel({
      transport,
      baseUrl: () => client.currentBaseUrl,
      fingerprint: () => client.fingerprint,
      appVersion: () => VERSION,
    });

    // 首次启用：一次性 grandfathered 快照（best-effort，不阻塞心跳）。
    try {
      await snapshotGrandfatheredOnce(store);
    } catch (e) {
      this.lastError = `grandfathered snapshot: ${(e as Error).message}`;
    }

    this.stopped = false;
    this.schedule(1500); // 启动后约 1.5s 静默首跳
    return true;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    // 不阻止进程退出
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.inFlight || !this.client || this.stopped) {
      this.schedule(5000);
      return;
    }
    this.inFlight = true;
    this.lastRunAt = Date.now();
    try {
      await this.runHeartbeat();
    } finally {
      this.inFlight = false;
    }

    // 跟随信封建议间隔；缺失按平台默认。
    const platformDefault =
      this.cfg.platformOverride === "desktop"
        ? this.cfg.intervalDesktopSec
        : this.cfg.intervalServerSec;
    try {
      const sec = this.store ? await this.store.getLastIntervalSec(platformDefault) : platformDefault;
      this.schedule(Math.max(30, sec) * 1000);
    } catch {
      this.schedule(this.cfg.intervalServerSec * 1000);
    }
  }

  /**
   * 单次心跳内核（定时 tick 与「立即同步」pulseNow 共用），带 inFlight 互斥。
   * 已是进行中则不重复发起，由调用方决定是等待还是直接取当前态。
   * 返回本次心跳结果；未启用/无 client/进行中返回 null。
   */
  private async runHeartbeat(): Promise<HeartbeatOutcome | null> {
    if (!this.client) return null;
    let outcome: HeartbeatOutcome;
    try {
      outcome = await this.client.heartbeat();
    } catch (e) {
      // 网络/解析异常只记 lastError，绝不冒泡炸宿主（与原 tick 同口径），下轮重试。
      this.lastError = (e as Error).message;
      return {
        ok: false,
        status: 0,
        baseUrl: this.client.currentBaseUrl,
        envelope: null,
        error: this.lastError,
      };
    }
    if (outcome.ok) {
      this.lastOkAt = Date.now();
      this.lastError = null;
      invalidateSeatCache(); // 席位/单据可能变化，下一请求重算
      // 后台心跳可能带回授权中心主动下发的新单据（续费恢复/吊销收敛/换绑）。
      // 发变更信号让闸门②缓存即时作废，否则吊销方向最坏有 GATE_TTL_MS(10s) fail-open 尾巴，
      // 续费恢复也要白等一个 TTL。每次成功都发是安全的：心跳间隔下限 30s，本就慢于 10s 门缓存。
      emitLicenseChanged();
    } else if (outcome.status === 429) {
      this.lastError = "RATE_LIMITED"; // 静默退避
    } else {
      this.lastError = outcome.rejected ?? outcome.error ?? "heartbeat failed";
    }
    return outcome;
  }

  /**
   * 可等待的立即同步（POST /sync 用）：触发一次心跳并等出成败，而不是 triggerSoon 的
   * fire-and-forget。已有定时心跳在途时复用其结果（不并发打第二次）。返回 null 表示未启用。
   */
  async pulseNow(): Promise<HeartbeatOutcome | null> {
    if (!this.client || this.stopped) return null;
    if (this.inFlight) {
      // 等当前在途心跳结束（最多 ~requestTimeout 的一轮）：简单轮询 inFlight 释放。
      await this.waitIdle();
      // 本轮在途结果已写进 lastOkAt/lastError；直接合成一个结果给调用方读最新视图。
      return {
        ok: this.lastError == null,
        status: this.lastError == null ? 200 : 0,
        baseUrl: this.client.currentBaseUrl,
        envelope: null,
        error: this.lastError ?? undefined,
      };
    }
    this.inFlight = true;
    this.lastRunAt = Date.now();
    try {
      return await this.runHeartbeat();
    } finally {
      this.inFlight = false;
    }
  }

  private waitIdle(maxMs = 15_000): Promise<void> {
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (!this.inFlight || Date.now() - started > maxMs) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
      if (typeof timer.unref === "function") timer.unref();
    });
  }

  /** 非阻塞补一次心跳（登录/init-admin 后调用）：距上次成功太近也照跑，错误静默。 */
  triggerSoon(): void {
    if (!this.client || this.stopped || this.inFlight) return;
    setTimeout(() => void this.tick(), 0)?.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  handles(): RuntimeHandles | null {
    if (!this.client || !this.feedback || !this.store) return null;
    return {
      client: this.client,
      feedback: this.feedback,
      store: this.store,
      cfg: this.cfg,
      health: () => this.status(),
      pulse: () => this.pulseNow(),
    };
  }

  status(): LicenseRuntimeStatus {
    return {
      mode: this.cfg.mode,
      running: !!this.client && !this.stopped,
      lastRunAt: this.lastRunAt,
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      baseUrl: this.client?.currentBaseUrl ?? null,
      inFlight: this.inFlight,
    };
  }
}

// ---- 进程单例 ----
let active: LicenseRuntime | null = null;
let activeCfg: LicenseConfig | null = null;

/** 启动授权运行时；mode=off 返回 false 且零副作用。重复启动幂等。 */
export async function bootLicenseRuntime(cfg?: LicenseConfig): Promise<boolean> {
  const resolved = cfg ?? parseLicenseConfig(process.env);
  if (!licenseNetworkActive(resolved.mode)) return false;
  if (active) return active.status().running;
  const rt = new LicenseRuntime(resolved);
  const ok = await rt.start();
  if (ok) {
    active = rt;
    activeCfg = resolved;
  }
  return ok;
}

export function getLicenseRuntime(): LicenseRuntime | null {
  return active;
}

export function getLicenseHandles(): RuntimeHandles | null {
  return active?.handles() ?? null;
}

export function triggerLicenseHeartbeat(): void {
  active?.triggerSoon();
}

/** 可等待的立即同步：跑一次心跳并等出成败；未启用/未 boot 返回 null。 */
export function pulseLicenseNow(): Promise<HeartbeatOutcome | null> {
  return active ? active.pulseNow() : Promise.resolve(null);
}

export function stopLicenseRuntime(): void {
  active?.stop();
  active = null;
  activeCfg = null;
}

export function licenseRuntimeConfig(): LicenseConfig | null {
  return activeCfg;
}
