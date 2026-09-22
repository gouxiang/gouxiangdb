// apps/api/src/domain/share/shareCaps.ts
// 分享链接「当前实际能做什么」的唯一裁决：动态降级 + 字段级读写闸。
//
// ★为什么必须在每次访问现算，而不是创建时判一次：
//   分享人是链接的授权主体——外部访问者没有系统身份，"能不能写"只能借分享人的权限。
//   分享人的权限来自角色 × 库视野（libraryPolicy），随时可能被管理员改掉：降权、移出角色、
//   停用账号、收回库视野。若创建时判一次就锁死，那就是一条"人已经没权了、链接还能改数据"
//   的残留写权限通道——正是本次要消灭的形态。故每次访问都重新 resolveBaseAccess，
//   失去编辑权即当次降级为只读（不删链接、不报错、不通知，只是变回只读）。
//
// 字段权限按【分享人】判定，理由见 exportFieldGate 的注释。
//
// 「可编辑」只作用于这一条链接：本文件从不写任何角色/成员/库视野数据，
// 外部访问者也不会因此获得系统内身份。

import type { LibraryAccessDTO, ShareMode } from "@gx/shared-types";
import { fieldAccessOf, resolveBaseAccessByTable, resolveKbAccess, tableAccessOf, contentAccessOf } from "../authz/libraryPolicy.js";
import { HttpError } from "../../guards.js";
import type { FieldMeta } from "../types.js";
import type { ShareLinkRow } from "./shareLinkLookup.js";

export interface ShareCaps {
  /** 本次访问实际生效的档位。前端一律以它为准。 */
  mode: ShareMode;
  /** 链接上登记的档位（创建时申请的）。 */
  requestedMode: ShareMode;
  /** 申请了 edit 但分享人已失去编辑权 -> 已降级。 */
  degraded: boolean;
  canEdit: boolean;
  canCreate: boolean;
  canDelete: boolean;
  /** 分享人当前的库裁决结果；无分享人（存量链接）为 null。 */
  sharerAccess: LibraryAccessDTO | null;
  sharerId: string | null;
}

function requestedModeOf(link: ShareLinkRow): ShareMode {
  return link.mode === "edit" ? "edit" : "view";
}

/** 只读兜底：无分享人、或分享人已消失/失权时一律落到这一档。 */
const VIEW_ONLY: Omit<ShareCaps, "requestedMode"> = {
  mode: "view",
  degraded: false,
  canEdit: false,
  canCreate: false,
  canDelete: false,
  sharerAccess: null,
  sharerId: null,
};

/**
 * 数据表分享的当次能力。
 * 判定链：申请档位 -> 有无分享人 -> 分享人对该表（经所在库）的四枚动作。
 */
export async function resolveTableShareCaps(
  link: ShareLinkRow | null,
  tableId: string,
): Promise<ShareCaps> {
  if (!link) return { ...VIEW_ONLY, requestedMode: "view" };
  const requestedMode = requestedModeOf(link);
  const sharerId = link.createdBy;
  if (requestedMode === "view" || !sharerId) {
    // 只读链接也要拿一份分享人的裁决结果——字段可见性（隐藏字段）仍按他裁剪。
    const access = sharerId ? await resolveBaseAccessByTable(sharerId, tableId) : null;
    return { ...VIEW_ONLY, requestedMode, sharerAccess: access, sharerId };
  }

  const access = await resolveBaseAccessByTable(sharerId, tableId);
  if (!access || !access.visible) {
    // 分享人被移出/停用/库视野收回：整库都进不去了，降级且按最窄字段集裁剪。
    return { ...VIEW_ONLY, requestedMode, degraded: true, sharerAccess: access, sharerId };
  }
  const table = tableAccessOf(access, tableId);
  const canEdit = table.update;
  return {
    mode: canEdit ? "edit" : "view",
    requestedMode,
    degraded: !canEdit,
    canEdit,
    canCreate: table.create,
    canDelete: table.delete,
    sharerAccess: access,
    sharerId,
  };
}

/**
 * 文档/画布分享的当次档位。
 * 口径（2026-09 二版）：**文档正文的匿名写已放开**，但只限「可编辑」档位的链接——
 * 判定链见 routes/publicDoc.ts 的 PUT /s/:token/doc/:docId/content（可写范围 → 档位 → 乐观锁）。
 * 因此 canEdit 不再恒 false：它是分享人此刻内容改权的现算结果，他被降权即回落只读。
 * mode 同时驱动【文档/画布中嵌入的数据表预览】能不能写（publicEmbed.ts）。
 */
