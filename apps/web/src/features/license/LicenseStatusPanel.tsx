// 授权状态主面板（设置 → 授权与席位）。
//
// 立场：只渲染后端给的事实（verdictLabel 直出、席位 seats/usedSeats、licensedTo/orgName、
// expiresAt、fingerprint、online/lastHeartbeatAt）。mode=enforce/verify 才显示校验模式小标；
// 授权中心地址（baseUrl）刻意【不渲染】——设备指纹可展示给管理员报官方直绑，但不暴露中心网址，
// 避免让最终用户感觉被监控。off/available=false 整块降级为一句说明（LicenseAdvanced 自身也按
// isAdmin/available 门控）。
import { useState, type ReactNode } from "react";
import { Icon, type IconName } from "../../components/icons";
import { Spinner, toast } from "../../components/ui";
import type { LicenseStatusDTO } from "@gx/shared-types";
import { useLicenseStatus } from "./license-hooks";
import { formatExpiryDate, seatFull, seatPercent } from "./license-selectors";
import { copyText, COPY_FAIL_HINT_TEXT } from "../../lib/clipboard";

/** verdict → 状态点/图标语义（只用图标+文案，不只靠颜色，R-D-34）。 */
function verdictIcon(verdict: string): { icon: IconName; tone: string } {
  switch (verdict) {
    case "licensed":
      return { icon: "shield", tone: "text-gx-success bg-gx-success-bg" };
    case "grace":
      return { icon: "clock", tone: "text-gx-warning bg-gx-warning-bg" };
    case "expired":
    case "invalid":
      return { icon: "shieldOff", tone: "text-gx-danger bg-gx-danger-bg" };
    default:
      return { icon: "shield", tone: "text-gx-text-tertiary bg-gx-control" };
  }
}

function InfoRow({ icon, label, children, mono = false }: { icon: IconName; label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      <Icon name={icon} size={14} className="mt-0.5 shrink-0 text-gx-text-tertiary" />
      <span className="w-20 shrink-0 text-gx-12 text-gx-text-tertiary">{label}</span>
      <span className={`min-w-0 flex-1 break-all text-gx-13 text-gx-text-primary ${mono ? "font-mono text-gx-12" : ""}`}>
        {children}
      </span>
    </div>
  );
}

function SeatMeter({ status }: { status: LicenseStatusDTO }) {
  const { seats, usedSeats } = status;
  if (seats === null) {
    return (
      <div className="rounded-gx-lg border border-gx-border bg-gx-control px-3 py-2.5">
        <p className="flex items-center gap-1.5 text-gx-13 text-gx-text-secondary">
          <Icon name="users" size={14} className="shrink-0 text-gx-text-tertiary" />
          不限席位数
        </p>
        <p className="mt-1 text-gx-11 text-gx-text-hint">当前部署未开启席位限制，成员数量不受授权约束。</p>
      </div>
    );
  }
  const pct = seatPercent(seats, usedSeats);
  const full = seatFull(seats, usedSeats);
  return (
    <div className="rounded-gx-lg border border-gx-border bg-gx-control px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2 text-gx-12">
        <span className="flex items-center gap-1.5 text-gx-text-secondary">
          <Icon name="users" size={14} className="shrink-0 text-gx-text-tertiary" />
          席位使用
        </span>
        <span className={`shrink-0 tabular-nums ${full ? "font-semibold text-gx-danger" : "text-gx-text-tertiary"}`}>
          {usedSeats ?? 0} / {seats}
        </span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-gx-row-hover"
        role="progressbar"
        aria-valuenow={pct ?? 0}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="席位使用比例"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${full ? "bg-gx-danger" : "bg-gx-accent"}`}
          style={{ width: `${pct ?? 0}%` }}
        />
      </div>
      {full && <p className="mt-1.5 text-gx-11 text-gx-danger">席位已满，新增成员将被拦截，请续费扩容。</p>}
    </div>
  );
}

function ModeTag({ mode }: { mode: string }) {
  if (mode !== "enforce" && mode !== "verify") return null;
  const enforce = mode === "enforce";
  return (
    <span
      title={enforce ? "授权异常会真实拦截账号与新增成员" : "只提示不拦截（灰度观察）"}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-gx-11 ${
        mode === "enforce" ? "bg-gx-accent-bg text-gx-accent-hover" : "bg-gx-control text-gx-text-tertiary"
      }`}
    >
      <Icon name={mode === "enforce" ? "shield" : "eye"} size={11} />
      {mode === "enforce" ? "强制模式" : "观察模式"}
    </span>
  );
}

