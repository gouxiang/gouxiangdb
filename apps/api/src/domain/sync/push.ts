// YN4 离线同步：push 回放——写队列串行应用、clientOpId 幂等去重、记录级乐观锁、批内部分接受。
//
// 设计权威：docs/design/2026-10-node-mode/DESIGN-OFFLINE-SYNC.md
//   §5.2（payload 形状）、§7.1（记录级乐观锁/实体已删）、§8.1（双表幂等）、§8.2（批内因果 +
//   子引用客户端临时 id）、§8.4（默认保留客户端 cuid 作权威 id）、§8.5（每条 op 独立可裁决、
//   部分接受不回滚已确认项、统一 withWriteTx("sync.replay") 原子一致）、§9.1（按当前权限，
//   但逐表 decide 重判/quarantine/失权擦除属 YN5）、§13（push 信封/回执）、§15.2（YN4 验收）。
//
// 本期（YN4）水位与边界（不提前做 YN5，也不绕开在线写本就有的权限）：
//   - 与在线 POST/PATCH/DELETE /api/records 【完全相同】的闸门：库门 edit_data、字段掩码写闸
//     runMaskWriteGate、字段写闸 fieldWriteGate、行级 rowFilter。离线攒的写在服务端被同一套规则
//     过滤——这不是 YN5 的「失权重判」，而是任何写都必须过的当下权限，缺失即成越权漏洞。
//   - 裁决结果本期只产 accepted / conflict / rejected 三态：
//       accepted：权限过 + 无版本冲突，落主数据/版本/oplog/incoming，同事务原子；
//       conflict：baseVersion ≠ 服务端当前版本，或同 id 已被别的 clientOpId 创建（§7.1/§8.4），
//                 只落 sync_incoming(status=conflict) + serverVersion，不碰主数据；
//       rejected：实体已删/不存在、字段/行/掩码无权、必填/唯一/关联非法、不支持的实体/操作，
//                 只落 sync_incoming(status=rejected) + reasonCode，不碰主数据。
//     quarantined/pending_approval、visibility 失权擦除、5 个审计事件属 YN5，本期不产。
//   - restore（回收站恢复）在线侧走 manage_table（高于 edit_data），其回放随 YN5 当前权限重判
//     一并接入；本期对 restore/未知 op 回 rejected=SYNC_OP_UNSUPPORTED（明确、不静默、可后续重试）。
//
// 幂等（§8.1）：每条入站 op 都在 sync_incoming 落一行终态回执（clientOpId @unique），accepted
//   另外在 sync_op_log 落事实（其 clientOpId 亦 @unique，双保险唯一约束）。重试先查 sync_incoming，
//   命中即回同一结果，绝不重复应用；唯一约束是并发竞态下的兜底（撞了重读已存回执）。

import type { LibraryAccessDTO } from "@gx/shared-types";
import { prisma, withWriteTx, runWrite, type DbTx } from "../../db.js";
import { HttpError } from "../../httpError.js";
import { resolveBaseAccess, fieldWriteGate } from "../authz/libraryPolicy.js";
import { enforceOrLegacy } from "../authz/enforceGate.js";
import { resolveTableMask } from "../authz/maskGate.js";
import { evaluateRowFilter } from "../authz/rowFilter.js";
import { loadTableFields, hydrateRecordById } from "../recordService.js";
import { runMaskWriteGate, createRecordTx, updateRecordTx, softDeleteRecordTx } from "../recordWrite.js";
import {
  applyCreateDefaults,
  applyEditDefaults,
  applyReverseDefaultsForChild,
  applyLinkChangeDefaults,
} from "../defaults.js";
import { invalidateOrdinalCache } from "../prismaDeps.js";
import type { FieldMeta } from "../types.js";
import { SyncVersionConflictError } from "./oplog.js";

// ───────────────────────────────── 信封类型 ─────────────────────────────────

/** 路由已做过基本结构校验的一条入站操作（原样对应 §13 push.req.ops[i]）。 */
export interface IncomingOp {
  clientOpId: string;
  entityType: string;
  entityId: string;
  op: string;
  /** 客户端提交时所基于的实体版本（字符串承载 BigInt，路由保证 /^\d+$/）。 */
  baseVersion: bigint;
  payload: Record<string, unknown>;
}

/** 单条裁决回执（§13 push.results[i]）。BigInt 序列化为字符串由路由层负责。 */
export interface PushResult {
  clientOpId: string;
  status: "accepted" | "conflict" | "rejected";
  reasonCode?: string;
  reasonDetail?: string;
  /** accepted：本次分配的服务端 seq / 应用后新版本。 */
  seq?: bigint;
  newVersion?: bigint;
  /** accepted=create：最终权威 id（默认等于客户端 entityId，保留 cuid）。 */
  entityId?: string;
  /** conflict：服务端当前版本，供客户端做双版本弹窗（YN6）。 */
  serverVersion?: bigint;
  /**
   * 【内部，路由层不序列化】accepted 后做事务外默认值补偿所需上下文（autoNumber/static/
   * lookup/formula 初值、序号缓存、反向 formula 联动），与在线 POST/PATCH/DELETE 事务后补偿同构。
   */
  _afterCommit?: {
    op: "create" | "patch" | "delete";
    tableId: string;
    /** patch：本次被改的物理/关联字段 id 集（决定是否重算）。 */
    changedFieldIds?: Set<string>;
  };
}

