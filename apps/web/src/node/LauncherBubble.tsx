// apps/web/src/node/LauncherBubble.tsx
// 桌面悬浮气泡（DESIGN-MACOS-APP.md §8.5 规则 #6）：常驻入口，随时看「当前在看哪个节点」并
// 打开启动器全局面板（/launcher，节点列表/状态/添加/连接动作都在那里，本气泡不重复动作编排）。
//
// 现网零 UI 变化的关键：
//   - 门控关闭（浏览器/fnOS/服务器）外层组件直接返回 null，**不调用任何 hook**（不构造启动器
//     仓库、不订阅、不占布局）；
//   - 门控开启但当前无活动节点（停在启动器本身/首启）也不渲染，避免与启动器界面重复；
//   - 在 /launcher 与公开分享/邀请页（匿名、无活动会话）隐藏。
//
// 定位 fixed 右下角、最高浮层；不进业务壳布局流，对任何页面尺寸无影响。

import { useLocation, useNavigate } from "react-router-dom";
import { Icon } from "../components/icons";
import { launcherEnabled } from "./desktopGate";
import { useLauncher } from "./useLauncher";
import type { LauncherStore } from "./launcherStore";

/** 这些匿名/公开路由下不显示气泡（本就没有活动会话，也不该把内部节点信息露给分享页）。 */
const HIDDEN_PREFIXES = ["/launcher", "/s/", "/share/", "/join/", "/invite/"];

export interface LauncherBubbleProps {
  enabled?: boolean;
  store?: LauncherStore;
}

function BubbleInner({ store }: { store?: LauncherStore }) {
  const { vm } = useLauncher(store);
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const onLauncher = HIDDEN_PREFIXES.some(
    (p) => pathname === p.replace(/\/$/, "") || pathname.startsWith(p),
  );
  if (onLauncher || !vm.activeRow) return null;

  const row = vm.activeRow;
  const label = row.kind === "local" ? "本机" : row.title;

  return (
    <button
      type="button"
      onClick={() => navigate("/launcher")}
      title="管理节点"
      aria-label="管理节点"
      className={
        "gx-z-popover fixed bottom-4 right-4 inline-flex h-9 items-center gap-1.5 rounded-full " +
        "border border-gx-border bg-gx-surface pl-2.5 pr-3 text-gx-13 font-medium " +
        "text-gx-text-secondary shadow-gx-md transition-colors duration-[120ms] " +
        "hover:bg-gx-row-hover focus:outline-none focus:ring-2 focus:ring-gx-accent/50"
      }
    >
      <span className={row.active ? "text-gx-accent" : "text-gx-text-tertiary"}>
        <Icon name={row.kind === "local" ? "database" : "globe"} size={15} />
      </span>
      <span className="max-w-[140px] truncate">{label}</span>
    </button>
  );
}

export function LauncherBubble({ enabled, store }: LauncherBubbleProps) {
  // 门控判定放最前：关闭时零 hook、零 DOM（现网完全无感）。
  if (!(enabled ?? launcherEnabled())) return null;
  return <BubbleInner store={store} />;
}
