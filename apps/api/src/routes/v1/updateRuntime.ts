// /api/v1/admin/update/* 共享运行时：UpdateService + UpdatePrefetcher 进程内单例 + 启动期 env 快照。
//
// 单独成文件的原因（S4）：下载端点 GET /admin/update/download 是【仅验票】的公开路由，
// 必须在 app.ts 于 v1（全局 requireActiveUser）之前挂载，否则原生导航不带登录头会被 401；
// 而 status / download-ticket / prefetch 是 v1 内的 owner 路由。多个路由文件共用这里的同一
// service / prefetcher 单例，清单 TTL 缓存（§5.4）与本地成品命中（方案 A）才能跨
// 「检查→预缓存→换票→下载」真正复用。
//
// env 在【模块加载期】快照冻结：通道身份（GX_UPDATE_CHANNEL/GX_DEPLOY_CHANNEL/TRIM_*）是
// 进程启动期事实，运行期不变；加载期取（而非请求期）也避免请求间 process.env 漂移污染。

import { config } from "../../config.js";
import { writeAudit } from "../../audit/audit.js";
import { UpdateService } from "../../domain/update/service.js";
import { UpdatePrefetcher, type PrefetchSettle } from "../../domain/update/prefetch.js";

export const STARTUP_ENV: NodeJS.ProcessEnv = { ...process.env };

let serviceSingleton: UpdateService | null = null;

export function updateService(): UpdateService {
  if (!serviceSingleton) {
    serviceSingleton = new UpdateService(config.update, { env: STARTUP_ENV });
  }
  return serviceSingleton;
}

let prefetcherSingleton: UpdatePrefetcher | null = null;
let prefetcherBoot: Promise<void> | null = null;

/**
 * 后台预缓存落定审计（detail 白名单，绝不落 url/token）。
 * completed/failed 都由 domain 在后台任务真正结束时回调，携带触发者 context。
 */
function recordPrefetchSettle(e: PrefetchSettle): void {
  const s = e.snapshot;
  const ctx = e.context;
  writeAudit(config.auditDir, {
    event: e.outcome === "completed" ? "update_prefetch_completed" : "update_prefetch_failed",
    actorId: ctx?.actorId ?? null,
    ip: ctx?.ip ?? "",
    method: "POST",
    path: "/api/v1/admin/update/prefetch",
    // completed=200，failed=502（上游/磁盘/校验类统一按上游失败口径记账）。
    status: e.outcome === "completed" ? 200 : 502,
    detail: {
      ...(ctx ? { channel: ctx.channel, arch: ctx.arch, platform: ctx.platform } : {}),
      version: s.version,
      filename: s.filename,
      sha256: s.sha256,
      state: s.state,
      ...(s.sizeBytes !== null ? { totalBytes: s.sizeBytes } : {}),
      ...(s.receivedBytes > 0 ? { bytes: s.receivedBytes } : {}),
      ...(s.errorCode ? { errorCode: s.errorCode } : {}),
    },
  });
}

/** 预缓存单例：复用 service 的 fetchImpl（测试桩/生产同源），首次构造即幂等 boot 恢复成品。 */
export function updatePrefetcher(): UpdatePrefetcher {
  if (!prefetcherSingleton) {
    const svc = updateService();
    prefetcherSingleton = new UpdatePrefetcher({
      dir: config.update.prefetchDir,
      idleTimeoutMs: config.update.prefetchIdleTimeoutMs,
      token: config.update.token,
      fetch: svc.fetchImpl,
      onSettle: recordPrefetchSettle,
    });
    prefetcherBoot = prefetcherSingleton.boot().catch(() => {
      // boot 只读缓存目录自愈，失败已在 domain 内降级 idle；这里不再让恢复影响请求。
    });
  }
  return prefetcherSingleton;
}

/** 路由在读取快照/命中前 await：确保从磁盘恢复 ready 已完成（仅首次有实际等待）。 */
export function updatePrefetcherReady(): Promise<void> {
  updatePrefetcher();
  return prefetcherBoot ?? Promise.resolve();
}

/**
 * 仅供路由集成测试：替换单例（如注入 nodeArch=linux/nodePlatform=x64 的 service，
 * 使 darwin 机也能走「linux fpk 升级」全链路）。生产代码不得调用；非 test 环境直接抛错。
 * 调用后 prefetcher 一并按新 service.fetchImpl 重建。
 */
export function __setUpdateRuntimeForTest(overrides: {
  nodeArch?: string;
  nodePlatform?: string;
  currentVersion?: string;
  fetch?: typeof fetch;
}): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setUpdateRuntimeForTest 仅允许在 NODE_ENV=test 调用");
  }
  serviceSingleton = new UpdateService(config.update, {
    env: STARTUP_ENV,
    ...(overrides.nodeArch ? { nodeArch: overrides.nodeArch } : {}),
    ...(overrides.nodePlatform ? { nodePlatform: overrides.nodePlatform } : {}),
    ...(overrides.currentVersion ? { currentVersion: overrides.currentVersion } : {}),
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
  });
  prefetcherSingleton = new UpdatePrefetcher({
    dir: config.update.prefetchDir,
    idleTimeoutMs: config.update.prefetchIdleTimeoutMs,
    token: config.update.token,
    fetch: serviceSingleton.fetchImpl,
    onSettle: recordPrefetchSettle,
  });
  prefetcherBoot = prefetcherSingleton.boot().catch(() => {});
}
