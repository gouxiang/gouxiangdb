// apps/web/src/App.tsx
// 路由骨架
//
// 页面组件由各模块实现（路径固定，勿改）：
//   features/auth/LoginPage.tsx      — 登录 / 注册
//   features/auth/ForceChangePassword.tsx — 首次登录强制改密（mustChangePassword）
//   features/auth/ShareJoinPage.tsx  — 通过分享链接加入
//   features/shell/AppShell.tsx      — 两栏骨架（侧栏 + 顶栏 + Outlet）
//   features/views/ViewRouter.tsx    — 按 view.type 分发到具体视图
//   features/settings/SettingsPage.tsx
//   features/settings/TrashPage.tsx

import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useParams, useSearchParams } from "react-router-dom";

import { useAuthStore } from "./store/auth";
import { CHANGE_PASSWORD_PATH, shouldForceChangePassword } from "./features/auth/force-change-guard";
import { useBases, useTables, useViews, useCanCreateLibrary } from "./api/hooks";
import { Spinner } from "./components/ui";
import { OfflineBanner } from "./components/states";
import { ErrorBoundary } from "./components/ErrorBoundary";

import LoginPage from "./features/auth/LoginPage";
import ForceChangePassword from "./features/auth/ForceChangePassword";
import ShareJoinPage from "./features/auth/ShareJoinPage";
import ViewRouter from "./features/views/ViewRouter";
import SettingsPage from "./features/settings/SettingsPage";
import TrashPage from "./features/settings/TrashPage";
import KbListPage from "./features/kb/KbListPage";
import KbHomePage from "./features/kb/KbHomePage";
import DocEditorPage from "./features/kb/DocEditorPage";
import CanvasEditorPage from "./features/kb/CanvasEditorPage";
import KbTrashPage from "./features/kb/KbTrashPage";
import KbSettingsPage from "./features/kb/KbSettingsPage";
import PublicSharePage from "./features/kb/PublicSharePage";
import ErdPage from "./features/erd/ErdPage";
import ContactsPage from "./features/contacts/ContactsPage";
import InviteAcceptPage from "./features/contacts/InviteAcceptPage";
import HelpCenterPage from "./features/help/HelpCenterPage";
import { ShellGate } from "./features/workspace/ShellGate";
import { BrandingTitle } from "./features/branding/BrandingTitle";
import { WorkspaceSettingsPage } from "./features/workspace/WorkspaceSettingsPage";
import PermPanel from "./features/authz/PermPanel";

function Loading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner size={20} />
    </div>
  );
}

/**
 * 强制改密守卫：已登录且 user.mustChangePassword=true 时，除改密页外一律重定向过去
 * （判定与路径常量见 features/auth/force-change-guard.ts）。
 */