/** 在线 / 离网状态点（不只靠颜色：带文字）。从未成功同步过显「未同步」。 */
function OnlinePill({ status }: { status: LicenseStatusDTO }) {
  const never = status.lastHeartbeatAt == null;
  const tone = status.online ? "text-gx-success" : never ? "text-gx-text-tertiary" : "text-gx-warning";
  const label = status.online ? "已连接授权中心" : never ? "尚未同步" : "离网，稍后自动重试";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full bg-gx-control px-2 py-0.5 text-gx-11 ${tone}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${status.online ? "bg-gx-success" : never ? "bg-gx-text-tertiary" : "bg-gx-warning"}`} />
      {label}
    </span>
  );
}

function formatDateTime(ms: number | null): string | null {
  if (ms == null) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 设备指纹行：管理员见完整指纹 + 复制（报官方后台直绑）；普通成员只见前 12 位。 */
function FingerprintRow({ status }: { status: LicenseStatusDTO }) {
  const [busy, setBusy] = useState(false);
  const full = status.isAdmin && status.fingerprint ? status.fingerprint : status.fingerprintShort;
  if (!full) return null;

  const copy = async () => {
    if (busy || !status.fingerprint) return;
    setBusy(true);
    try {
      const ok = await copyText(status.fingerprint);
      toast(ok ? "完整设备指纹已复制" : COPY_FAIL_HINT_TEXT, ok ? "success" : "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <InfoRow icon="keyRound" label="设备指纹" mono>
      <span className="flex items-center gap-1.5">
        <span className="min-w-0 break-all">{full}</span>
        {status.isAdmin && status.fingerprint && (
          <button
            type="button"
            onClick={() => void copy()}
            title="复制完整设备指纹（发给官方用于开通/换绑）"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-gx-lg text-gx-text-tertiary transition-colors hover:bg-gx-row-hover hover:text-gx-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gx-accent/50"
          >
            <Icon name="copy" size={13} />
          </button>
        )}
      </span>
    </InfoRow>
  );
}

export function LicenseStatusPanel() {
  const { data: status, isLoading, isError, refetch, isFetching } = useLicenseStatus();

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-gx-lg border border-gx-border bg-gx-surface px-4 py-6 text-gx-13 text-gx-text-tertiary">
        <Spinner size={16} />
        正在读取授权状态…
      </div>
    );
  }

  // off / 未 boot / 状态口暂时不可用：降级说明，不渲染席位与管理事实。
  if (isError || !status.available) {
    return (
      <div className="flex flex-col gap-2 rounded-gx-lg border border-gx-border bg-gx-control px-4 py-5">
        <p className="flex items-center gap-2 text-gx-13 text-gx-text-secondary">
          <Icon name="shieldOff" size={16} className="shrink-0 text-gx-text-tertiary" />
          当前部署未启用商业授权，产品按默认档位运行。
        </p>
        <p className="text-gx-12 text-gx-text-tertiary">
          如需商业授权、席位扩容或向官方反馈问题，请联系部署管理员开启授权服务；下方仍可使用官方反馈通道（服务开启后）。
        </p>
      </div>
    );
  }

  const vi = verdictIcon(status.verdict);
  const expiry = formatExpiryDate(status.expiresAt);
  const org = status.licensedTo ?? status.orgName;
  const lastSync = formatDateTime(status.lastHeartbeatAt);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-gx-lg border border-gx-border bg-gx-surface px-4 py-3">
        <div className="flex items-center gap-3">
          <span className={`flex h-10 w-10 items-center justify-center rounded-full ${vi.tone}`}>
            <Icon name={vi.icon} size={20} />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-gx-15 font-semibold text-gx-text-primary">{status.verdictLabel}</span>
              <ModeTag mode={status.mode} />
              <OnlinePill status={status} />
            </div>
            <p className="mt-0.5 text-gx-12 text-gx-text-tertiary">
              {org ? `授权对象：${org}` : "暂无授权单据信息"}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void refetch()}
          title="重新从服务器读取授权状态"
          className="inline-flex h-7 items-center gap-1 rounded-gx-lg px-2 text-gx-12 text-gx-text-tertiary transition-colors hover:bg-gx-row-hover hover:text-gx-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gx-accent/50"
        >
          <Icon name="refresh" size={13} className={isFetching ? "animate-spin" : ""} />
          刷新
        </button>
      </div>

      <SeatMeter status={status} />

      <div className="rounded-gx-lg border border-gx-border bg-gx-surface px-3">
        {org && <InfoRow icon="building" label="授权对象">{org}</InfoRow>}
        {expiry && <InfoRow icon="clock" label="到期日期">{expiry}</InfoRow>}
        {lastSync && <InfoRow icon="sync" label="最近同步">{lastSync}</InfoRow>}
        {status.version !== null && (
          <InfoRow icon="history" label="单据版本">
            <span className="tabular-nums">{status.version}</span>
          </InfoRow>
        )}
        <FingerprintRow status={status} />
      </div>
    </div>
  );
}