export interface PushOutcome {
  baseId: string;
  results: PushResult[];
  /** 本批 accepted 的最大 seq（用于推进订阅游标）；无 accepted 为 null。 */
  maxAcceptedSeq: bigint | null;
}

// ───────────────────────── 只增原因码（§13 同款，不回吐敏感明文） ─────────────────────────

const RC = {
  VERSION_CONFLICT: "SYNC_VERSION_CONFLICT",
  ENTITY_DELETED: "SYNC_ENTITY_DELETED",
  ENTITY_NOT_FOUND: "SYNC_ENTITY_NOT_FOUND",
  PERMISSION_REVOKED: "SYNC_PERMISSION_REVOKED",
  ROW_NOT_VISIBLE: "SYNC_ROW_NO_LONGER_VISIBLE",
  FIELD_FORBIDDEN: "SYNC_FIELD_FORBIDDEN",
  VALIDATION: "SYNC_VALIDATION",
  NOT_UNIQUE: "SYNC_NOT_UNIQUE",
  BAD_TABLE: "SYNC_BAD_TABLE",
  LINK_INVALID: "SYNC_LINK_INVALID",
  OP_UNSUPPORTED: "SYNC_OP_UNSUPPORTED",
  MALFORMED: "SYNC_MALFORMED_PAYLOAD",
} as const;

/** 本期回放支持的 record 操作（restore 随 YN5 接入，理由见文件头）。 */
const SUPPORTED_RECORD_OPS = new Set(["create", "patch", "delete"]);

// ───────────────────────────── 库写门（对齐在线写水位） ─────────────────────────────

/**
 * 库级写门：与 guards.requireCanEditData 同一接线缝（resolveBaseAccess + edit_data，
 * legacy=visible && (canManage || 任一表 c/u/d)）。不过抛 403——回放器把它归一成 rejected，
 * 而不是让整批请求 403（§8.5：每条 op 独立可裁决，库门是整批共享的前置）。
 */
async function authorizeBaseWrite(userId: string, baseId: string): Promise<LibraryAccessDTO> {
  const access = await resolveBaseAccess(userId, baseId);
  const anyWritable = Object.values(access.tables).some(
    (t) => t.create || t.update || t.delete,
  );
  const legacyAllowed = access.visible && (access.canManage || anyWritable);
  const decided = await enforceOrLegacy({
    guard: "sync.push",
    userId,
    action: "edit_data",
    legacyAllowed,
    ref: { resourceType: "base", resourceId: baseId },
  });
  if (!decided.allowed) {
    throw new HttpError(403, access.visible ? "当前角色无权编辑数据" : "无权访问该 Base", RC.PERMISSION_REVOKED);
  }
  return access;
}

// ───────────────────────────── 小工具 ─────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/** 把一条入站 op 落为 sync_incoming 终态回执（冲突/拒绝/接受都落，幂等重放查它）。 */
async function recordIncomingTx(
  tx: DbTx,
  o: IncomingOp,
  clientId: string,
  baseId: string,
  actorId: string,
  r: PushResult,
): Promise<void> {
  await tx.syncIncoming.create({
    data: {
      clientId,
      clientOpId: o.clientOpId,
      baseId,
      entityType: o.entityType,
      entityId: o.entityId,
      op: o.op,
      payload: JSON.stringify(o.payload ?? {}),
      baseVersion: o.baseVersion,
      actorId,
      status: r.status,
      reasonCode: r.reasonCode ?? null,
      reasonDetail: r.reasonDetail ?? null,
      serverVersion: r.serverVersion ?? r.newVersion ?? 0n,
      attempts: 1,
      decidedBy: actorId,
      decidedAt: new Date(),
    },
  });
}

/** 由 sync_incoming 已存终态行重建幂等回执（重试回同一结果）。 */
function receiptFromIncoming(row: {
  status: string;
  reasonCode: string | null;
  reasonDetail: string | null;
  serverVersion: bigint;
}): PushResult {
  const status = row.status as PushResult["status"];
  return {
    clientOpId: "", // 由调用方按当前 op 填（不同重试 clientOpId 相同，下面补）
    status,
    ...(row.reasonCode ? { reasonCode: row.reasonCode } : {}),
    ...(row.reasonDetail ? { reasonDetail: row.reasonDetail } : {}),
    ...(status === "conflict" ? { serverVersion: row.serverVersion } : {}),
  };
}

// ───────────────────────── 表/字段/掩码的一次性装载与校验 ─────────────────────────

interface TableContext {
  tableId: string;
  fields: FieldMeta[];
  /** 本次写可交给 createRecordTx/updateRecordTx 的字段写闸（已绑定当前 access）。 */
  fieldGate: (fieldIds: readonly string[]) => void;
  mask: Awaited<ReturnType<typeof resolveTableMask>>;
}

/**
 * 装载某表上下文并执行与在线路由同构的「事务前」校验：
 * 表存在/未删/属于本 base、掩码写闸（只校验物理键）。字段写闸闭包留给事务体（与在线同位置）。
 * 任何不过都归一成带原因码的 HttpError，由外层落 rejected。
 */
