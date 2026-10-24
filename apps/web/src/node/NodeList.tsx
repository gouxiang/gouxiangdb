// apps/web/src/node/NodeList.tsx
// 启动器节点列表（DESIGN-MACOS-APP.md §8.5 规则 #6）。受控纯展示：数据来自 useLauncher 派生的
// NodeRow[]，动作全部经回调上抛（连接/断开/删除/连本机/独立启停），node + react-dom/server 锁结构。
// 本地实时相位 row.runtime 由容器 applyLocalRuntime(localStatus) 映射注入；runtime 缺省（unknown，
// 非壳/测试）时维持单个「使用本机」旧形态——非壳零变化的关键。

import { Button, IconButton, Input } from "../components/ui";
import { Icon, BrandMark } from "../components/icons";
import type { NodeRow, LocalRuntimePhase } from "./launcherViewModel";
import { hostLabel } from "./launcherViewModel";

/** 某行正在重命名的受控状态：nodeId + 当前草稿。null＝无编辑行。 */
export interface NodeRenameState {
  nodeId: string;
  value: string;
}

export interface NodeListProps {
  rows: NodeRow[];
  /** 正在进行连接/断开的节点 id（按钮 loading/禁用）；无则 null。 */
  busyNodeId?: string | null;
  /** 当前处于行内重命名的节点与草稿（受控，由面板持有）；无则 null。 */
  rename?: NodeRenameState | null;
  onConnectRemote?: (nodeId: string) => void;
  onDisconnect?: (nodeId: string) => void;
  onRemove?: (nodeId: string) => void;
  onConnectLocal?: () => void;
  /** 本机已是活动节点（使用中）时点「进入」直接进工作区，不重连、不重启内核。 */
  onEnterLocal?: () => void;
  /** 活动副本行点「进入」直接进该副本工作区（已通电，不重连、不再要令牌）。 */
  onEnterReplica?: (nodeId: string) => void;
  /** 非活动副本行点「进入副本」：打开重连表单，重输连接令牌后通电并进入。 */
  onReconnectReplica?: (nodeId: string) => void;
  /** 独立启动本机内核（不进入）；未注入或 runtime 未知时不渲染启停按钮。 */
  onStartLocal?: () => void;
  /** 独立停止本机内核（不断开活动指针）。 */
  onStopLocal?: () => void;
  onStartRename?: (nodeId: string) => void;
  onRenameChange?: (value: string) => void;
  onRenameCommit?: (nodeId: string) => void;
  onRenameCancel?: () => void;
}

function statusText(row: NodeRow): string {
  if (row.active) return "使用中";
  if (row.role === "replica") {
    // 副本无内核实时相位：只表达注册表/分键会话层面是否已通电。
    // 已连通（壳内已为该 nodeId 建立会话但非活动）可免密进入；未连接需重输令牌。
    return row.connected ? "已连通，可进入" : "未连接";
  }
  if (row.kind === "remote") {
    // 纯选路后两种非活动态只描述该节点记住的会话：点「进入」都会切到该远端，
    // 有记住会话直接进业务壳，无会话打开它自己的登录页（remote-empty）。
    return row.connected ? "已记住登录" : "需要登录";
  }
  // 本地主库行：壳内四态走实时相位；unknown（非壳/未注入）回落期望态旧推导。
  switch (row.runtime) {
    case "ready":
      return "运行中";
    case "starting":
      return "启动中…";
    case "stopped":
      return "已停止";
    case "absent":
      return "未启用";
    default:
      return row.localDesired === "stopped" ? "已停止" : "未连接";
  }
}

/** 本地实时相位对应的标题旁小圆点；unknown 不渲染（非壳零变化）。 */
function RuntimeDot({ phase }: { phase: LocalRuntimePhase | undefined }) {
  if (!phase || phase === "unknown") return null;
  const cls =
    phase === "ready"
      ? "bg-gx-success"
      : phase === "starting"
        ? "bg-gx-warning"
        : "bg-gx-text-faint";
  // ready 点柔和呼吸（1.8s）；starting/stopped/absent 静态，避免误导。
  const pulse = phase === "ready" ? " gx-launcher-dot-live" : "";
  return (
    <span
      aria-hidden="true"
      className={`h-1.5 w-1.5 shrink-0 rounded-full${pulse} ${cls}`}
    />
  );
}

