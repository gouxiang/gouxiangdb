// 授权宽限/到期非阻塞顶部横幅（verdict∈{grace,expired,invalid} 且账号未被软挂起时显示）。
// grace=琥珀提醒续费；expired/invalid=警示提示联系管理员。licensed/free/grandfathered/
// bypassed/off 一律 return null（零像素、零布局影响）。
//
// 挂载位置与 OfflineBanner 同级（App 根 flex-col），出现时推动内容而非悬浮遮挡。
// 门控：仅「已认证 + 业务路径」渲染——/login、/launcher、公开分享 /s、/share、/join、
// /invite、强制改密页不挂载（未登录时 /status 会 401，也不该在登录页跳授权提示）。
import { useLocation } from "react-router-dom";
import { Icon } from "../../components/icons";
import { useActiveSession } from "../../node/activeSession";
import { CHANGE_PASSWORD_PATH } from "../auth/force-change-guard";
import { useLicenseStatus } from "./license-hooks";
import { bannerCopy, deriveGate } from "./license-selectors";
import { useLicenseGateStore } from "../../store/licenseGate";

const EXEMPT_PREFIXES = ["/s/", "/share/", "/join/", "/invite/"];

function isExemptPath(pathname: string): boolean {
  if (pathname === "/login" || pathname === "/launcher" || pathname === CHANGE_PASSWORD_PATH) return true;
  return EXEMPT_PREFIXES.some((p) => pathname.startsWith(p));
}

export function GraceBanner() {
  const { pathname } = useLocation();
  const session = useActiveSession();
  const { data: status } = useLicenseStatus();
  const suspended = useLicenseGateStore((s) => s.suspended);

  // 未登录或豁免路径：不订阅式地提前返回（query 仍可能被其他宿主触发，本组件零渲染）。
  if (!session.authenticated || isExemptPath(pathname)) return null;

  const gate = deriveGate(status, suspended);

  // 挂起页接管时不显横幅；其余无提示态也是 null。
  if (gate.suspended || !gate.banner) return null;

  const banner = gate.banner;
  const warning = banner.tone === "warning";
  const text = bannerCopy(banner, status.available ? status.adminEmail : null);

  return (
    <div
      role="status"
      data-license-banner={banner.verdict}
      className={[
        "flex shrink-0 items-center justify-center gap-1.5 px-4 py-1.5 text-gx-12",
        warning ? "bg-gx-warning-bg text-gx-warning" : "bg-gx-danger text-white",
      ].join(" ")}
    >
      <Icon name="alertCircle" size={12} className="shrink-0" />
      <span className="min-w-0 truncate">{text}</span>
    </div>
  );
}