async function loadTableContext(
  userId: string,
  access: LibraryAccessDTO,
  baseId: string,
  tableId: string,
  writableKeys: readonly string[],
): Promise<TableContext> {
  const table = await prisma.table.findUnique({
    where: { id: tableId },
    select: { baseId: true, deletedAt: true },
  });
  if (!table || table.deletedAt || table.baseId !== baseId) {
    throw new HttpError(400, "目标数据表不存在或不属于该 Base", RC.BAD_TABLE);
  }
  const fields = await loadTableFields(tableId);
  const mask = await resolveTableMask(userId, tableId, fields);
  // 与在线 POST/PATCH 同位置：掩码外/只读物理键整单拦下（异常在内部转 HttpError 403）。
  runMaskWriteGate(mask, writableKeys);
  const fieldGate = fieldWriteGate(access, tableId, (id) => fields.find((f) => f.id === id)?.name ?? id);
  return { tableId, fields, fieldGate, mask };
}

/** 与在线 PATCH/DELETE 同构的行级 rowFilter 前置校验；不满足归 403（落 ROW_NOT_VISIBLE）。 */
async function assertRowVisible(
  userId: string,
  ctx: TableContext,
  recordId: string,
): Promise<void> {
  if (!ctx.mask?.rowFilter) return;
  const before = await hydrateRecordById(ctx.tableId, recordId, {
    fields: ctx.mask.visibleFields,
    deps: ctx.mask.hydrateDeps,
  });
  if (!before || !evaluateRowFilter(ctx.mask.rowFilter, before, ctx.fields, userId)) {
    throw new HttpError(403, "该记录已不在你的可编辑范围内", RC.ROW_NOT_VISIBLE);
  }
}

// ───────────────────────── links 批内临时 id 解析（§8.2/§8.4） ─────────────────────────

interface LinkRef {
  linkFieldId: string;
  authId: string;
  ord: number;
}

/**
 * 解析 create.payload.links：[{linkFieldId, childClientRef, ord}]。
 * idMap 为本批【已成功】create 的「客户端实体 id → 权威 id」映射；默认保留 cuid 时二者相等，
 * 故 idMap.get(ref) ?? ref 即可。引用了尚不存在/后建记录的目标，会在 writeLinks 的关联表归属
 * 校验处被同一规则拦下（rejected=LINK_INVALID，绝不静默丢）。客户端应按本地登记的因果顺序发送
 * （先建被关联记录、再建带关联的记录，§8.2）。
 */
function resolveLinkRefs(
  payload: Record<string, unknown>,
  idMap: ReadonlyMap<string, string>,
): { links: LinkRef[]; bad: boolean } {
  const raw = payload.links;
  if (raw === undefined || raw === null) return { links: [], bad: false };
  if (!Array.isArray(raw)) return { links: [], bad: true };
  const out: LinkRef[] = [];
  for (const item of raw) {
    const obj = asRecord(item);
    const linkFieldId = str(obj?.linkFieldId);
    const childRef = str(obj?.childClientRef);
    if (!linkFieldId || !childRef) return { links: [], bad: true };
    const ord = typeof obj?.ord === "number" && Number.isFinite(obj.ord) ? obj.ord : 0;
    out.push({ linkFieldId, authId: idMap.get(childRef) ?? childRef, ord });
  }
  out.sort((a, b) => a.ord - b.ord);
  return { links: out, bad: false };
}

/** 把解析后的关联按 linkFieldId 分组成 applyFieldWrites 认得的 [{recordId}] 形态，并入物理字段。 */
function mergeLinksIntoFields(
  fields: Record<string, unknown>,
  links: readonly LinkRef[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...fields };
  const byField = new Map<string, string[]>();
  for (const l of links) {
    const arr = byField.get(l.linkFieldId) ?? [];
    arr.push(l.authId);
    byField.set(l.linkFieldId, arr);
  }
  for (const [fid, ids] of byField) out[fid] = ids.map((recordId) => ({ recordId }));
  return out;
}

// ───────────────────────── 事务后默认值补偿（与在线路由同构） ─────────────────────────

/**
 * accepted 事务提交后的「增强写」补偿（autoNumber 编号、static 默认、lookup/formula 初值、
 * 序号缓存失效、关联反向 formula 联动）。与在线 POST/PATCH/DELETE 事务后行为完全一致：
 *   - 在写队列里跑（runWrite，非交互事务，内部自带语句），但与主事务分开；
 *   - 失败只告警、不回滚已 accepted 的记录，也不改回执（这些是派生发，客户端 pull 会拿到）；
 *   - 不额外推进同步版本/不产 oplog（与在线默认值补偿同口径，默认值属服务端权威派生）。
 */
async function runPostCommitCompensation(
  userId: string,
  r: PushResult,
): Promise<void> {
  const ac = r._afterCommit;
  if (!ac || !r.entityId) return;
  try {
    if (ac.op === "create") {
      await runWrite("sync.defaults.create", () =>
        applyCreateDefaults(ac.tableId, r.entityId!, userId));
      invalidateOrdinalCache(ac.tableId);
      await runWrite("sync.defaults.reverseOnCreate", () =>
        applyReverseDefaultsForChild(ac.tableId, [r.entityId!], userId));
    } else if (ac.op === "patch") {
      if (ac.changedFieldIds && ac.changedFieldIds.size > 0) {
        await runWrite("sync.defaults.edit", () =>
          applyEditDefaults(ac.tableId, r.entityId!, ac.changedFieldIds!, userId));
      }
      await runWrite("sync.defaults.reverseOnUpdate", async () => {
        await applyReverseDefaultsForChild(ac.tableId, [r.entityId!], userId);
        const touchedLink = [...(ac.changedFieldIds ?? [])].length > 0
          && (await loadTableFields(ac.tableId)).some(
            (f) => (ac.changedFieldIds?.has(f.id)) && (f.type === "links" || f.type === "subtable"),
          );
        if (touchedLink) await applyLinkChangeDefaults(ac.tableId, [r.entityId!]);
      });
    } else {
      // delete
      invalidateOrdinalCache(ac.tableId);
      await runWrite("sync.defaults.reverseOnDelete", () =>
        applyReverseDefaultsForChild(ac.tableId, [r.entityId!], userId, { includeDeleted: true }));
    }
  } catch (e) {
    // 与在线路由同口径：补偿失败不阻断、不回滚；只记录服务端日志。
    console.error("[sync.push] post-commit defaults failed:", ac.op, r.entityId, e);
  }
}

