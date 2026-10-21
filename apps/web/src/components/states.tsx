// apps/web/src/components/states.tsx
// 阶段 3 · 状态体系（UI-SPEC v1.0 §3.3 空态/异常态 + §3.5 加载与骨架屏）
//
// 规范锚点：
//   R-D-12 无权限态：就地卡片，图标 + 「无访问权限」+ 说明 + 返回/申请权限；不跳登录、不弹 toast
//   R-D-13 首次空态：24px 图标 + 14px/500 主文案 + 12px 说明 + 一个主按钮（必须有行动入口）
//   R-D-14 筛选空态：「没有匹配的内容」+「换个关键词试试」+「清除筛选」文字按钮，不显示新建
//   R-D-15 加载态：≥300ms 才显示；短列表 spinner，长列表/表格用骨架屏
//   R-D-16 错误态：图标 +「加载失败」+ 原因 +「重试」主按钮 +「返回」次按钮；不用全屏错误页
//   R-D-17 会话过期（401）：顶部横幅 + 保留当前页内容 +「重新登录」
//   R-D-18 冲突（409）：就地提示「内容已被他人更新」+「查看最新版本 / 保留我的版本」二选一
//   R-D-19 离线：顶部 12px 横幅「网络已断开…」，恢复后自动同步并 toast
//   R-D-25 骨架屏与目标内容同构；底色 #F1F5FB，微光 1.2s
//   R-D-26 骨架屏不少于 3 行、不超过 8 行，不铺满整屏
//   R-D-28 长任务用可关闭的进度浮层，显示「已完成 23/120」，允许后台继续
//
// 全部使用 gx-* token 与 components/icons.tsx 自建图标；不新增依赖、不裸 fetch。

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { clsx } from "clsx";
import { Button, FOCUS_RING } from "./ui";
import { Icon, type IconName } from "./icons";
import { useSyncStore } from "../store/sync";
import { syncShellGateEnabled } from "../node/syncGate";
import { bannerModel } from "../features/sync/bannerModel";

/** R-D-26 骨架行数硬边界：少于 3 行不像骨架，多于 8 行等于铺满整屏。 */
export function clampSkeletonRows(rows: number): number {
  return Math.max(3, Math.min(8, rows));
}

// ============ 骨架屏（R-D-25 / R-D-26）============

/** 单个骨架块：底色走 gx-row-hover(#F1F5FB)，微光动画由 .gx-skeleton 提供（1.2s） */
export function SkeletonBar({
  width,
  height = 12,
  className,
}: {
  width?: number | string;
  height?: number;
  className?: string;
}) {
  return (
    <div
      className={clsx("gx-skeleton rounded-gx-lg bg-gx-row-hover", className)}
      style={{ width, height }}
    />
  );
}

/** 列表骨架：等高行 + 行内两段式块（与「图标 + 标题」行同构） */
export function SkeletonList({ rows = 5, className }: { rows?: number; className?: string }) {
  const n = clampSkeletonRows(rows);
  return (
    <div data-gx-skeleton="list" className={clsx("flex flex-col gap-2 p-3", className)}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <SkeletonBar width={20} height={20} className="rounded-full" />
          <SkeletonBar width={`${52 - i * 4}%`} height={12} />
        </div>
      ))}
    </div>
  );
}

/**
 * 表格骨架：与数据表同构（一条 36px 表头 + N 条 44px 数据行），不铺满整屏。
 * 用于列表/详情首屏加载；局部刷新（翻页、筛选）按 R-D-27 走进度条，不用骨架屏。
 */
