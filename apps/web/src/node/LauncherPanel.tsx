// apps/web/src/node/LauncherPanel.tsx
// 启动器主面板（DESIGN-MACOS-APP.md §8.5）：横屏居中白卡，节点列表 + 添加节点。
//
// 组合已单测的零件：useLauncher（订阅仓库/VM）、useShellRuntime（壳内 localStatus 轮询）、
// NodeList、AddRemoteNodeForm、LauncherErrorBar。
// 「连接＝只选路」（2026-10）：点远端行的「进入」/添加节点成功都只把活动指针指向该远端——
// 有记住的会话直接进业务壳；无会话（remote-empty）随即展示该远端节点**自己的登录页**，
// 不再在启动器内弹账号密码表单（ConnectNodeForm 已退出本面板）。
// 本地内核的真正起停由成品壳 gx:start_local / gx:stop_local 承担（shellBridge → Rust）：
//   - 「启动/停止」只起停进程、不改活动指针（startLocalOnly/stopLocalOnly）；
//   - 「进入本机」connectLocal 才切活动数据源并把壳代理上游切到本地。
// 面板不含桌面门控本身（NodeLauncherGate 在 VITE_NODE_LAUNCHER=1 且壳内才渲染），浏览器/fnOS
// 永远不会加载到这里；非壳 store.shellBound=false，useShellRuntime 不轮询、行态回落旧文案。

import { useState } from "react";
import { Button } from "../components/ui";
import { Icon, BrandMark } from "../components/icons";
import { useLauncher } from "./useLauncher";
import type { LauncherStore } from "./launcherStore";
import { NodeList, type NodeRenameState } from "./NodeList";
import { AddRemoteNodeForm } from "./AddRemoteNodeForm";
import { LauncherErrorBar } from "./LauncherErrorBar";
import { useShellRuntime } from "./useShellRuntime";
import { applyLocalRuntime, ensureLocalRow } from "./launcherViewModel";
import type { NodeRow } from "./launcherViewModel";
import { normalizeNodeLabel } from "./addRemoteFlow";

type View = { mode: "list" } | { mode: "add" };

