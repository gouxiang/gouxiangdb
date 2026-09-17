// M2/S5 组织角色管理事务：自定义角色 CRUD、授予/撤销（user|dept，scope 固定 workspace）、
// 批量主体集 diff。系统角色不可删、不可改 key/name/actions（仅 description 可改）。
//
// 写路径全走 withWriteTx，回调内只用 tx；M2 scope 恒 workspace：请求体带 nodeId/scopeType
// 一律 400（node 作用域留 M3+）。

import crypto from "node:crypto";
import type { OrgAction, OrgRoleDTO, AssignmentSubjectInput, RoleAssignmentDTO } from "@gx/shared-types";
import { ORG_ACTIONS } from "@gx/shared-types";
import { HttpError } from "../../guards.js";
import { withWriteTx, prisma, type DbTx } from "../../db.js";
import { getDefaultWorkspaceId } from "./workspace.js";
import { SYSTEM_ROLE_BY_ID, OWNER_ROLE_ID, assertOrgActions } from "./roles.js";
import { assertWorkspaceHasOwnerTx } from "./lifecycle.js";

/** 动作白名单非法统一为 400（assertOrgActions 抛普通 Error，边界翻译避免冒泡 500）。 */
function parseActionsStrict(raw: unknown): OrgAction[] {
  if (!Array.isArray(raw)) throw new HttpError(400, "actions 必须是数组");
  try {
    return assertOrgActions(raw);
  } catch {
    throw new HttpError(400, `存在非法组织管理动作（仅允许 ${ORG_ACTIONS.join("/")}）`);
  }
}

function toRoleDTO(r: {
  id: string; workspaceId: string; systemKey: string | null; name: string; description: string;
  isSystem: number; permissions: string; createdAt: Date; deletedAt: Date | null;
}): OrgRoleDTO {
  let actions: OrgAction[] = [];
  try {
    const parsed: unknown = JSON.parse(r.permissions);
    if (Array.isArray(parsed)) {
      actions = parsed.filter((p): p is OrgAction => typeof p === "string"
        && (ORG_ACTIONS as readonly string[]).includes(p));
    }
  } catch {
    actions = [];
  }
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    systemKey: r.systemKey as OrgRoleDTO["systemKey"],
    name: r.name,
    description: r.description,
    isSystem: r.isSystem === 1,
    actions,
    createdAt: r.createdAt.toISOString(),
    deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
  };
}

/** 列角色：系统角色固定序在前，自定义按 createdAt。 */
export async function listRoles(): Promise<OrgRoleDTO[]> {
  const workspaceId = await getDefaultWorkspaceId();
  const rows = await prisma.role.findMany({
    where: { workspaceId, deletedAt: null },
  });
  return [...rows].sort((a, b) => {
    const sa = SYSTEM_ROLE_BY_ID.get(a.id) ? 0 : 1;
    const sb = SYSTEM_ROLE_BY_ID.get(b.id) ? 0 : 1;
    if (sa !== sb) return sa - sb;
    if (sa === 0) {
      const order = ["role_owner", "role_creator", "role_editor", "role_commenter", "role_viewer"];
      return order.indexOf(a.id) - order.indexOf(b.id);
    }
    return a.createdAt.getTime() - b.createdAt.getTime();
  }).map(toRoleDTO);
}

export async function getRoleById(id: string): Promise<OrgRoleDTO | null> {
  const workspaceId = await getDefaultWorkspaceId();
  const r = await prisma.role.findFirst({ where: { id, workspaceId, deletedAt: null } });
  return r ? toRoleDTO(r) : null;
}

export async function createCustomRole(input: {
  name: unknown;
  description?: unknown;
  actions?: unknown;
}): Promise<OrgRoleDTO> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length === 0 || name.length > 60) throw new HttpError(400, "角色名称不能为空且不超过 60 字");
  const description = typeof input.description === "string" ? input.description.slice(0, 200) : "";
  const actions = input.actions === undefined ? [] : parseActionsStrict(input.actions);
  const workspaceId = await getDefaultWorkspaceId();

  return withWriteTx("org.role.create", async (tx) => {
    const dup = await tx.role.findFirst({ where: { workspaceId, name, deletedAt: null }, select: { id: true } });
    if (dup) throw new HttpError(409, "已存在同名角色");
    const created = await tx.role.create({
      data: {
        id: `role_c_${crypto.randomBytes(12).toString("hex")}`,
        workspaceId,
        systemKey: null,
        name,
        description,
        isSystem: 0,
        permissions: JSON.stringify(actions),
      },
    });
    return toRoleDTO(created);
  });
}

