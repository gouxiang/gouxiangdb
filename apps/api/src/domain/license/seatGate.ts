/**
 * 闸门①（新增账号）预算与断言——供 members.ts / auth.ts 三处造人路径共用。
 *
 * 口径（PLAN §5，与 seats.seatAddBlockReason 锁定）：
 *  - 仅 mode=enforce 真拦；off / verify 一律放行（verify 只在 UI 通电提示）；
 *  - 运行时未启动（mode=off 默认 / license 子系统未 boot）-> gate=null，零行为变化；
 *  - 占席在【写事务内】重算 COUNT(ACTIVE+INVITED)，不用事务外读到的快照，避免两个并发
 *    造人请求同时通过预算把第 6 人写进去；
 *  - 空库首 owner（init-admin / signup 自举）COUNT=0 天然 <5 放行，无需特判；
 *  - 邀请激活 acceptInvite 是 INVITED->ACTIVE，占席数不增加，调用方不接本闸。
 *
 * 任何 license 内部异常都向上抛为明确的 403/或由调用方决定；本文件不做网络调用。
 */
import type { DbTx } from "../../db.js";
import { prisma } from "../../db.js";
import { HttpError } from "../../httpError.js";
import { getLicenseHandles } from "./runtime.js";
import { seatAddBlockReason, type SeatAddBlockReason } from "./seats.js";
import type { EntitlementView } from "./state.js";
import { LICENSE_COPY } from "./copy.js";

/** 机器码（前端据此刻画"第 6 人拦截"弹窗）。 */
export const LICENSE_SEAT_LIMIT = "LICENSE_SEAT_LIMIT";

/**
 * 取当前授权视图快照；运行时未启动（off/未 boot）返回 null——调用方据此完全旁路。
 * 只读内存单据 + store 冗余事实，不发网络。
 */
export async function getActiveSeatGate(): Promise<EntitlementView | null> {
  const handles = getLicenseHandles();
  if (!handles) return null;
  return handles.client.getView();
}

function reasonToMessage(reason: SeatAddBlockReason): string {
  switch (reason) {
    case "GRANDFATHERED":
      return LICENSE_COPY.seatLimitGrandfathered;
    case "FREE_FULL":
      return LICENSE_COPY.seatLimitFree;
    default:
      return LICENSE_COPY.seatLimitCommercial;
  }
}

/** 事务内：重算占席并在满员时抛 403。gate=null（off/verify）直接放行。 */
export async function assertSeatAddAllowedTx(tx: DbTx, gate: EntitlementView | null): Promise<void> {
  if (!gate) return;
  const occupied = await tx.user.count({
    where: { status: { in: ["ACTIVE", "INVITED"] } },
  });
  const reason = seatAddBlockReason(gate, occupied);
  if (reason) throw new HttpError(403, reasonToMessage(reason), LICENSE_SEAT_LIMIT);
}

/**
 * 非事务造人路径（auth.ts 企业面关闭时的裸 prisma.user.create）：用全局 prisma 现算。
 * 并发防护弱于事务版（无串行写队列包裹），但该分支（enterpriseOrg=off）与授权商业化
 * 同时启用的概率低，且 signup 开关默认关；保持与主路径同一策略/文案即可。
 */
export async function assertSeatAddAllowed(gate: EntitlementView | null): Promise<void> {
  if (!gate) return;
  const occupied = await prisma.user.count({
    where: { status: { in: ["ACTIVE", "INVITED"] } },
  });
  const reason = seatAddBlockReason(gate, occupied);
  if (reason) throw new HttpError(403, reasonToMessage(reason), LICENSE_SEAT_LIMIT);
}
