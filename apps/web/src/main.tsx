// apps/web/src/main.tsx
// 应用入口

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import App from "./App";
import { ToastHost } from "./components/ui";
import { ConfirmHost } from "./components/feedback";
import {
  bindQueryClientClearing,
  registerQueryClient,
} from "./node/queryClientBridge";
import { installLauncher } from "./node/installLauncher";
import "./index.css";

// 部署子路径（飞牛网关 /app/gouxiangdb/）下作为 BrowserRouter basename；
// import.meta.env.BASE_URL 由 Vite 按构建 base 注入：根部署为 "/"（行为不变），
// 子路径为 "/app/gouxiangdb/"（去尾斜杠）。react-router 的 navigate/Link/Navigate
// 会自动补该 basename，故应用内路由调用仍写 "/login"、"/base/.." 即可。
const routerBasename = import.meta.env.BASE_URL.replace(/\/+$/, "") || "/";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  },
});

// 节点模式 S2：注册主 QueryClient 并订阅数据源切换。浏览器/fnOS 下 resolver 恒 local、
// 从不 emit，本订阅零副作用；仅桌面启动器切节点时才清空缓存（node 域 queryClientBridge）。
registerQueryClient(queryClient);
bindQueryClientClearing();

// 桌面节点启动器装配（S4）：门控关闭（浏览器/fnOS/服务器构建）时 installLauncher 为 no-op，
// 不构造仓库、不注册任何东西、现网零副作用；门控开启（桌面壳）时这一步会构造/跨重启恢复
// 启动器仓库（构造即把上次活动节点的数据源 restore 进 resolver）并注册远端 401 回流，
// 保证用户从 / 直达业务壳（不经 /launcher）时远端会话与 401 处理同样就位。
installLauncher();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={routerBasename}>
        <App />
        {/* R-D-20 Toast 宿主（右下角 / 最多 3 条） + R-D-23 危险操作确认宿主（L1~L5） */}
        <ToastHost />
        <ConfirmHost />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