export function SkeletonTable({
  rows = 6,
  cols = 5,
  className,
}: {
  rows?: number;
  cols?: number;
  className?: string;
}) {
  const n = clampSkeletonRows(rows);
  return (
    <div data-gx-skeleton="table" className={clsx("flex flex-col", className)}>
      <div className="flex h-9 items-center gap-4 border-b border-gx-hairline bg-gx-table-header px-4">
        {Array.from({ length: cols }, (_, i) => (
          <SkeletonBar key={i} width={i === 0 ? 120 : 88} height={10} />
        ))}
      </div>
      {Array.from({ length: n }, (_, r) => (
        <div key={r} className="flex h-11 items-center gap-4 border-b border-gx-hairline px-4">
          {Array.from({ length: cols }, (_, c) => (
            <SkeletonBar key={c} width={c === 0 ? 140 : `${40 + ((r + c) % 3) * 12}%`} height={12} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** 卡片骨架：等高卡（画廊 / 看板用） */
export function SkeletonCards({ count = 4, className }: { count?: number; className?: string }) {
  const n = clampSkeletonRows(count);
  return (
    <div data-gx-skeleton="cards" className={clsx("grid gap-3 p-3", className)}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-gx-lg border border-gx-hairline p-3">
          <SkeletonBar width="60%" height={12} />
          <SkeletonBar width="90%" height={10} />
          <SkeletonBar width="40%" height={10} />
        </div>
      ))}
    </div>
  );
}

// ============ 进度浮层（R-D-28）============

/**
 * 长任务（导入 / 导出 / 批量）进度浮层：可关闭，显示「已完成 23/120」，允许后台继续。
 * 关闭只是收起浮层，不取消任务——调用方继续跑并由 toast 汇报结果。
 */
export function ProgressOverlay({
  open,
  title,
  done,
  total,
  hint,
  onClose,
  onCancel,
  cancelText = "取消任务",
}: {
  open: boolean;
  title: ReactNode;
  done: number;
  total: number;
  hint?: ReactNode;
  onClose?: () => void;
  onCancel?: () => void;
  cancelText?: string;
}) {
  if (!open) return null;
  const safeTotal = Math.max(total, done);
  const pct = safeTotal > 0 ? Math.round((done / safeTotal) * 100) : 0;
  return createPortal(
    <div className="fixed bottom-6 right-6 gx-z-popover w-[320px] rounded-gx-xl border border-gx-border bg-gx-surface p-4 shadow-gx-lg">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 text-gx-13 font-medium text-gx-text-primary">{title}</div>
        {onClose && (
          <button
            type="button"
            aria-label="收起进度（任务继续在后台执行）"
            title="收起进度（任务继续在后台执行）"
            onClick={onClose}
            className={clsx(
              "shrink-0 rounded-gx-lg p-0.5 text-gx-text-tertiary transition-colors duration-[120ms] hover:bg-gx-row-hover",
              FOCUS_RING,
            )}
          >
            <Icon name="close" size={14} />
          </button>
        )}
      </div>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-gx-row-hover">
        <div className="h-full rounded-full bg-gx-accent transition-[width] duration-[120ms]" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-2 flex items-center justify-between text-gx-11 text-gx-text-hint">
        <span>
          已完成 {done}/{safeTotal}
        </span>
        <span>{pct}%</span>
      </div>
      {hint && <div className="mt-1 text-gx-11 text-gx-text-hint">{hint}</div>}
      {onCancel && (
        <div className="mt-3 flex justify-end">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {cancelText}
          </Button>
        </div>
      )}
    </div>,
    document.body,
  );
}

// ============ 错误态（R-D-16）============

/** 区域加载失败：图标 + 标题 + 原因 +「重试」主按钮 +「返回」次按钮。不使用全屏错误页。 */
export function ErrorState({
  icon = "alertCircle",
  title = "加载失败",
  reason,
  onRetry,
  onBack,
  retrying,
  className,
}: {
  icon?: IconName;
  title?: string;
  reason?: ReactNode;
  onRetry?: () => void;
  onBack?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      data-gx-error-state="true"
      className={clsx("flex flex-col items-center justify-center gap-3 px-6 py-12 text-center", className)}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gx-danger-bg text-gx-danger">
        <Icon name={icon} size={24} />
      </div>
      <div className="text-gx-14 font-medium text-gx-text-primary">{title}</div>
      {reason && <div className="max-w-md break-words text-gx-12 text-gx-text-hint">{reason}</div>}
      {(onRetry || onBack) && (
        <div className="flex items-center gap-2">
          {onBack && (
            <Button variant="secondary" size="sm" onClick={onBack}>
              返回
            </Button>
          )}
          {onRetry && (
            <Button variant="primary" size="sm" icon="refresh" loading={retrying} onClick={onRetry}>
              重试
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ============ 会话过期 401（R-D-17）============

/** 顶部横幅：保留当前页内容，点击「重新登录」后回到原页。 */
export function SessionExpiredNotice({
  onRelogin,
  className,
}: {
  onRelogin?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      data-gx-session-expired="true"
      className={clsx(
        "flex items-center gap-2 border-b border-gx-warning bg-gx-warning-bg px-4 py-2 text-gx-12 text-gx-text-secondary",
        className,
      )}
    >
      <Icon name="alertCircle" size={14} className="shrink-0 text-gx-warning" />
      <span className="min-w-0 flex-1">登录状态已过期，当前页面的未保存改动不会丢失。</span>
      {onRelogin && (
        <Button size="sm" variant="primary" onClick={onRelogin}>
          重新登录
        </Button>
      )}
    </div>
  );
}

// ============ 冲突 409（R-D-18）============

/** 就地提示「内容已被他人更新」+「查看最新版本 / 保留我的版本」二选一，禁止静默覆盖。 */
export function ConflictNotice({
  title = "内容已被他人更新",
  description = "保存时发现服务端版本比你的更新。请选择保留哪一份，不会自动覆盖。",
  onViewLatest,
  onKeepMine,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  onViewLatest?: () => void;
  onKeepMine?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      data-gx-conflict="true"
      className={clsx(
        "flex items-start gap-2 rounded-gx-lg border border-gx-warning bg-gx-warning-bg px-3 py-2",
        className,
      )}
    >
      <Icon name="alertCircle" size={14} className="mt-0.5 shrink-0 text-gx-warning" />
      <div className="min-w-0 flex-1">
        <div className="text-gx-13 font-medium text-gx-text-primary">{title}</div>
        <div className="mt-0.5 text-gx-12 text-gx-text-secondary">{description}</div>
        {(onViewLatest || onKeepMine) && (
          <div className="mt-2 flex items-center gap-2">
            {onViewLatest && (
              <Button size="sm" variant="secondary" onClick={onViewLatest}>
                查看最新版本
              </Button>
            )}
            {onKeepMine && (
              <Button size="sm" variant="primary" onClick={onKeepMine}>
                保留我的版本
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ============ 离线（R-D-19）============

/** 在线状态订阅：SSR/单测（无 window）一律视为在线，不抛错。 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    if (typeof window === "undefined" || typeof navigator === "undefined") return;
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}

/**
 * 顶部 12px 横幅。
 *
 * 默认零行为：普通浏览器 / 非壳 / 副本功能未启用时（syncShellGateEnabled()=false）走
 * <LegacyOfflineBanner>——与改造前逐字节相同（useOnlineStatus 二态、在线 return null、
 * 同样的深色 12px 细条），不订阅同步 store、不产生轮询。
 *
 * 仅桌面壳 + 副本语境（门控开）改由 <SyncPhaseBanner> 读六态：在线/同步中 return null（零像素），
 * 其余态显示 12px 可点击细条，点击打开同步中心对应分区。
 */
export function OfflineBanner({ text = "网络已断开，改动已本地保存", className }: { text?: string; className?: string }) {
  // syncShellGateEnabled 只读 import.meta.env + Tauri 桥，纯布尔、无副作用；浏览器面恒 false。
  const inSyncShell = syncShellGateEnabled();
  if (!inSyncShell) return <LegacyOfflineBanner text={text} className={className} />;
  return <SyncPhaseBanner className={className} />;
}

/** 改造前的原二态横幅（逐字节保留），作为非壳/门控关时的唯一分支。 */
function LegacyOfflineBanner({ text, className }: { text: string; className?: string }) {
  const online = useOnlineStatus();
  if (online) return null;
  return (
    <div
      role="status"
      data-gx-offline="true"
      className={clsx(
        "flex items-center justify-center gap-1.5 bg-gx-text-primary px-4 py-1 text-gx-11 text-white",
        className,
      )}
    >
      <Icon name="alertCircle" size={11} className="shrink-0" />
      {text}
    </div>
  );
}

/** 壳 + 副本语境：六态横幅，在线/同步中零像素；其余态点击打开同步中心。 */
function SyncPhaseBanner({ className }: { className?: string }) {
  const phase = useSyncStore((s) => s.phase);
  const enabled = useSyncStore((s) => s.enabled);
  const openCenter = useSyncStore((s) => s.openCenter);
  // enabled 未确认（探活前/404）时不渲染任何同步 UI（零行为）。
  const model = enabled ? bannerModel(phase) : null;
  if (!model) return null;
  const danger = model.tone === "danger";
  return (
    <button
      type="button"
      role="status"
      data-gx-offline="true"
      data-sync-banner={model.tone}
      onClick={() => openCenter(model.tab)}
      title="点击打开同步中心"
      className={clsx(
        "flex w-full cursor-pointer items-center justify-center gap-1.5 px-4 py-1 text-gx-11 text-white",
        danger ? "bg-gx-danger" : "bg-gx-text-primary",
        className,
      )}
    >
      <Icon name={danger ? "shieldOff" : "alertCircle"} size={11} className="shrink-0" />
      {model.text}
    </button>
  );
}

// ============ 无权限态（R-D-12）============

/** 就地卡片：图标 + 「无访问权限」+ 说明 +「返回 / 申请权限」。不跳登录页、不弹 toast。 */
export function NoPermissionState({
  title = "无访问权限",
  description = "你没有查看这个内容的权限。",
  onBack,
  onRequest,
  requestText = "申请权限",
  className,
}: {
  title?: string;
  description?: ReactNode;
  onBack?: () => void;
  onRequest?: () => void;
  requestText?: string;
  className?: string;
}) {
  return (
    <div
      data-gx-no-permission="true"
      className={clsx("flex flex-col items-center justify-center gap-3 px-6 py-16 text-center", className)}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gx-bg text-gx-text-hint">
        <Icon name="lock" size={24} />
      </div>
      <div className="text-gx-14 font-medium text-gx-text-primary">{title}</div>
      <div className="max-w-md text-gx-12 text-gx-text-hint">{description}</div>
      {(onBack || onRequest) && (
        <div className="flex items-center gap-2">
          {onBack && (
            <Button variant="secondary" size="sm" onClick={onBack}>
              返回
            </Button>
          )}
          {onRequest && (
            <Button variant="primary" size="sm" onClick={onRequest}>
              {requestText}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
