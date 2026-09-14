// M2/S3 部门业务编排：建/改名/移动（子树 path 事务重写 + 防环 + 深度护栏）/软删。
//
// 分层：本模块只做业务与事务，不碰 Hono req/res；写路径全部走 withWriteTx，
// 事务回调内只用传入 tx（铁律 db.ts:111）。controller（routes/v1/org/departments.ts）
// 负责取当前用户/参数校验/错误码翻译。

import { HttpError } from "../../guards.js";
import { withWriteTx, prisma, type DbTx } from "../../db.js";
import { getDefaultWorkspaceId } from "./workspace.js";
import {
  selfPath as buildSelfPath,
  depthOfPath,
  wouldCreateCycle,
  validateDeptName,
  listSubtreeTx,
  planSubtreeRewrite,
  applySubtreeRewriteTx,
  MAX_DEPTH,
} from "./deptTree.js";

export interface DepartmentDTO {
  id: string;
  workspaceId: string;
  parentId: string | null;
  path: string;
  name: string;
  ord: number;
  status: string;
  memberCount: number;
  createdAt: string;
  updatedAt: string | null;
}

function toDTO(row: {
  id: string; workspaceId: string; parentId: string | null; path: string;
  name: string; ord: number; status: string;
  createdAt: Date; updatedAt: Date | null;
}, memberCount: number): DepartmentDTO {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    parentId: row.parentId,
    path: row.path,
    name: row.name,
    ord: row.ord,
    status: row.status,
    memberCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

/** 纯函数校验错误（name/depth）统一翻译为 400（否则会冒泡成 500）。 */
function badRequest(fn: () => string): string {
  try {
    return fn();
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

async function loadActiveDeptTx(tx: DbTx, id: string) {
  const dept = await tx.department.findUnique({ where: { id } });
  if (!dept || dept.deletedAt !== null) {
    throw new HttpError(404, "部门不存在或已删除");
  }
  return dept;
}

/** 同父同名（仅活部门）冲突 -> 409；excludeId 用于改名时排除自身。 */
async function assertSiblingNameFreeTx(
  tx: DbTx,
  workspaceId: string,
  parentId: string | null,
  name: string,
  excludeId?: string,
): Promise<void> {
  const dup = await tx.department.findFirst({
    where: {
      workspaceId,
      parentId,
      name,
      deletedAt: null,
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
    },
    select: { id: true },
  });
  if (dup) throw new HttpError(409, "同一上级下已存在同名部门");
}

/** 列出工作区全部活部门（平铺，含 memberCount=该部门 dept_members 行数；S3 口径，S4 细化状态过滤）。 */
export async function listDepartments(): Promise<DepartmentDTO[]> {
  const workspaceId = await getDefaultWorkspaceId();
  const rows = await prisma.department.findMany({
    where: { workspaceId, deletedAt: null },
    orderBy: [{ ord: "asc" }, { createdAt: "asc" }],
  });
  const groups = await prisma.deptMember.groupBy({
    by: ["departmentId"],
    _count: { _all: true },
  });
  const countMap = new Map(groups.map((g) => [g.departmentId, g._count._all]));
  return rows.map((r) => toDTO(r, countMap.get(r.id) ?? 0));
}

export interface CreateDeptInput {
  name: unknown;
  parentId?: unknown;
  ord?: unknown;
}

/** 建部门：insert 后在同事务按父 path 拼自身 path 再 update（计划 §5-B）。 */
export async function createDepartment(input: CreateDeptInput): Promise<DepartmentDTO> {
  const name = badRequest(() => validateDeptName(input.name));
  const parentId = input.parentId === undefined || input.parentId === null ? null : String(input.parentId);
  const ord = typeof input.ord === "number" && Number.isInteger(input.ord) ? input.ord : 0;
  const workspaceId = await getDefaultWorkspaceId();

  return withWriteTx("org.dept.create", async (tx) => {
    let parentPath: string | null = null;
    if (parentId) {
      const parent = await tx.department.findUnique({ where: { id: parentId } });
      if (!parent || parent.deletedAt !== null || parent.workspaceId !== workspaceId) {
        throw new HttpError(400, "上级部门不存在或已删除");
      }
      if (depthOfPath(parent.path) >= MAX_DEPTH) {
        throw new HttpError(400, `部门层级不能超过 ${MAX_DEPTH} 层`);
      }
      parentPath = parent.path;
    }
    await assertSiblingNameFreeTx(tx, workspaceId, parentId, name);

    const created = await tx.department.create({
      data: { workspaceId, parentId, path: "", name, ord, status: "active" },
    });
    const path = buildSelfPath(parentPath, created.id);
    const final = await tx.department.update({ where: { id: created.id }, data: { path } });
    return toDTO(final, 0);
  });
}

export interface UpdateDeptInput {
  name?: unknown;
  ord?: unknown;
  parentId?: unknown;
}

/** 改名/排序/移动：parentId 实际变化触发子树 path 事务重写（防环 + 32 层护栏）。 */
export async function updateDepartment(id: string, input: UpdateDeptInput): Promise<DepartmentDTO> {
  const workspaceId = await getDefaultWorkspaceId();

  return withWriteTx("org.dept.update", async (tx) => {
    const self = await loadActiveDeptTx(tx, id);
    if (self.workspaceId !== workspaceId) throw new HttpError(404, "部门不存在或已删除");

    let nextName = self.name;
    if (input.name !== undefined) nextName = badRequest(() => validateDeptName(input.name));
    const nextOrd =
      typeof input.ord === "number" && Number.isInteger(input.ord) ? input.ord : self.ord;
    const moveRequested = input.parentId !== undefined;
    const nextParentId =
      input.parentId === null ? null : input.parentId === undefined ? self.parentId : String(input.parentId);

    if (nextName !== self.name) {
      await assertSiblingNameFreeTx(tx, workspaceId, nextParentId, nextName, id);
    }

    let nextPath = self.path;
    if (moveRequested && nextParentId !== self.parentId) {
      let newParentPath: string | null = null;
      if (nextParentId) {
        if (nextParentId === id) throw new HttpError(400, "不能把部门移动到自身之下");
        const target = await tx.department.findUnique({ where: { id: nextParentId } });
        if (!target || target.deletedAt !== null || target.workspaceId !== workspaceId) {
          throw new HttpError(400, "上级部门不存在或已删除");
        }
        newParentPath = target.path;
      }
      // 防环：新父是自身或自己子孙即拒绝。
      if (wouldCreateCycle(self.path, newParentPath)) {
        throw new HttpError(400, "不能把部门移动到其自身的子部门之下（会形成环）");
      }
      const newSelfPath = buildSelfPath(newParentPath, id);
      const subtree = await listSubtreeTx(tx, workspaceId, self.path);
      // 超 32 层护栏由纯函数抛普通 Error，边界翻译为 400。
      let plan: ReturnType<typeof planSubtreeRewrite>;
      try {
        plan = planSubtreeRewrite(subtree, self.path, newSelfPath);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      await applySubtreeRewriteTx(tx, plan);
      nextPath = newSelfPath;
    }

    const saved = await tx.department.update({
      where: { id },
      data: { name: nextName, ord: nextOrd, parentId: nextParentId, path: nextPath },
    });
    const memberCount = await tx.deptMember.count({ where: { departmentId: id } });
    return toDTO(saved, memberCount);
  });
}

/** 软删：仍有子部门或成员 -> 409 并带 counts 引导先处理；否则置 deletedAt。 */
export async function deleteDepartment(id: string): Promise<{ id: string; deleted: true }> {
  const workspaceId = await getDefaultWorkspaceId();

  await withWriteTx("org.dept.delete", async (tx) => {
    const self = await loadActiveDeptTx(tx, id);
    if (self.workspaceId !== workspaceId) throw new HttpError(404, "部门不存在或已删除");

    const childCount = await tx.department.count({
      where: { workspaceId, parentId: id, deletedAt: null },
    });
    const memberCount = await tx.deptMember.count({ where: { departmentId: id } });
    if (childCount > 0 || memberCount > 0) {
      throw new HttpError(
        409,
        `部门下仍有 ${childCount} 个子部门、${memberCount} 名成员，请先移动或移除后再删除`,
      );
    }
    await tx.department.update({
      where: { id },
      data: { deletedAt: new Date(), status: "deleted" },
    });
  });
  return { id, deleted: true };
}
