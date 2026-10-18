// apps/web/src/node/LauncherPanel.tsx
// 启动器主面板（DESIGN-MACOS-APP.md §8.5）：横屏居中白卡，节点列表 + 添加节点 + 凭据重连。
//
// 组合已单测的零件：useLauncher（订阅仓库/VM）、useShellRuntime（壳内 localStatus 轮询）、
// NodeList、AddRemoteNodeForm、ConnectNodeForm、LauncherErrorBar。
// 本地内核的真正起停由成品壳 gx:start_local / gx:stop_local 承担（shellBridge → Rust）：
//   - 「启动/停止」只起停进程、不改活动指针（startLocalOnly/stopLocalOnly）；
//   - 「进入本机」connectLocal 才切活动数据源并把壳代理上游切到本地。
// 面板不含桌面门控本身（NodeLauncherGate 在 VITE_NODE_LAUNCHER=1 且壳内才渲染），浏览器/fnOS
// 永远不会加载到这里；非壳 store.shellBound=false，useShellRuntime 不轮询、行态回落旧文案。

import { useState } from "react";
import { Button } from "../components/ui";
import { Icon } from "../components/icons";
import { useLauncher } from "./useLauncher";
import type { LauncherStore } from "./launcherStore";
import { NodeList, type NodeRenameState } from "./NodeList";
import { AddRemoteNodeForm } from "./AddRemoteNodeForm";
import { ConnectNodeForm } from "./ConnectNodeForm";
import { LauncherErrorBar } from "./LauncherErrorBar";
import { useShellRuntime } from "./useShellRuntime";
import { applyLocalRuntime } from "./launcherViewModel";
import type { NodeRow } from "./launcherViewModel";
import { normalizeNodeLabel, shellConnectPort } from "./addRemoteFlow";

type View =
  | { mode: "list" }
  | { mode: "add" }
  | { mode: "connect"; nodeId: string; title: string; baseURL: string };