export async function updateRole(id: string, input: {
  name?: unknown;
  description?: unknown;
  actions?: unknown;
}): Promise<OrgRoleDTO> {
  return withWriteTx("org.role.update", async (tx) => {
    const role = await tx.role.findUnique({ where: { id } });
    if (!role || role.deletedAt !== null) throw new HttpError(404, "角色不存在或已删除");
    if (role.isSystem === 1) {
      // 系统角色：仅 description 可改；改 name/actions 405。
      const triesManageKey = input.name !== undefined || input.actions !== undefined;
      if (triesManageKey) throw new HttpError(405, "系统角色仅可修改说明，不可改名称或动作");
      const description = typeof input.description === "string" ? input.description.slice(0, 200) : role.description;
      return toRoleDTO(await tx.role.update({ where: { id }, data: { description } }));
    }
    const data: { name?: string; description?: string; permissions?: string } = {};
    if (input.name !== undefined) {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (name.length === 0 || name.length > 60) throw new HttpError(400, "角色名称不能为空且不超过 60 字");
      const dup = await tx.role.findFirst({
        where: { workspaceId: role.workspaceId, name, deletedAt: null, NOT: { id } },
        select: { id: true },
      });
      if (dup) throw new HttpError(409, "已存在同名角色");
      data.name = name;
    }
    if (input.description !== undefined) {
      data.description = typeof input.description === "string" ? input.description.slice(0, 200) : "";
    }
    if (input.actions !== undefined) {
      data.permissions = JSON.stringify(parseActionsStrict(input.actions));
    }
    return toRoleDTO(await tx.role.update({ where: { id }, data }));
  });
}

/**
 * 软删自定义角色：仍有授予悬挂 -> 409 并返回悬挂数（或要求 reassignTo 迁移）。
 * 系统角色不可删（405）。
 */
export async function deleteRole(id: string, reassignTo?: unknown): Promise<{ id: string; deleted: true }> {
  await withWriteTx("org.role.delete", async (tx) => {
    const role = await tx.role.findUnique({ where: { id } });
    if (!role || role.deletedAt !== null) throw new HttpError(404, "角色不存在或已删除");
    if (role.isSystem === 1) throw new HttpError(405, "系统角色不可删除");

    const assignments = await tx.roleAssignment.findMany({ where: { roleId: id } });
    if (assignments.length > 0) {
      const targetId = typeof reassignTo === "string" ? reassignTo : null;
      if (!targetId) {
        throw new HttpError(409, `角色仍有 ${assignments.length} 条授予，请先撤销或指定 reassignTo 迁移`);
      }
      const target = await tx.role.findUnique({ where: { id: targetId } });
      if (!target || target.deletedAt !== null) throw new HttpError(400, "reassignTo 目标角色不存在");
      if (targetId === id) throw new HttpError(400, "reassignTo 不能是角色自身");
      for (const a of assignments) {
        // 迁移到目标角色（冲突唯一键则跳过：目标已有同主体授予）。
        const exists = await tx.roleAssignment.findFirst({
          where: {
            roleId: targetId, subjectType: a.subjectType, subjectId: a.subjectId,
            scopeType: a.scopeType, scopeNodeId: a.scopeNodeId,
          },
          select: { id: true },
        });
        if (exists) {
          await tx.roleAssignment.delete({ where: { id: a.id } });
        } else {
          await tx.roleAssignment.update({ where: { id: a.id }, data: { roleId: targetId } });
        }
      }
    }
    await tx.role.update({ where: { id }, data: { deletedAt: new Date() } });
  });
  return { id, deleted: true };
}

function toAssignmentDTO(a: {
  id: string; roleId: string; subjectType: string; subjectId: string;
  scopeType: string; scopeNodeId: string | null; createdAt: Date; createdBy: string | null;
}): RoleAssignmentDTO {
  return {
    id: a.id, roleId: a.roleId,
    subjectType: a.subjectType as RoleAssignmentDTO["subjectType"],
    subjectId: a.subjectId,
    scopeType: "workspace", scopeNodeId: null,
    createdAt: a.createdAt.toISOString(), createdBy: a.createdBy,
  };
}

/** 校验 scope：M2 恒 workspace，不允许 nodeId/其他 scopeType。 */
function assertWorkspaceScope(body: Record<string, unknown>): void {
  if (body.nodeId !== undefined || body.scopeNodeId !== undefined) {
    throw new HttpError(400, "M2 暂不支持节点作用域，请勿传 nodeId/scopeNodeId");
  }
  if (body.scopeType !== undefined && body.scopeType !== "workspace") {
    throw new HttpError(400, "M2 角色作用域固定为 workspace");
  }
}

async function assertSubjectExistsTx(tx: DbTx, s: AssignmentSubjectInput): Promise<void> {
  if (s.subjectType === "user") {
    const u = await tx.user.findUnique({ where: { id: s.subjectId }, select: { id: true } });
    if (!u) throw new HttpError(400, `被授权用户不存在: ${s.subjectId}`);
  } else if (s.subjectType === "dept") {
    const d = await tx.department.findFirst({ where: { id: s.subjectId, deletedAt: null }, select: { id: true } });
    if (!d) throw new HttpError(400, `被授权部门不存在或已删除: ${s.subjectId}`);
  } else {
    throw new HttpError(400, "subjectType 只能是 user 或 dept");
  }
}

