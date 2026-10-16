// apps/web/src/node/LauncherPanel.tsx
// 启动器主面板（DESIGN-MACOS-APP.md §8.5）：节点列表 + 添加节点 + 凭据重连，全部门控内。
//
// 组合已单测的零件：useLauncher（订阅仓库/VM）、NodeList、AddRemoteNodeForm、ConnectNodeForm。
// 本地动作（connectLocal/disconnect）直接调 store；未登录远端点「连接」时就地展开凭据表单，
// 已登录（有会话）则免密直连。面板不含桌面门控本身（由 S4-4 路由/挂载层在桌面标志开启时渲染），
// 浏览器/fnOS 永远不会加载到这里。
//
// 注意：本地内核的真正「起进程」由 D2 的 Tauri command 承担（本仓库暂无壳）；当前 connectLocal
// 只切换数据源与期望态。组件不为尚不存在的能力放假按钮。

import { useState } from "react";
import { Button } from "../components/ui";
import { useLauncher } from "./useLauncher";
import type { LauncherStore } from "./launcherStore";
import { NodeList } from "./NodeList";
import { AddRemoteNodeForm } from "./AddRemoteNodeForm";
import { ConnectNodeForm } from "./ConnectNodeForm";
import type { NodeRow } from "./launcherViewModel";

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

export function LauncherPanel({ store, onEnterWorkspace }: LauncherPanelProps) {
  const { vm, store: resolved } = useLauncher(store);
  const [view, setView] = useState<View>({ mode: "list" });
  const [busyNodeId, setBusyNodeId] = useState<string | null>(null);

  // 有活动节点时面板其实不应停留在连接界面（挂载层会把界面交给业务壳）；
  // 仍安全处理：通知挂载层进入工作区。
  function handleActive(nodeId: string) {
    onEnterWorkspace?.(nodeId);
  }

  async function connectLocal() {
    setBusyNodeId("local");
    try {
      const out = resolved.connectLocal();
      if (out.active) handleActive(out.active.nodeId);
    } finally {
      setBusyNodeId(null);
    }
  }

  async function quickConnectRemote(row: NodeRow) {
    // 有已存会话 → 免密直连；无会话 → 展开凭据表单。
    if (!row.connected) {
      setView({ mode: "connect", nodeId: row.nodeId, title: row.title, baseURL: row.baseURL });
      return;
    }
    setBusyNodeId(row.nodeId);
    try {
      const out = await resolved.connectRemote(row.nodeId);
      if (out.active) handleActive(out.active.nodeId);
    } finally {
      setBusyNodeId(null);
    }
  }

  function disconnect(nodeId: string) {
    const out = resolved.disconnect(nodeId);
    if (!out.active) setView({ mode: "list" });
  }

  function removeRemote(nodeId: string) {
    resolved.removeRemote(nodeId);
    if (view.mode === "connect" && view.nodeId === nodeId) setView({ mode: "list" });
  }

  // 全新安装空注册表：直接落到「添加节点」首屏（戴总硬规则 #1）。
  const initialAdd = vm.isEmpty && view.mode === "list";

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[420px] flex-col gap-4 px-5 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-gx-20 font-semibold text-gx-text-primary">构想工作台</h1>
        <p className="text-gx-13 text-gx-text-tertiary">
          选择一个节点开始，或添加网络上的另一台电脑
        </p>
      </header>

      {view.mode === "add" || initialAdd ? (
        <section className="rounded-gx-2xl border border-gx-border bg-gx-surface p-4">
          <div className="mb-3 text-gx-14 font-medium text-gx-text-primary">添加网络节点</div>
          <AddRemoteNodeForm
            store={resolved}
            onConnected={(nodeId) => {
              setView({ mode: "list" });
              handleActive(nodeId);
            }}
            onCancel={vm.isEmpty ? undefined : () => setView({ mode: "list" })}
          />
        </section>
      ) : view.mode === "connect" ? (
        <section className="rounded-gx-2xl border border-gx-border bg-gx-surface p-4">
          <ConnectNodeForm
            nodeId={view.nodeId}
            title={view.title}
            baseURL={view.baseURL}
            port={resolved.controller}
            onConnected={(nodeId) => {
              setView({ mode: "list" });
              handleActive(nodeId);
            }}
            onCancel={() => setView({ mode: "list" })}
          />
        </section>
      ) : (
        <>
          <NodeList
            rows={vm.rows}
            busyNodeId={busyNodeId}
            onConnectLocal={() => void connectLocal()}
            onConnectRemote={(nodeId) => {
              const row = vm.rows.find((r) => r.nodeId === nodeId);
              if (row) void quickConnectRemote(row);
            }}
            onDisconnect={disconnect}
            onRemove={removeRemote}
          />
          <div>
            <Button variant="secondary" icon="plus" onClick={() => setView({ mode: "add" })}>
              添加网络节点
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
