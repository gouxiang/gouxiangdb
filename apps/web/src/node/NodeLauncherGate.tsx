// apps/web/src/node/NodeLauncherGate.tsx
// 启动器界面的路由门（DESIGN-MACOS-APP.md §8.5；主设计 §15.1 NodeModeGate）。
//
// 挂载在 RequireAuth **之外**的独立路由 /launcher：桌面纯远端用户在本地 gx-auth 无 token、
// 任何节点连接之前就要能看到启动器，故不能要求本地登录态。
//
// 行为：
//   - 门控关闭（浏览器/fnOS/服务器构建，未注入 VITE_NODE_LAUNCHER=1）→ 一律重定向回 "/"，
//     最终落到现有的登录/首页分流，**对现网零行为变化**；
//   - 门控开启（桌面壳）→ 装配运行时（注册远端 401 处理器，见 installLauncher）并渲染面板；
//     选路成功后按「进入当拍」的活动数据源实时分流（见下），进入业务壳或该节点自己的登录页。
//
// 组件静态打进与桌面共享的同一份 dist（壳托管的就是 apps/web/dist），故不能构建期 tree-shake，
// 只能运行时门控；门控关时除一条 Navigate 外不产生任何副作用。

import { useEffect } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { launcherEnabled } from "./desktopGate";
import { installLauncher } from "./installLauncher";
import { LauncherPanel } from "./LauncherPanel";
import type { LauncherStore } from "./launcherStore";
import { dataSourceResolver } from "./datasource";

export interface NodeLauncherGateProps {
  /** 测试注入门控；缺省读构建标志。 */
  enabled?: boolean;
  /** 测试/桌面壳覆盖仓库；缺省走浏览器单例。 */
  store?: LauncherStore;
}

/**
 * 选路成功当拍的进入目标。必须**实时**读 resolver 而不是用组件渲染期的 useActiveSession 快照：
 * onEnterWorkspace 在 connectLocal/connectRemote 的 await resolve 之后同步触发，此刻 Gate 尚未
 * 因 resolver emit 重渲染，hook 值仍是点击前的活动源（会把「带记住会话直接进入」误判成未登录）。
 * 口径与 useActiveSession.authenticated 完全一致：活动数据源带 token → 直接进业务壳 "/"；
 * token=null（本机首 boot 未登录，或远端 remote-empty）→ 该节点自己的登录页 "/login"。
 * 不能统一跳 "/" 交 RequireAuth：本地未登录会被它弹回 /launcher，形成死循环。
 */
export function enterTargetNow(): "/" | "/login" {
  return dataSourceResolver.current().token ? "/" : "/login";
}

export function NodeLauncherGate({ enabled, store }: NodeLauncherGateProps) {
  const navigate = useNavigate();
  const isEnabled = enabled ?? launcherEnabled();

  // 只在门控开启时装配；卸载时注销 401 处理器。hooks 无条件调用以遵守规则。
  useEffect(() => {
    if (!isEnabled) return;
    const install = installLauncher({ enabled: true, ...(store ? { store } : {}) });
    return install.cleanup;
  }, [isEnabled, store]);

  if (!isEnabled) {
    return <Navigate to="/" replace />;
  }

  return (
    <LauncherPanel
      store={store}
      onEnterWorkspace={() => navigate(enterTargetNow(), { replace: true })}
    />
  );
}
