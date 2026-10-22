// apps/web/src/node/ShellStatusDock.tsx
// 桌面壳底部固定状态条（0.2.5 正式版 UI 优化①）：取代旧的右下角悬浮圆球。
//
// 一条悬浮在壳底部**居中**的细 pill，集中展示：当前连接节点、连接稳定度（信号格 + 实时 ms）、
// 核心版本号、壳版本号。position:fixed、不进任何业务布局流——内容页高度/布局零变化，列表可从
// 其后方正常滚过；只在 pill 本体上接指针事件。底边距叠加 env(safe-area-inset-bottom) 适配安全区。
//
// 点「节点信息」段 → 右侧滑出节点切换抽屉（不再整页跳 /launcher），抽屉内复用 LauncherPanel
// （variant="drawer"），连接/起停/添加/改名逻辑与整页逐字相同；遮罩点击 / Esc / 关闭按钮三种方式收起，
// 滑入滑出动画统一。打开抽屉不卸载底层页面，底层内容仍在、可浏览（遮罩半透明）。
//
// 现网零变化：必须**构建门控开且物理在 Tauri 壳内**（launcherEnabled() && hasShell()）才渲染；
// 浏览器/fnOS/服务器二者缺一恒返回 null，且不构造仓库/不订阅/不发 /healthz。无活动节点或处于
// 启动器/公开分享等匿名路由时同样不渲染（口径同旧 LauncherBubble）。

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import { BrandMark, Icon } from "../components/icons";
import { launcherEnabled } from "./desktopGate";
import { hasShell } from "./shellBridge";
import { useLauncher } from "./useLauncher";
import { useShellRuntime } from "./useShellRuntime";
import { useShellHealth } from "./useShellHealth";
import { LauncherPanel } from "./LauncherPanel";
import type { LauncherStore } from "./launcherStore";
import { useSyncStatus } from "../hooks/useSyncStatus";
import { useSyncStore } from "../store/sync";

/** 匿名/公开路由及启动器整页下不显示底部条（无活动会话，也不该把节点信息露给分享页）。 */
const HIDDEN_PREFIXES = ["/launcher", "/s/", "/share/", "/join/", "/invite/"];

/** 抽屉宽（固定统一），窄屏兜底 88vw。 */
const DRAWER_WIDTH = 384;
/** 与 CSS 滑入滑出动画时长一致（index.css gx-dock-*），用于关闭态收尾后卸载。 */
const DRAWER_ANIM_MS = 220;

export interface ShellStatusDockProps {
  /** 测试注入门控；缺省＝构建标志 && 物理在壳内。 */
  enabled?: boolean;
  store?: LauncherStore;
}

/** 信号格（自绘，不引图标库）：按在线态与实时延迟分 0–4 档。 */
export function signalLevel(ok: boolean, ping: number | null): 0 | 1 | 2 | 3 | 4 {
  if (!ok || ping === null) return 0;
  if (ping < 80) return 4;
  if (ping < 200) return 3;
  if (ping < 500) return 2;
  return 1;
}

function SignalBars({ level }: { level: 0 | 1 | 2 | 3 | 4 }) {
  // 4 根高度递增的圆角竖条；到达档位高亮 accent，未到档位用淡色（离线全淡）。
  const heights = [5, 8, 11, 14];
  return (
    <span
      className="flex items-end gap-[2px]"
      role="img"
      aria-label={level === 0 ? "连接中断" : `信号强度 ${level} 级`}
    >
      {heights.map((h, i) => {
        const on = i < level;
        return (
          <span
            key={i}
            className="w-[3px] rounded-[1px]"
            style={{
              height: h,
              backgroundColor: on
                ? "var(--gx-accent, #e1467f)"
                : "var(--gx-text-faint, rgba(0,0,0,0.18))",
              opacity: on ? 1 : 0.5,
            }}
          />
        );
      })}
    </span>
  );
}

