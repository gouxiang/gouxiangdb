// apps/web/src/App.tsx
// 路由骨架
//
// 页面组件由各模块实现（路径固定，勿改）：
//   features/auth/LoginPage.tsx      — 登录 / 注册
//   features/auth/ShareJoinPage.tsx  — 通过分享链接加入
//   features/shell/AppShell.tsx      — 两栏骨架（侧栏 + 顶栏 + Outlet）
//   features/views/ViewRouter.tsx    — 按 view.type 分发到具体视图
//   features/settings/SettingsPage.tsx
//   features/settings/TrashPage.tsx

import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useParams, useSearchParams } from "react-router-dom";

import { useAuthStore } from "./store/auth";
import { useBases, useTables, useViews } from "./api/hooks";
import { Spinner } from "./components/ui";
import { ErrorBoundary } from "./components/ErrorBoundary";

import LoginPage from "./features/auth/LoginPage";
import ShareJoinPage from "./features/auth/ShareJoinPage";
import AppShell from "./features/shell/AppShell";
import ViewRouter from "./features/views/ViewRouter";
import SettingsPage from "./features/settings/SettingsPage";
import TrashPage from "./features/settings/TrashPage";
import KbShell from "./features/kb/KbShell";
import KbListPage from "./features/kb/KbListPage";
import KbHomePage from "./features/kb/KbHomePage";
import DocEditorPage from "./features/kb/DocEditorPage";
import CanvasEditorPage from "./features/kb/CanvasEditorPage";
import KbTrashPage from "./features/kb/KbTrashPage";
import KbSettingsPage from "./features/kb/KbSettingsPage";
import PublicSharePage from "./features/kb/PublicSharePage";
import ErdPage from "./features/erd/ErdPage";

function Loading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner size={20} />
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const token = useAuthStore((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** / → 第一个 Base */
function RootRedirect() {
  const { data: bases, isLoading } = useBases();
  if (isLoading) return <Loading />;
  if (!bases || bases.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-gx-13 text-gx-text-tertiary">
        <div>还没有任何 Base</div>
        <div className="text-gx-12 text-gx-text-hint">请通过侧栏新建一个 Base 开始使用</div>
      </div>
    );
  }
  return <Navigate to={`/base/${bases[0]!.id}`} replace />;
}

/** /base/:baseId → 第一张表的第一个视图 */
function BaseIndexRedirect() {
  const { baseId } = useParams();
  const { data: tables, isLoading } = useTables(baseId ?? null);
  if (isLoading) return <Loading />;
  if (!tables || tables.length === 0) return <Navigate to={`/base/${baseId}/settings`} replace />;
  return <TableIndexRedirect baseId={baseId!} tableId={tables[0]!.id} />;
}

/** /base/:baseId/table/:tableId → 第一个视图（?design=1 时优先选 detail view 用于表单设计器入口） */
function TableIndexRedirect({ baseId, tableId }: { baseId?: string; tableId?: string }) {
  const p = useParams();
  const bid = baseId ?? p.baseId!;
  const tid = tableId ?? p.tableId!;
  const [searchParams] = useSearchParams();
  const { data: views, isLoading } = useViews(tid);
  if (isLoading) return <Loading />;
  if (!views || views.length === 0) return <Navigate to={`/base/${bid}/settings`} replace />;
  // design=1：优先选第一个 detail 视图，没有则选第一个 view
  const wantDesign = searchParams.get("design") === "1";
  const targetView = wantDesign
    ? views.find((v) => v.type === "detail") ?? views[0]!
    : views[0]!;
  // 保留 design query 透传到目标 URL
  const qs = wantDesign ? "?design=1" : "";
  return <Navigate to={`/base/${bid}/table/${tid}/view/${targetView.id}${qs}`} replace />;
}

export default function App() {
  const token = useAuthStore((s) => s.token);
  const location = useLocation();
  // 路由切换时重置错误边界（否则一次崩溃后切到其它页面仍显示错误态）
  const boundaryKey = location.pathname;

  return (
    <Routes>
      <Route path="/login" element={token ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route path="/join/:token" element={<ShareJoinPage />} />
      {/* 公开分享页：匿名可访问，不走登录守卫 */}
      <Route path="/s/:token" element={<PublicSharePage />} />
      <Route path="/s/:token/doc/:docId" element={<PublicSharePage />} />

      <Route
        element={
          <RequireAuth>
            <ErrorBoundary key={`base-${boundaryKey}`}>
              <AppShell />
            </ErrorBoundary>
          </RequireAuth>
        }
      >
        <Route path="/" element={<RootRedirect />} />
        <Route path="/base/:baseId" element={<BaseIndexRedirect />} />
        <Route path="/base/:baseId/settings" element={<SettingsPage />} />
        <Route path="/base/:baseId/trash" element={<TrashPage />} />
        <Route path="/base/:baseId/erd" element={<ErdPage />} />
        <Route path="/base/:baseId/table/:tableId" element={<TableIndexRedirect />} />
        <Route path="/base/:baseId/table/:tableId/view/:viewId" element={<ViewRouter />} />
      </Route>

      {/* 知识库：独立布局壳 KbShell，与数据表 AppShell 平行、零交叉 */}
      <Route
        element={
          <RequireAuth>
            <ErrorBoundary key={`kb-${boundaryKey}`}>
              <KbShell />
            </ErrorBoundary>
          </RequireAuth>
        }
      >
        <Route path="/kb" element={<KbListPage />} />
        <Route path="/kb/:kbId" element={<KbHomePage />} />
        <Route path="/kb/:kbId/doc/:docId" element={<DocEditorPage />} />
        <Route path="/kb/:kbId/canvas/:docId" element={<CanvasEditorPage />} />
        <Route path="/kb/:kbId/trash" element={<KbTrashPage />} />
        <Route path="/kb/:kbId/settings" element={<KbSettingsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
