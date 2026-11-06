// 闸门②（登录态软挂起）：仅 mode=enforce 且当前 verdict∈{expired,invalid} 时，
// 把落在 suspendList 名单内的【登录成员】挡在业务 /api 之外——数据与账号都不删，
// 续费后下一轮心跳（或管理员 activate/refresh）即自动恢复。
//
// fail-safe 铁律：
//   - mode=off（出厂默认）/ 运行时未 boot / handles 缺失：直接 next()，零查询、零行为变化；
//   - verify 只通电不挂人（computeSuspension 内部已判 mode==="enforce"）；
//   - licensed/grace/free/grandfathered/bypassed：suspended 集恒为空，全员放行
//     （grace 只在前端横幅提醒，不拦；free/grandfathered 不挂老号，老号永远能登录）；
//   - 名单算法唯一真源 state.suspendList（owner/admin 保底、按 createdAt 取前 seats 人）。
//
// 性能：listSeatUsers 自带 30s 短缓存；本中间件再对"挂起集 + verdict + 联系邮箱"做 10s
// 进程内缓存，把每请求 DB 读收敛到每 10s 一次。续费/激活成功由 license 路由 bustCache。
//
// 挂载点：app.ts 紧随 mustChangePasswordMiddleware 之后挂 /api/*（Hono 按注册顺序，
// 必须在业务路由之前）。白名单口径同改密闸：effectivePath（剥 basePath）+ 精确/前缀判定。

import type { Context, MiddlewareHandler, Next } from "hono";
import { resolveActiveAuth } from "../domain/org/authState.js";
import { effectivePath } from "../utils/request-path.js";
import { getLicenseHandles } from "../domain/license/runtime.js";
import { onLicenseChanged } from "../domain/license/changes.js";
import { listSeatUsers, computeSuspension } from "../domain/license/seats.js";
import type { EntitlementView } from "../domain/license/state.js";
import { LICENSE_COPY } from "../domain/license/copy.js";

/** 前端据 body.code 渲染"账号挂起页"的机器码。 */
export const LICENSE_SEAT_SUSPENDED = "LICENSE_SEAT_SUSPENDED";

const GATE_TTL_MS = 10_000;

interface CachedGate {
  at: number;
  suspended: Set<string>;
  verdict: EntitlementView["verdict"];
  contactEmail: string;
}

let cache: CachedGate | null = null;

/** 续费/激活/导入成功后调用：立即放开（否则最坏要等 10s TTL）。 */
export function invalidateLicenseGateCache(): void {
  cache = null;
}

// 订阅后台心跳带回的单据变更（续费恢复/吊销收敛）：与前台 bumpAfterEntitlementChange 等价地
// 即时作废门缓存，避免漏清导致的 10s fail-open 尾巴。模块加载即注册，进程生命周期内常驻。
onLicenseChanged(() => invalidateLicenseGateCache());

// 白名单：身份/改密自助 + 授权 BFF（挂起页要读 /status、要能发反馈；管理员要能续费激活）
// + 健康探针。license 前缀整体放行——BFF 内部自带 requireActiveUser 与管理员鉴权。
const EXACT_ALLOW = new Set<string>([
  "/api/auth/me",
  "/api/auth/login",
  "/api/auth/me/change-password",
  "/api/health",
]);
const PREFIX_ALLOW = ["/api/license"];

function isAllowed(p: string, method: string): boolean {
  if (!p.startsWith("/api/")) return true;
  void method;
  if (EXACT_ALLOW.has(p)) return true;
  return PREFIX_ALLOW.some((pre) => p === pre || p.startsWith(`${pre}/`));
}

async function resolveGate(now: number): Promise<CachedGate | null> {
  if (cache && now - cache.at < GATE_TTL_MS) return cache;
  const handles = getLicenseHandles();
  if (!handles) {
    cache = null;
    return null;
  }
  const view = await handles.client.getView();
  const snapshot = await listSeatUsers(now);
  const { suspended, verdict } = computeSuspension(view, snapshot.users);
  let contactEmail = "";
  try {
    contactEmail = (await handles.store.getContact()).adminEmail;
  } catch {
    contactEmail = "";
  }
  cache = { at: now, suspended, verdict, contactEmail };
  return cache;
}

async function gate(c: Context, next: Next): Promise<Response | void> {
  const resolved = await resolveActiveAuth(c);
  if (!resolved) return next(); // 未认证交给各路由 401，不泄漏挂起事实
  const p = effectivePath(c);
  if (isAllowed(p, c.req.method)) return next();

  const g = await resolveGate(Date.now());
  if (!g || g.suspended.size === 0) return next();
  if (!g.suspended.has(resolved.userId)) return next();

  return c.json(
    {
      error: LICENSE_COPY.suspended,
      code: LICENSE_SEAT_SUSPENDED,
      verdict: g.verdict,
      // 供挂起页展示"联系管理员 xxx"；管理员未自报邮箱时为空串，前端回落通用文案。
      contactEmail: g.contactEmail || null,
    },
    403,
  );
}

export const licenseSeatGateMiddleware: MiddlewareHandler = (c, next) => gate(c, next);
