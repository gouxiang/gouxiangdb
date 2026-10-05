// apps/api/src/domain/share/externalRecords.ts
// 外部访问者（无登录态）经分享链接读写数据表记录的事务体。
//
// 读：视图配置 + 按视图查询记录（分页），字段按分享人权限裁剪。
// 写：只在当次能力为 edit 时放行，且每次都重新走一遍字段闸与库权限（见 shareCaps.ts）。
//     一切写入落审计（share_external_write），被拒也落一条（share_external_denied）——
//     "谁在什么时候借谁的链接改了什么"必须能查，否则外部写就是一条无主通道。
//
// 本文件不含任何路由/HTTP 类型：入参出参都是纯数据，便于单测。

import type { PublicRecordsPayload, PublicTablePayload, ShareWriteAction } from "@gx/shared-types";
import { prisma, withWriteTx } from "../../db.js";
import { HttpError } from "../../guards.js";
import { config } from "../../config.js";
import { writeAudit } from "../../audit/audit.js";
import {
  loadTableFields,
  parseViewConfig,
  queryRecords,
  visibleFields,
} from "../recordService.js";
import { createRecordTx, softDeleteRecordTx, updateRecordTx } from "../recordWrite.js";
import { externalFieldGate, shareVisibleFields, type ShareCaps } from "./shareCaps.js";

const SHARE_PAGE_DEFAULT = 50;
const SHARE_PAGE_MAX = 200;

export function sharePage(query: { limit?: string; offset?: string }): { limit: number; offset: number } {
  const raw = Number(query.limit ?? SHARE_PAGE_DEFAULT);
  const limit = Math.min(Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : SHARE_PAGE_DEFAULT, SHARE_PAGE_MAX);
  const rawOffset = Number(query.offset ?? 0);
  const offset = Math.max(Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0, 0);
  return { limit, offset };
}

interface ViewRow {
  id: string;
  name: string;
  type: string;
  lockMode: string;
  config: string;
  order: number;
}

/** 取分享锚定的视图：链接指定了 viewId 就用它，否则取该表第一个（order 升序）。 */
async function resolveView(tableId: string, viewId: string | null): Promise<ViewRow | null> {
  if (viewId) {
    const v = await prisma.view.findFirst({ where: { id: viewId, tableId } });
    return v ?? null;
  }
  return prisma.view.findFirst({ where: { tableId }, orderBy: { order: "asc" } });
}

interface ExternalReadInput {
  tableId: string;
  viewId: string | null;
  limit: number;
  offset: number;
}

/** 读一次「表 + 视图」：返回够前端渲染表格/看板/画廊/日历的字段与记录。 */
export async function readSharedTable(
  input: ExternalReadInput,
  caps: ShareCaps,
  table: PublicTablePayload["table"],
): Promise<PublicTablePayload> {
  const allFields = await loadTableFields(input.tableId);
  const fields = shareVisibleFields(caps.sharerAccess, input.tableId, allFields);
  const view = await resolveView(input.tableId, input.viewId);
  const viewConfig = parseViewConfig(view?.config ?? null);
  const result = await queryRecords({
    tableId: input.tableId,
    fields,
    config: viewConfig,
    limit: input.limit,
    offset: input.offset,
  });

  return {
    kind: "table",
    token: "",
    mode: caps.mode,
    requestedMode: caps.requestedMode,
    degraded: caps.degraded,
    canEdit: caps.canEdit,
    table,
    view: view
      ? { id: view.id, name: view.name, type: view.type, lockMode: view.lockMode, config: viewConfig }
      : null,
    fields,
    visibleFields: visibleFields(fields, viewConfig),
    records: result.records,
    total: result.total,
    filteredTotal: result.filteredTotal,
    page: { limit: input.limit, offset: input.offset },
  };
}

