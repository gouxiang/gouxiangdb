// M5/S5 indexer worker：认领主库 outbox（change_events）-> 派生到独立 search.db。
//
// 权威依据：M5-implementation-plan §5.3（认领状态机/退避/单写者）、§4.6/§4.7（chunk/授权）、
// §4.9（FTS 优先、向量欠账不阻断）、§4.10（indexer.ts 分包）。
//
// 关键事实（2026-09-16 探针实测，见 __tests__）：
//   - Prisma SQLite 把 DateTime 存为 epoch【毫秒整数】；故原子认领 SQL 的时间门槛必须绑
//     number(Date.now())，绑 ISO 字符串会因 SQLite 类型排序（数字<文本）使条件恒真。
//   - UPDATE...RETURNING 经 prisma.$queryRawUnsafe 可用；并发两个 worker 对同一行只有一个
//     拿到（第二个 RETURNING 空集），满足单认领。
//
// 边界：本模块只提供可 start/stop 的 worker 与单例，【不在 src/index.ts 自动启动】；接线在
// S6/S7，默认 GX_M5_SEARCH=off 时无任何人 new/start -> 零建库、零连接、零副作用。

import type { PrismaClient } from "@prisma/client";
import type { SearchStore } from "./searchStore.js";
import { META_KEYS, getMeta, setMeta } from "./schema.js";
import type { EmbeddingProvider } from "./embedding/types.js";
import { extractEntity } from "./entityExtract.js";
import { applyUpsert, deleteDerived, type DeriveSummary } from "./indexerDerive.js";
import {
  decideFailure,
  isLockStale,
  lockOwnedBy,
  formatLockValue,
  parseLockHeartbeat,
  DEFAULT_STALLED_MS,
  MAX_ATTEMPTS,
} from "./indexerSchedule.js";

export const DEFAULT_BATCH = 50;
export const DEFAULT_IDLE_POLL_MS = 2000;
export const DEFAULT_START_DELAY_MS = 3000;
export const DEFAULT_WORKSPACE = "ws_default";

interface ClaimedRow {
  id: string;
  entityType: string;
  entityId: string;
  version: bigint;
  op: string;
  attempts: number;
  workerId: string;
}

export interface IndexerDeps {
  prisma: PrismaClient;
  store: SearchStore;
  mode: "off" | "cloud";
  provider: EmbeddingProvider | null;
  workerId: string;
  fieldChunkCap?: number;
  workspaceId?: string;
  batchSize?: number;
  idlePollMs?: number;
  startDelayMs?: number;
  stalledMs?: number;
  /** 每轮成功处理后回调（测试/观测用）。 */
  onProcessed?: (event: ClaimedRow, summary: DeriveSummary | { deleted: number }) => void;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** 认领时写入 change_events.workerId 的令牌：逻辑 id + 认领毫秒，供精确 stalled 回收。 */
function claimToken(workerId: string, nowMs: number): string {
  return `${workerId}@${nowMs}`;
}

/**
 * 原子认领一条到期事件（pending/failed 都可被重试认领）。
 * SQLite 3.53 UPDATE...RETURNING；无到期事件返回 null。时间门槛绑毫秒数（见文件头探针结论）。
 */
export async function claimNext(prisma: PrismaClient, workerId: string, nowMs: number): Promise<ClaimedRow | null> {
  const rows = await prisma.$queryRawUnsafe<ClaimedRow[]>(
    `UPDATE change_events SET status='processing', workerId=?1, attempts=attempts+1
     WHERE id=(SELECT id FROM change_events
               WHERE status IN ('pending','failed') AND nextRunAt<=?2
               ORDER BY nextRunAt LIMIT 1)
     RETURNING id, entityType, entityId, version, op, attempts, workerId`,
    claimToken(workerId, nowMs), nowMs,
  );
  return rows[0] ?? null;
}

/**
 * 精确回收崩溃遗留：只把【认领时间已超 stalledMs】的 processing 行重置回 pending。
 * workerId 令牌形如 `<id>@<claimMs>`（SQLite 无 split，在应用层解析后缀），绝不重置活
 * worker 正在处理的新鲜行；无 @ 时间戳的历史行 claimMs 视为 0（陈旧，可回收）。
 */
async function reclaimStalled(prisma: PrismaClient, nowMs: number, stalledMs: number): Promise<number> {
  const processing = await prisma.$queryRawUnsafe<Array<{ id: string; workerId: string | null }>>(
    `SELECT id, workerId FROM change_events WHERE status='processing'`,
  );
  const staleIds = processing
    .map((r) => {
      const at = Number(r.workerId?.split("@").pop());
      const claimMs = Number.isFinite(at) && at > 0 ? at : 0;
      return { id: r.id, stale: nowMs - claimMs >= stalledMs };
    })
    .filter((x) => x.stale)
    .map((x) => x.id);
  if (staleIds.length === 0) return 0;
  const res = await prisma.changeEvent.updateMany({
    where: { id: { in: staleIds } },
    data: { status: "pending", workerId: null, nextRunAt: new Date(nowMs) },
  });
  return res.count;
}

/**
 * indexer worker。单写者：search.db index_meta.worker_lock 存 ${workerId}:${heartbeatMs}，
 * 锁新鲜且属于他人 -> 本实例 start 返回 false 退出；锁过期/无主/自己 -> 抢占并在每轮心跳。
 */
export class SearchIndexer {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly d: Required<Omit<IndexerDeps, "onProcessed" | "provider">> & {
    onProcessed?: IndexerDeps["onProcessed"];
    provider: EmbeddingProvider | null;
  };

