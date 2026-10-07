// 表级管理守卫（权限引擎永久单一化）：把库管理权与结构设计权拆成两枚互相独立的动作，
// 不再由库 canManage 一票通放：
//   - requireTableManage：manage_table（挂库节点）——表重命名/删表/清空/回收站、可见行配置入口；
//   - requireSchemaDesign：manage_schema（挂表节点）——字段/视图/结构管理、进设计器、布局版本。
//
// 结论恒定经引擎执法门 enforceOrLegacy 裁决（引擎为唯一权威）；引擎故障/节点缺失按 fail-closed。

import type { Context } from "hono";
import type { LibraryAccessDTO } from "@gx/shared-types";
import { requireUserId } from "../../guards.js";
import { HttpError } from "../../httpError.js";
import { enforceOrLegacy } from "./enforceGate.js";
import { resolveBaseAccess, resolveBaseAccessByTable, baseIdOfTable } from "./libraryPolicy.js";
import { nodeId } from "../nav/backfill.js";

interface TableManageResult {
  userId: string;
  access: LibraryAccessDTO;
  /** 该表 nav 节点 id。 */
  tableNodeId: string;
}

/** 加载表所在库裁决；表不存在 404。 */
async function loadAccess(c: Context, tableId: string) {
  const userId = await requireUserId(c);
  const access = await resolveBaseAccessByTable(userId, tableId);
  if (!access) throw new HttpError(404, "表不存在");
  return { userId, access };
}

interface BaseDesignResult {
  userId: string;
  access: LibraryAccessDTO;
  baseNodeId: string;
}

/**
 * 建表守卫（manage_schema，base 节点）：创建表是结构设计、不是对既有表的元数据动作；
 * 且此刻新表尚不存在、无 table 节点，故直接在 base 节点判 manage_schema
 * （actionLegalForNode 允许 manage_schema 挂 base）。
 */
export async function requireCreateTable(c: Context, baseId: string): Promise<BaseDesignResult> {
  const userId = await requireUserId(c);
  const access = await resolveBaseAccess(userId, baseId);
  const allowed = await enforceOrLegacy({
    guard: "requireCreateTable",
    userId,
    ref: { resourceType: "base", resourceId: baseId },
    action: "manage_schema",
    legacyAllowed: access.canManage,
    semantics: "authority",
  });
  if (!allowed.allowed) {
    throw new HttpError(403, access.visible ? "当前角色无权修改表结构" : "无权访问该 Base");
  }
  return { userId, access, baseNodeId: nodeId("base", baseId) };
}

/**
 * 表元数据管理守卫（manage_table）。用于 PATCH/DELETE /tables/:id、清空表、
 * 回收站恢复与彻底删除、可见行配置写入口。
 */
export async function requireTableManage(c: Context, tableId: string): Promise<TableManageResult> {
  const { userId, access } = await loadAccess(c, tableId);
  const allowed = await enforceOrLegacy({
    guard: "requireTableManage",
    userId,
    ref: { resourceType: "table", resourceId: tableId },
    action: "manage_table",
    legacyAllowed: access.canManage,
    semantics: "authority",
  });
  if (!allowed.allowed) {
    throw new HttpError(403, access.visible ? "当前角色无权管理该表" : "无权访问该 Base");
  }
  return { userId, access, tableNodeId: nodeId("table", tableId) };
}

/**
 * 回收站恢复表守卫（manage_table，base 节点执法）。
 *
 * 恢复时该 table 的 nav 节点随表软删，若像 requireTableManage 那样解析 table 节点，
 * fail-closed 会让任何表都恢复不了。manage_table 策略本就挂在【库节点】上，故此处
 * 解析到存活的 base 节点执法；baseId 经软删表反查（findUnique 不过滤软删）。
 */
export async function requireRestoreTable(c: Context, tableId: string): Promise<TableManageResult> {
  const userId = await requireUserId(c);
  const baseId = await baseIdOfTable(tableId);
  if (!baseId) throw new HttpError(404, "数据表不存在");
  const access = await resolveBaseAccess(userId, baseId);
  const allowed = await enforceOrLegacy({
    guard: "requireRestoreTable",
    userId,
    ref: { resourceType: "base", resourceId: baseId },
    action: "manage_table",
    legacyAllowed: access.canManage,
    semantics: "authority",
  });
  if (!allowed.allowed) {
    throw new HttpError(403, access.visible ? "当前角色无权管理该表" : "无权访问该 Base");
  }
  return { userId, access, tableNodeId: nodeId("table", tableId) };
}

/**
 * 表结构设计守卫（manage_schema）。用于字段增删改、视图结构、进设计器、布局版本。
 * 结论与 requireTableManage 同位但语义独立。
 */
export async function requireSchemaDesign(c: Context, tableId: string): Promise<TableManageResult> {
  const { userId, access } = await loadAccess(c, tableId);
  const allowed = await enforceOrLegacy({
    guard: "requireSchemaDesign",
    userId,
    ref: { resourceType: "table", resourceId: tableId },
    action: "manage_schema",
    legacyAllowed: access.canManage,
    semantics: "authority",
  });
  if (!allowed.allowed) {
    throw new HttpError(403, access.visible ? "当前角色无权修改表结构" : "无权访问该 Base");
  }
  return { userId, access, tableNodeId: nodeId("table", tableId) };
}
