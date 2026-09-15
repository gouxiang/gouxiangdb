// M3/S8 登录态统一布局闸门：
//   GX_ENTERPRISE_NAV on（GET menu 200）→ 新 WorkspaceShell（base/kb 统一一壳）；
//   off（menu 404 NOT_FOUND）→ 按路径回退旧 AppShell（数据表）/ KbShell（知识库）。
// 三个壳内部都渲染 <Outlet/>，故 App.tsx 只需声明一组内容路由、路径零变化（N5/ADR-0028）。
import { useLocation } from "react-router-dom";
import { Spinner } from "../../components/ui";
import AppShell from "../shell/AppShell";
import KbShell from "../kb/KbShell";
import { WorkspaceShell } from "./WorkspaceShell";
import { useNavV2Flag } from "./featureFlags";

export function ShellGate() {
  const { enabled, isLoading } = useNavV2Flag();
  const { pathname } = useLocation();

  if (isLoading || enabled === null) {
    // 探活期间不闪旧壳：单一中性 loading，避免双壳抖动
    return (
      <div className="flex h-screen items-center justify-center bg-gx-bg">
        <Spinner size={22} />
      </div>
    );
  }

  if (enabled) return <WorkspaceShell />;
  return pathname.startsWith("/kb") ? <KbShell /> : <AppShell />;
}
