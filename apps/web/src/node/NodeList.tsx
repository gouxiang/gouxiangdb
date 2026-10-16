// apps/web/src/node/NodeList.tsx
// 启动器节点列表（DESIGN-MACOS-APP.md §8.5 规则 #6）。受控纯展示：数据来自 useLauncher
// 派生的 NodeRow[]，所有动作经回调上抛给容器（连接/断开/删除/连本机），本组件不直接碰 store，
// 便于 node + react-dom/server 锁定结构与文案，也便于将来把「连接未登录远端」换成凭据弹层。
//
// 本地节点的「启动/停止进程」依赖 D2 的 Tauri command（本仓库暂无壳），故本地行只表达
// 注册表层面的状态与「使用本机」连接动作；真正的进程起停留待桌面壳接入后补按钮（默认不渲染
// 一个点了无效的控件，遵守 R-D-09 不做假入口）。

import { Button } from "../components/ui";
import { Icon, type IconName } from "../components/icons";
import type { NodeRow } from "./launcherViewModel";

export interface NodeListProps {
  rows: NodeRow[];
  /** 正在进行连接/断开的节点 id（按钮 loading/禁用）；无则 null。 */
  busyNodeId?: string | null;
  onConnectRemote?: (nodeId: string) => void;
  onDisconnect?: (nodeId: string) => void;
  onRemove?: (nodeId: string) => void;
  onConnectLocal?: () => void;
}

function statusText(row: NodeRow): string {
  if (row.active) return "使用中";
  if (row.kind === "remote") return row.connected ? "可免密重连" : "未连接";
  return row.localDesired === "stopped" ? "已停止" : "未连接";
}

export function NodeList({
  rows,
  busyNodeId = null,
  onConnectRemote,
  onDisconnect,
  onRemove,
  onConnectLocal,
}: NodeListProps) {
  if (rows.length === 0) {
    return (
      <div className="px-1 py-6 text-center text-gx-13 text-gx-text-hint">
        还没有节点，先添加一个节点开始
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map((row) => {
        const busy = busyNodeId === row.nodeId;
        const icon: IconName = row.kind === "local" ? "database" : "globe";
        return (
          <li
            key={row.nodeId}
            className={
              "flex items-center gap-2.5 rounded-gx-lg border px-3 py-2.5 " +
              (row.active
                ? "border-gx-accent/40 bg-gx-accent-bg"
                : "border-gx-border bg-gx-surface")
            }
          >
            <span className={row.active ? "text-gx-accent" : "text-gx-text-tertiary"}>
              <Icon name={icon} size={16} />
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-gx-14 font-medium text-gx-text-primary">
                  {row.title}
                </span>
                {row.active && (
                  <span className="inline-flex items-center gap-0.5 text-gx-12 text-gx-accent">
                    <Icon name="check" size={12} />
                    {statusText(row)}
                  </span>
                )}
              </div>
              <div className="truncate text-gx-12 text-gx-text-tertiary">
                {row.kind === "remote" ? row.subtitle : statusText(row)}
                {row.kind === "remote" && row.account ? ` · ${row.account}` : ""}
                {row.kind === "remote" && !row.active ? ` · ${statusText(row)}` : ""}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              {row.active ? (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy}
                  disabled={busy}
                  onClick={() => onDisconnect?.(row.nodeId)}
                >
                  断开
                </Button>
              ) : row.kind === "local" ? (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy}
                  disabled={busy}
                  onClick={onConnectLocal}
                >
                  使用本机
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy}
                  disabled={busy}
                  onClick={() => onConnectRemote?.(row.nodeId)}
                >
                  连接
                </Button>
              )}
              {row.removable && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || row.active}
                  disabledReason={row.active ? "请先断开再删除" : undefined}
                  title={row.active ? "请先断开再删除" : "删除该节点"}
                  onClick={() => onRemove?.(row.nodeId)}
                >
                  删除
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
