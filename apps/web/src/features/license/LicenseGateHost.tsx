// 授权闸门全局宿主：挂在 App.tsx 的登录后受保护布局路由内（ShellGate 同层），
// 故只覆盖登录后业务页，不遮挡 /login、/launcher、/s、/share、/join、/invite。
//   - SuspendedPage：fixed inset-0 全屏接管（挂起态）；
//   - SeatLimitDialog：满员一次性对话框。
// 宽限横幅（GraceBanner）在各业务壳内容流内渲染（推动内容而非悬浮遮挡）。
import { SuspendedPage } from "./SuspendedPage";
import { SeatLimitDialog } from "./SeatLimitDialog";

export function LicenseGateHost() {
  return (
    <>
      <SuspendedPage />
      <SeatLimitDialog />
    </>
  );
}
