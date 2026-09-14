// M2/S4 组织成员【写侧】：多部门归属（兼岗/调岗/主部门）、邀请（INVITED + 一次性激活码）、
// 管理员直接建 ACTIVE 账号、signup 运行时 owner 自举。
//
// 只读目录（分页/搜索/子树/单成员投影）在 memberDirectory.ts（拆分守 <=300 行）。
// 分层：只做业务与事务，不碰 Hono；写路径全走 withWriteTx，事务回调内只用传入 tx。
// 邮件邀请不投递（无邮件基础设施，计划 §2.2）：createInvitedUser 返回明文激活码一次，
// 由管理员线下转发；库存 sha256 摘要。

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { HttpError } from "../../guards.js";
import { withWriteTx, type DbTx } from "../../db.js";
import { getDefaultWorkspaceId } from "./workspace.js";
import { USER_STATUS } from "./authState.js";

// 只读 DTO/查询从 memberDirectory 再导出，调用方可只从 members 一处导入。
export type {
  DeptMembershipDTO,
  OrgMemberDTO,
  MemberPage,
  ListMembersFilter,
} from "./memberDirectory.js";
export { listMembers, getMemberById, MEMBER_PAGE_MAX } from "./memberDirectory.js";

const BCRYPT_ROUNDS = 10;

export interface AssignDepartmentsInput {
  add?: unknown;
  remove?: unknown;
  mainDeptId?: unknown;
}

function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && x.trim() !== "");
}

/**
 * 增量调整成员部门归属：add（加入兼岗，已存在不重复）/ remove（移出）/ mainDeptId（设主部门）。
 * 全程一个写事务；主部门唯一性靠"先清旧 main 再设新 main" + 部分唯一索引双保险。
 * mainDeptId 必须是调整后仍归属的活部门，否则 400。
 */
export async function assignDepartments(
  actorId: string,
  userId: string,
  input: AssignDepartmentsInput,
): Promise<{ userId: string; deptMemberships: import("./memberDirectory.js").DeptMembershipDTO[] }> {
  const workspaceId = await getDefaultWorkspaceId();
  const add = asStringArray(input.add);
  const remove = new Set(asStringArray(input.remove));
  const mainDeptId =
    typeof input.mainDeptId === "string" && input.mainDeptId.trim() !== ""
      ? input.mainDeptId
      : null;

  return withWriteTx("org.member.assignDepartments", async (tx) => {
    const target = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!target) throw new HttpError(404, "成员不存在");

    // 校验涉及部门都属于本工作区且未软删。
    const involved = [...new Set([...add, ...(mainDeptId ? [mainDeptId] : [])])];
    if (involved.length) {
      const depts = await tx.department.findMany({
        where: { id: { in: involved }, workspaceId, deletedAt: null },
        select: { id: true },
      });
      const live = new Set(depts.map((d) => d.id));
      const bad = involved.find((id) => !live.has(id));
      if (bad) throw new HttpError(400, `部门不存在或已删除: ${bad}`);
    }

    for (const departmentId of add) {
      if (remove.has(departmentId)) continue; // 同请求既加又删：以不加处理
      await tx.deptMember.upsert({
        where: { departmentId_userId: { departmentId, userId } },
        create: { departmentId, userId, isMain: 0 },
        update: {}, // 已归属保持原状（含原 isMain）
      });
    }
    for (const departmentId of remove) {
      await tx.deptMember.deleteMany({ where: { departmentId, userId } });
    }

    if (mainDeptId) {
      const stillMember = await tx.deptMember.findUnique({
        where: { departmentId_userId: { departmentId: mainDeptId, userId } },
        select: { id: true },
      });
      if (!stillMember) {
        throw new HttpError(400, "主部门必须是该成员当前归属的部门");
      }
      // 先清旧主部门再设新主（部分唯一索引兜底一人一主）。
      await tx.deptMember.updateMany({ where: { userId, isMain: 1 }, data: { isMain: 0 } });
      await tx.deptMember.update({
        where: { departmentId_userId: { departmentId: mainDeptId, userId } },
        data: { isMain: 1 },
      });
    }

    const rows = await tx.deptMember.findMany({
      where: { userId },
      include: { department: { select: { deletedAt: true } } },
    });
    const deptMemberships = rows
      .filter((m) => !m.department.deletedAt)
      .map((m) => ({
        departmentId: m.departmentId,
        isMain: m.isMain === 1,
        joinedAt: m.joinedAt.toISOString(),
      }));
    void actorId;
    return { userId, deptMemberships };
  });
}

