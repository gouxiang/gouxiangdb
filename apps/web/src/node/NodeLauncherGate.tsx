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
//     成功连接某节点后 navigate("/")，进入业务壳（远端会话槽守卫在 S4-5 处理）。
//
// 组件静态打进与桌面共享的同一份 dist（壳托管的就是 apps/web/dist），故不能构建期 tree-shake，
// 只能运行时门控；门控关时除一条 Navigate 外不产生任何副作用。

import { useEffect } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { launcherEnabled } from "./desktopGate";
import { installLauncher } from "./installLauncher";
import { LauncherPanel } from "./LauncherPanel";
import type { LauncherStore } from "./launcherStore";

export interface NodeLauncherGateProps {
  /** 测试注入门控；缺省读构建标志。 */
  enabled?: boolean;
  /** 测试/桌面壳覆盖仓库；缺省走浏览器单例。 */
  store?: LauncherStore;
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
      onEnterWorkspace={() => navigate("/", { replace: true })}
    />
  );
}