export async function resolveDocShareCaps(docRole: string, kbId: string, sharerId: string | null): Promise<ShareCaps> {
  const requestedMode: ShareMode = docRole === "editor" ? "edit" : "view";
  if (requestedMode === "view" || !sharerId) {
    const access = sharerId ? await resolveKbAccess(sharerId, kbId) : null;
    return { ...VIEW_ONLY, requestedMode, sharerAccess: access, sharerId };
  }
  const access = await resolveKbAccess(sharerId, kbId);
  if (!access || !access.visible) {
    return { ...VIEW_ONLY, requestedMode, degraded: true, sharerAccess: access, sharerId };
  }
  const content = contentAccessOf(access);
  return {
    mode: content.update ? "edit" : "view",
    requestedMode,
    degraded: !content.update,
    canEdit: content.update,
    canCreate: content.create,
    canDelete: content.delete,
    sharerAccess: access,
    sharerId,
  };
}

/**
 * 外部可见字段集：剔除分享人眼中「隐藏」的字段。
 *
 * 为什么按分享人而不是"全部可见"：外部访问者没有身份，唯一能代表"这次分享能露到什么程度"
 * 的就是分享人自己能看到什么。若按全字段外发，等于任何人都能用一条链接把自己的隐藏字段
 * 发布出去——把字段权限这道闸门开在了库权限之外。
 * 「仅可见」字段照常外发但不可写（它本来就是"看得见改不了"）。
 */
export function shareVisibleFields(
  access: LibraryAccessDTO | null,
  tableId: string,
  fields: FieldMeta[],
): FieldMeta[] {
  if (!access) return fields;
  return fields.filter((f) => fieldAccessOf(access, tableId, f.id) !== "hidden");
}

/**
 * 外部写入的字段闸：分享人眼中非 editable 的字段一律拒写（含"仅可见"与"隐藏"）。
 *
 * 为什么按分享人判定（而不是按某个"外部人角色"）：
 *   1. 外部访问者没有身份，不存在可用的字段裁决主体；凭空造一个等于默认放行。
 *   2. 分享人是这次外发的授权主体，也是事后被追责的人——他不许改的字段，借他的链接出去
 *      的人更不该能改，否则"仅可见"这道闸可以被一条分享链接整体绕过。
 *   3. 与登录态口径一致：登录用户写入受 libraryPolicy 的 fieldWriteGate 约束，外部写入复用
 *      同一个函数，只是裁决主体换成分享人，语义不外溢、规则不两套。
 */
export function externalFieldGate(
  access: LibraryAccessDTO | null,
  tableId: string,
  fields: FieldMeta[],
): (fieldIds: readonly string[]) => void {
  const nameOf = new Map(fields.map((f) => [f.id, f.name]));
  return (fieldIds) => {
    if (!access) throw new HttpError(403, "该分享链接不可编辑");
    for (const fieldId of fieldIds) {
      if (fieldAccessOf(access, tableId, fieldId) !== "editable") {
        throw new HttpError(403, `字段「${nameOf.get(fieldId) ?? fieldId}」为仅可见或已隐藏，不可编辑`);
      }
    }
  };
}

/**
 * 数据表：本人此刻能否授予「可编辑」档位（不抛错版本）。
 * 与 assert 版共用同一条判定链，避免 GET 置灰与 POST 校验两套口径。
 */
export async function canSharerGrantTableEdit(sharerId: string, tableId: string): Promise<boolean> {
  const access = await resolveBaseAccessByTable(sharerId, tableId);
  return !!access && !!tableAccessOf(access, tableId)?.update;
}

/** 创建「可编辑」分享的前置校验：分享人本人必须对该表有改权，否则 403。 */
export async function assertSharerCanGrantEdit(sharerId: string, tableId: string): Promise<void> {
  if (!(await canSharerGrantTableEdit(sharerId, tableId))) {
    throw new HttpError(403, "只有本人对该数据表有编辑权时才能创建可编辑分享");
  }
}

/**
 * 文档/画布：本人此刻能否授予「可编辑」档位（不抛错版本）。
 *
 * ★为什么要有这个布尔版：前端分享弹窗需要在用户点之前就把「可编辑」置灰，
 *   而置灰所需的信息（我本人对这个知识库的内容有没有改权）只有后端知道。
 *   assert 版在 false 时抛 403，无法用于 GET；若 GET 自己再写一套判定，
 *   两处口径迟早分裂（一边灰一边放行）。故判定只此一处，assert 复用它。
 */
export async function canSharerGrantDocEdit(sharerId: string, kbId: string): Promise<boolean> {
  const access = await resolveKbAccess(sharerId, kbId);
  return !!access && access.visible && contentAccessOf(access).update;
}

/** 创建文档/画布「可编辑」分享的前置校验：分享人本人必须对该知识库内容有改权。 */
export async function assertSharerCanGrantDocEdit(sharerId: string, kbId: string): Promise<void> {
  if (!(await canSharerGrantDocEdit(sharerId, kbId))) {
    throw new HttpError(403, "只有本人对该知识库内容有编辑权时才能创建可编辑分享");
  }
}
