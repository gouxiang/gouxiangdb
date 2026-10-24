// apps/web/src/features/sync/SyncCenterDrawer.tsx
// 同步中心右侧抽屉（beta.2 S4/S5-WEB）。抽屉壳照抄 node/ShellStatusDock：
// createPortal(body) / gx-z-modal fixed justify-end / bg-black/30 遮罩 / role=dialog /
// gx-dock-* 滑入滑出 / 宽 384 maxWidth 88vw / Esc 关闭 / 220ms 收尾卸载。
//
// 五分区（顶部小 tab）：
//   status    当前态 + 时间 + 节点
//   outbox    待发出箱 pendingOutbox
//   conflicts 冲突列表（来自 store，轮询 /api/local-sync/conflicts?status=conflict，在线代理）
//   incoming  隔离区（quarantined/rejected/pending_approval，在线代理），支持 retry / discard；离线只读置灰
//   storage   localBytesUsed 只读展示
// 仅在门控激活且 store.centerOpen 时由 SyncCenterHost 挂载——浏览器面零渲染。
//
// 结构：SyncCenterDrawer 是容器（读 zustand + 网络 effects + portal/Esc），SyncCenterPanel 是纯展示
// 面板（只吃 props、不读 store）。这层接缝让五分区可在无 DOM 的 node 下用 renderToStaticMarkup 直渲
// （zustand v5 的 SSR 快照恒为 getInitialState，getState() 变更不会进 renderToStaticMarkup）。

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components/icons";
import { Button, toast } from "../../components/ui";
import { useSyncStore, type SyncCenterTab, type SyncPhase, type PendingConflict } from "../../store/sync";
import {
  listIncoming,
  retryIncoming,
  discardIncoming,
  triggerSyncNow,
  getLocalSyncStatus,
  isSyncUpstreamError,
  type IncomingItem,
  type LocalSyncStatus,
} from "../../api/localSync";
import { reasonText } from "./reasonCodes";
import { openConflictResolver } from "./ConflictResolverHost";

const DRAWER_WIDTH = 384;
const DRAWER_ANIM_MS = 220;

const TABS: Array<{ id: SyncCenterTab; label: string }> = [
  { id: "status", label: "状态" },
  { id: "outbox", label: "待发" },
  { id: "conflicts", label: "冲突" },
  { id: "incoming", label: "隔离区" },
  { id: "storage", label: "占用" },
];

const PHASE_TEXT: Record<string, string> = {
  online: "已同步",
  syncing: "同步中",
  offlinePending: "离线 · 有改动待同步",
  offlineLocalOnly: "离线 · 仅本机",
  quarantined: "存在被隔离的改动",
  error: "同步异常",
};

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const shown = v >= 100 || i === 0 ? Math.round(v) : (Number.isInteger(v) ? String(v) : v.toFixed(1));
  return `${shown} ${units[i]}`;
}

function Empty({ text }: { text: string }) {
  return <div className="px-3 py-6 text-center text-gx-12 text-gx-text-hint">{text}</div>;
}