export async function listAssignments(roleId: string): Promise<RoleAssignmentDTO[]> {
  const rows = await prisma.roleAssignment.findMany({ where: { roleId }, orderBy: { createdAt: "asc" } });
  return rows.map(toAssignmentDTO);
}

/** 授予单条（幂等：已存在不重复建）。 */
export async function grantRole(
  actorId: string,
  roleId: string,
  body: Record<string, unknown>,
): Promise<RoleAssignmentDTO> {
  assertWorkspaceScope(body);
  const subjectType = body.subjectType;
  const subjectId = typeof body.subjectId === "string" ? body.subjectId : "";
  if (subjectType !== "user" && subjectType !== "dept") throw new HttpError(400, "subjectType 只能是 user 或 dept");
  if (!subjectId) throw new HttpError(400, "缺少 subjectId");

  return withWriteTx("org.role.grant", async (tx) => {
    const existsRole = await tx.role.findFirst({ where: { id: roleId, deletedAt: null }, select: { id: true } });
    if (!existsRole) throw new HttpError(404, "角色不存在或已删除");
    await assertSubjectExistsTx(tx, { subjectType, subjectId });
    const existing = await tx.roleAssignment.findFirst({
      where: { roleId, subjectType, subjectId, scopeType: "workspace", scopeNodeId: null },
    });
    if (existing) return toAssignmentDTO(existing);
    const created = await tx.roleAssignment.create({
      data: { roleId, subjectType, subjectId, scopeType: "workspace", scopeNodeId: null, createdBy: actorId },
    });
    return toAssignmentDTO(created);
  });
}

export interface ReplaceAssignmentsResult {
  assignments: RoleAssignmentDTO[];
  added: Array<{ subjectType: string; subjectId: string }>;
  removed: Array<{ subjectType: string; subjectId: string }>;
}

/** 批量替换角色主体集：与现授予做 diff，撤销缺失、新增多余（一个事务）。 */
export async function replaceAssignments(
  actorId: string,
  roleId: string,
  body: Record<string, unknown>,
): Promise<ReplaceAssignmentsResult> {
  assertWorkspaceScope(body);
  const subjects = Array.isArray(body.subjects) ? (body.subjects as unknown[]) : [];
  const normalized: AssignmentSubjectInput[] = [];
  for (const s of subjects) {
    if (!s || typeof s !== "object") throw new HttpError(400, "subjects 每项必须是 {subjectType,subjectId}");
    const st = (s as Record<string, unknown>).subjectType;
    const sid = (s as Record<string, unknown>).subjectId;
    if (st !== "user" && st !== "dept") throw new HttpError(400, "subjectType 只能是 user 或 dept");
    if (typeof sid !== "string" || !sid) throw new HttpError(400, "缺少 subjectId");
    if (!normalized.some((n) => n.subjectType === st && n.subjectId === sid)) {
      normalized.push({ subjectType: st, subjectId: sid });
    }
  }

  return withWriteTx("org.role.replaceAssignments", async (tx) => {
    const existsRole = await tx.role.findFirst({ where: { id: roleId, deletedAt: null }, select: { id: true } });
    if (!existsRole) throw new HttpError(404, "角色不存在或已删除");
    for (const s of normalized) await assertSubjectExistsTx(tx, s);

    const current = await tx.roleAssignment.findMany({ where: { roleId, scopeType: "workspace" } });
    const want = new Set(normalized.map((s) => `${s.subjectType}:${s.subjectId}`));
    const removed: ReplaceAssignmentsResult["removed"] = [];
    const added: ReplaceAssignmentsResult["added"] = [];
    for (const a of current) {
      if (!want.has(`${a.subjectType}:${a.subjectId}`)) {
        await tx.roleAssignment.delete({ where: { id: a.id } });
        removed.push({ subjectType: a.subjectType, subjectId: a.subjectId });
      }
    }
    const have = new Set(current.map((a) => `${a.subjectType}:${a.subjectId}`));
    for (const s of normalized) {
      if (!have.has(`${s.subjectType}:${s.subjectId}`)) {
        await tx.roleAssignment.create({
          data: { roleId, subjectType: s.subjectType, subjectId: s.subjectId, scopeType: "workspace", createdBy: actorId },
        });
        added.push({ subjectType: s.subjectType, subjectId: s.subjectId });
      }
    }
    // 写后兜底：替换 role_owner 主体集可能删掉全部有效 owner 来源（空 subjects、换成
    // DISABLED 用户、换成无 ACTIVE 成员的部门），复算在岗 owner 为空则 409 回滚。
    // 自定义角色不持 owner 语义，不触发。
    if (roleId === OWNER_ROLE_ID) {
      await assertWorkspaceHasOwnerTx(tx);
    }
    const finalRows = await tx.roleAssignment.findMany({ where: { roleId }, orderBy: { createdAt: "asc" } });
    return { assignments: finalRows.map(toAssignmentDTO), added, removed };
  });
}