/** 生成一次性激活码：32 字节随机 -> hex；库存 sha256 摘要（明文不入库）。 */
export function newInviteToken(): { plain: string; hash: string } {
  const plain = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(plain).digest("hex");
  return { plain, hash };
}

export interface InvitedUserResult {
  userId: string;
  email: string;
  status: string;
  inviteToken: string; // 明文，仅本次返回
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** 邀请建号：email 唯一 409；status=INVITED；存激活码 sha256；workspaceId=ws_default。 */
export async function createInvitedUser(input: {
  email: unknown;
  displayName: unknown;
}): Promise<InvitedUserResult> {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
  if (!isValidEmail(email)) throw new HttpError(400, "邮箱格式不正确");
  if (displayName.length === 0 || displayName.length > 60) throw new HttpError(400, "姓名不能为空且不超过 60 字");

  const workspaceId = await getDefaultWorkspaceId();
  const { plain, hash } = newInviteToken();
  // INVITED 账号无真密码：放随机不可登录占位（接受邀请时才设真密码）。
  const placeholderHash = await bcrypt.hash(crypto.randomBytes(16).toString("hex"), BCRYPT_ROUNDS);

  return withWriteTx("org.member.invite", async (tx) => {
    const dup = await tx.user.findUnique({ where: { email }, select: { id: true } });
    if (dup) throw new HttpError(409, "该邮箱已被使用");
    const user = await tx.user.create({
      data: {
        email,
        displayName,
        passwordHash: placeholderHash,
        status: USER_STATUS.INVITED,
        workspaceId,
        inviteTokenHash: hash,
        invitedAt: new Date(),
      },
    });
    return { userId: user.id, email: user.email, status: user.status, inviteToken: plain };
  });
}

export interface CreatedActiveUser {
  userId: string;
  email: string;
  status: string;
}

/** 管理员直接建 ACTIVE 账号（带初始密码）。email 唯一 409。 */
export async function createActiveUser(input: {
  email: unknown;
  displayName: unknown;
  password: unknown;
}): Promise<CreatedActiveUser> {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (!isValidEmail(email)) throw new HttpError(400, "邮箱格式不正确");
  if (displayName.length === 0 || displayName.length > 60) throw new HttpError(400, "姓名不能为空且不超过 60 字");
  if (password.length < 8 || password.length > 72) throw new HttpError(400, "初始密码至少 8 位、不超过 72 位");

  const workspaceId = await getDefaultWorkspaceId();
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  return withWriteTx("org.member.create", async (tx) => {
    const dup = await tx.user.findUnique({ where: { email }, select: { id: true } });
    if (dup) throw new HttpError(409, "该邮箱已被使用");
    const user = await tx.user.create({
      data: { email, displayName, passwordHash, status: USER_STATUS.ACTIVE, workspaceId },
    });
    return { userId: user.id, email: user.email, status: user.status };
  });
}

/**
 * 供 signup 运行时 owner 自举（计划 §5-D.4）：仅当该用户是工作区唯一用户、且尚不存在任何
 * user 级 owner 授予时，授予系统 owner。幂等（重复调用不产生第二行）。返回是否授予。
 * 事务内只用 tx（workspaceId 由调用方传入，不在此触全局 prisma）。
 */
export async function bootstrapFirstOwnerTx(
  tx: DbTx,
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  const [userCount, ownerCount] = await Promise.all([
    tx.user.count({ where: { workspaceId } }),
    tx.roleAssignment.count({ where: { roleId: "role_owner", subjectType: "user" } }),
  ]);
  if (userCount === 1 && ownerCount === 0) {
    await tx.roleAssignment.create({
      data: {
        roleId: "role_owner",
        subjectType: "user",
        subjectId: userId,
        scopeType: "workspace",
        createdBy: "system-signup-bootstrap",
      },
    });
    return true;
  }
  return false;
}