// ───────────────────────── 主入口 ─────────────────────────

/**
 * 回放一批（一个 base）入站操作。每条 op 在独立 withWriteTx("sync.replay") 内裁决/提交，
 * 串行写队列保证批内因果；前几条 accepted、后一条 conflict/reject 时已确认项不回滚（§8.5）。
 *
 * 调用方（路由）必须已过同步总门 + 登录；本函数再做当前库写门裁决。
 */
export async function pushBaseOps(
  userId: string,
  clientId: string,
  baseId: string,
  ops: readonly IncomingOp[],
): Promise<PushOutcome> {
  // 整批共享的库写门（与在线 requireCanEditData 同源）。不过直接抛 403，由路由转 SYNC_PERMISSION_REVOKED。
  const access = await authorizeBaseWrite(userId, baseId);

  const results: PushResult[] = [];
  // 批内已成功 create 的客户端实体 id → 权威 id（§8.2）。默认保留 cuid 时键值相同。
  const idMap = new Map<string, string>();
  let maxAcceptedSeq: bigint | null = null;

  for (const o of ops) {
    const result = await replayOne(userId, clientId, baseId, access, o, idMap);
    // 事务已提交：新鲜 accepted 才跑事务后默认值补偿（幂等重放回执不带 _afterCommit，不重复补偿）。
    if (result.status === "accepted" && result._afterCommit) {
      await runPostCommitCompensation(userId, result);
    }
    results.push(result);
    if (result.status === "accepted" && result.seq !== undefined) {
      if (maxAcceptedSeq === null || result.seq > maxAcceptedSeq) maxAcceptedSeq = result.seq;
      if (result.entityId) idMap.set(o.entityId, result.entityId);
    }
  }

  // 回执推进游标：把该订阅游标推进到本批 accepted 的最大 seq（客户端不必再回拉自己刚推上的变更）。
  if (maxAcceptedSeq !== null) {
    const sub = await prisma.syncSubscription.findUnique({
      where: { clientId_scopeType_scopeId: { clientId, scopeType: "base", scopeId: baseId } },
      select: { cursorSeq: true },
    });
    if (sub && maxAcceptedSeq > sub.cursorSeq) {
      await prisma.syncSubscription.update({
        where: { clientId_scopeType_scopeId: { clientId, scopeType: "base", scopeId: baseId } },
        data: { cursorSeq: maxAcceptedSeq },
      });
    }
  }

  return { baseId, results, maxAcceptedSeq };
}

/** 幂等命中（sync_incoming 已终态）时重建完全相同的回执。 */
function idempotentReceipt(clientOpId: string, row: {
  status: string; reasonCode: string | null; reasonDetail: string | null; serverVersion: bigint;
  opSeq: bigint | null; opNewVersion: bigint | null; opEntityId: string | null;
}): PushResult {
  const base = receiptFromIncoming(row);
  const out: PushResult = { ...base, clientOpId };
  if (row.status === "accepted") {
    if (row.opSeq !== null) out.seq = row.opSeq;
    if (row.opNewVersion !== null) out.newVersion = row.opNewVersion;
    if (row.opEntityId) out.entityId = row.opEntityId;
  }
  return out;
}

/**
 * 裁决并应用单条 op。先查幂等；未命中则进串行写事务。
 * 任何「不接受」都在同事务只落 sync_incoming（不写主数据/oplog/版本）后正常提交，
 * 使后续 op 不受影响、批次得以部分接受。
 */