export interface LauncherPanelProps {
  /** 生产用浏览器单例（useLauncher 默认）；测试/壳覆盖时注入。 */
  store?: LauncherStore;
  /** 成为活动节点后（进入业务界面）由挂载层接管路由；面板只通知。 */
  onEnterWorkspace?: (nodeId: string) => void;
  /**
   * full   ：/launcher 整页（横屏居中白卡，首启/未连接时的落地形态，行为不变）。
   * drawer ：壳内底部状态条唤出的侧滑抽屉——填满抽屉容器、自带滚动与头部，
   *          不再套居中外层与大卡（连接/起停逻辑与 full 完全一致）。
   */
  variant?: "full" | "drawer";
}

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export function LauncherPanel({ store, onEnterWorkspace, variant = "full" }: LauncherPanelProps) {
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
  // 展示行先保证含本机行（注册表无 local 条目时补"未启用"占位行），再叠加壳内实时相位——
  // 这样用户即便先直连了远端、从未初始化本机，切换页也始终能启动/进入本机（交互硬规则）。
  // 顺序不可换：applyLocalRuntime 需作用于含占位行在内的本机行，占位行才能在壳内显示"未启用"。
  const rows = applyLocalRuntime(ensureLocalRow(vm.rows), rt.status, localBusy);
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

  // 已「使用中」的本机行点「进入」：不重连（内核已活、活动指针已在本机），直接通知挂载层
  // 进入工作区（挂载层据本地登录态决定去 /login 首管理员引导还是业务壳）。
  function enterLocal() {
    handleActive("local");
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
    // 「连接＝只选路」：有无已存会话都直接 connectRemote（不发登录、不弹凭据表单）。
    // 有记住的会话 → 活动数据源带 JWT，挂载层直接进业务壳；无会话 → remote-empty，
    // 挂载层据活动会话视图路由到该远端节点自己的 /login。两种情况都是毫秒级选路。
    setBusyNodeId(row.nodeId);
    setError(null);
    try {
      const out = await resolved.connectRemote(row.nodeId);
      if (out.active) handleActive(out.active.nodeId);
    } catch (e) {
      setError(errorMessage(e, "进入节点失败，请重试"));
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
  }

  const content = (
    <div className="flex flex-col gap-6">
      <header className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3.5">
          <span className="gx-launcher-logo flex h-11 w-11 shrink-0 items-center justify-center rounded-gx-xl">
            <BrandMark className="h-7 w-7" />
          </span>
          <div className="min-w-0 pt-0.5">
            <h1 className="text-gx-20 font-semibold tracking-tight text-gx-text-primary">
              构想工作台
            </h1>
            <p className="mt-1 text-gx-13 leading-snug text-gx-text-tertiary">
              选择一个节点开始，或添加网络上的另一台电脑
            </p>
          </div>
        </div>
        {/* 壳版本胶囊仅整页 full 形态展示；drawer 形态右上角是抽屉关闭钮、且底部状态条已含壳版本，隐藏避免重叠。 */}
        {variant === "full" && rt.info?.shellVersion ? (
          <span className="shrink-0 rounded-full bg-gx-control px-2 py-0.5 text-gx-12 leading-5 text-gx-text-faint">
            v{rt.info.shellVersion}
          </span>
        ) : null}
      </header>

          <LauncherErrorBar message={error} onClose={() => setError(null)} />
          {bootHint ? <p className="text-gx-12 text-gx-text-tertiary">{bootHint}</p> : null}

          {view.mode === "add" ? (
            <section className="gx-launcher-rise">
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
          ) : vm.isEmpty ? (
            <div className="flex flex-col gap-2.5">
              {/* 主 CTA：品牌暖→玫红渐变卡（色值见 index.css「桌面启动器动效」段注释），
                  保留下沉/禁用语义与原 Button 一致（disabled + title 原因 + focus ring）。 */}
              <button
                type="button"
                disabled={busyNodeId !== null}
                title={busyNodeId !== null ? "本机内核正在启动" : undefined}
                onClick={() => void connectLocal()}
                className={
                  "gx-launcher-cta gx-launcher-cta-primary gx-launcher-rise relative flex w-full items-center gap-3 overflow-hidden rounded-gx-2xl px-4 py-3.5 text-left " +
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gx-accent/50 " +
                  "disabled:cursor-not-allowed disabled:opacity-50"
                }
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-gx-15 font-semibold text-white">
                    在这台电脑上开始
                  </span>
                  <span className="mt-0.5 block text-gx-12 text-white/80">
                    数据保存在本机，离线也能用
                  </span>
                </span>
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-gx-lg bg-white/90 shadow-sm">
                  <BrandMark className="h-5 w-5" />
                </span>
                <Icon
                  name="chevronRight"
                  size={16}
                  className="gx-launcher-arrow shrink-0 text-white/80"
                />
              </button>
              <button
                type="button"
                disabled={busyNodeId !== null}
                onClick={() => openView({ mode: "add" })}
                style={{ animationDelay: "70ms" }}
                className={
                  "gx-launcher-cta gx-launcher-rise relative flex w-full items-center gap-3 rounded-gx-2xl border border-gx-hairline bg-gx-surface px-4 py-3 text-left " +
                  "hover:border-gx-accent/40 hover:bg-gx-row-hover " +
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gx-accent/50 " +
                  "disabled:cursor-not-allowed disabled:opacity-50"
                }
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-gx-lg bg-gx-accent-bg text-gx-accent">
                  <BrandMark tone="mono" className="h-[18px] w-[18px]" />
                </span>
                <span className="min-w-0 flex-1 text-gx-14 font-medium text-gx-text-primary">
                  连接到网络上的另一台电脑
                </span>
                <Icon
                  name="chevronRight"
                  size={15}
                  className="gx-launcher-arrow shrink-0 text-gx-text-faint"
                />
              </button>
            </div>
          ) : (
            <>
              <NodeList
                rows={rows}
                busyNodeId={busyNodeId}
                rename={rename}
                onConnectLocal={() => void connectLocal()}
                onEnterLocal={() => enterLocal()}
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
  );

  // 侧滑抽屉变体：填满抽屉容器、自带滚动与紧凑留白；不再套整页居中外层与大卡。
  if (variant === "drawer") {
    return (
      <div className="flex h-full flex-col overflow-y-auto bg-gx-bg px-5 py-5" data-launcher-drawer>
        {content}
      </div>
    );
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-gx-bg px-6 py-10">
      {/* 全屏焦点白卡（同登录卡口径）：发丝线外框，保留 16 圆角与焦点投影 */}
      <div className="w-full max-w-[560px] rounded-gx-3xl border border-gx-hairline bg-gx-surface p-8 shadow-gx-lg">
        {content}
      </div>
    </div>
  );
}