export interface LauncherPanelProps {
  /** 生产用浏览器单例（useLauncher 默认）；测试/壳覆盖时注入。 */
  store?: LauncherStore;
  /** 成为活动节点后（进入业务界面）由挂载层接管路由；面板只通知。 */
  onEnterWorkspace?: (nodeId: string) => void;
}

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export function LauncherPanel({ store, onEnterWorkspace }: LauncherPanelProps) {
  const { vm, store: resolved } = useLauncher(store);
  // 非壳 shellBound=false：hook 返回全 null 稳定对象，不发任何 invoke/timer（零变化）。
  const rt = useShellRuntime(resolved.shellBound);
  const [view, setView] = useState<View>({ mode: "list" });
  const [busyNodeId, setBusyNodeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rename, setRename] = useState<NodeRenameState | null>(null);

  // 面板本地 busy id："local-enter"（进入本机）/ "local-start"（独立启停）；NodeList 按
  // startsWith("local") 判定本地行忙碌，远端 hex id 不会命中。
  const localBusy = !!busyNodeId && busyNodeId.startsWith("local");
  const rows = applyLocalRuntime(vm.rows, rt.status, localBusy);
  const hasLocalEntry = resolved.getState().entries.some((e) => e.kind === "local");
  const firstBooting =
    localBusy && ((!!rt.status?.added && !rt.status.initialized) || !hasLocalEntry);
  const bootHint = localBusy
    ? firstBooting
      ? "首次启动正在初始化本机数据，首次会稍慢，请稍候…"
      : "正在启动本机…"
    : null;

  // 切到添加/重连等非列表视图时退出编辑态，避免回来仍停在改名框。
  function openView(next: View) {
    setRename(null);
    setView(next);
  }

  function startRename(nodeId: string) {
    const row = vm.rows.find((r) => r.nodeId === nodeId);
    // 预填自定义名；默认名（本机/host）行从空串开始，占位符提示回落的默认名。
    setRename({ nodeId, value: row?.label ?? "" });
  }

  function commitRename(nodeId: string) {
    if (!rename) return;
    resolved.rename(nodeId, normalizeNodeLabel(rename.value));
    setRename(null);
  }

  // 有活动节点时面板其实不应停留在连接界面（挂载层会把界面交给业务壳）；
  // 仍安全处理：通知挂载层进入工作区。
  function handleActive(nodeId: string) {
    onEnterWorkspace?.(nodeId);
  }

  async function connectLocal() {
    setBusyNodeId("local-enter");
    setError(null);
    try {
      // 壳模式：store 内部先 start_local 等 ready 再切源（失败 throw，active 不变）。
      const out = await resolved.connectLocal();
      if (out.active) handleActive(out.active.nodeId);
    } catch (e) {
      setError(errorMessage(e, "启动本机失败，请重试"));
    } finally {
      setBusyNodeId(null);
      rt.refresh();
    }
  }

  async function handleStartLocal() {
    setBusyNodeId("local-start");
    setError(null);
    try {
      await resolved.startLocalOnly();
    } catch (e) {
      setError(errorMessage(e, "启动本机失败，请重试"));
    } finally {
      setBusyNodeId(null);
      rt.refresh();
    }
  }

  async function handleStopLocal() {
    setBusyNodeId("local-start");
    setError(null);
    try {
      await resolved.stopLocalOnly();
    } catch (e) {
      setError(errorMessage(e, "停止本机失败，请重试"));
    } finally {
      setBusyNodeId(null);
      rt.refresh();
    }
  }

  async function quickConnectRemote(row: NodeRow) {
    // 有已存会话 → 免密直连；无会话 → 展开凭据表单。
    if (!row.connected) {
      openView({ mode: "connect", nodeId: row.nodeId, title: row.title, baseURL: row.baseURL });
      return;
    }
    setBusyNodeId(row.nodeId);
    setError(null);
    try {
      const out = await resolved.connectRemote(row.nodeId);
      if (out.active) handleActive(out.active.nodeId);
    } catch (e) {
      setError(errorMessage(e, "连接失败，请重试"));
    } finally {
      setBusyNodeId(null);
      rt.refresh();
    }
  }

  async function disconnect(nodeId: string) {
    setBusyNodeId(nodeId);
    setError(null);
    try {
      const out = await resolved.disconnect(nodeId);
      if (!out.active) openView({ mode: "list" });
    } catch (e) {
      // 壳命令失败不回滚已提交的断开：仍回列表，但不再静默吞错。
      setError(errorMessage(e, "断开失败，请重试"));
      openView({ mode: "list" });
    } finally {
      setBusyNodeId(null);
      rt.refresh();
    }
  }

  function removeRemote(nodeId: string) {
    resolved.removeRemote(nodeId);
    if (rename?.nodeId === nodeId) setRename(null);
    if (view.mode === "connect" && view.nodeId === nodeId) openView({ mode: "list" });
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-gx-bg px-6 py-10">
      <div className="w-full max-w-[560px] rounded-gx-2xl border border-gx-border bg-gx-surface p-8">
        <div className="flex flex-col gap-5">
          <header className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-gx-lg bg-gx-accent-bg text-gx-accent">
                <Icon name="database" size={18} />
              </span>
              <div className="min-w-0">
                <h1 className="text-gx-20 font-medium text-gx-text-primary">构想工作台</h1>
                <p className="mt-0.5 text-gx-13 text-gx-text-tertiary">
                  选择一个节点开始，或添加网络上的另一台电脑
                </p>
              </div>
            </div>
            {rt.info?.shellVersion ? (
              <span className="shrink-0 pt-1 text-gx-12 text-gx-text-faint">
                v{rt.info.shellVersion}
              </span>
            ) : null}
          </header>

          <LauncherErrorBar message={error} onClose={() => setError(null)} />
          {bootHint ? <p className="text-gx-12 text-gx-text-tertiary">{bootHint}</p> : null}

          {view.mode === "add" ? (
            <section>
              <div className="mb-3 text-gx-14 font-medium text-gx-text-primary">添加网络节点</div>
              <AddRemoteNodeForm
                store={resolved}
                onConnected={(nodeId) => {
                  openView({ mode: "list" });
                  handleActive(nodeId);
                }}
                onCancel={() => openView({ mode: "list" })}
              />
            </section>
          ) : view.mode === "connect" ? (
            <section>
              <ConnectNodeForm
                nodeId={view.nodeId}
                title={view.title}
                baseURL={view.baseURL}
                // 非壳：直连控制器（现状时序，不经 store emit）；壳：改道 store 以触发 set_upstream。
                port={resolved.shellBound ? shellConnectPort(resolved) : resolved.controller}
                onConnected={(nodeId) => {
                  openView({ mode: "list" });
                  handleActive(nodeId);
                }}
                onCancel={() => openView({ mode: "list" })}
              />
            </section>
          ) : vm.isEmpty ? (
            <div className="flex flex-col gap-2">
              <Button
                block
                size="lg"
                variant="primary"
                icon="database"
                disabled={busyNodeId !== null}
                disabledReason="本机内核正在启动"
                onClick={() => void connectLocal()}
              >
                <span className="flex flex-col items-start leading-tight">
                  <span>在这台电脑上开始</span>
                  <span className="text-gx-12 font-normal opacity-80">
                    数据保存在本机，离线也能用
                  </span>
                </span>
              </Button>
              <Button
                block
                size="lg"
                variant="secondary"
                icon="globe"
                disabled={busyNodeId !== null}
                onClick={() => openView({ mode: "add" })}
              >
                连接到网络上的另一台电脑
              </Button>
            </div>
          ) : (
            <>
              <NodeList
                rows={rows}
                busyNodeId={busyNodeId}
                rename={rename}
                onConnectLocal={() => void connectLocal()}
                onStartLocal={() => void handleStartLocal()}
                onStopLocal={() => void handleStopLocal()}
                onConnectRemote={(nodeId) => {
                  const row = vm.rows.find((r) => r.nodeId === nodeId);
                  if (row) void quickConnectRemote(row);
                }}
                onDisconnect={(nodeId) => void disconnect(nodeId)}
                onRemove={removeRemote}
                onStartRename={startRename}
                onRenameChange={(value) =>
                  setRename((cur) => (cur ? { ...cur, value } : cur))
                }
                onRenameCommit={commitRename}
                onRenameCancel={() => setRename(null)}
              />
              <div>
                <Button variant="secondary" icon="plus" onClick={() => openView({ mode: "add" })}>
                  添加网络节点
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