async function replayOne(
  userId: string,
  clientId: string,
  baseId: string,
  access: LibraryAccessDTO,
  o: IncomingOp,
  idMap: Map<string, string>,
): Promise<PushResult> {
  // ① 幂等：已终态 → 回同一结果（accepted 回填 seq/newVersion；conflict 回填 serverVersion）。
  const existing = await prisma.syncIncoming.findUnique({
    where: { clientOpId: o.clientOpId },
    select: {
      status: true, reasonCode: true, reasonDetail: true, serverVersion: true, entityId: true,
    },
  });
  if (existing) {
    let opSeq: bigint | null = null;
    let opNewVersion: bigint | null = null;
    if (existing.status === "accepted") {
      const opLog = await prisma.syncOpLog.findUnique({
        where: { clientOpId: o.clientOpId },
        select: { seq: true, newVersion: true, entityId: true },
      });
      opSeq = opLog?.seq ?? null;
      opNewVersion = opLog?.newVersion ?? null;
      return idempotentReceipt(o.clientOpId, {
        status: existing.status, reasonCode: existing.reasonCode, reasonDetail: existing.reasonDetail,
        serverVersion: existing.serverVersion, opSeq, opNewVersion, opEntityId: opLog?.entityId ?? existing.entityId,
      });
    }
    return idempotentReceipt(o.clientOpId, {
      status: existing.status, reasonCode: existing.reasonCode, reasonDetail: existing.reasonDetail,
      serverVersion: existing.serverVersion, opSeq, opNewVersion, opEntityId: existing.entityId,
    });
  }

  // ② 实体/操作白名单（不支持的操作明确拒绝、不静默；restore 随 YN5）。
  if (o.entityType !== "record" || !SUPPORTED_RECORD_OPS.has(o.op)) {
    return await commitTerminal(userId, clientId, baseId, o, {
      clientOpId: o.clientOpId, status: "rejected",
      reasonCode: RC.OP_UNSUPPORTED,
      reasonDetail: o.entityType !== "record"
        ? `本期仅支持 record 实体，收到 ${o.entityType}`
        : `本期回放暂不支持 op=${o.op}`,
    });
  }

  // ③ 串行写事务内裁决 + 应用。
  try {
    return await withWriteTx("sync.replay", (tx) =>
      replayOneTx(tx, userId, clientId, baseId, access, o, idMap));
  } catch (e) {
    // 领域写 Tx 在【写语句之后】失败（唯一约束 P2002、关联写失败、版本断言兜底等）会毒化当前
    // SQLite 事务，不能在同事务补写 incoming——故让其冒泡中止回放事务，在这里另开短事务落终态。
    if (e instanceof AbortReplayError) {
      return await commitTerminal(userId, clientId, baseId, o, e.receipt);
    }
    // 不应到达：事务体内的常规冲突/拒绝都已转成终态（事务内或 AbortReplay）。
    // 仍兜底给明确回执，绝不让整批 push 500。
    if (e instanceof SyncVersionConflictError) {
      return await commitTerminal(userId, clientId, baseId, o, {
        clientOpId: o.clientOpId, status: "conflict", reasonCode: RC.VERSION_CONFLICT,
        serverVersion: e.currentVersion,
      });
    }
    const code = e instanceof HttpError ? (e.code || RC.VALIDATION) : RC.VALIDATION;
    const detail = e instanceof HttpError ? e.message : "回放时发生意外错误";
    return await commitTerminal(userId, clientId, baseId, o, {
      clientOpId: o.clientOpId, status: "rejected", reasonCode: code, reasonDetail: detail,
    });
  }
}

/**
 * 领域写 Tx 失败的穿界信号：携带已归类好的终态回执，中止当前（可能已被毒化的）回放事务，
 * 由 replayOne 外层在新短事务里落 sync_incoming。
 */
class AbortReplayError extends Error {
  readonly receipt: PushResult;
  constructor(receipt: PushResult) {
    super("abort-replay");
    this.name = "AbortReplayError";
    this.receipt = receipt;
  }
}

/** 把一条终态（conflict/rejected）单独落成 sync_incoming（独立短事务，供幂等重放）。 */
async function commitTerminal(
  userId: string,
  clientId: string,
  baseId: string,
  o: IncomingOp,
  r: PushResult,
): Promise<PushResult> {
  try {
    await withWriteTx("sync.incoming", (tx) =>
      recordIncomingTx(tx, o, clientId, baseId, userId, r));
    return r;
  } catch (e) {
    // 并发幂等竞态：两个同 clientOpId 的 push 都错过了事务前的快查，串行落库时后者撞
    // sync_incoming.clientOpId @unique（P2002）。此时前者已定终态——重读并回它的同一回执，
    // 语义仍是幂等，绝不让重复请求冒出 500（§8.1）。
    if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "P2002") {
      return await readIdempotentReceipt(o.clientOpId, o.entityId);
    }
    throw e;
  }
}

/** 按 clientOpId 重读已终态回执（accepted 回填 oplog 的 seq/newVersion/entityId）。 */
async function readIdempotentReceipt(clientOpId: string, fallbackEntityId: string): Promise<PushResult> {
  const row = await prisma.syncIncoming.findUnique({
    where: { clientOpId },
    select: {
      status: true, reasonCode: true, reasonDetail: true, serverVersion: true, entityId: true,
    },
  });
  // 极端情况下 incoming 行尚不可见（不应发生，唯一冲突必因已存在行）；兜底回 conflict。
  if (!row) return { clientOpId, status: "conflict", reasonCode: RC.VERSION_CONFLICT };
  if (row.status === "accepted") {
    const opLog = await prisma.syncOpLog.findUnique({
      where: { clientOpId },
      select: { seq: true, newVersion: true, entityId: true },
    });
    return idempotentReceipt(clientOpId, {
      status: row.status, reasonCode: row.reasonCode, reasonDetail: row.reasonDetail,
      serverVersion: row.serverVersion,
      opSeq: opLog?.seq ?? null, opNewVersion: opLog?.newVersion ?? null,
      opEntityId: opLog?.entityId ?? row.entityId ?? fallbackEntityId,
    });
  }
  return idempotentReceipt(clientOpId, {
    status: row.status, reasonCode: row.reasonCode, reasonDetail: row.reasonDetail,
    serverVersion: row.serverVersion, opSeq: null, opNewVersion: null,
    opEntityId: row.entityId ?? fallbackEntityId,
  });
}

// ───────────────────────── 事务体：按 op 分派 ─────────────────────────

