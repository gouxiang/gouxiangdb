// 授权闸门全局收口（beta.2 授权接入）：apiFetch 在 !res.ok 分支 throw 前旁路通知本 store，
// 由全局宿主（LicenseGateHost）按状态渲染挂起页 / 满员弹窗。
//
// 铁律：
//   1. 【绝不 import ../api/client】——client.ts 顶部 import 本模块的 notifyLicenseError，
//      反向依赖会形成循环。本文件只认「后端错误体形状」，不认 ApiError 类型。
//   2. 运行时态【不持久化】：挂起/满员都是请求期事实，刷新后由状态轮询（/license/status）
//      与后续请求重新建立；本地缓存旧挂起事实会在续费后错误挡住用户。
//   3. fail-safe：只认两个明确机器码（LICENSE_SEAT_SUSPENDED / LICENSE_SEAT_LIMIT），
//      其余错误体一律忽略，绝不因为解析到未知字段就挡住用户。
import { create } from "zustand";
import {
  LICENSE_SEAT_LIMIT_CODE,
  LICENSE_SEAT_SUSPENDED_CODE,
} from "@gx/shared-types";

/** 挂起态（闸门②）：verdict 只可能 expired/invalid（后端 LicenseSuspendedErrorBody 约束）。 */
export interface LicenseSuspendedState {
  verdict: "expired" | "invalid";
  /** 管理员自报联系邮箱；未自报为 null（前端回落通用文案）。 */
  contactEmail: string | null;
  /** 后端中文错误文案（LICENSE_COPY.suspended），作为兜底展示用词。 */
  message: string | null;
}

interface LicenseGateState {
  /** 非 null = 当前账号被软挂起，全局宿主渲染全屏挂起页。 */
  suspended: LicenseSuspendedState | null;
  /** 非 null = 刚触发「满员拦截」，全局宿主弹一次满员对话框（存后端文案）。 */
  seatLimit: string | null;
  /** 闸门①标记当前满员裁决档位（供弹窗细分文案/入口，可选）。 */
  seatLimitCode: string | null;
  setSuspended: (s: LicenseSuspendedState) => void;
  clearSuspended: () => void;
  setSeatLimit: (message: string, code?: string | null) => void;
  clearSeatLimit: () => void;
}

export const useLicenseGateStore = create<LicenseGateState>()((set) => ({
  suspended: null,
  seatLimit: null,
  seatLimitCode: null,
  setSuspended: (s) => set({ suspended: s }),
  clearSuspended: () => set({ suspended: null }),
  setSeatLimit: (message, code = null) => set({ seatLimit: message, seatLimitCode: code }),
  clearSeatLimit: () => set({ seatLimit: null, seatLimitCode: null }),
}));

/** 宽松读取错误体（client.ts 传入的是已 parse 的 body；容错 null/非对象）。 */
function asErrorBody(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

/**
 * apiFetch 集中错误收口旁路：在 throw ApiError 之前调用，按 body.code 分流。
 *
 *   LICENSE_SEAT_SUSPENDED → 置挂起态（全屏挂起页）
 *   LICENSE_SEAT_LIMIT     → 置满员态（一次性对话框）
 *   其它                   → 忽略（包括 401/404/普通 403），不影响既有错误流程
 *
 * 幂等：重复收到同一挂起体只覆盖不叠加；满员弹窗以最新文案为准。
 * 纯同步、不抛异常——任何解析意外都不得影响调用方原本的 throw 行为。
 */
export function notifyLicenseError(body: unknown): void {
  try {
    const o = asErrorBody(body);
    const code = typeof o.code === "string" ? o.code : "";
    if (code === LICENSE_SEAT_SUSPENDED_CODE) {
      const verdict = o.verdict === "invalid" ? "invalid" : "expired";
      const contactEmail = typeof o.contactEmail === "string" && o.contactEmail.trim() !== "" ? o.contactEmail : null;
      const message = typeof o.error === "string" ? o.error : null;
      useLicenseGateStore.getState().setSuspended({ verdict, contactEmail, message });
      return;
    }
    if (code === LICENSE_SEAT_LIMIT_CODE) {
      const message = typeof o.error === "string" && o.error.trim() !== "" ? o.error : "当前授权席位数已用尽，如需新增成员请联系管理员续费扩容。";
      useLicenseGateStore.getState().setSeatLimit(message, code);
    }
  } catch {
    // 收口旁路永不得干扰主错误流（throw ApiError 照常发生）。
  }
}

// 测试辅助：重置全部闸门态（仅单测用）。
export function __resetLicenseGateForTests(): void {
  useLicenseGateStore.setState({ suspended: null, seatLimit: null, seatLimitCode: null });
}