function DockInner({ store }: { store?: LauncherStore }) {
  const { vm, store: resolved } = useLauncher(store);
  const { pathname } = useLocation();
  // 物理在壳才轮询本地内核态（取壳版本号）；非壳 hook 返回稳定空对象、零 timer。
  const rt = useShellRuntime(resolved.shellBound);
  // 同源 /healthz 计时：实时延迟 ms + 核心版本号。
  const health = useShellHealth(resolved.shellBound);
  // 离线同步状态轮询：仅壳内且有活动节点（本组件已在 ShellStatusDock 门控后）才挂载；
  // 非壳零 timer/fetch。返回的 enabled=壳语境，真正「副本功能启用」以 store.enabled 收敛。
  useSyncStatus({ enabled: resolved.shellBound });
  const syncEnabled = useSyncStore((s) => s.enabled);
  const syncPhase = useSyncStore((s) => s.phase);
  const syncBadge = useSyncStore(
    (s) => s.report.conflictCount + s.report.quarantinedCount + s.report.pendingOutbox,
  );
  const openSyncCenter = useSyncStore((s) => s.openCenter);

  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);

  const hiddenRoute = HIDDEN_PREFIXES.some(
    (p) => pathname === p.replace(/\/$/, "") || pathname.startsWith(p),
  );

  // Esc 收起抽屉（与点遮罩、关闭按钮三种方式统一）。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function closeDrawer() {
    setOpen(false);
    setClosing(true);
    window.setTimeout(() => setClosing(false), DRAWER_ANIM_MS);
  }

  if (hiddenRoute || !vm.activeRow) return null;

  const row = vm.activeRow;
  const label = row.kind === "local" ? "本机" : row.title;
  const level = signalLevel(health.ok, health.ping);
  const coreVersion = health.version;
  const shellVersion = rt.info?.shellVersion ?? null;

  const drawerMounted = open || closing;

  // 底部条：App 在壳内把整体包成纵向 flex（见 App.tsx / index.css gx-shell-app），
  // 本条作为 shrink-0 的最后一行占据文档流——内容区 flex:1 自适应让出高度，
  // 谁也不遮挡谁；不再 fixed 悬浮。顶边细分隔线，整条作为壳的附加 chrome。
  const bar = (
    <div
      className="gx-shell-dock flex shrink-0 items-center justify-center border-t border-gx-hairline bg-gx-surface text-gx-12 select-none"
      style={{ height: 38, paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      data-shell-dock
    >
      <div className="flex h-full items-center">
        {/* 节点信息：唯一可点开抽屉的入口段 */}
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="切换或管理节点"
          aria-label="切换或管理节点"
          aria-haspopup="dialog"
          aria-expanded={open}
          className="flex h-full items-center gap-1.5 px-2 font-medium text-gx-text-secondary transition-colors hover:text-gx-text-primary"
        >
          <span className={row.kind === "local" ? "shrink-0" : "shrink-0 text-gx-accent"}>
            <BrandMark tone={row.kind === "local" ? "color" : "mono"} className="h-[15px] w-[15px]" />
          </span>
          <span className="max-w-[180px] truncate">{label}</span>
          <Icon name="chevronUp" size={13} className="shrink-0 text-gx-text-tertiary" />
        </button>

        <span className="mx-2 h-4 w-px bg-gx-hairline" />

        {/* 连接稳定度：信号格 + 实时毫秒延迟 */}
        <span
          className="flex items-center gap-1.5 text-gx-text-tertiary"
          title={level === 0 ? "与当前节点连接中断" : `往返延迟 ${health.ping} ms`}
        >
          <SignalBars level={level} />
          <span className={level === 0 ? "text-gx-text-faint" : "tabular-nums text-gx-text-secondary"}>
            {level === 0 ? "离线" : `${health.ping} ms`}
          </span>
        </span>

        <span className="mx-2 h-4 w-px bg-gx-hairline" />

        {/* 版本：核心（API/内核）/ 壳（Tauri 外壳） */}
        <span className="flex items-center gap-2 whitespace-nowrap text-gx-text-faint">
          <span title="核心版本">核心 {coreVersion ? `v${coreVersion}` : "—"}</span>
          <span title="壳版本">壳 {shellVersion ? `v${shellVersion}` : "—"}</span>
        </span>

        {/* 离线同步中心入口：仅「副本功能已确认启用」才渲染（浏览器/非副本恒无此节点，零像素）。 */}
        {syncEnabled ? (
          <>
            <span className="mx-2 h-4 w-px bg-gx-hairline" />
            <button
              type="button"
              onClick={() => openSyncCenter()}
              title="同步中心"
              aria-label="打开同步中心"
              className="flex h-full items-center gap-1.5 px-2 font-medium text-gx-text-secondary transition-colors hover:text-gx-text-primary"
            >
              <Icon
                name="sync"
                size={14}
                className={syncPhase === "syncing" ? "animate-spin" : "shrink-0"}
              />
              {syncBadge > 0 ? (
                <span className="rounded-full bg-gx-accent px-1.5 text-gx-10 leading-4 text-white tabular-nums">
                  {syncBadge}
                </span>
              ) : null}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );

  // 节点切换侧滑抽屉：createPortal 到 body（应用浮层统一口径，脱离页面祖先的定位/
  // 堆叠上下文，避免被壳内 transform/overflow 祖先误定位）；外壳 fixed flex justify-end，
  // 面板 relative 贴右全高（同 VersionHistoryDrawer 的可靠结构）。
  const drawer = drawerMounted ? (
    <div className="gx-z-modal fixed inset-0 flex justify-end" data-shell-dock-drawer>
      <button
        type="button"
        aria-label="关闭节点切换"
        onClick={closeDrawer}
        className={
          "absolute inset-0 border-0 bg-black/30 " +
          (closing ? "gx-dock-overlay-out" : "gx-dock-overlay-in")
        }
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="切换或管理节点"
        className={
          // v6：贴边抽屉面板用 1px 发丝线与遮罩外分隔（结构线，非控件深线）
          "relative flex h-full flex-col overflow-hidden border-l border-gx-hairline bg-gx-surface shadow-gx-lg " +
          (closing ? "gx-dock-panel-out" : "gx-dock-panel-in")
        }
        style={{ width: DRAWER_WIDTH, maxWidth: "88vw" }}
      >
        <button
          type="button"
          onClick={closeDrawer}
          aria-label="关闭"
          title="关闭"
          className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-full text-gx-text-tertiary transition-colors hover:bg-gx-row-hover hover:text-gx-text-primary"
        >
          <Icon name="close" size={16} />
        </button>
        <LauncherPanel
          store={store}
          variant="drawer"
          onEnterWorkspace={() => closeDrawer()}
        />
      </div>
    </div>
  ) : null;

  return (
    <>
      {bar}
      {drawer &&
        (typeof document === "undefined" ? drawer : createPortal(drawer, document.body))}
    </>
  );
}

export function ShellStatusDock({ enabled, store }: ShellStatusDockProps) {
  // 物理在壳才渲染：构建门控开但普通浏览器直访 dist-shell 时 hasShell()=false → null（零副作用）。
  const on = enabled ?? (launcherEnabled() && hasShell());
  if (!on) return null;
  return <DockInner store={store} />;
}
