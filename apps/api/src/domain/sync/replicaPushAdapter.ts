// beta.2 S3a：local_outbox 行 → 权威端 wire op 的【纯适配】（无 DB、无网络、无副作用）。
// 设计权威：DESIGN-OFFLINE-SYNC.md §5.2（本地 payload 形状）、§13（push wire）、push.ts 回放读取键。
//
// 为什么 record 必须转、结构/树直通——均已对权威端 handler 逐键核对（结论随 S3a 汇报）：
//   - record 本地落 {op,entityType,tableId,changes:FieldChange[]}（localOutbox.ts:99-104），而权威端
//     create 读 payload.fields（push.ts:1275-1276）、patch 读 payload.changed{fid:{from,to}}（:1429-1430）；
//     且本地 op 字面 "update"，权威端只认 "patch"（SUPPORTED_RECORD_OPS push.ts:198）。
//   - 结构/树 S2c 已把 payload 存成与 oplog 落库同构（localOutbox.ts:156-161 / :217-222），回放 handler
//     只读其中业务键、忽略 op/entityType/tableId/workspaceId 包裹键，故【直通】安全。

import type { LocalOutbox } from "@prisma/client";
import { isTreeEntityType } from "./navRegistry.js";
import type { WirePushOp } from "./replicaPushTransport.js";

/** 适配器只依赖的行字段（Prisma LocalOutbox 满足；测试可手造最小对象）。 */
export type OutboxAdapterRow = Pick<
  LocalOutbox,
  "clientOpId" | "baseId" | "entityType" | "entityId" | "op" | "payload" | "baseVersion"
>;

/** 无法适配的坏行原因（编排层据此落 rejected=SYNC_MALFORMED_PAYLOAD，op 绝不丢、绝不抛崩整批）。 */
export type AdaptFailReason = "BAD_JSON" | "BAD_RECORD_CHANGES" | "UNSUPPORTED_RECORD_OP" | "MALFORMED_PAYLOAD";

export type AdaptResult =
  | { ok: true; op: WirePushOp }
  | { ok: false; reason: AdaptFailReason; detail: string };

/** 与 push.ts RC.MALFORMED 同源的原因码（本域只增码，不 import push.ts 防循环）。 */
export const ADAPT_MALFORMED_CODE = "SYNC_MALFORMED_PAYLOAD";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function fail(reason: AdaptFailReason, detail: string): AdaptResult {
  return { ok: false, reason, detail };
}

/** record 轨：changes(FieldChange[]) → 权威端 fields / changed，并把 update 改名 patch。 */
function adaptRecord(
  row: OutboxAdapterRow,
  parsed: Record<string, unknown>,
  baseVersion: string,
): AdaptResult {
  const tid = typeof parsed["tableId"] === "string" && parsed["tableId"] ? parsed["tableId"] as string : null;
  const rawChanges = parsed["changes"];
  // changes 缺省/null 视为空数组（delete/restore 本就空）；给了却不是数组 = 坏行。
  if (rawChanges !== undefined && rawChanges !== null && !Array.isArray(rawChanges)) {
    return fail("BAD_RECORD_CHANGES", "record payload.changes 必须是数组");
  }
  const list = Array.isArray(rawChanges) ? rawChanges : [];
  const changes: Record<string, unknown>[] = [];
  for (const c of list) {
    const rec = asRecord(c);
    // 每个 change 必须是带非空 fieldId 的对象，否则无法安全映射（不静默丢字段）。
    if (!rec || typeof rec["fieldId"] !== "string" || !(rec["fieldId"] as string)) {
      return fail("BAD_RECORD_CHANGES", "record change 缺少合法 fieldId");
    }
    changes.push(rec);
  }

  const withTable = (rest: Record<string, unknown>): Record<string, unknown> =>
    tid ? { tableId: tid, ...rest } : rest;

  if (row.op === "create") {
    const fields: Record<string, unknown> = {};
    for (const c of changes) fields[c["fieldId"] as string] = c["after"];
    return wire(row, "create", withTable({ fields }), baseVersion);
  }
  if (row.op === "update" || row.op === "patch") {
    const changed: Record<string, unknown> = {};
    for (const c of changes) changed[c["fieldId"] as string] = { from: c["before"], to: c["after"] };
    // 权威端只认 "patch"；update→patch 是本适配层的核心改名。
    return wire(row, "patch", withTable({ changed }), baseVersion);
  }
  if (row.op === "delete" || row.op === "restore") {
    return wire(row, row.op, withTable({}), baseVersion);
  }
  return fail("UNSUPPORTED_RECORD_OP", `不支持的 record op: ${row.op}`);
}

function wire(
  row: OutboxAdapterRow,
  op: string,
  payload: Record<string, unknown>,
  baseVersion: string,
): AdaptResult {
  const out: WirePushOp = {
    clientOpId: row.clientOpId,
    entityType: row.entityType,
    entityId: row.entityId,
    op,
    baseVersion,
    payload,
  };
  return { ok: true, op: out };
}

/**
 * 把一行 local_outbox 转成权威端 wire op（纯函数）。
 * record 走字段映射；table/field/view（结构，baseId 非空）与 navnode（树，baseId=null）整 payload 直通
 * ——其本地 payload 已与回放 handler 期望同构，多余包裹键被 handler 忽略。
 */
export function localOutboxRowToWireOp(row: OutboxAdapterRow): AdaptResult {
  const baseVersion = row.baseVersion.toString();

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload) as unknown;
  } catch {
    return fail("BAD_JSON", "payload 不是合法 JSON");
  }
  const obj = asRecord(parsed);
  if (!obj) return fail("MALFORMED_PAYLOAD", "payload 不是 JSON 对象");

  if (row.entityType === "record") {
    return adaptRecord(row, obj, baseVersion);
  }

  if (row.entityType === "table" || row.entityType === "field" || row.entityType === "view"
    || isTreeEntityType(row.entityType)) {
    if (typeof row.op !== "string" || !row.op) {
      return fail("MALFORMED_PAYLOAD", "结构/树 op 缺失");
    }
    return wire(row, row.op, obj, baseVersion);
  }

  return fail("MALFORMED_PAYLOAD", `未知 entityType: ${row.entityType}`);
}