/** 只翻页时用：与 readSharedTable 同口径，省掉视图/字段元数据的重复传输。 */
export async function readSharedRecords(
  input: ExternalReadInput,
  caps: ShareCaps,
): Promise<PublicRecordsPayload> {
  const allFields = await loadTableFields(input.tableId);
  const fields = shareVisibleFields(caps.sharerAccess, input.tableId, allFields);
  const view = await resolveView(input.tableId, input.viewId);
  const result = await queryRecords({
    tableId: input.tableId,
    fields,
    config: parseViewConfig(view?.config ?? null),
    limit: input.limit,
    offset: input.offset,
  });
  return {
    canEdit: caps.canEdit,
    mode: caps.mode,
    degraded: caps.degraded,
    records: result.records,
    total: result.total,
    filteredTotal: result.filteredTotal,
    page: { limit: input.limit, offset: input.offset },
  };
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

interface ExternalWriteInput {
  tableId: string;
  recordId?: string;
  patch: Record<string, unknown>;
  /** 外部访问者的来源 IP（审计用，不参与判定）。 */
  ip: string;
  token: string;
}

/**
 * 外部写入的统一审计出口（数据表记录写与文档正文写共用，避免两套 event/脱敏口径）。
 * detail 内绝不带 token 明文（writeAudit 也会脱敏，这里再收一层）。
 */
export function auditWrite(input: { event: "share_external_write" | "share_external_denied"; status: number; sharerId: string | null; ip: string; detail: Record<string, unknown> }): void {
  writeAudit(config.auditDir, {
    event: input.event,
    actorId: input.sharerId,
    ip: input.ip,
    method: "PUBLIC",
    path: "/api/public/s/:token",
    status: input.status,
    detail: input.detail,
  });
}

function deny(caps: ShareCaps, action: ShareWriteAction, input: ExternalWriteInput, reason: string): never {
  auditWrite({
    event: "share_external_denied",
    status: 403,
    sharerId: caps.sharerId,
    ip: input.ip,
    // detail 内绝不带 token 明文（writeAudit 也会脱敏，这里再收一层）。
    detail: { action, tableId: input.tableId, recordId: input.recordId ?? null, reason },
  });
  throw new HttpError(403, reason);
}

/** 写前统一校验：当次能力 + 分享人存在性。任何一条不满足都落审计后 403。 */
function assertWritable(caps: ShareCaps, action: ShareWriteAction, input: ExternalWriteInput): string {
  if (caps.mode !== "edit") {
    deny(caps, action, input, "该分享链接为只读");
  }
  if (!caps.sharerId) {
    deny(caps, action, input, "分享链接缺少分享人，不可编辑");
  }
  if (action === "create" && !caps.canCreate) {
    deny(caps, action, input, "分享人已失去该表的创建权限");
  }
  if (action === "delete" && !caps.canDelete) {
    deny(caps, action, input, "分享人已失去该表的删除权限");
  }
  return caps.sharerId as string;
}

export async function externalCreateRecord(input: ExternalWriteInput, caps: ShareCaps): Promise<{ id: string }> {
  const sharerId = assertWritable(caps, "create", input);
  const fields = await loadTableFields(input.tableId);
  const gate = externalFieldGate(caps.sharerAccess, input.tableId, fields);
  const created = await withWriteTx("share.record.create", (tx) =>
    createRecordTx(tx, {
      tableId: input.tableId,
      payloadFields: input.patch,
      fields,
      userId: sharerId,
      fieldGate: gate,
      // 外部新建不进草稿模式：网格就地建空行是登录态交互，外链一律严格校验必填。
      isDraft: false,
    }),
  );
  auditWrite({
    event: "share_external_write",
    status: 201,
    sharerId,
    ip: input.ip,
    detail: { action: "create", tableId: input.tableId, recordId: created.id, fieldIds: Object.keys(input.patch) },
  });
  return created;
}

export async function externalUpdateRecord(input: ExternalWriteInput, caps: ShareCaps): Promise<void> {
  const recordId = input.recordId;
  if (!recordId) throw new HttpError(400, "缺少 recordId");
  const sharerId = assertWritable(caps, "update", input);
  const fields = await loadTableFields(input.tableId);
  const gate = externalFieldGate(caps.sharerAccess, input.tableId, fields);
  await withWriteTx("share.record.update", (tx) =>
    updateRecordTx(tx, { tableId: input.tableId, recordId, patch: input.patch, fields, userId: sharerId, fieldGate: gate }),
  );
  auditWrite({
    event: "share_external_write",
    status: 200,
    sharerId,
    ip: input.ip,
    detail: { action: "update", tableId: input.tableId, recordId, fieldIds: Object.keys(input.patch) },
  });
}

export async function externalDeleteRecord(input: ExternalWriteInput, caps: ShareCaps): Promise<void> {
  const recordId = input.recordId;
  if (!recordId) throw new HttpError(400, "缺少 recordId");
  const sharerId = assertWritable(caps, "delete", input);
  // 删除不逐字段校验，但仍要确认这条记录确实在被分享的表里（防跨表删）。
  const record = await prisma.record.findFirst({ where: { id: recordId, tableId: input.tableId, deletedAt: null } });
  if (!record) throw new HttpError(404, "记录不存在或已删除");
  await withWriteTx("share.record.delete", (tx) => softDeleteRecordTx(tx, recordId, sharerId));
  auditWrite({
    event: "share_external_write",
    status: 200,
    sharerId,
    ip: input.ip,
    detail: { action: "delete", tableId: input.tableId, recordId },
  });
}

