// 账号软挂起全屏页（闸门② LICENSE_SEAT_SUSPENDED）。
//
// 触发：任意业务 /api 请求 403 LICENSE_SEAT_SUSPENDED → licenseGate store.suspended。
// 文案：数据与账号均保留，管理员续费后自动恢复；后端 verdict（expired/invalid）决定标题语气，
//   中文状态词直出后端 verdictLabel；contactEmail 有值时给「联系管理员 xxx」，否则通用文案。
// 出口：「刷新状态」手动 refetch /status——续费后裁决离开 expired/invalid，useLicenseStatus
//   自动 clearSuspended；「我知道了」仅本次清掉覆盖层（下一次业务 403 会再次唤起，不丢事实）。
import { Button } from "../../components/ui";
import { Icon } from "../../components/icons";
import { useLicenseStatus } from "./license-hooks";
import { suspendedCopy } from "./license-selectors";
import { useLicenseGateStore } from "../../store/licenseGate";

export function SuspendedPage() {
  const { data: status, refetch, isFetching } = useLicenseStatus();
  const suspended = useLicenseGateStore((s) => s.suspended);
  const clearSuspended = useLicenseGateStore((s) => s.clearSuspended);
  if (!suspended) return null;

  const verdictLabel = status.available ? status.verdictLabel : suspended.verdict === "invalid" ? "授权已停用" : "商业版已到期";
  const body = suspendedCopy(suspended.verdict, suspended.message);
  const contact = status.available ? status.adminEmail : suspended.contactEmail;

  // 续费后裁决离开 expired/invalid 时 useLicenseStatus 的 effect 会自动 clear；
  // 若裁决仍是 expired/invalid 但挂起名单可能已变（如管理员释放了席位），乐观撤掉覆盖层，
  // 让下一个业务请求重新判定——仍在名单内则后端再 403 弹回，事实源永远在后端。
  const refresh = async () => {
    const res = await refetch();
    const v = res.data?.verdict;
    if (v === undefined || v === "expired" || v === "invalid") clearSuspended();
  };

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="license-suspended-title"
      className="gx-z-modal fixed inset-0 flex items-center justify-center bg-gx-bg px-6"
    >
      <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-gx-2xl border border-gx-hairline bg-gx-surface px-8 py-9 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-gx-warning-bg text-gx-warning">
          <Icon name="shieldOff" size={24} />
        </span>
        <h1 id="license-suspended-title" className="text-gx-18 font-semibold text-gx-text-primary">
          {verdictLabel}·账号暂被挂起
        </h1>
        <p className="text-gx-13 leading-6 text-gx-text-secondary">{body}</p>
        <p className="text-gx-12 leading-5 text-gx-text-tertiary">
          你的数据与账号都会保留，无需重新注册；管理员完成续费或恢复授权后，点击下方「刷新状态」即可继续使用。
        </p>
        {contact && (
          <p className="flex items-center gap-1.5 rounded-gx-lg bg-gx-control px-3 py-1.5 text-gx-12 text-gx-text-secondary">
            <Icon name="mail" size={13} className="shrink-0 text-gx-text-tertiary" />
            联系管理员：
            <a className="text-gx-accent hover:underline" href={`mailto:${contact}`}>
              {contact}
            </a>
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <Button variant="primary" icon="refresh" loading={isFetching} onClick={() => void refresh()}>
            刷新状态
          </Button>
          <Button variant="secondary" onClick={clearSuspended}>
            我知道了
          </Button>
        </div>
      </div>
    </div>
  );
}
