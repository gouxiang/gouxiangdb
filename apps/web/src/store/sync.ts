// apps/web/src/store/sync.ts
// 离线同步前端切片状态（beta.2 S4/S5-WEB）：六态派生 + 同步中心抽屉开关 + 冲突队列。
//
// 铁律（默认零行为变化）：
//   - 浏览器/非壳/副本功能未启用时，本 store 的运行时态永远停在初始空态、phase=null，
//     UI 选择器据 gate 判定不渲染任何东西；不产生轮询、不产生入口。
//   - 运行时态（报告 / 冲突队列 / 抽屉开关 / 在线位 / 派生 phase）【绝不持久化】——
//     它们是轮询瞬时结果，刷新后由重新探活重建。persist 仅保留极轻量 UI 偏好（抽屉上次分区）。
//
// 六态不由后端直接给文案，而由纯函数 derivePhase 从「启用位 + 在线位 + 报告计数/错误 + 是否有远端」
// 派生，便于在 node 环境穷举单测（无 DOM）。

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  disabledSyncStatus,
  type IncomingItem,
  type LocalSyncStatus,
} from "../api/localSync";

/** 六态联合（覆盖负责人列举的全部语义，见 derivePhase 规则）。 */
export type SyncPhase =
  | "online" // 在线，已同步（无待发、无隔离、无错误）
  | "syncing" // 在线且同步中（一轮在飞，或仍有待发出箱）
  | "offlinePending" // 离线，且有/曾有远端副本（改动待推、等待恢复连接）
  | "offlineLocalOnly" // 离线，仅本地、从未建立远端同步关系
  | "quarantined" // 失权隔离：存在被服务器移出/拒绝的改动，需要人工处理
  | "error"; // 在线但同步持续出错的退避态

/** derivePhase 的最小输入（从 navigator 位 + LocalSyncStatus 投影而来）。 */
export interface DerivePhaseInput {
  /** 副本离线功能是否已确认启用；false/未探活 → 返回 null（不展示任何同步态）。 */
  enabled: boolean;
  /** 浏览器在线位（navigator.onLine）。 */
  online: boolean;
  /** 同步引擎一轮是否在飞（报告 inFlight/stage≠idle）。 */
  inFlight: boolean;
  /** 本地待发出箱条数。 */
  pendingOutbox: number;
  /** 失权隔离 / 被拒条数。 */
  quarantinedCount: number;
  /** 冲突条数（不单独占六态，但保留输入以备文案/角标）。 */
  conflictCount: number;
  /** 是否已建立过远端同步关系（有订阅 base 或曾成功 pull/push）。 */
  hasRemoteBase: boolean;
  /** 最近一次同步错误（报告 lastError）。 */
  lastError: string | null;
}

/**
 * 纯函数：六态派生。规则（自上而下短路，优先级即介入紧迫度）：
 *   0. 未启用                         → null（门控外，不渲染）。
 *   1. quarantinedCount > 0           → "quarantined"（失权最需人工介入，优先于一切）。
 *   2. online && lastError && !inFlight → "error"（离线期的网络错不算 error，故先要求 online）。
 *   3. online && (inFlight || 有待发)  → "syncing"（在飞，或空闲但仍有出箱待下轮推）。
 *   4. online                         → "online"。
 *   5. 离线 && !hasRemoteBase          → "offlineLocalOnly"（纯本地、无远端）。
 *   6. 离线 && hasRemoteBase           → "offlinePending"（有远端副本，待恢复连接后推/拉）。
 * 冲突（conflictCount）不改变 phase：冲突由命令式双栏弹窗独立承载，避免与失权/错误态互斥掩盖。
 */
export function derivePhase(input: DerivePhaseInput): SyncPhase | null {
  if (!input.enabled) return null;

  if (input.quarantinedCount > 0) return "quarantined";

  if (input.online && input.lastError && !input.inFlight) return "error";

  if (input.online) {
    if (input.inFlight || input.pendingOutbox > 0) return "syncing";
    return "online";
  }

  // 离线分支。
  if (!input.hasRemoteBase) return "offlineLocalOnly";
  return "offlinePending";
}

/** 冲突队列项：由 incoming（status=conflict）映射，供双栏弹窗左右两值与裁决使用。 */
export interface PendingConflict {
  /** sync_incoming 行 id（retry/discard 用）。 */
  incomingId: string;
  /** 冲突操作的 clientOpId（resolve 的 resolveOf）。 */
  clientOpId: string;
  baseId: string | null;
  entityType: string;
  entityId: string;
  op: string;
  /** 我当时提交的值（双栏左「我的值」）。 */
  mine: Record<string, unknown>;
  /** 服务端当前版本快照（双栏右「服务器值」）；可能为 null（缺快照则降级，不允许 custom）。 */
  theirs: Record<string, unknown> | null;
  reasonCode: string | null;
  reasonDetail: string | null;
  status: string;
}

