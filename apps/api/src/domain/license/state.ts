/**
 * verdict 状态机（移植自授权中心 simulator/state.ts，与 05-TEST-VECTORS.json 锁定同一批输入输出）。
 * 两道闸门只调 currentEntitlement()。本文件与服务端不共享代码。
 */
import type { Entitlement } from "./verify.js";

export const FREE_SEATS = 5;
export const GRACE_SECONDS = 30 * 24 * 3600;

export type Mode = "off" | "verify" | "enforce";
export type Verdict =
  | "bypassed"
  | "free"
  | "grandfathered"
  | "licensed"
  | "grace"
  | "expired"
  | "invalid";

export interface EntitlementView {
  mode: Mode;
  verdict: Verdict;
  seats: number; // 免费/失效回落 5；off 为 Infinity
  licensedTo?: string;
  expiresAt?: number;
  version?: number;
  everCommercial: boolean;
}

export interface StateInputs {
  mode: Mode;
  entitlement: Entitlement | null; // 当前缓存的有效单据（验签+指纹+版本均已通过）
  now: number;
  everCommercial: boolean; // 三处冗余事实（KV + 隐藏文件 + 加密缓存，见 store.ts）
  grandfathered: boolean; // 升级前已 >5 人的老团队一次性快照
}

export function currentEntitlement(i: StateInputs): EntitlementView {
  if (i.mode === "off") {
    return { mode: i.mode, verdict: "bypassed", seats: Infinity, everCommercial: false };
  }

  if (!i.entitlement) {
    // 无有效单据：曾经商业（到期删单据也要挂）→ expired；祖父老团 → grandfathered；否则 free
    if (i.everCommercial) {
      return { mode: i.mode, verdict: "expired", seats: FREE_SEATS, everCommercial: true };
    }
    return {
      mode: i.mode,
      verdict: i.grandfathered ? "grandfathered" : "free",
      seats: FREE_SEATS,
      everCommercial: false,
    };
  }

  if (i.entitlement.revoked) {
    return {
      mode: i.mode,
      verdict: "invalid",
      seats: FREE_SEATS,
      licensedTo: i.entitlement.licensedTo,
      version: i.entitlement.version,
      everCommercial: true,
    };
  }

  const base = {
    licensedTo: i.entitlement.licensedTo,
    expiresAt: i.entitlement.expiresAt,
    version: i.entitlement.version,
    everCommercial: true,
  } as const;

  if (i.now <= i.entitlement.expiresAt) {
    return { mode: i.mode, verdict: "licensed", seats: i.entitlement.seats, ...base };
  }
  if (i.now <= i.entitlement.expiresAt + GRACE_SECONDS) {
    return { mode: i.mode, verdict: "grace", seats: i.entitlement.seats, ...base };
  }
  // 宽限满：回落 5 人，执行软挂起（名单算法见 suspendList）
  return { mode: i.mode, verdict: "expired", seats: FREE_SEATS, ...base };
}

/** 占席账号（客户端侧输入）。 */
export interface SeatUser {
  id: string;
  createdAt: number;
  role: "owner" | "admin" | "member";
}

/**
 * 软挂起名单（每请求现算、不落库、不改 status）：
 * 1. 占席 = ACTIVE+INVITED（DISABLED 已排除在输入外）
 * 2. createdAt 升序、并列 id 升序
 * 3. 保留前 seats 名，其余挂起
 * 4. owner/admin 保底：前 seats 名内若无管理员，取全表第一个管理员顶替 keep 内排序最末的 member
 * 返回 { keep:Set, suspend:Set }
 */
export function suspendList(
  users: SeatUser[],
  seats: number,
): { keep: Set<string>; suspend: Set<string> } {
  const sorted = [...users].sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const keep = new Set<string>(sorted.slice(0, seats).map((u) => u.id));

  const keptUsers = sorted.filter((u) => keep.has(u.id));
  const hasAdminKept = keptUsers.some((u) => u.role === "owner" || u.role === "admin");
  if (!hasAdminKept) {
    const admin = sorted.find((u) => u.role === "owner" || u.role === "admin");
    if (admin) {
      // 顶替当前保留名单里排序最末的非管理员
      const keptSorted = sorted.filter((u) => keep.has(u.id) && u.role === "member");
      const victim = keptSorted[keptSorted.length - 1];
      if (victim) {
        keep.delete(victim.id);
        keep.add(admin.id);
      }
    }
  }
  const suspend = new Set<string>();
  for (const u of sorted) if (!keep.has(u.id)) suspend.add(u.id);
  return { keep, suspend };
}