  constructor(deps: IndexerDeps) {
    this.d = {
      prisma: deps.prisma,
      store: deps.store,
      mode: deps.mode,
      provider: deps.provider ?? null,
      workerId: deps.workerId,
      fieldChunkCap: deps.fieldChunkCap ?? 50,
      workspaceId: deps.workspaceId ?? DEFAULT_WORKSPACE,
      batchSize: deps.batchSize ?? DEFAULT_BATCH,
      idlePollMs: deps.idlePollMs ?? DEFAULT_IDLE_POLL_MS,
      startDelayMs: deps.startDelayMs ?? DEFAULT_START_DELAY_MS,
      stalledMs: deps.stalledMs ?? DEFAULT_STALLED_MS,
      onProcessed: deps.onProcessed,
      nowMs: deps.nowMs ?? (() => Date.now()),
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  get isRunning(): boolean { return this.running; }

  /** 抢占单写者锁：新鲜且属他人返回 false；否则心跳并（必要时）回收 stalled，返回 true。 */
  private acquireOrReuse(): boolean {
    const lock = getMeta(this.d.store.db, META_KEYS.workerLock);
    const hb = parseLockHeartbeat(lock);
    if (lock && !lockOwnedBy(lock, this.d.workerId) && hb !== null &&
        !isLockStale(hb, this.d.nowMs(), this.d.stalledMs)) {
      return false; // 另一个活 worker 持锁
    }
    setMeta(this.d.store.db, META_KEYS.workerLock, formatLockValue(this.d.workerId, this.d.nowMs()));
    return true;
  }

  private heartbeat(): void {
    setMeta(this.d.store.db, META_KEYS.workerLock, formatLockValue(this.d.workerId, this.d.nowMs()));
  }

  /** 启动；被活锁挡住返回 false。延迟 startDelayMs 后开始第一轮。 */
  start(): boolean {
    if (this.running) return true;
    if (!this.acquireOrReuse()) return false;
    this.running = true;
    this.timer = setTimeout(() => { void this.loop(); }, this.d.startDelayMs);
    return true;
  }

  stop(): void {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private async loop(): Promise<void> {
    if (!this.running) return;
    try {
      if (!this.acquireOrReuse()) { this.running = false; return; }
      // 每轮先精确回收崩溃遗留的超时 processing 行（只按认领时间戳判，不影响新行）。
      await reclaimStalled(this.d.prisma, this.d.nowMs(), this.d.stalledMs);
      let processed = 0;
      for (let i = 0; i < this.d.batchSize; i += 1) {
        if (!this.running) break;
        const ev = await claimNext(this.d.prisma, this.d.workerId, this.d.nowMs());
        if (!ev) break;
        await this.processOne(ev);
        processed += 1;
        this.heartbeat();
      }
      if (processed < this.d.batchSize) await this.d.sleep(this.d.idlePollMs); // 无积压不空转抢
    } catch (err) {
      console.error("[search-indexer] loop error:", err instanceof Error ? err.message : String(err));
      await this.d.sleep(this.d.idlePollMs);
    }
    if (this.running) this.timer = setTimeout(() => { void this.loop(); }, 0);
  }

  /** 处理单条：取活实体 -> upsert 派生 或 delete 清派生；失败按退避置 failed/dead。 */
  async processOne(ev: ClaimedRow): Promise<void> {
    try {
      const entity = await extractEntity(this.d.prisma, ev, this.d.fieldChunkCap);
      if (ev.op === "delete" || !entity.present) {
        const deleted = deleteDerived(this.d.store, ev.entityType, ev.entityId);
        this.d.onProcessed?.(ev, { deleted });
      } else {
        const summary = await applyUpsert(this.d.store, entity, {
          workspaceId: this.d.workspaceId, mode: this.d.mode, provider: this.d.provider,
        });
        this.d.onProcessed?.(ev, summary);
      }
      await this.d.prisma.changeEvent.update({
        where: { id: ev.id },
        data: { status: "done", processedAt: new Date(this.d.nowMs()), lastError: null },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const dec = decideFailure(this.d.nowMs(), ev.attempts);
      await this.d.prisma.changeEvent.update({
        where: { id: ev.id },
        data: {
          status: dec.status,
          nextRunAt: new Date(dec.nextRunAtMs),
          lastError: message.slice(0, 500),
          ...(dec.status === "dead" ? { processedAt: new Date(this.d.nowMs()) } : {}),
        },
      }).catch(() => undefined);
      if (dec.status === "dead") console.error(`[search-indexer] event ${ev.id} went dead: ${message}`);
    }
  }

  /** 公开钩子：回收崩溃遗留的超时 processing 行（测试/CLI 可显式调用）。 */
  async recoverStalled(): Promise<number> {
    return reclaimStalled(this.d.prisma, this.d.nowMs(), this.d.stalledMs);
  }

  /** 单测/CLI：同步跑一轮（先回收 stalled，再认领一批，不依赖定时器），返回处理条数。 */
  async runOnce(): Promise<number> {
    if (!this.acquireOrReuse()) return 0;
    await reclaimStalled(this.d.prisma, this.d.nowMs(), this.d.stalledMs);
    let n = 0;
    for (let i = 0; i < this.d.batchSize; i += 1) {
      const ev = await claimNext(this.d.prisma, this.d.workerId, this.d.nowMs());
      if (!ev) break;
      await this.processOne(ev);
      n += 1;
    }
    return n;
  }
}

export { MAX_ATTEMPTS };
