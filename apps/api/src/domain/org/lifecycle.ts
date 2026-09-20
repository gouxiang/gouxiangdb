// M2 账号生命周期状态机（计划 §5-D）。
// S4：接受邀请（INVITED -> ACTIVE，一次性激活码，发带 tv JWT）。
// S6：disableUser / reactivateUser / assertNotLastOwner（本文件在 S6 扩充）。
// 企业化定位：新增 deleteUser（物理删除，权限位 delete_users 单独门控）。

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { HttpError } from "../../guards.js";
import { withWriteTx, type DbTx } from "../../db.js";
import { USER_STATUS, issueToken, invalidateAuthState } from "./authState.js";
import { usersWithRole, OWNER_ROLE_ID } from "./roles.js";

/** 激活码明文 -> sha256 摘要（与建邀请时同一算法）。 */
export function hashInviteToken(plain: string): string {
  return crypto.createHash("sha256").update(plain).digest("hex");
}

export interface AcceptInviteResult {
  token: string;
  user: { id: string; email: string; displayName: string; status: string };
}

/**
 * 接受邀请：公开端点（不要求登录）。
 * 成功 -> ACTIVE、设置密码/可选昵称、清空 inviteTokenHash（一次性）、签发带 tv JWT。
 * 失败 -> 404（token 无效或已被使用：摘要已清空无法再命中，统一 404 避免账号枚举）。
 */