/** 清空自定义名后回落的默认名（主库「本机」、副本「本机副本」；远端取 host）。 */
function defaultName(row: NodeRow): string {
  if (row.role === "primary") return "本机";
  if (row.role === "replica") return "本机副本";
  return hostLabel(row.baseURL) || row.nodeId;
}

/**
 * 本地非活动行行动区。runtime 未知（非壳/未注入实时态）→ 维持旧单个「使用本机」，
 * 不渲染任何启停按钮（非壳零变化）；壳内四态显主「进入本机」+ 次「启动/停止」。
 */
function LocalActions({
  runtime,
  busy,
  onConnectLocal,
  onStartLocal,
  onStopLocal,
}: {
  runtime: LocalRuntimePhase | undefined;
  busy: boolean;
  onConnectLocal?: () => void;
  onStartLocal?: () => void;
  onStopLocal?: () => void;
}) {
  // R-D-09：置灰带原因。启动中（实时相位或点击乐观态）两按钮全禁用。
  if (runtime === "starting" || busy) {
    return (
      <>
        <Button size="sm" variant="primary" disabled title="本机内核正在启动">
          启动中…
        </Button>
        <Button size="sm" variant="secondary" disabled title="本机内核正在启动">
          {runtime === "ready" ? "停止" : "启动"}
        </Button>
      </>
    );
  }
  if (runtime === undefined || runtime === "unknown") {
    return (
      <Button size="sm" variant="secondary" onClick={onConnectLocal}>
        使用本机
      </Button>
    );
  }
  if (runtime === "ready") {
    return (
      <>
        <Button size="sm" variant="primary" onClick={onConnectLocal}>
          进入本机
        </Button>
        <Button size="sm" variant="secondary" onClick={onStopLocal}>
          停止
        </Button>
      </>
    );
  }
  // absent / stopped：进入主按钮（内部先确保内核就绪）+ 独立启动次按钮。
  return (
    <>
      <Button size="sm" variant="primary" onClick={onConnectLocal}>
        进入本机
      </Button>
      <Button size="sm" variant="secondary" onClick={onStartLocal}>
        启动
      </Button>
    </>
  );
}