/** 纯函数：把一条 incoming 项收敛为冲突队列项；非对象/缺主键返回 null。 */
export function toPendingConflict(item: IncomingItem): PendingConflict | null {
  if (!item || !item.id || !item.clientOpId) return null;
  return {
    incomingId: item.id,
    clientOpId: item.clientOpId,
    baseId: item.baseId,
    entityType: item.entityType,
    entityId: item.entityId,
    op: item.op,
    mine: item.payload ?? {},
    theirs: item.conflictServerPayload ?? null,
    reasonCode: item.reasonCode,
    reasonDetail: item.reasonDetail,
    status: item.status,
  };
}

/** 从状态报告投影 derivePhase 所需输入（纯函数，便于单测边界）。 */
export function toDeriveInput(
  report: LocalSyncStatus,
  online: boolean,
): DerivePhaseInput {
  const hasRemoteBase =
    report.bases.length > 0 || report.lastPulledAt !== null || report.lastPushedAt !== null;
  const inFlight = report.inFlight === true || (report.stage !== null && report.stage !== "idle");
  return {
    enabled: report.enabled,
    online,
    inFlight,
    pendingOutbox: report.pendingOutbox,
    quarantinedCount: report.quarantinedCount,
    conflictCount: report.conflictCount,
    hasRemoteBase,
    lastError: report.lastError,
  };
}

/** 同步中心抽屉分区（与五分区对应；lastTab 是唯一被持久化的轻量偏好）。 */
export type SyncCenterTab = "status" | "outbox" | "conflicts" | "incoming" | "storage";

interface SyncRuntimeState {
  // ── 运行时态（不持久化）──
  /** 副本功能是否已由状态端点确认启用（404/未探活=false）。 */
  enabled: boolean;
  online: boolean;
  report: LocalSyncStatus;
  phase: SyncPhase | null;
  conflicts: PendingConflict[];
  /** 抽屉是否展开（临时 UI，不持久化）。 */
  centerOpen: boolean;
  /** 最近一次状态轮询时间（epoch ms；仅诊断/刷新提示）。 */
  lastFetchedAt: number | null;

  // ── 持久化轻量偏好 ──
  lastTab: SyncCenterTab;

  // ── actions ──
  setOnline: (online: boolean) => void;
  /** 写入一份状态报告 + 当前在线位，并重算 phase（核心更新口）。 */
  setSyncSnapshot: (report: LocalSyncStatus, online: boolean, fetchedAt?: number) => void;
  /** 404/禁用/切源时：回零运行时态（不清持久化偏好）。 */
  resetRuntime: () => void;
  replaceConflicts: (items: IncomingItem[]) => void;
  /** 裁决/放弃后按 incomingId 或 clientOpId 出队。 */
  dismissConflict: (ref: { incomingId?: string; clientOpId?: string }) => void;
  openCenter: (tab?: SyncCenterTab) => void;
  closeCenter: () => void;
  toggleCenter: () => void;
  setTab: (tab: SyncCenterTab) => void;
}

const INITIAL_REPORT = disabledSyncStatus();

export const useSyncStore = create<SyncRuntimeState>()(
  persist(
    (set) => ({
      enabled: false,
      online: true,
      report: INITIAL_REPORT,
      phase: null,
      conflicts: [],
      centerOpen: false,
      lastFetchedAt: null,

      lastTab: "status",

      setOnline: (online) =>
        set((s) => {
          const phase = derivePhase(toDeriveInput(s.report, online));
          return { online, phase };
        }),

      setSyncSnapshot: (report, online, fetchedAt) =>
        set(() => {
          const phase = derivePhase(toDeriveInput(report, online));
          return {
            enabled: report.enabled,
            online,
            report,
            phase,
            lastFetchedAt: fetchedAt ?? Date.now(),
          };
        }),

      resetRuntime: () =>
        set({
          enabled: false,
          online: true,
          report: INITIAL_REPORT,
          phase: null,
          conflicts: [],
          centerOpen: false,
          lastFetchedAt: null,
        }),

      replaceConflicts: (items) =>
        set({
          conflicts: items
            .map(toPendingConflict)
            .filter((x): x is PendingConflict => x !== null),
        }),

      dismissConflict: (ref) =>
        set((s) => ({
          conflicts: s.conflicts.filter(
            (c) =>
              !(ref.incomingId && c.incomingId === ref.incomingId) &&
              !(ref.clientOpId && c.clientOpId === ref.clientOpId),
          ),
        })),

      openCenter: (tab) =>
        set((s) => ({ centerOpen: true, ...(tab ? { lastTab: tab } : {}) })),
      closeCenter: () => set({ centerOpen: false }),
      toggleCenter: () => set((s) => ({ centerOpen: !s.centerOpen })),
      setTab: (tab) => set({ lastTab: tab }),
    }),
    {
      name: "gx-sync",
      // 只持久化轻量 UI 偏好；所有运行时态（含抽屉开关/队列/phase）刷新即重建。
      partialize: (s) => ({ lastTab: s.lastTab }),
    },
  ),
);