function RequirePasswordChanged({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const { pathname } = useLocation();
  if (shouldForceChangePassword(user, pathname)) {
    return <Navigate to={CHANGE_PASSWORD_PATH} replace />;
  }
  return <>{children}</>;
}

function RequireAuth({ children }: { children: ReactNode }) {
  const token = useAuthStore((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** / → 第一个 Base */
function RootRedirect() {
  const { data: bases, isLoading } = useBases();
  // 建库权限门：无 create_library 时不指引用户去点一个他看不到的「新建库」入口。
  const canCreate = useCanCreateLibrary();
  if (isLoading) return <Loading />;
  if (!bases || bases.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-gx-13 text-gx-text-tertiary">
        <div>还没有任何库</div>
        {/* 有权限时指向真实入口（一级导航「新建库」）；无权限时提示找管理员，不误导。 */}
        <div className="text-gx-12 text-gx-text-hint">
          {canCreate
            ? "点击左侧导航栏底部的「新建库」开始使用"
            : "还没有可用的库，请联系管理员为你开通"}
        </div>
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
    <>
      {/* R-D-19 离线横幅：在线时渲染 null（零布局影响）；恢复后自动消失 */}
      <OfflineBanner />
      {/* 浏览器标题跟随后台品牌产品名（所有路由共享，含登录页/公开分享页） */}
      <BrandingTitle />
      <Routes>
      <Route path="/login" element={token ? <Navigate to="/" replace /> : <LoginPage />} />
      {/* 首次登录强制改密：需要登录态，但不套业务壳（壳内接口会被闸门 403 挡住） */}
      <Route
        path={CHANGE_PASSWORD_PATH}
        element={
          <RequireAuth>
            <ForceChangePassword />
          </RequireAuth>
        }
      />
      <Route path="/join/:token" element={<ShareJoinPage />} />
      {/*
        后端 bases.ts 的 GET/POST /:baseId/share 把展示用 url 拼成 `/share/<token>`
        （apps/api/src/routes/bases.ts:445），而本路由表历史上只注册了 `/join/:token`，
        两者同指「通过分享链接加入 Base」这一种业务 —— 用户复制库分享链接给他人打开时会
        命中兜底路由无法加入。此处补上等价路由消歧义（ShareJoinPage 只依赖 :token 参数）。
      */}
      <Route path="/share/:token" element={<ShareJoinPage />} />
      {/* 公开分享页：匿名可访问，不走登录守卫 */}
      <Route path="/s/:token" element={<PublicSharePage />} />
      <Route path="/s/:token/doc/:docId" element={<PublicSharePage />} />

      {/* 公开邀请接受页：登录前凭一次性激活码设置密码并激活账号（M2 组织通讯录） */}
      <Route path="/invite/:token" element={<InviteAcceptPage />} />

      {/*
        登录态统一布局闸门（M3/S8）：GX_ENTERPRISE_NAV on → WorkspaceShell（base/kb
        统一一壳）；off（menu 404）→ ShellGate 内部按路径回退旧 AppShell/KbShell。
        内容路由只有一组、路径全部不变（N5/ADR-0028），旧两壳文件保留供回退。
      */}
      <Route
        element={
          <RequireAuth>
            <RequirePasswordChanged>
              <ErrorBoundary key={`shell-${boundaryKey}`}>
                <ShellGate />
              </ErrorBoundary>
            </RequirePasswordChanged>
          </RequireAuth>
        }
      >
        <Route path="/" element={<RootRedirect />} />

        {/* 数据表资产（旧 AppShell 内容） */}
        <Route path="/base/:baseId" element={<BaseIndexRedirect />} />
        <Route path="/base/:baseId/settings" element={<SettingsPage />} />
        <Route path="/base/:baseId/trash" element={<TrashPage />} />
        <Route path="/base/:baseId/erd" element={<ErdPage />} />
        <Route path="/base/:baseId/table/:tableId" element={<TableIndexRedirect />} />
        <Route path="/base/:baseId/table/:tableId/view/:viewId" element={<ViewRouter />} />

        {/* 知识库资产（旧 KbShell 内容） */}
        <Route path="/kb" element={<KbListPage />} />
        <Route path="/kb/:kbId" element={<KbHomePage />} />
        <Route path="/kb/:kbId/doc/:docId" element={<DocEditorPage />} />
        <Route path="/kb/:kbId/canvas/:docId" element={<CanvasEditorPage />} />
        <Route path="/kb/:kbId/trash" element={<KbTrashPage />} />
        <Route path="/kb/:kbId/settings" element={<KbSettingsPage />} />

        {/* 工作区级页面：M2 通讯录 + M4 权限管理 + M3 设置中心（新壳左下设置区入口） */}
        <Route path="/workspace/contacts" element={<ContactsPage />} />
        <Route path="/workspace/authz" element={<PermPanel />} />
        <Route path="/workspace/settings/*" element={<WorkspaceSettingsPage />} />
        {/* 帮助中心：与其它设置页同层（登录后可看），入口在新壳底部固定区/旧壳侧栏底部 */}
        <Route path="/help" element={<HelpCenterPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  );
}
