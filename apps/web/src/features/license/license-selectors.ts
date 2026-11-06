// 授权 UI 纯函数层：从 LicenseStatusDTO 派生「横幅 / 挂起页」可见性与语气。
// 不依赖 React/DOM，node 环境穷举七态 verdict × available，供 license-selectors.test.ts。
import type { LicenseStatusDTO, LicenseVerdict } from "@gx/shared-types";

/** 需要在顶部非阻塞提醒的 verdict：grace（琥珀）、expired/invalid（警示）。 */
export const BANNER_VERDICTS: ReadonlySet<LicenseVerdict> = new Set([
  "grace",
  "expired",
  "invalid",
]);

export type BannerTone = "warning" | "danger";

export interface LicenseBannerView {
  tone: BannerTone;
  verdict: LicenseVerdict;
  /** 后端中文短标签（直出，不做前端映射）。 */
  verdictLabel: string;
}

/**
 * 派生全局闸门视图。
 *
 * 输入：
 *   view       最近一次 GET /status（null=尚未拿到/请求失败）
 *   suspended  闸门②由业务请求 403 旁路写入的挂起事实（store）
 *
 * 规则（自上而下）：
 *   1. off / available=false / view 缺失：不挂起、不显横幅（默认零行为）。
 *   2. suspended 非 null：全屏挂起页（此时不显横幅，避免双层提示）。
 *   3. verdict∈{grace,expired,invalid}：非阻塞横幅；expired/invalid 且当前账号恰好在
 *      软挂起名单时，下一个业务请求即会 403 把 suspended 填上、升级为挂起页。
 *   4. licensed/free/grandfathered/bypassed：无任何提示。
 */
export interface GateView {
  suspended: boolean;
  banner: LicenseBannerView | null;
}

export function deriveGate(
  view: Pick<LicenseStatusDTO, "available" | "verdict" | "verdictLabel"> | null,
  suspended: { verdict: string } | null,
): GateView {
  if (suspended) {
    return { suspended: true, banner: null };
  }
  if (!view || !view.available) {
    return { suspended: false, banner: null };
  }
  if (BANNER_VERDICTS.has(view.verdict)) {
    const tone: BannerTone = view.verdict === "grace" ? "warning" : "danger";
    return {
      suspended: false,
      banner: { tone, verdict: view.verdict, verdictLabel: view.verdictLabel },
    };
  }
  return { suspended: false, banner: null };
}

/** 横幅中文正文（verdict 唯一用词来自后端 verdictLabel，前端只组织句式）。 */
export function bannerCopy(banner: LicenseBannerView, contactEmail: string | null): string {
  if (banner.verdict === "grace") {
    return "商业授权已进入宽限期，请管理员尽快续费；宽限期结束后未续费账号将被暂停使用。";
  }
  return contactEmail
    ? `商业授权已到期（${banner.verdictLabel}），请联系管理员 ${contactEmail} 续费。`
    : `商业授权已到期（${banner.verdictLabel}），请联系管理员续费。`;
}

/** 挂起页正文：数据/账号保留 + 续费自动恢复。 */
export function suspendedCopy(verdict: "expired" | "invalid", message: string | null): string {
  if (message && message.trim() !== "") return message;
  return verdict === "invalid"
    ? "授权已停用，当前账号暂被挂起。你的数据与账号均保留，管理员恢复授权后将自动恢复访问。"
    : "商业许可已到期，当前账号暂被挂起。你的数据与账号均保留，管理员续费后将自动恢复访问。";
}

/** 席位占用百分比（0-100）；seats=null（不限席位）返回 null。 */
export function seatPercent(seats: number | null, usedSeats: number | null): number | null {
  if (seats === null || seats <= 0) return null;
  const used = Math.max(0, usedSeats ?? 0);
  return Math.min(100, Math.round((used / seats) * 100));
}

/** 席位是否已满（用于进度条警示色；seats=null 恒不满）。 */
export function seatFull(seats: number | null, usedSeats: number | null): boolean {
  if (seats === null) return false;
  return (usedSeats ?? 0) >= seats;
}

/** epoch 秒 → 本地日期串（YYYY-M-D）；null/非法返回 null（调用方不渲染该行）。 */
export function formatExpiryDate(epochSec: number | null): string | null {
  if (epochSec === null || !Number.isFinite(epochSec) || epochSec <= 0) return null;
  const d = new Date(epochSec * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
