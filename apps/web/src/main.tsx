// apps/web/src/main.tsx
// 应用入口

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import App from "./App";
import { ToastHost } from "./components/ui";
import { ConfirmHost } from "./components/feedback";
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