export async function acceptInvite(input: {
  token: unknown;
  password: unknown;
  displayName?: unknown;
}): Promise<AcceptInviteResult> {
  const token = typeof input.token === "string" ? input.token.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (token.length === 0) throw new HttpError(400, "缺少激活令牌");
  if (password.length < 8 || password.length > 72) {
    throw new HttpError(400, "密码至少 8 位、不超过 72 位");
  }
  const displayName =
    typeof input.displayName === "string" && input.displayName.trim() !== ""
      ? input.displayName.trim().slice(0, 60)
      : null;

  const hash = hashInviteToken(token);
  return withWriteTx("org.member.acceptInvite", async (tx) => {
    const user = await tx.user.findFirst({ where: { inviteTokenHash: hash } });
    // 无匹配：token 错误或已使用（成功激活时已清空 hash）。统一 404。
    if (!user) throw new HttpError(404, "激活链接无效或已被使用");
    if (user.status !== USER_STATUS.INVITED) {
      // 防御：非 INVITED 却仍挂着 hash 的异常态不允许经此路径改密。
      throw new HttpError(409, "账号已激活，无法重复使用邀请链接");
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const updated = await tx.user.update({
      where: { id: user.id },
      data: {
        status: USER_STATUS.ACTIVE,
        passwordHash,
        inviteTokenHash: null,
        ...(displayName ? { displayName } : {}),
      },
    });
    const jwt = await issueToken(updated.id, updated.tokenVersion);
    return {
      token: jwt,
      user: {
        id: updated.id,
        email: updated.email,
        displayName: updated.displayName,
        status: updated.status,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// S6：停用 / 重新激活 / 最后 owner 保护
// ---------------------------------------------------------------------------

/**
 * 最后 owner 保护（必须把部门继承授予展开计入，计划 §5-D.4 / §11-15）。
 * owners 经 usersWithRole 反查：user 直接持 role_owner ∪ 被授 role_owner 部门【子树】内的
 * ACTIVE 成员。若目标当前是在岗 owner 且停用后 owner 集合为空 -> 409。
 * 事务内执行，复用同一事务视图，避免"检查-写入"间隙被绕过。
 */
export async function assertNotLastOwnerTx(tx: DbTx, targetId: string): Promise<void> {
  const owners = await usersWithRole(OWNER_ROLE_ID, tx);
  if (owners.includes(targetId) && owners.length <= 1) {
    throw new HttpError(409, "至少保留一位工作区所有者，请先移交所有者再停用");
  }
}

/**
 * 写操作后兜底守卫：确保工作区仍至少有一位【在岗】(ACTIVE) owner，否则 409 回滚。
 * 与针对单个 targetId 的写前检查 assertNotLastOwnerTx 分开——replaceAssignments（主体集
 * 批量替换）与 assignDepartments（移除部门归属）都可能不经停用路径就摘掉全部有效 owner
 * 来源，故在事务内写操作完成后统一复算 usersWithRole。必须在 withWriteTx 回调内调用，
 * 抛错即触发事务回滚，delete/create 全部不落库。
 */
export async function assertWorkspaceHasOwnerTx(tx: DbTx): Promise<void> {
  const owners = await usersWithRole(OWNER_ROLE_ID, tx);
  if (owners.length === 0) {
    throw new HttpError(409, "至少保留一位工作区所有者");
  }
}

export interface LifecycleResult {
  id: string;
  status: string;
  disabledAt: string | null;
  tokenVersion: number;
}

function toLifecycleResult(u: {
  id: string; status: string; disabledAt: Date | null; tokenVersion: number;
}): LifecycleResult {
  return {
    id: u.id,
    status: u.status,
    disabledAt: u.disabledAt ? u.disabledAt.toISOString() : null,
    tokenVersion: u.tokenVersion,
  };
}

/**
 * 停用成员：自停用 400；最后 owner（含部门继承展开）409；
 * 置 DISABLED+disabledAt+tokenVersion+1，保留全部 membership/授予行；事务提交后失效其缓存态。
 * 已是 DISABLED 为幂等 no-op（不重复 bump、不触发 owner 检查）。
 */
export async function disableUser(actorId: string, targetId: string): Promise<LifecycleResult> {
  if (actorId === targetId) {
    throw new HttpError(400, "不能停用自己的账号");
  }
  const result = await withWriteTx("org.member.disable", async (tx) => {
    const user = await tx.user.findUnique({ where: { id: targetId } });
    if (!user) throw new HttpError(404, "成员不存在");
    if (user.status === USER_STATUS.DISABLED) return toLifecycleResult(user);

    await assertNotLastOwnerTx(tx, targetId);

    const updated = await tx.user.update({
      where: { id: targetId },
      data: {
        status: USER_STATUS.DISABLED,
        disabledAt: new Date(),
        tokenVersion: { increment: 1 },
      },
    });
    // M6/S1（C-4 定稿）：停用同事务批量吊销该用户全部未吊销 PAT（revokedAt 置位=终态）。
    // 认证侧另有 users.status=ACTIVE 检查兜底，故已 DISABLED 用户的 PAT 即便此处未置位也拒；
    // 此处置位是为了「吊销状态可查询/可审计」与「重新激活后依旧不可用」（见 reactivateUser 注释）。
    await tx.personalAccessToken.updateMany({
      where: { userId: targetId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return toLifecycleResult(updated);
  });
  // tokenVersion 已 +1：即使开了短缓存也主动失效，保证同进程下一次请求即 401。
  invalidateAuthState(targetId);
  return result;
}

// ---------------------------------------------------------------------------
// 企业化定位：删除用户（物理删除，最后 owner 保护）
// ---------------------------------------------------------------------------

export interface DeleteUserResult {
  id: string;
  email: string;
  deleted: true;
}

/**
 * 删除成员账号：自删 400；删除后工作区无在岗 owner -> 409 回滚；否则物理删除。
 *
 * 为什么是物理删除而不是加 users.deletedAt 软删列：
 *   schema 已把 memberships / kbMemberships / kbDocAcls / comments / deptMemberships /
 *   personalAccessTokens 全部配成 ON DELETE CASCADE（见 prisma/schema.prisma 的 User 模型），
 *   链路本身是完整的，软删只会让"同一个邮箱能不能再建一次账号"这类问题多出一套分支，
 *   且 User.email 唯一索引在软删后会长期占住不可复用。代价是删除不可恢复——
 *   因此这个动作必须单独成一枚 delete_users 权限位，不与停用共用。
 *
 * 保护次序（都必须在同一事务内，删完再检查才不会被"删了才发现没人兜底"绕过）：
 *   1. actorId === targetId -> 400（参照自停用的写法）；
 *   2. 目标不存在 -> 404；
 *   3. 先把未吊销的 PAT 置 revokedAt：PAT 行会被级联删掉，但"吊销"应留下可审计的终态；
 *   4. 物理删除用户，手工清两种不被级联覆盖的悬挂引用（见下）；
 *   5. 写后复算 owner 集合：用户的 owner 授予行不被 SQLite 级联覆盖、必须显式删，
 *      否则 usersWithRole 会算出一名已不存在的 owner，兜底形同虚设；且只有在删之前
 *      工作区确实还有 owner 时才要求删完仍有 owner（否则无主工作区永远清不干净）。
 */
export async function deleteUser(actorId: string, targetId: string): Promise<DeleteUserResult> {
  if (actorId === targetId) {
    throw new HttpError(400, "不能删除自己的账号");
  }
  const result = await withWriteTx("org.member.delete", async (tx) => {
    const user = await tx.user.findUnique({ where: { id: targetId } });
    if (!user) throw new HttpError(404, "成员不存在");

    // PAT 吊销先于删除落库（同 disableUser 的做法）：即便立刻被级联清除，
    // 吊销状态也要先成为可查询/可审计的终态。
    await tx.personalAccessToken.updateMany({
      where: { userId: targetId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // 写前快照：原来有几位在岗 owner。这个数决定 409 该不该参与判定（见下）。
    const ownersBefore = await usersWithRole(OWNER_ROLE_ID, tx);

    await tx.user.delete({ where: { id: targetId } });

    // 悬挂授予清理：role_assignments.subjectId 是多态列、无 FK（见 schema 注释），
    // SQLite 不会替我们级联，必须显式删掉该用户作为主体的授予行。留着会让
    // usersWithRole 反查出已不存在的用户 id，最后 owner 兜底因此失效。
    await tx.roleAssignment.deleteMany({
      where: { subjectType: "user", subjectId: targetId },
    });

    // 写后兜底：只在「删之前工作区还有 owner」时才要求删完仍有 owner。
    // 不能无条件调用 assertWorkspaceHasOwnerTx——那样在一个本身就没有 owner 的工作区里
    // 任何账号都删不掉（包括清理一个没人管的残留账号），这不是保护而是死锁。
    // 「一位 owner 都没有」是部署事故，不是删除操作造成的，不该由删除路径背锅。
    if (ownersBefore.length > 0) await assertWorkspaceHasOwnerTx(tx);
    return { id: user.id, email: user.email, deleted: true as const };
  });
  invalidateAuthState(targetId);
  return result;
}

/**
 * 重新激活：DISABLED -> ACTIVE、disabledAt=null、tokenVersion 再 +1（强制重新登录：
 * 停用前的旧 token 因 tv 已不匹配，激活后依旧不可用，必须重新登录）。
 * 幂等：已 ACTIVE 直接返回；INVITED 不经此路径（应走邀请接受）-> 400。
 *
 * **M6/S1（C-4 定稿）：重新激活【不恢复】任何 PAT**——停用时置位的 revokedAt 是终态，
 * 重新启用账号需重新签发 PAT（安全优先：账号停用期间的令牌不应自动复活）。
 * 这是有意为之，不是遗漏。
 */
export async function reactivateUser(actorId: string, targetId: string): Promise<LifecycleResult> {
  void actorId;
  const result = await withWriteTx("org.member.reactivate", async (tx) => {
    const user = await tx.user.findUnique({ where: { id: targetId } });
    if (!user) throw new HttpError(404, "成员不存在");
    if (user.status === USER_STATUS.ACTIVE) return toLifecycleResult(user);
    if (user.status === USER_STATUS.INVITED) {
      throw new HttpError(400, "待激活账号应通过邀请链接激活，不能直接重新启用");
    }
    const updated = await tx.user.update({
      where: { id: targetId },
      data: {
        status: USER_STATUS.ACTIVE,
        disabledAt: null,
        tokenVersion: { increment: 1 },
      },
    });
    return toLifecycleResult(updated);
  });
  invalidateAuthState(targetId);
  return result;
}