function IncomingRow({ item, online, onChange }: { item: IncomingItem; online: boolean; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  // 重试/放弃都是侧车代理远端的在线操作；离线时置灰只读。
  const reason = reasonText(item.reasonCode, item.reasonDetail);
  const isConflict = item.status === "conflict";

  async function retry() {
    if (!online) return;
    setBusy(true);
    try {
      const r = await retryIncoming(item.id);
      if (r?.status === "accepted") toast("该改动已生效", "success");
      else if (r?.status === "conflict") {
        toast("存在冲突，请在冲突分区处理", "info");
        openConflictResolver();
      } else toast("仍未生效，可稍后重试或放弃", "info");
      onChange();
    } catch (e) {
      toast(isSyncUpstreamError(e) ? "无法连接远端服务器，联网后再试" : "重试失败，请稍后再试", "error");
    } finally {
      setBusy(false);
    }
  }
  async function discard() {
    if (!online) return;
    setBusy(true);
    try {
      await discardIncoming(item.id);
      toast("已放弃该改动", "info");
      onChange();
    } catch (e) {
      toast(isSyncUpstreamError(e) ? "无法连接远端服务器，联网后再试" : "操作失败，请稍后再试", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-b border-gx-hairline px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-gx-12 font-medium text-gx-text-primary">
          {item.entityType || "内容"} · {item.op || "修改"}
        </span>
        <span className="shrink-0 text-gx-11 text-gx-text-tertiary">第 {item.attempts} 次</span>
      </div>
      {reason ? <div className="mt-1 text-gx-11 text-gx-text-tertiary">{reason}</div> : null}
      {isConflict ? (
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          disabled={!online}
          disabledReason={online ? undefined : "联网后处理冲突"}
          onClick={() => openConflictResolver()}
        >
          去解决冲突
        </Button>
      ) : (
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="secondary" loading={busy} disabled={!online}
            disabledReason={online ? undefined : "联网后处理冲突"} onClick={() => void retry()}>
            重试
          </Button>
          <Button size="sm" variant="ghost" disabled={busy || !online} onClick={() => void discard()}>
            放弃
          </Button>
        </div>
      )}
    </div>
  );
}

function StatusSection({
  report,
  phase,
  online,
  lastFetchedAt,
  syncNowBusy,
  onSyncNow,
}: {
  report: LocalSyncStatus;
  phase: SyncPhase | null;
  online: boolean;
  lastFetchedAt: number | null;
  syncNowBusy: boolean;
  onSyncNow: () => void;
}) {
  const rows: Array<[string, string]> = [
    ["当前状态", phase ? PHASE_TEXT[phase] ?? "—" : online ? "在线" : "离线"],
    ["网络", online ? "在线" : "离线"],
    ["上次拉取", fmtTime(report.lastPulledAt)],
    ["上次推送", fmtTime(report.lastPushedAt)],
    ["同步节点", report.nodeId ?? "—"],
    ["本次刷新", lastFetchedAt ? fmtTime(new Date(lastFetchedAt).toISOString()) : "—"],
  ];
  // 已有一轮在飞（运行态）或本次触发请求在途时置灰；通电按钮默认可见可点。
  const inProgress = report.inFlight === true || report.running === true;
  return (
    <div>
      <dl className="divide-y divide-gx-hairline">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between px-3 py-2 text-gx-12">
            <dt className="text-gx-text-tertiary">{k}</dt>
            <dd className="ml-3 truncate text-gx-text-primary">{v}</dd>
          </div>
        ))}
      </dl>
      {report.lastError ? (
        <div className="m-3 rounded-gx-lg bg-gx-accent-bg/50 px-3 py-2 text-gx-11 text-gx-text-secondary">
          {report.lastError}
        </div>
      ) : null}
      {report.bases.length > 0 ? (
        <div className="m-3">
          <div className="mb-1 text-gx-11 text-gx-text-tertiary">本地同步的库（{report.bases.length}）</div>
          <ul className="divide-y divide-gx-hairline overflow-hidden rounded-gx-lg border border-gx-hairline">
            {report.bases.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-2 bg-gx-bg px-3 py-2 text-gx-12">
                <span className="truncate text-gx-text-primary">{b.name || b.id}</span>
                <span className="shrink-0 text-gx-11 text-gx-text-tertiary">
                  推 {fmtTime(b.lastPushedAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Button
        variant="primary"
        className="m-3 w-[calc(100%-1.5rem)]"
        loading={syncNowBusy}
        disabled={syncNowBusy || inProgress}
        disabledReason={inProgress ? "有一轮同步正在进行" : undefined}
        onClick={onSyncNow}
      >
        立即同步
      </Button>
    </div>
  );
}

function OutboxSection({ pending }: { pending: number }) {
  if (pending <= 0) return <Empty text="没有待发送的改动，一切已同步" />;
  return (
    <div className="px-3 py-4 text-center">
      <div className="text-gx-2xl font-semibold text-gx-accent tabular-nums">{pending}</div>
      <div className="mt-1 text-gx-12 text-gx-text-tertiary">条改动等待发送，恢复连接后自动同步</div>
    </div>
  );
}

function ConflictsSection({ conflicts, online }: { conflicts: PendingConflict[]; online: boolean }) {
  if (conflicts.length === 0) {
    return <Empty text={online ? "没有待解决的冲突" : "联网后处理冲突"} />;
  }
  return (
    <div>
      {conflicts.map((c) => (
        <button
          type="button"
          key={c.incomingId}
          onClick={() => openConflictResolver()}
          className="flex w-full items-center justify-between border-b border-gx-hairline px-3 py-2 text-left hover:bg-gx-row-hover"
        >
          <span className="min-w-0">
            <span className="block truncate text-gx-12 font-medium text-gx-text-primary">
              {c.entityType || "内容"} · {c.op || "修改"}
            </span>
            <span className="block truncate text-gx-11 text-gx-text-tertiary">
              {reasonText(c.reasonCode, c.reasonDetail) || "版本冲突，需要选择保留哪个值"}
            </span>
          </span>
          <Icon name="chevronRight" size={15} className="shrink-0 text-gx-text-hint" />
        </button>
      ))}
    </div>
  );
}

function IncomingSection({
  online,
  items,
  loadError,
  onChange,
}: {
  online: boolean;
  items: IncomingItem[] | null;
  loadError: string | null;
  onChange: () => void;
}) {
  if (!online) return <Empty text="当前离线，隔离区为只读；联网后处理冲突" />;
  if (loadError) {
    return (
      <div>
        <div className="px-3 py-2 text-gx-11 text-gx-danger">{loadError}</div>
        {items && items.length > 0
          ? items.map((it) => <IncomingRow key={it.id} item={it} online={online} onChange={onChange} />)
          : null}
      </div>
    );
  }
  if (items === null) return <Empty text="加载中…" />;
  if (items.length === 0) return <Empty text="隔离区为空" />;
  return (
    <div>
      {items.map((it) => (
        <IncomingRow key={it.id} item={it} online={online} onChange={onChange} />
      ))}
    </div>
  );
}

function StorageSection({ bytes }: { bytes: number }) {
  return (
    <dl className="divide-y divide-gx-hairline">
      <div className="flex items-center justify-between px-3 py-2 text-gx-12">
        <dt className="text-gx-text-tertiary">本地副本占用</dt>
        <dd className="text-gx-text-primary tabular-nums">{formatBytes(bytes)}</dd>
      </div>
    </dl>
  );
}

/** 纯展示面板的入参（容器从 store 投影；SSR 单测可直接喂值，绕开 zustand v5 的 SSR 初始快照限制）。 */
export interface SyncCenterPanelProps {
  tab: SyncCenterTab;
  online: boolean;
  report: LocalSyncStatus;
  phase: SyncPhase | null;
  conflicts: PendingConflict[];
  lastFetchedAt: number | null;
  incomingItems: IncomingItem[] | null;
  incomingError: string | null;
  closing: boolean;
  onSelectTab: (tab: SyncCenterTab) => void;
  onClose: () => void;
  onIncomingChange: () => void;
  /** 立即同步按钮：请求在途标志 + 点击回调（容器发请求，纯面板只渲染/透传）。 */
  syncNowBusy: boolean;
  onSyncNow: () => void;
}

/** 纯展示面板：不读 store、不发请求，只按 props 渲染（容器负责状态与网络）。 */
export function SyncCenterPanel(props: SyncCenterPanelProps) {
  const {
    tab, online, report, phase, conflicts, lastFetchedAt,
    incomingItems, incomingError, closing, onSelectTab, onClose, onIncomingChange,
    syncNowBusy, onSyncNow,
  } = props;

  const badgeFor = (id: SyncCenterTab): number | null => {
    if (id === "conflicts") return report.conflictCount > 0 ? report.conflictCount : null;
    if (id === "incoming") return report.quarantinedCount > 0 ? report.quarantinedCount : null;
    return null;
  };

  return (
    <div className="gx-z-modal fixed inset-0 flex justify-end" data-sync-center-drawer>
      <button
        type="button"
        aria-label="关闭同步中心"
        onClick={onClose}
        className={
          "absolute inset-0 border-0 bg-black/30 " +
          (closing ? "gx-dock-overlay-out" : "gx-dock-overlay-in")
        }
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="同步中心"
        className={
          "relative flex h-full flex-col overflow-hidden border-l border-gx-hairline bg-gx-surface shadow-gx-lg " +
          (closing ? "gx-dock-panel-out" : "gx-dock-panel-in")
        }
        style={{ width: DRAWER_WIDTH, maxWidth: "88vw" }}
      >
        <div className="flex items-center justify-between border-b border-gx-hairline px-4 py-3">
          <span className="text-gx-14 font-semibold text-gx-text-primary">同步中心</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
            className="flex h-7 w-7 items-center justify-center rounded-full text-gx-text-tertiary transition-colors hover:bg-gx-row-hover hover:text-gx-text-primary"
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-gx-hairline px-2 py-1.5">
          {TABS.map((t) => {
            const badge = badgeFor(t.id);
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onSelectTab(t.id)}
                className={
                  "flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-gx-12 transition-colors " +
                  (active
                    ? "bg-gx-accent-bg text-gx-accent"
                    : "text-gx-text-tertiary hover:bg-gx-row-hover hover:text-gx-text-primary")
                }
              >
                {t.label}
                {badge !== null ? (
                  <span className="rounded-full bg-gx-accent px-1.5 text-gx-10 leading-4 text-white tabular-nums">
                    {badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "status" ? (
            <StatusSection
              report={report}
              phase={phase}
              online={online}
              lastFetchedAt={lastFetchedAt}
              syncNowBusy={syncNowBusy}
              onSyncNow={onSyncNow}
            />
          ) : null}
          {tab === "outbox" ? <OutboxSection pending={report.pendingOutbox} /> : null}
          {tab === "conflicts" ? <ConflictsSection conflicts={conflicts} online={online} /> : null}
          {tab === "incoming" ? (
            <IncomingSection
              online={online}
              items={incomingItems}
              loadError={incomingError}
              onChange={onIncomingChange}
            />
          ) : null}
          {tab === "storage" ? <StorageSection bytes={report.localBytesUsed} /> : null}
        </div>
      </div>
    </div>
  );
}

export function SyncCenterDrawer() {
  const open = useSyncStore((s) => s.centerOpen);
  const tab = useSyncStore((s) => s.lastTab);
  const setTab = useSyncStore((s) => s.setTab);
  const closeCenter = useSyncStore((s) => s.closeCenter);
  const report = useSyncStore((s) => s.report);
  const phase = useSyncStore((s) => s.phase);
  const online = useSyncStore((s) => s.online);
  const conflicts = useSyncStore((s) => s.conflicts);
  const lastFetchedAt = useSyncStore((s) => s.lastFetchedAt);
  const replaceConflicts = useSyncStore((s) => s.replaceConflicts);
  const setSyncSnapshot = useSyncStore((s) => s.setSyncSnapshot);

  const [closing, setClosing] = useState(false);
  // 隔离区明细（容器内的本地视图状态；纯展示面板只消费）。
  const [incomingItems, setIncomingItems] = useState<IncomingItem[] | null>(null);
  const [incomingError, setIncomingError] = useState<string | null>(null);
  const [incomingVersion, setIncomingVersion] = useState(0);
  // 「立即同步」触发请求在途标志（容器持有，纯面板只消费 loading/disabled）。
  const [syncNowBusy, setSyncNowBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeWithAnim();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 停在「冲突」分区且在线时，经侧车代理在线拉一次最新明细（轮询只在 conflictCount>0 时拉）。
  // 与原 ConflictsSection 行为严格一致：该分区组件仅在 tab==="conflicts" 时挂载，故 effect 只在此刻跑。
  useEffect(() => {
    if (!open || tab !== "conflicts" || !online) return;
    let cancelled = false;
    void listIncoming("conflict")
      .then((list) => {
        if (!cancelled) replaceConflicts(list.items);
      })
      .catch(() => {
        // 502/瞬时错：保留 store 中上一次拉到的队列只读展示，不清空、不弹全局错。
      });
    return () => {
      cancelled = true;
    };
  }, [open, tab, online, replaceConflicts]);

  // 隔离明细是侧车代理远端的在线操作：仅打开且停在隔离分区时拉；离线不拉、不清；
  // 恢复在线/切到该分区/手动刷新（version）时重拉。
  useEffect(() => {
    if (!open || tab !== "incoming") return;
    if (!online) {
      // 离线不清空既有明细，仅由分区按 online 置灰只读。
      return;
    }
    let cancelled = false;
    setIncomingError(null);
    void listIncoming("quarantined,rejected,pending_approval")
      .then((list) => {
        if (!cancelled) setIncomingItems(list.items);
      })
      .catch((e) => {
        if (cancelled) return;
        // 502 远端不通：就地提示，保留上一次列表（若有），绝不当作「隔离区为空」。
        setIncomingError(isSyncUpstreamError(e) ? "无法连接远端服务器，显示的可能不是最新" : "隔离区加载失败，请稍后重试");
        setIncomingItems((prev) => prev ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [open, tab, online, incomingVersion]);

  if (!open && !closing) return null;

  function closeWithAnim() {
    closeCenter();
    setClosing(true);
    window.setTimeout(() => setClosing(false), DRAWER_ANIM_MS);
  }

  // 「立即同步」：触发后轮询前先重拉一次 status 投影，让用户立刻看到运行态，不等 5s 轮询。
  async function handleSyncNow() {
    if (syncNowBusy) return; // 防重入。
    setSyncNowBusy(true);
    try {
      const r = await triggerSyncNow();
      // 立即刷新状态投影（best-effort）：status 拉取失败不应盖掉触发结果的提示——
      // 触发已成功时，状态会在下一次 5s 轮询自然追上。
      try {
        const fresh = await getLocalSyncStatus();
        // 只接受「仍启用」的投影：触发刚成功，侧车必然在线；若即时重拉意外收敛成
        // disabled（瞬时 404），不拿它覆盖当前活体面板，留待下一次轮询校正。
        if (fresh.enabled) setSyncSnapshot(fresh, online);
      } catch {
        // 忽略即时重拉错误（含 502）；不改变下面对触发结果的 toast 分支。
      }
      if (r.triggered) toast("已开始同步", "success");
      else toast("已有一轮同步在进行", "info");
    } catch (e) {
      toast(
        isSyncUpstreamError(e) ? "无法连接远端服务器，联网后再试" : "触发同步失败，请稍后再试",
        "error",
      );
    } finally {
      setSyncNowBusy(false);
    }
  }

  const panel = (
    <SyncCenterPanel
      tab={tab}
      online={online}
      report={report}
      phase={phase}
      conflicts={conflicts}
      lastFetchedAt={lastFetchedAt}
      incomingItems={incomingItems}
      incomingError={incomingError}
      closing={closing}
      onSelectTab={setTab}
      onClose={closeWithAnim}
      onIncomingChange={() => setIncomingVersion((v) => v + 1)}
      syncNowBusy={syncNowBusy}
      onSyncNow={() => void handleSyncNow()}
    />
  );

  return typeof document === "undefined" ? panel : createPortal(panel, document.body);
}

/** 门控宿主：仅副本功能启用时挂载抽屉本体（读 store.enabled）。 */
export function SyncCenterHost() {
  const enabled = useSyncStore((s) => s.enabled);
  if (!enabled) return null;
  return <SyncCenterDrawer />;
}
