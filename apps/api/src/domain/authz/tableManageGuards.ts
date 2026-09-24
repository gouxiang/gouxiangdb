// apps/api/src/domain/authz/tableManageGuards.ts
// P1/S6 表级管理守卫（切片设计 §6.2、§7.3）：把旧 requireCanManageSchema/requireCanManageBase
// 按语义拆成两枚互相独立的动作，不再由库 canManage 一票通放：
//   - requireTableManage：manage_table（挂库节点）——表重命名/删表/清空/回收站、可见行配置入口；
//   - requireSchemaDesign：manage_schema（挂表节点）——字段/视图/结构管理、进设计器、布局版本。
//
// 引擎仍 off：两守卫的【落定结论】都取第二代裁决的 access.canManage（它是这两位此刻唯一来源），
// 故 off 态与旧守卫逐值等价、响应零漂移。shadow 探针在 table 节点对拍：manage_table 虽实际挂
// 库节点，引擎沿 table -> base 祖先链命中（§6.2 注释）；manage_schema 在 table 节点直接命中。
// 本模块不读 Hono 之外的全局状态，裁决经 libraryPolicy 解析，与 guards.ts 同源。

import type { Context } from "hono";
import type { LibraryAccessDTO } from "@gx/shared-types";
import { requireUserId } from "../../guards.js";
import { HttpError } from "../../httpError.js";
import { authzShadowActive } from "../../configAuthz.js";
import { runShadowCheck } from "./adapter.js";
import { resolveBaseAccess, resolveBaseAccessByTable } from "./libraryPolicy.js";
import { nodeId } from "../nav/backfill.js";

export interface TableManageResult {
  userId: string;
  access: LibraryAccessDTO;
  /** 该表 nav 节点 id（manage_table 经祖先链在库节点命中，仍以表节点为对拍点）。 */
  tableNodeId: string;
}

/** 加载表所在库裁决；表不存在 404，库不可见 403。 */
async function loadAccess(c: Context, tableId: string) {
  const userId = await requireUserId(c);
  const access = await resolveBaseAccessByTable(userId, tableId);
  if (!access) throw new HttpError(404, "表不存在");
  if (!access.visible) throw new HttpError(403, "无权访问该 Base");
  return { userId, access };
}

/** shadow 对拍缝：仅 shadow 模式跑引擎，计数/记日志，不改返回、不抛错。 */
async function shadow(
  guard: string,
  userId: string,
  tableId: string,
  action: "manage_table" | "manage_schema",
  oldAllowed: boolean,
): Promise<void> {
  if (!authzShadowActive()) return;
  await runShadowCheck(guard, userId, { resourceType: "table", resourceId: tableId }, action, oldAllowed);
}

export interface BaseDesignResult {
  userId: string;
  access: LibraryAccessDTO;
  baseNodeId: string;
}

/**
 * 建表守卫（manage_schema，base 节点）：创建表是结构设计、不是对既有表的元数据动作；
 * 且此刻新表尚不存在、无 table 节点，故直接在 base 节点对拍 manage_schema
 * （actionLegalForNode 允许 manage_schema 挂 base）。off 态结论同取 canManage，与旧守卫等价。
 */
export async function requireCreateTable(c: Context, baseId: string): Promise<BaseDesignResult> {
  const userId = await requireUserId(c);
  const access = await resolveBaseAccess(userId, baseId);
  if (!access.visible) throw new HttpError(403, "无权访问该 Base");
  const baseNodeId = nodeId("base", baseId);
  const allowed = access.canManage;
  if (authzShadowActive()) {
    await runShadowCheck("requireCreateTable", userId, { resourceType: "base", resourceId: baseId }, "manage_schema", allowed);
  }
  if (!allowed) throw new HttpError(403, "当前角色无权修改表结构");
  return { userId, access, baseNodeId };
}

/**
 * 表元数据管理守卫（manage_table）。用于 PATCH/DELETE /tables/:id、清空表、
 * 回收站恢复与彻底删除、可见行配置写入口。
 */
export async function requireTableManage(c: Context, tableId: string): Promise<TableManageResult> {
  const { userId, access } = await loadAccess(c, tableId);
  if (!access.canManage) {
    await shadow("requireTableManage", userId, tableId, "manage_table", false);
    throw new HttpError(403, "当前角色无权管理该表");
  }
  await shadow("requireTableManage", userId, tableId, "manage_table", true);
  return { userId, access, tableNodeId: nodeId("table", tableId) };
}

/**
 * 表结构设计守卫（manage_schema）。用于字段增删改、视图结构、进设计器、布局版本。
 * 结论与 requireTableManage 同位但语义独立，shadow 对拍 manage_schema。
 */
export async function requireSchemaDesign(c: Context, tableId: string): Promise<TableManageResult> {
  const { userId, access } = await loadAccess(c, tableId);
  if (!access.canManage) {
    await shadow("requireSchemaDesign", userId, tableId, "manage_schema", false);
    throw new HttpError(403, "当前角色无权修改表结构");
  }
  await shadow("requireSchemaDesign", userId, tableId, "manage_schema", true);
  return { userId, access, tableNodeId: nodeId("table", tableId) };
}