export function NodeList({
  rows,
  busyNodeId = null,
  rename = null,
  onConnectRemote,
  onDisconnect,
  onRemove,
  onConnectLocal,
  onEnterLocal,
  onEnterReplica,
  onReconnectReplica,
  onStartLocal,
  onStopLocal,
  onStartRename,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
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
      {rows.map((row, idx) => {
        // 身份以 row.role 为真源：primary=本机主库（busy id 形如 local-enter/local-start，
        // 旧测试直接传 "local"）；replica/远端一律按 nodeId 精确匹配，不再用 kind 二分。
        const isPrimary = row.role === "primary";
        const isReplica = row.role === "replica";
        const localBusy = isPrimary && !!busyNodeId && busyNodeId.startsWith("local");
        const busy = busyNodeId === row.nodeId || localBusy;
        const editing = rename?.nodeId === row.nodeId;
        // 统一品牌 G：主库行用彩色品牌带，副本/远端行用单色 currentColor（活动行随 gx-accent）。
        return (
          <li
            key={row.nodeId}
            style={{ animationDelay: `${Math.min(idx * 40, 200)}ms` }}
            className={
              "gx-launcher-row gx-launcher-rise relative flex items-center gap-2.5 rounded-gx-lg border px-3 py-2.5 " +
              (row.active
                ? "border-gx-accent/40 bg-gx-accent-bg"
                : "border-gx-hairline bg-gx-surface hover:border-gx-accent/30 hover:bg-gx-row-hover")
            }
          >
            {row.active && (
              <span
                aria-hidden="true"
                className="absolute bottom-2 left-0 top-2 w-0.5 rounded-full bg-gx-accent/60"
              />
            )}
            <span
              className={
                isPrimary
                  ? "shrink-0"
                  : row.active
                    ? "shrink-0 text-gx-accent"
                    : "shrink-0 text-gx-text-tertiary"
              }
            >
              <BrandMark tone={isPrimary ? "color" : "mono"} className="h-4 w-4" />
            </span>

            <div className="min-w-0 flex-1">
              {editing ? (
                <Input
                  value={rename?.value ?? ""}
                  // 节点名无安全顾虑；autoFocus 在 SSR 仅落属性，客户端水合后聚焦。
                  autoFocus
                  inputMode="text"
                  maxLength={40}
                  placeholder={defaultName(row)}
                  aria-label="节点名称"
                  className="h-7"
                  disabled={busy}
                  onChange={(e) => onRenameChange?.(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onRenameCommit?.(row.nodeId);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      onRenameCancel?.();
                    }
                  }}
                />
              ) : (
                <div className="flex items-center gap-1.5">
                  {isPrimary && <RuntimeDot phase={row.runtime} />}
                  <span className="truncate text-gx-14 font-medium text-gx-text-primary">
                    {row.title}
                  </span>
                  {onStartRename && row.canRename && (
                    <IconButton
                      icon="edit"
                      size={13}
                      label="重命名"
                      disabled={busy}
                      onClick={() => onStartRename(row.nodeId)}
                    />
                  )}
                  {row.active && (
                    <span className="inline-flex items-center gap-0.5 text-gx-12 text-gx-accent">
                      <Icon name="check" size={12} />
                      {statusText(row)}
                    </span>
                  )}
                </div>
              )}
              <div className="truncate text-gx-12 text-gx-text-tertiary">
                {(() => {
                  // 主库：直接显实时相位/期望态；副本/远端：显基址，再按账号/连接态追加后缀。
                  if (!isReplica && row.kind !== "remote") return statusText(row);
                  const parts: string[] = [];
                  if (row.subtitle) parts.push(row.subtitle);
                  if (row.kind === "remote" && row.account) parts.push(row.account);
                  if (!row.active && (isReplica || row.kind === "remote")) {
                    parts.push(statusText(row));
                  }
                  return parts.join(" · ");
                })()}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              {editing ? (
                <>
                  <IconButton
                    icon="check"
                    size={15}
                    label="保存名称"
                    disabled={busy}
                    onClick={() => onRenameCommit?.(row.nodeId)}
                  />
                  <IconButton
                    icon="close"
                    size={15}
                    label="取消"
                    disabled={busy}
                    onClick={() => onRenameCancel?.()}
                  />
                </>
              ) : row.active && isPrimary ? (
                <>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy}
                    onClick={() => onEnterLocal?.()}
                  >
                    进入
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy}
                    disabled={busy}
                    onClick={() => onDisconnect?.(row.nodeId)}
                  >
                    断开
                  </Button>
                </>
              ) : row.active && isReplica ? (
                // 活动副本：已通电（active 指针指向它），「进入」直进副本工作区，不再要令牌；
                // 「断开」释放该副本活动指针。令牌永不回填，故此处不出现重输令牌入口。
                <>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy}
                    onClick={() => onEnterReplica?.(row.nodeId)}
                  >
                    进入
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy}
                    disabled={busy}
                    onClick={() => onDisconnect?.(row.nodeId)}
                  >
                    断开
                  </Button>
                </>
              ) : row.active ? (
                // 活动远端行：给「进入」（对已活动远端幂等重选路，记住会话毫秒直进工作区）
                // +「断开」。修复"远端登录后回切换页无法再回到该远端"的回归。
                <>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy}
                    onClick={() => onConnectRemote?.(row.nodeId)}
                  >
                    进入
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy}
                    disabled={busy}
                    onClick={() => onDisconnect?.(row.nodeId)}
                  >
                    断开
                  </Button>
                </>
              ) : isPrimary ? (
                <LocalActions
                  runtime={row.runtime}
                  busy={localBusy}
                  onConnectLocal={onConnectLocal}
                  onStartLocal={onStartLocal}
                  onStopLocal={onStopLocal}
                />
              ) : isReplica ? (
                // 非活动副本：档案已入册但当前未通电。主按钮「进入副本」打开重连表单，
                // 重输连接令牌后 connectReplica 通电并进入（令牌零持久化，故每次都要重给）。
                <Button
                  size="sm"
                  variant="primary"
                  loading={busy}
                  disabled={busy}
                  onClick={() => onReconnectReplica?.(row.nodeId)}
                >
                  进入副本
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy}
                  disabled={busy}
                  onClick={() => onConnectRemote?.(row.nodeId)}
                >
                  进入
                </Button>
              )}
              {!editing && row.removable && (
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