async function replayOneTx(
  tx: DbTx,
  userId: string,
  clientId: string,
  baseId: string,
  access: LibraryAccessDTO,
  o: IncomingOp,
  idMap: Map<string, string>,
): Promise<PushResult> {
  if (o.op === "create") return await replayCreateTx(tx, userId, clientId, baseId, access, o, idMap);
  if (o.op === "patch") return await replayPatchTx(tx, userId, clientId, baseId, access, o);
  // delete
  return await replayDeleteTx(tx, userId, clientId, baseId, access, o);
}

/** 终结分支：在当前事务内只落 incoming（不写主数据），返回事务提交后即生效的回执。 */
async function terminalInTx(
  tx: DbTx,
  userId: string,
  clientId: string,
  baseId: string,
  o: IncomingOp,
  r: PushResult,
): Promise<PushResult> {
  await recordIncomingTx(tx, o, clientId, baseId, userId, r);
  return r;
}

/** create 回放：保留客户端 cuid；baseVersion 须为 0 且实体不存在，否则同 id 冲突（§8.4）。 */
async function replayCreateTx(
  tx: DbTx,
  userId: string,
  clientId: string,
  baseId: string,
  access: LibraryAccessDTO,
  o: IncomingOp,
  idMap: Map<string, string>,
): Promise<PushResult> {
  const tableId = str(o.payload.tableId);
  const rawFields = asRecord(o.payload.fields) ?? {};
  if (!tableId) {
    return await terminalInTx(tx, userId, clientId, baseId, o, {
      clientOpId: o.clientOpId, status: "rejected", reasonCode: RC.MALFORMED,
      reasonDetail: "create 缺少 payload.tableId",
    });
  }

  // 版本/实体状态（权威，串行事务内读）：实体已存在（有版本行或记录行）即同 id 冲突。
  const versionRow = await tx.syncEntityVersion.findUnique({
    where: { id: o.entityId }, select: { version: true, isDeleted: true },
  });
  const existingRecord = await tx.record.findUnique({
    where: { id: o.entityId }, select: { id: true },
  });
  if (versionRow || existingRecord) {
    const cur = versionRow?.version ?? 0n;
    return await terminalInTx(tx, userId, clientId, baseId, o, {
      clientOpId: o.clientOpId, status: "conflict", reasonCode: RC.VERSION_CONFLICT,
      reasonDetail: "该 id 已存在（被别的操作创建）", serverVersion: cur,
    });
  }
  if (o.baseVersion !== 0n) {
    return await terminalInTx(tx, userId, clientId, baseId, o, {
      clientOpId: o.clientOpId, status: "conflict", reasonCode: RC.VERSION_CONFLICT,
      reasonDetail: "新建操作的 baseVersion 应为 0", serverVersion: 0n,
    });
  }

  // links 解析（批内临时 id）。
  const { links, bad } = resolveLinkRefs(o.payload, idMap);
  if (bad) {
    return await terminalInTx(tx, userId, clientId, baseId, o, {
      clientOpId: o.clientOpId, status: "rejected", reasonCode: RC.MALFORMED,
      reasonDetail: "payload.links 形状不合法",
    });
  }
  const payloadFields = mergeLinksIntoFields(rawFields, links);

  // 事务前同构校验（读）：表归属 + 字段掩码写闸。
  let ctx: TableContext;
  try {
    ctx = await loadTableContext(userId, access, baseId, tableId, Object.keys(payloadFields));
  } catch (e) {
    return await rejectFromPreflightTx(tx, userId, clientId, baseId, o, e);
  }

  // 日期 defaultNow 注入（与在线 POST 同一本地墙钟口径），保证必填/默认校验等价。
  const now = new Date();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const localDate = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const localDateTime = `${localDate}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  for (const f of ctx.fields) {
    if ((f.type === "date" || f.type === "datetime") && (f as { defaultNow?: boolean }).defaultNow) {
      const v = payloadFields[f.id];
      if (v === undefined || v === null || v === "") {
        payloadFields[f.id] = f.type === "date" ? localDate : localDateTime;
      }
    }
  }

  // 应用（内部含必填/唯一/字段写闸/关联归属校验，失败随抛）。
  let applied: Awaited<ReturnType<typeof createRecordTx>>;
  try {
    applied = await createRecordTx(tx, {
      tableId, payloadFields, fields: ctx.fields, userId, isDraft: false, fieldGate: ctx.fieldGate,
      // YN4：保留客户端 cuid + 客户端身份记账 + 乐观锁（期望 0）。
      recordId: o.entityId,
      sync: {
        identity: {
          clientId, clientOpId: o.clientOpId, clientBaseVersion: o.baseVersion, expectedBaseVersion: 0n,
        },
        op: "create",
      },
    });
  } catch (e) {
    abortFromWrite(e, o.clientOpId);
  }

  const r: PushResult = {
    clientOpId: o.clientOpId, status: "accepted",
    seq: applied.sync?.seq, newVersion: applied.sync?.newVersion, entityId: applied.id,
    _afterCommit: { op: "create", tableId },
  };
  await recordIncomingTx(tx, o, clientId, baseId, userId, {
    ...r, serverVersion: undefined,
  });
  return r;
}

/** patch 回放：记录须存在且未删；baseVersion 须等于服务端当前版本，否则 conflict。 */
async function replayPatchTx(
  tx: DbTx,
  userId: string,
  clientId: string,
  baseId: string,
  access: LibraryAccessDTO,
  o: IncomingOp,
): Promise<PushResult> {
  // 实体状态：不存在 → NOT_FOUND；已软删 → ENTITY_DELETED；版本不符 → conflict（先于任何写判定）。
  const rec = await tx.record.findUnique({
    where: { id: o.entityId },
    select: { id: true, tableId: true, deletedAt: true, table: { select: { baseId: true } } },
  });
  const versionRow = await tx.syncEntityVersion.findUnique({
    where: { id: o.entityId }, select: { version: true, isDeleted: true },
  });
  if (!rec) {
    return await terminalInTx(tx, userId, clientId, baseId, o, {
      clientOpId: o.clientOpId, status: "rejected", reasonCode: RC.ENTITY_NOT_FOUND,
      reasonDetail: "要修改的记录不存在",
    });
  }
  if (rec.deletedAt || versionRow?.isDeleted) {
    return await terminalInTx(tx, userId, clientId, baseId, o, {
      clientOpId: o.clientOpId, status: "rejected", reasonCode: RC.ENTITY_DELETED,
      reasonDetail: "记录已被删除", serverVersion: versionRow?.version ?? 0n,
    });
  }
  const currentVersion = versionRow?.version ?? 0n;
  if (o.baseVersion !== currentVersion) {
    return await terminalInTx(tx, userId, clientId, baseId, o, {
      clientOpId: o.clientOpId, status: "conflict", reasonCode: RC.VERSION_CONFLICT,
      reasonDetail: `记录版本已变化（本地基于 ${o.baseVersion.toString()}，服务端 ${currentVersion.toString()}）`,
      serverVersion: currentVersion,
    });
  }
  if (rec.table.baseId !== baseId) {
    return await terminalInTx(tx, userId, clientId, baseId, o, {
      clientOpId: o.clientOpId, status: "rejected", reasonCode: RC.BAD_TABLE,
      reasonDetail: "记录不属于该 Base",
    });
  }

  // changed: {fid:{from,to}} → 应用层 patch {fid:to}（容忍裸值）。
  const changed = asRecord(o.payload.changed);
  const tableId = str(o.payload.tableId) ?? rec.tableId;
  if (!changed || Object.keys(changed).length === 0) {
    return await terminalInTx(tx, userId, clientId, baseId, o, {
      clientOpId: o.clientOpId, status: "rejected", reasonCode: RC.MALFORMED,
      reasonDetail: "patch 缺少非空 payload.changed",
    });
  }
  if (tableId !== rec.tableId) {
    return await terminalInTx(tx, userId, clientId, baseId, o, {
      clientOpId: o.clientOpId, status: "rejected", reasonCode: RC.BAD_TABLE,
      reasonDetail: "payload.tableId 与记录所在表不一致",
    });
  }
  const patch: Record<string, unknown> = {};
  for (const [fid, v] of Object.entries(changed)) {
    const cell = asRecord(v);
    patch[fid] = cell && "to" in cell ? cell.to : v;
  }

  let ctx: TableContext;
  try {
    ctx = await loadTableContext(userId, access, baseId, tableId, Object.keys(patch));
    // 行级 rowFilter（与在线 PATCH 同构）。
    await assertRowVisible(userId, ctx, o.entityId);
  } catch (e) {
    return await rejectFromPreflightTx(tx, userId, clientId, baseId, o, e);
  }

  let applied: Awaited<ReturnType<typeof updateRecordTx>>;
  try {
    applied = await updateRecordTx(tx, {
      tableId, recordId: o.entityId, patch, fields: ctx.fields, userId, fieldGate: ctx.fieldGate,
      sync: {
        identity: {
          clientId, clientOpId: o.clientOpId,
          clientBaseVersion: o.baseVersion, expectedBaseVersion: currentVersion,
        },
        op: "patch",
      },
    });
  } catch (e) {
    abortFromWrite(e, o.clientOpId);
  }

  const r: PushResult = {
    clientOpId: o.clientOpId, status: "accepted",
    seq: applied.sync?.seq, newVersion: applied.sync?.newVersion, entityId: o.entityId,
    _afterCommit: { op: "patch", tableId, changedFieldIds: new Set(Object.keys(patch)) },
  };
  await recordIncomingTx(tx, o, clientId, baseId, userId, r);
  return r;
}

/** delete 回放：对已删实体幂等成功（§7.1）；存活则版本须匹配。 */
async function replayDeleteTx(
  tx: DbTx,
  userId: string,
  clientId: string,
  baseId: string,
  access: LibraryAccessDTO,
  o: IncomingOp,
): Promise<PushResult> {
  const rec = await tx.record.findUnique({
    where: { id: o.entityId },
    select: { id: true, tableId: true, deletedAt: true, table: { select: { baseId: true } } },
  });
  const versionRow = await tx.syncEntityVersion.findUnique({
    where: { id: o.entityId }, select: { version: true, isDeleted: true, lastSeq: true },
  });

  // 实体已是墓碑 → delete 幂等成功（不重复推进版本），回执回当前版本/最后 seq（§7.1）。
  // 实体已是墓碑 → delete 幂等成功（不重复推进版本），回执回当前版本/最后 seq（§7.1）。
  // 注意 deletedAt 未删时为 null，必须用 `!== null` 显式判定——不能写 `deletedAt ?? true`
  // （null 会触发 ?? 右值把存活记录误判成已删）。
  const recIsTombstone = rec ? rec.deletedAt !== null : false;
  if (recIsTombstone || versionRow?.isDeleted) {
    const r: PushResult = {
      clientOpId: o.clientOpId, status: "accepted",
      seq: versionRow?.lastSeq ?? 0n, newVersion: versionRow?.version ?? 0n, entityId: o.entityId,
    };
    await recordIncomingTx(tx, o, clientId, baseId, userId, r);
    return r;
  }
  if (!rec) {
    return await terminalInTx(tx, userId, clientId, baseId, o, {
      clientOpId: o.clientOpId, status: "rejected", reasonCode: RC.ENTITY_NOT_FOUND,
      reasonDetail: "要删除的记录不存在",
    });
  }
  const currentVersion = versionRow?.version ?? 0n;
  if (o.baseVersion !== currentVersion) {
    return await terminalInTx(tx, userId, clientId, baseId, o, {
      clientOpId: o.clientOpId, status: "conflict", reasonCode: RC.VERSION_CONFLICT,
      reasonDetail: `记录版本已变化（本地基于 ${o.baseVersion.toString()}，服务端 ${currentVersion.toString()}）`,
      serverVersion: currentVersion,
    });
  }
  if (rec.table.baseId !== baseId) {
    return await terminalInTx(tx, userId, clientId, baseId, o, {
      clientOpId: o.clientOpId, status: "rejected", reasonCode: RC.BAD_TABLE,
      reasonDetail: "记录不属于该 Base",
    });
  }

  let ctx: TableContext;
  try {
    // delete 无物理字段键；仍装载表上下文以跑 rowFilter（与在线 DELETE 同构）。
    ctx = await loadTableContext(userId, access, baseId, rec.tableId, []);
    await assertRowVisible(userId, ctx, o.entityId);
  } catch (e) {
    return await rejectFromPreflightTx(tx, userId, clientId, baseId, o, e);
  }

  let applied: Awaited<ReturnType<typeof softDeleteRecordTx>>;
  try {
    applied = await softDeleteRecordTx(tx, o.entityId, userId, {
      identity: {
        clientId, clientOpId: o.clientOpId,
        clientBaseVersion: o.baseVersion, expectedBaseVersion: currentVersion,
      },
      op: "delete",
    });
  } catch (e) {
    abortFromWrite(e, o.clientOpId);
  }

  const r: PushResult = {
    clientOpId: o.clientOpId, status: "accepted",
    seq: applied.sync?.seq, newVersion: applied.sync?.newVersion, entityId: o.entityId,
    _afterCommit: { op: "delete", tableId: rec.tableId },
  };
  await recordIncomingTx(tx, o, clientId, baseId, userId, r);
  return r;
}

/**
 * 把异常归类为一条终态回执（不落库），供两个写点复用：
 *   - 409（含唯一约束）→ NOT_UNIQUE；
 *   - 403 → ROW_NOT_VISIBLE / FIELD_FORBIDDEN；
 *   - SyncVersionConflictError → conflict/VERSION_CONFLICT（带服务端当前版本）；
 *   - Prisma P2002（同 cuid 撞库，理论上已被版本预检拦，兜底）→ conflict；
 *   - 其余 HttpError 用其 code；其它 → VALIDATION。
 */
function classifyError(e: unknown, clientOpId: string): PushResult {
  if (e instanceof SyncVersionConflictError) {
    return {
      clientOpId, status: "conflict", reasonCode: RC.VERSION_CONFLICT,
      serverVersion: e.currentVersion,
    };
  }
  if (e instanceof HttpError) {
    let reasonCode = e.code || RC.VALIDATION;
    if (e.status === 403) {
      reasonCode = e.code === RC.ROW_NOT_VISIBLE ? RC.ROW_NOT_VISIBLE : RC.FIELD_FORBIDDEN;
    } else if (e.status === 409) {
      reasonCode = RC.NOT_UNIQUE;
    }
    return { clientOpId, status: "rejected", reasonCode, reasonDetail: e.message };
  }
  // Prisma 唯一约束（如并发下同一 cuid 已被别的 clientOpId 建出）→ 按同 id 冲突处理。
  if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "P2002") {
    return { clientOpId, status: "conflict", reasonCode: RC.VERSION_CONFLICT, reasonDetail: "该 id 已存在" };
  }
  return {
    clientOpId, status: "rejected", reasonCode: RC.VALIDATION,
    reasonDetail: e instanceof Error ? e.message : "操作未通过服务端校验",
  };
}

/**
 * 【写前纯读校验】失败（表归属、字段掩码写闸、行级 rowFilter；均为只读，未执行任何变更语句，
 * 事务未被毒化）→ 在当前事务内只落 incoming 终态并正常提交，不影响批内其它 op。
 */
async function rejectFromPreflightTx(
  tx: DbTx,
  userId: string,
  clientId: string,
  baseId: string,
  o: IncomingOp,
  e: unknown,
): Promise<PushResult> {
  return await terminalInTx(tx, userId, clientId, baseId, o, classifyError(e, o.clientOpId));
}

/**
 * 【领域写 Tx 内】失败（可能已执行变更语句、SQLite 事务已被毒化）→ 绝不在同事务补写。
 * 归类后抛 AbortReplayError 中止回放事务（主数据/oplog/版本随 ROLLBACK 一并撤销，绝不留半成品），
 * 由 replayOne 外层在新短事务里落这条终态。
 */
function abortFromWrite(e: unknown, clientOpId: string): never {
  throw new AbortReplayError(classifyError(e, clientOpId));
}
