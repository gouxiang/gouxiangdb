/**
 * 占席与软挂起名单（两道闸门共用）。
 *
 * 占席 = status ACTIVE + INVITED（DISABLED 已释放名额，排除）。
 * 角色真源 role_assignments：subjectType="user" 且 roleId∈{role_owner,role_admin}；
 * owner 优先于 admin，其余为 member。不读 members 表（那是库级角色，非组织管理角色）。
 *
 * 软挂起只每请求"现算"（读库结果短缓存 ttlMs），绝不落库、绝不改 users.status、不删数据，
 * 与手动 DISABLED 彻底分开。名单算法本身在 state.suspendList（锁定向量）。
 */
import { prisma } from "../../db.js";
import { SUPER_ADMIN_ROLE_ID, ADMIN_ROLE_ID } from "../org/roles.js";
import {
  suspendList,
  type EntitlementView,
  type SeatUser,
} from "./state.js";
import type { LicenseStore } from "./store.js";

export interface SeatSnapshot {
  /** 用于排序/挂起计算的占席用户（ACTIVE+INVITED）。 */
  users: SeatUser[];
  /** 占席总数（含已邀请未激活）。 */
  occupied: number;
}

export interface Suspension {
  /** 当前应被软挂起的用户 id 集（仅 enforce 且 verdict∈expired/invalid 非空）。 */
  suspended: Set<string>;
  /** 计算所用 verdict（供中间件/UI）。 */
  verdict: EntitlementView["verdict"];
}

/**
 * 纯函数：view + 占席用户 -> 软挂起名单。
 * 仅 enforce 档且 verdict 为 expired / invalid 才挂人；
 * licensed/grace 全员可用（grace 只提醒），free/grandfathered 不挂老号（只拦新增），
 * off/bypassed 不挂。
 */
export function computeSuspension(view: EntitlementView, users: SeatUser[]): Suspension {
  const active = view.mode === "enforce" && (view.verdict === "expired" || view.verdict === "invalid");
  if (!active) return { suspended: new Set(), verdict: view.verdict };
  return { suspended: suspendList(users, view.seats).suspend, verdict: view.verdict };
}

/**
 * 纯函数：席位预算——是否还有空位再容纳一个占席账号。
 *  - off/bypassed：无限；
 *  - 其余 verdict 一律受 view.seats 约束（free/grandfathered/expired/invalid=5，licensed/grace=单据 seats）。
 * grandfathered 的"老号不受影响"由占席事实保证（老号已在库内），新增仍需名额。
 * 注意：本函数只算名额，不含 mode 策略；是否真拦截见 seatAddBlockReason（仅 enforce）。
 */
export function canAddSeat(view: EntitlementView, occupied: number): boolean {
  if (view.verdict === "bypassed") return true;
  return occupied < view.seats;
}

export type SeatAddBlockReason = "FREE_FULL" | "GRANDFATHERED" | "COMMERCIAL_FULL";

/**
 * 闸门①策略（06：仅 enforce 真拦；verify/off 不拦新增）。
 * 返回 null=放行；否则返回原因码供造人事务前抛 403 LICENSE_SEAT_LIMIT 与文案分流：
 *  - grandfathered：升级前老团队，老号不动、新增需商业许可；
 *  - free：免费 5 人触顶；
 *  - expired/invalid/grace/licensed 触顶：商业席位满（grace 仍按单据 seats）。
 */
export function seatAddBlockReason(
  view: EntitlementView,
  occupied: number,
): SeatAddBlockReason | null {
  if (view.mode !== "enforce") return null; // verify 只通电不拦新增；off 零闸门
  if (canAddSeat(view, occupied)) return null;
  if (view.verdict === "grandfathered") return "GRANDFATHERED";
  if (view.verdict === "free") return "FREE_FULL";
  return "COMMERCIAL_FULL";
}

/**
 * 占席读取（带进程内短缓存，默认 30s，可在 env/构造覆盖）。
 * 续费/refresh 收到新信封后由 client 调 invalidateSeatCache() 立即重算。
 */
let cache: { at: number; snapshot: SeatSnapshot } | null = null;
let ttlMs = 30_000;

export function setSeatCacheTtl(ms: number): void {
  ttlMs = ms > 0 ? ms : 0;
}

export function invalidateSeatCache(): void {
  cache = null;
}

export async function listSeatUsers(now: number = Date.now()): Promise<SeatSnapshot> {
  if (cache && now - cache.at < ttlMs) return cache.snapshot;

  const rows = await prisma.user.findMany({
    where: { status: { in: ["ACTIVE", "INVITED"] } },
    select: { id: true, createdAt: true },
  });
  const ids = rows.map((r) => r.id);

  // 一次取回这些用户的组织角色授予；owner 优先于 admin。
  const adminRoleIds = new Set<string>([SUPER_ADMIN_ROLE_ID, ADMIN_ROLE_ID]);
  const assignments = ids.length
    ? await prisma.roleAssignment.findMany({
        where: {
          subjectType: "user",
          subjectId: { in: ids },
          roleId: { in: [...adminRoleIds] },
        },
        select: { subjectId: true, roleId: true },
      })
    : [];
  const roleOf = new Map<string, SeatUser["role"]>();
  for (const a of assignments) {
    const role: SeatUser["role"] = a.roleId === SUPER_ADMIN_ROLE_ID ? "owner" : "admin";
    const prev = roleOf.get(a.subjectId);
    if (!prev || role === "owner") roleOf.set(a.subjectId, role);
  }

  const users: SeatUser[] = rows.map((r) => ({
    id: r.id,
    createdAt: Math.floor(r.createdAt.getTime() / 1000),
    role: roleOf.get(r.id) ?? "member",
  }));

  const snapshot: SeatSnapshot = { users, occupied: users.length };
  cache = { at: now, snapshot };
  return snapshot;
}

/** 单用户组织角色（路由管理员判定用，直查 role_assignments，不拉全表）。 */
export async function getUserOrgRole(userId: string): Promise<SeatUser["role"]> {
  const rows = await prisma.roleAssignment.findMany({
    where: { subjectType: "user", subjectId: userId, roleId: { in: [SUPER_ADMIN_ROLE_ID, ADMIN_ROLE_ID] } },
    select: { roleId: true },
  });
  if (rows.some((r) => r.roleId === SUPER_ADMIN_ROLE_ID)) return "owner";
  if (rows.length > 0) return "admin";
  return "member";
}

export function isOrgAdminRole(role: SeatUser["role"]): boolean {
  return role === "owner" || role === "admin";
}

/**
 * grandfathered 一次性快照：首次启用授权（KV 尚无该键）时，
 * 若当前占席已 > 免费 5 人且该实例从未商业，则记为祖父老团队（只拦新增，永不挂老号）。
 * 只写一次；之后无论人数增减都不再改判（见 04/06）。
 */
export async function snapshotGrandfatheredOnce(store: LicenseStore): Promise<boolean> {
  const snap = await listSeatUsers();
  const ever = await store.getEverCommercial();
  const value = snap.occupied > 5 && !ever;
  await store.setGrandfatheredOnce(value);
  return value;
}
