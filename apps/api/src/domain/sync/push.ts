// YN4/YN5 离线同步：push 回放——写队列串行应用、clientOpId 幂等去重、记录级乐观锁、批内部分接受、
// 按【当前】权限逐 op 重判 + rejected/quarantined 隔离。
//
// 设计权威：docs/design/2026-10-node-mode/DESIGN-OFFLINE-SYNC.md
//   §5.2（payload 形状）、§7.1（记录级乐观锁/实体已删）、§8.1（双表幂等）、§8.2（批内因果 +
//   子引用客户端临时 id）、§8.4（默认保留客户端 cuid 作权威 id）、§8.5（每条 op 独立可裁决、
//   部分接受不回滚已确认项、统一 withWriteTx("sync.replay") 原子一致）、§9.1（服务端唯一裁决者：
//   只认当前 token+当前策略，对每条 op 调引擎 decide）、§9.2（rejected/quarantined/ENTITY_DELETED）、
//   §9.5（accepted/rejected/quarantined 均写审计，不落字段明文）、§13（push 信封/回执/错误码）、
//   §15.2（YN4/YN5 验收）。
//
// 权限裁决（YN5 起，服务端是唯一裁决者，§9.1）：
//   - 库门 enter：当前 token 对 base 的 enter 引擎裁决。失败＝成员身份异常——若该用户【曾订阅】
//     此 base（sync_subscriptions 有 actorId 行，说明离线期间被移出/停用）→ 整批逐条 quarantined
//     （进隔离区不销毁，重授权后可 retry / 可 discard 留痕）；从未订阅的陌生主体 → rejected。
//   - 逐表重判：仍在库内时，对每条 op 的目标表节点调 engineDecideResource，动作映射与在线端点
//     同源——create→c、patch→u、delete→d、restore→manage_table（§9.1）。表级某动作被收回 →
//     rejected=SYNC_PERMISSION_REVOKED（操作不生效、明确告知），绝不因离线时的旧角色而放行。
//   - 行级 rowFilter 失配 → ROW_NO_LONGER_VISIBLE；字段被收回出现在写键里 → FIELD_FORBIDDEN，
//     本期整 op 拒绝（U4：不剥字段静默提交）。
//   - 引擎故障 fail-closed（enforceOrLegacy 抛 503，与在线写同构），不落任何主数据、整批可重试。
//   - 与在线写同水位：除逐表重判外，仍过字段掩码写闸 runMaskWriteGate、字段写闸 fieldWriteGate、
//     行级 rowFilter，缺一则成越权漏洞。
// 裁决四态：accepted（落库）/conflict（版本不符，YN6 弹窗）/rejected（明确无权/非法，不生效）/
//   quarantined（身份异常隔离，可重试/放弃）。审计打点在路由层按本批【新终态】发（幂等重放不刷审计）。
//   restore 回放随 YN5 接入（见 replayRestoreTx）；不支持的实体/操作仍回 rejected=SYNC_OP_UNSUPPORTED。
//
// 幂等（§8.1）：每条入站 op 都在 sync_incoming 落一行终态回执（clientOpId @unique），accepted
//   另外在 sync_op_log 落事实（其 clientOpId 亦 @unique，双保险唯一约束）。重试先查 sync_incoming，
//   命中即回同一结果，绝不重复应用；唯一约束是并发竞态下的兜底（撞了重读已存回执）。

import { randomUUID } from "node:crypto";
import type { LibraryAccessDTO, ResourceAction } from "@gx/shared-types";
import { prisma, withWriteTx, runWrite, type DbTx } from "../../db.js";
import { HttpError } from "../../httpError.js";
import { resolveBaseAccess, fieldWriteGate } from "../authz/libraryPolicy.js";
import { enforceOrLegacy } from "../authz/enforceGate.js";
import { resolveTableMask } from "../authz/maskGate.js";
import { fieldScopeOf, stripHiddenFromRecords } from "../authz/fieldScope.js";
import { evaluateRowFilter } from "../authz/rowFilter.js";
import { loadTableFields, hydrateRecordById } from "../recordService.js";
import { runMaskWriteGate, createRecordTx, updateRecordTx, softDeleteRecordTx, restoreRecordTx } from "../recordWrite.js";
import {
  applyCreateDefaults,
  applyEditDefaults,
  applyReverseDefaultsForChild,
  applyLinkChangeDefaults,
} from "../defaults.js";
import { invalidateOrdinalCache } from "../prismaDeps.js";
import type { FieldMeta } from "../types.js";
import { SyncVersionConflictError } from "./oplog.js";
import { writeStructureOpTx, readSchemaVersionTx, readSchemaVersion } from "./structureOplog.js";
import {
  getStructureOpHandler,
  isStructureEntityType,
  type StructureOpHandler,
  type StructureResolution,
} from "./structureRegistry.js";
import { buildStructureSnapshot, resolveStructureTableId } from "./structureSnapshot.js";
import { canConvertStoredValue, isEmptyStoredValue } from "./structureValidation.js";
import { writeTreeOpTx, readTreeVersion, TREE_WORKSPACE_ID } from "./treeOplog.js";
import { getTreeOpHandler, isTreeEntityType, type TreeOpHandler } from "./navRegistry.js";
import { hasOrgAction } from "../org/authorization.js";

// ───────────────────────────────── 信封类型 ─────────────────────────────────

/** 路由已做过基本结构校验的一条入站操作（原样对应 §13 push.req.ops[i]）。 */
export interface IncomingOp {
  clientOpId: string;
  entityType: string;
  entityId: string;
  op: string;
  /** 客户端提交时所基于的实体版本（字符串承载 BigInt，路由保证 /^\d+$/）。 */
  baseVersion: bigint;
  /**
   * 【additive，§19.2】仅 record op 可有：该记录所属表在客户端发起写时的 table_schema 结构版本。
   * null＝旧客户端/未携带 → 不启用结构依赖门（默认零行为变化，不阻断任何现存调用方）。
   * 携带且 < 服务端当前 schemaVersion → 数据 op 挂起为结构依赖冲突（等结构分叉先被人工解决）。
   */
  baseSchemaVersion?: bigint | null;
  payload: Record<string, unknown>;
  /**
   * 【内部，路由永不设置】YN6：非空表示这是冲突人工解决产生的 resolve op，值＝被解决的原始冲突
   * clientOpId。仅由 resolveConflict 在域内构造 op 时挂；replayPatchTx 据此把 oplog 记为
   * result="resolved"/conflictOf。普通 push 的 op 恒无此字段。
   */
  _resolveOf?: string;
  /**
   * 【内部，路由永不设置】#788-D：true 表示这是一条曾因结构依赖挂起（STRUCTURE_DEPENDENCY）的数据
   * op，在用户显式解决结构分叉后【按服务端当前新结构核对重放】。作用有二：
   *   ① structureDependencyGateTx 见到此位不再因 baseSchemaVersion 落后而再次挂起（用户已确认对齐）；
   *   ② create/patch 主写前对涉及字段按【当前类型/选项】做可转换核对：可转则显式转型后落库，
   *      不可转（如「张三」→数字）或字段已被对方删除 → 落数据冲突，绝不静默丢/静默写脏值（§19.3-3）。
   */
  _reconcileSchema?: boolean;
}

/** 单条裁决回执（§13 push.results[i]）。BigInt 序列化为字符串由路由层负责。 */
export interface PushResult {
  clientOpId: string;
  /**
   * 裁决终态。前四态由本次 push 实时裁决产生；`dropped` 仅在【幂等重读】历史行时出现——
   * 用户已在同步中心显式放弃该 op 后，设备 outbox 重发同一条，回 dropped（不复活、不重放、
   * 不报错），客户端据此清掉本地 outbox。审计只对 accepted/rejected/quarantined 打点，dropped
   * 是用户在同步中心的独立决定，路由 auditFreshTerminal 自然跳过。
   */
  status: "accepted" | "conflict" | "rejected" | "quarantined" | "dropped";
  reasonCode?: string;
  reasonDetail?: string;
  /**
   * 【内部，路由层不序列化】本条是否为【本次请求新落】的终态回执（新写了一行 sync_incoming）。
   * true 时路由层据 status 发 sync_push_accepted/rejected/quarantined 审计；幂等重放回执不带
   * 此标记，不重复审计（§9.5：审计随裁决产生，重放同一裁决不应刷审计）。
   */
  _freshTerminal?: boolean;
  /** accepted：本次分配的服务端 seq / 应用后新版本。 */
  seq?: bigint;
  newVersion?: bigint;
  /** accepted=create：最终权威 id（默认等于客户端 entityId，保留 cuid）。 */
  entityId?: string;
  /** conflict：服务端当前版本，供客户端做双版本弹窗（YN6）。 */
  serverVersion?: bigint;
  /**
   * 【内部，路由层不序列化】conflict 时按当前权限脱敏后的服务端当前记录快照（YN6 双版本弹窗
   * 右侧）。recordIncomingTx 把它 JSON 序列化进 sync_incoming.conflictServerPayload；不回字段明文
   * 到 push 回执（前端经 GET /incoming 取本人冲突项时才带），与 §7.2 一致。
   */
  _conflictServerPayload?: Record<string, unknown>;
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
  QUARANTINED: "SYNC_QUARANTINED",
  ROW_NOT_VISIBLE: "SYNC_ROW_NO_LONGER_VISIBLE",
  FIELD_FORBIDDEN: "SYNC_FIELD_FORBIDDEN",
  VALIDATION: "SYNC_VALIDATION",
  NOT_UNIQUE: "SYNC_NOT_UNIQUE",
  BAD_TABLE: "SYNC_BAD_TABLE",
  LINK_INVALID: "SYNC_LINK_INVALID",
  OP_UNSUPPORTED: "SYNC_OP_UNSUPPORTED",
  MALFORMED: "SYNC_MALFORMED_PAYLOAD",
  INCOMING_NOT_FOUND: "SYNC_INCOMING_NOT_FOUND",
  INCOMING_STATE: "SYNC_INCOMING_INVALID_STATE",
  RESOLVE_BAD_DECISION: "SYNC_RESOLVE_BAD_DECISION",
  RESOLVE_NOT_CONFLICT: "SYNC_RESOLVE_NOT_CONFLICT",
  RESOLVE_MALFORMED: "SYNC_RESOLVE_MALFORMED",
  // YN7 结构轨（§19.2/§19.3）：结构版本分叉（表结构已被他人改变）。
  STRUCTURE_CONFLICT: "SYNC_STRUCTURE_VERSION_CONFLICT",
  // #788-A 数据 op 的结构依赖（§19.2）：record op 携带的 baseSchemaVersion 落后于服务端当前
  // table_schema 版本（离线期间表结构已被他人改变）→ 挂起，等结构分叉人工解决后按新结构重放。
  STRUCTURE_DEPENDENCY: "SYNC_STRUCTURE_DEPENDENCY_CONFLICT",
  // #788-A（§19.3 场景 4）：数据 op 所属表已被（对方）软删 → 依赖冲突，用户 restore_table 后整体重放。
  TABLE_DELETED: "SYNC_TABLE_DELETED",
  // #788-D（§19.3 场景 3）：挂起的数据 op 在结构分叉解决后按【新结构】核对，某字段已被对方删除或其
  // 存量值无法安全转到新类型（如「张三」→数字）→ 转【数据冲突】弹窗，逐记录改值或放弃，绝不静默丢。
  SCHEMA_REPLAY_VALUE: "SYNC_SCHEMA_REPLAY_VALUE_CONFLICT",
  // #788-D：结构冲突的复合 resolve 载荷非法（steps 缺失/形状错）。
  RESOLVE_STEPS_MALFORMED: "SYNC_RESOLVE_STEPS_MALFORMED",
} as const;

/** 本期回放支持的 record 操作（YN5 起接入 restore，见 replayRestoreTx）。 */
const SUPPORTED_RECORD_OPS = new Set(["create", "patch", "delete", "restore"]);

/** record op → 目标表节点资源动作映射（§9.1：与在线端点同一映射；restore 在线走 manage_table）。 */
const RECORD_OP_ACTION: Record<string, ResourceAction> = {
  create: "c",
  patch: "u",
  delete: "d",
  restore: "manage_table",
};

// ───────────────────────── 库门探测 + 成员关系分流（YN5 §9.1/§9.2） ─────────────────────────

/** 库门裁决结果：enter 通过则带当前 access；否则带「是否曾订阅」供 quarantine/rejected 分流。 */
type BaseGate =
  | { allowed: true; access: LibraryAccessDTO }
  | { allowed: false; everSubscribed: boolean };

/**
 * 库门探测：按【当前 token】对 base 做 enter 引擎裁决（与 guards.requireCanView 同一接线缝）。
 * YN5 起库门不再用 edit_data 整批 403——能否写某张表下沉到逐表 engineDecideResource(c/u/d)，
 * 故库门只判「还进不进得去这个库」。失败不抛：由调用方按成员关系逐 op 分流。
 * 引擎故障照常抛 HttpError 503（enforceOrLegacy fail-closed），绝不静默放行、也不落终态。
 */
async function probeBaseEnter(userId: string, clientId: string, baseId: string): Promise<BaseGate> {
  const access = await resolveBaseAccess(userId, baseId);
  const decided = await enforceOrLegacy({
    guard: "sync.push",
    userId,
    action: "enter",
    legacyAllowed: access.visible,
    ref: { resourceType: "base", resourceId: baseId },
  });
  if (decided.allowed) return { allowed: true, access };
  // 成员关系异常判定（§9.2）：该用户【曾在此节点订阅过此 base】（任意客户端、sync_subscriptions
  // 有 actorId 行）说明离线期间被移出 base/组织 → quarantine；从未订阅的陌生主体 → rejected。
  const ever = await prisma.syncSubscription.findFirst({
    where: { scopeType: "base", scopeId: baseId, actorId: userId },
    select: { id: true },
  });
  return { allowed: false, everSubscribed: !!ever };
}

/**
 * 逐表当前权限重判（§9.1）：对目标表节点调引擎 decide，动作与在线端点同源
 * （create→c/patch→u/delete→d/restore→manage_table）。
 * 表级动作被收回 → 抛 403 PERMISSION_REVOKED（由回放归一成 rejected，操作不生效、明确告知）。
 * 引擎故障 → enforceOrLegacy 抛 503，调用方【不得】落成终态，须冒泡 fail-closed（整批可安全重试）。
 */
async function assertTableAction(
  userId: string,
  tableId: string,
  action: ResourceAction,
): Promise<void> {
  const decided = await enforceOrLegacy({
    guard: "sync.push.table",
    userId,
    action,
    // authority 语义：只认引擎当前裁决，legacy 位不参与（传入不放大权限的 false）。
    legacyAllowed: false,
    ref: { resourceType: "table", resourceId: tableId },
  });
  if (!decided.allowed) {
    throw new HttpError(403, "当前角色已无权对此数据表执行该操作（权限可能在离线期间被收回）", RC.PERMISSION_REVOKED);
  }
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
  baseId: string | null,
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
      // YN6：conflict 时存按当前权限脱敏的服务端快照，供前端双版本弹窗（GET /incoming 透出）。
      conflictServerPayload: r._conflictServerPayload
        ? JSON.stringify(r._conflictServerPayload)
        : null,
      attempts: 1,
      decidedBy: actorId,
      decidedAt: new Date(),
    },
  });
  // 标记本行为本次请求【新落】终态——路由层据此发审计；幂等重放回执不经过此处，天然不刷审计。
  r._freshTerminal = true;
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

/**
 * #788-A 数据 op 的结构依赖门（§19.2/§19.3 场景 4），必须在回放事务内调用（同事务读到的
 * table_schema 版本与随后的主写一致，避免事务外快照过期）。
 *
 *   - 父表已（被对方）软删 → 无条件落 conflict=SYNC_TABLE_DELETED（不论是否携带结构版本；
 *     用户 restore_table 后这些数据 op 整体重放，§19.3-4）。表不存在/不属本 base 不在此判定，
 *     交给既有 BAD_TABLE 校验（保持单一事实源）。
 *   - 携带 baseSchemaVersion（新客户端）且与服务端当前 table_schema 版本不一致（落后为主，
 *     超前亦拦——结构 op 尚未被服务端接受时数据不得抢先落库）→ conflict=STRUCTURE_DEPENDENCY，
 *     挂起等结构分叉先被人工解决、再按新结构重放。
 *   - baseSchemaVersion 为 null/缺省（旧客户端）→ 不启用版本门（additive、默认零行为变化）。
 *
 * 返回终态回执表示「应挂起/冲突，只落 incoming、不写主数据」；返回 null 表示通过、继续正常回放。
 */
async function structureDependencyGateTx(
  tx: DbTx,
  userId: string,
  clientId: string,
  baseId: string,
  o: IncomingOp,
  tableId: string,
): Promise<PushResult | null> {
  const table = await tx.table.findUnique({
    where: { id: tableId },
    select: { baseId: true, deletedAt: true },
  });
  // 场景 4：父表软删 → 依赖冲突（与表存在性/归属校验互不覆盖；此处只在确属本 base 的软删表上判）。
  if (table && table.baseId === baseId && table.deletedAt) {
    const schemaVersion = await readSchemaVersionTx(tx, tableId);
    return await terminalInTx(tx, userId, clientId, baseId, o, {
      clientOpId: o.clientOpId,
      status: "conflict",
      reasonCode: RC.TABLE_DELETED,
      reasonDetail: "该数据表已被删除（可能由他人在你离线期间操作）；请先恢复数据表，你的这些数据改动会在恢复后整体重放",
      serverVersion: schemaVersion,
    });
  }

  // §19.2 结构版本依赖门：仅对显式携带 baseSchemaVersion 的新客户端启用。
  if (!(o._reconcileSchema === true) && o.baseSchemaVersion !== null && o.baseSchemaVersion !== undefined) {
    const currentSchemaVersion = await readSchemaVersionTx(tx, tableId);
    if (o.baseSchemaVersion !== currentSchemaVersion) {
      return await terminalInTx(tx, userId, clientId, baseId, o, {
        clientOpId: o.clientOpId,
        status: "conflict",
        reasonCode: RC.STRUCTURE_DEPENDENCY,
        reasonDetail: `表结构在你离线期间已变化（数据改动基于结构版本 ${o.baseSchemaVersion.toString()}，服务端当前 ${currentSchemaVersion.toString()}）；请先解决结构冲突，数据将按最新结构重新核对后应用`,
        serverVersion: currentSchemaVersion,
      });
    }
  }
  return null;
}

/**
 * #788-D 把可转换标量值显式转成【新类型】的规范形态（§19.3-3「如 "12"→12 则经用户确认后应用」）。
 * 调用前已用 canConvertStoredValue 判定可转；此处只做无歧义转换：数字组→number、checkbox→boolean、
 * 文本组→string、日期/单选/多选/JSON 原样（日期串与选项 id 本身就是规范存储形态）。
 */
function coerceValueToType(v: unknown, type: string): unknown {
  if (["number", "currency", "percent", "duration", "rating"].includes(type)) {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string") return Number(v.trim());
    return v;
  }
  if (type === "checkbox") {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (["true", "1", "是", "yes"].includes(s)) return true;
      if (["false", "0", "否", "no"].includes(s)) return false;
    }
    return v;
  }
  if (["singleLineText", "longText", "richText", "email", "url", "phone"].includes(type)) {
    if (typeof v === "string") return v;
    return String(v);
  }
  return v;
}

/**
 * #788-D 结构分叉解决后，把一条挂起的数据 op 按【服务端当前新结构】核对（§19.3-3，只读、在主写前）：
 *   - 负载里的字段已被对方删除（或已软删）→ 数据冲突（该列已不存在，需用户逐记录改值/放弃，绝不丢）；
 *   - 非空值无法安全转到字段当前类型（如「张三」→number）→ 数据冲突，带首个原因；
 *   - 可安全转换 → 就地把值规范成新类型（"12"→12），随后走正常 create/patch 主写与现有校验。
 * 空值恒放行（清空不阻碍）。关联/计算等非标量字段不在此转换，交由既有写校验。
 * @returns 冲突时返回面向用户的原因（调用方落 conflict）；通过返回 null。
 */
function reconcilePayloadToSchema(
  fields: FieldMeta[],
  payloadFields: Record<string, unknown>,
): string | null {
  for (const [fieldId, rawVal] of Object.entries(payloadFields)) {
    // loadTableFields 只给活字段；查不到即该字段已在结构变化中被删。
    const f = fields.find((x) => x.id === fieldId);
    if (!f) {
      return `字段（${fieldId}）在结构变化后已不存在，该记录改动需重新选择字段或放弃（不会自动丢弃你的数据）`;
    }
    if (isEmptyStoredValue(rawVal)) continue;
    // loadTableFields 只给活字段、options 已是解析后的 SelectOption[]（非 JSON 串）。
    const options = (f.type === "singleSelect" || f.type === "multiSelect") ? f.options : null;
    const check = canConvertStoredValue(rawVal, f.type, options);
    if (!check.ok) {
      return `字段「${f.name}」已改为${f.type}类型，原值${check.reason ?? "无法转换"}，请逐记录改值或放弃该改动（不会自动写入不兼容的值）`;
    }
    payloadFields[fieldId] = coerceValueToType(rawVal, f.type);
  }
  return null;
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

/**
 * conflict 时构建【服务端当前版本快照】（YN6 §7.2 双版本弹窗右侧），按【当前 token】权限脱敏：
 * 走与 snapshot/visibility 同源的 fieldScopeOf → resolveTableMask → hydrate(单条) → rowFilter →
 * stripHidden 管线，绝不回吐掩码外/隐藏字段明文。仅用于展示与字段对照，只读、不推进任何版本。
 *
 * 失败软处理：快照仅为弹窗展示，构建失败绝不能阻断 conflict 终态落库（那会弄丢用户的离线改动）；
 * 出错时返回最小占位 {unavailable:true}，前端仍可凭 serverVersion 让用户选「采用服务端」。
 */
async function buildConflictServerPayload(
  userId: string,
  baseId: string,
  o: IncomingOp,
  serverVersion: bigint,
): Promise<Record<string, unknown>> {
  const base = { version: serverVersion.toString(), serverTime: new Date().toISOString() };
  try {
    const rec = await prisma.record.findUnique({
      where: { id: o.entityId },
      select: { id: true, tableId: true, deletedAt: true, table: { select: { baseId: true } } },
    });
    if (!rec) return { ...base, exists: false, fields: {} };
    if (rec.table.baseId !== baseId) return { ...base, exists: false, fields: {} };
    const fields = await loadTableFields(rec.tableId);
    const access = await resolveBaseAccess(userId, baseId);
    const scope = fieldScopeOf(access, rec.tableId, fields);
    const scopeFields = scope.active ? scope.fields : fields;
    const mask = await resolveTableMask(userId, rec.tableId, scopeFields);
    if (mask && mask.mask.cap.visible === false) {
      return { ...base, tableId: rec.tableId, tableReadable: false, fields: {} };
    }
    const queryFields = mask ? mask.visibleFields : scopeFields;
    const hydrated = await hydrateRecordById(rec.tableId, rec.id, {
      fields: queryFields,
      deps: mask?.hydrateDeps,
    });
    if (!hydrated) return { ...base, tableId: rec.tableId, rowVisible: false, fields: {} };
    if (mask?.rowFilter && !evaluateRowFilter(mask.rowFilter, hydrated, fields, userId)) {
      return { ...base, tableId: rec.tableId, rowVisible: false, fields: {} };
    }
    const [stripped] = stripHiddenFromRecords([hydrated], scope.hiddenIds);
    return {
      ...base,
      tableId: rec.tableId,
      exists: true,
      isDeleted: rec.deletedAt !== null,
      tableReadable: true,
      rowVisible: true,
      // 已按当前权限裁剪/脱敏的平铺字段（key=fieldId），与快照同一口径。
      fields: (stripped?.fields ?? {}) as Record<string, unknown>,
    };
  } catch (e) {
    console.error("[sync.push] build conflictServerPayload failed:", o.clientOpId, e);
    return { ...base, unavailable: true };
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
 * 串行写队列保证批内因果；前几条 accepted、后一条 conflict/reject/quarantine 时已确认项不回滚（§8.5）。
 *
 * 调用方（路由）必须已过同步总门 + 登录；本函数再做【当前】库门 enter 探测 + 逐 op 当前权限重判。
 * 库门失败（被移出/陌生主体）时不整批 403，而是逐条落 quarantine/rejected 终态（§9.1/§9.2）。
 */
export async function pushBaseOps(
  userId: string,
  clientId: string,
  baseId: string,
  ops: readonly IncomingOp[],
): Promise<PushOutcome> {
  // 库门探测（当前 enter）；失败分流 quarantine（曾订阅＝成员关系被移除）/rejected（陌生主体）。
  const gate = await probeBaseEnter(userId, clientId, baseId);

  const results: PushResult[] = [];
  // 批内已成功 create 的客户端实体 id → 权威 id（§8.2）。默认保留 cuid 时键值相同。
  const idMap = new Map<string, string>();
  let maxAcceptedSeq: bigint | null = null;

  for (const o of ops) {
    const result = gate.allowed
      ? await replayOne(userId, clientId, baseId, gate.access, o, idMap)
      : await replayGatedOut(userId, clientId, baseId, o, gate.everSubscribed);
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

// ─────────────────── YN8：工作区导航树轨（navnode；不属任何 base） ───────────────────

/**
 * 回放一批【工作区级】导航树 op（§19.6）。与 record/结构轨的区别：
 *   - 不过 base 库门（树是跨库工作区资源），改成逐条按【当前】组织动作 manage_menu 裁决——
 *     与在线 /api/v1/nav、/api/v1/nodes 路由的 requireOrgAction("manage_menu") 完全同口径；
 *   - 乐观锁基线 o.baseVersion 复用为【工作区 treeVersion】（单工作区单钟，见 treeOplog）；
 *   - sync_incoming / sync_op_log 的 baseId 恒 null；回执推进 scopeType="workspace_tree" 订阅游标；
 *   - 每条 op 独立串行事务、部分接受（§8.5），幂等仍走全局 clientOpId。
 * 无 manage_menu → 整批逐条 rejected=PERMISSION_REVOKED（组织动作无 quarantine 语义）。
 */
export async function pushTreeOps(
  userId: string,
  clientId: string,
  ops: readonly IncomingOp[],
): Promise<{ results: PushResult[]; maxAcceptedSeq: bigint | null }> {
  const canManage = await hasOrgAction(userId, "manage_menu");

  const results: PushResult[] = [];
  let maxAcceptedSeq: bigint | null = null;

  for (const o of ops) {
    const result = canManage
      ? await replayTreeOne(userId, clientId, o)
      : await commitTerminal(userId, clientId, null, o, {
          clientOpId: o.clientOpId, status: "rejected", reasonCode: RC.PERMISSION_REVOKED,
          reasonDetail: "当前角色已无权管理导航树（权限可能在离线期间被收回）",
        });
    results.push(result);
    if (result.status === "accepted" && result.seq !== undefined) {
      if (maxAcceptedSeq === null || result.seq > maxAcceptedSeq) maxAcceptedSeq = result.seq;
    }
  }

  // 推进工作区树订阅游标（客户端不必回拉自己刚推上的树变更）。
  if (maxAcceptedSeq !== null) {
    const sub = await prisma.syncSubscription.findUnique({
      where: { clientId_scopeType_scopeId: { clientId, scopeType: "workspace_tree", scopeId: TREE_WORKSPACE_ID } },
      select: { cursorSeq: true },
    });
    if (sub && maxAcceptedSeq > sub.cursorSeq) {
      await prisma.syncSubscription.update({
        where: { clientId_scopeType_scopeId: { clientId, scopeType: "workspace_tree", scopeId: TREE_WORKSPACE_ID } },
        data: { cursorSeq: maxAcceptedSeq },
      });
    }
  }

  return { results, maxAcceptedSeq };
}

/** 裁决并应用单条树 op：先幂等，再进串行写事务（复用全局终态/幂等件，baseId 恒 null）。 */
async function replayTreeOne(userId: string, clientId: string, o: IncomingOp): Promise<PushResult> {
  const prior = await lookupIdempotentReceipt(o.clientOpId, o.entityId);
  if (prior) return prior;

  // 硬白名单：非树轨实体/未登记 op 在进事务前明确拒绝。
  if (!isTreeEntityType(o.entityType)) {
    return await commitTerminal(userId, clientId, null, o, {
      clientOpId: o.clientOpId, status: "rejected", reasonCode: RC.OP_UNSUPPORTED,
      reasonDetail: `工作区树通道暂不支持实体类型 ${o.entityType}`,
    });
  }

  try {
    return await withWriteTx("sync.replayTree", (tx) => replayTreeOneTx(tx, userId, clientId, o));
  } catch (e) {
    if (e instanceof AbortReplayError) {
      return await commitTerminal(userId, clientId, null, o, e.receipt);
    }
    if (e instanceof HttpError && e.status >= 500) throw e;
    if (e instanceof SyncVersionConflictError) {
      return await commitTerminal(userId, clientId, null, o, {
        clientOpId: o.clientOpId, status: "conflict", reasonCode: RC.STRUCTURE_CONFLICT,
        reasonDetail: `导航树已变化（本地基于树版本 ${o.baseVersion.toString()}，服务端 ${e.currentVersion.toString()}）`,
        serverVersion: e.currentVersion,
      });
    }
    const code = e instanceof HttpError ? (e.code || RC.VALIDATION) : RC.VALIDATION;
    const detail = e instanceof HttpError ? e.message : "回放导航操作时发生意外错误";
    return await commitTerminal(userId, clientId, null, o, {
      clientOpId: o.clientOpId, status: "rejected", reasonCode: code, reasonDetail: detail,
    });
  }
}

async function replayTreeOneTx(
  tx: DbTx,
  userId: string,
  clientId: string,
  o: IncomingOp,
): Promise<PushResult> {
  const handler: TreeOpHandler | null = getTreeOpHandler(o.entityType, o.op);
  if (!handler) {
    return await terminalInTx(tx, userId, clientId, null, o, {
      clientOpId: o.clientOpId, status: "rejected", reasonCode: RC.OP_UNSUPPORTED,
      reasonDetail: `暂不支持导航树操作 ${o.entityType}.${o.op}`,
    });
  }

  // 写前纯读校验（只读，未毒化事务，可同事务落终态）。
  try {
    await handler.assertTx(tx, o);
  } catch (e) {
    return await rejectFromPreflightTx(tx, userId, clientId, null, o, e);
  }

  // 树主写（复用 domain/nav 的 *Tx：防环/深度/删除策略同事务生效；失败可能毒化事务 → 穿界）。
  let applied;
  try {
    applied = await handler.applyTx(tx, userId, o);
  } catch (e) {
    abortFromWrite(e, o.clientOpId);
  }

  // 工作区 treeVersion +1 + oplog（乐观断言=o.baseVersion；分叉 → 树冲突人工裁决，§19.6）。
  let ledger: Awaited<ReturnType<typeof writeTreeOpTx>>;
  try {
    ledger = await writeTreeOpTx(
      tx,
      { entityType: "navnode", entityId: applied.entityId, op: applied.op, actorId: userId, payload: applied.payload },
      {
        clientId, clientOpId: o.clientOpId, clientBaseVersion: o.baseVersion,
        expectedBaseVersion: o.baseVersion,
        ...(o._resolveOf ? { result: "resolved" as const, conflictOf: o._resolveOf } : {}),
      },
    );
  } catch (e) {
    if (e instanceof SyncVersionConflictError) {
      throw new AbortReplayError({
        clientOpId: o.clientOpId,
        status: "conflict",
        reasonCode: RC.STRUCTURE_CONFLICT,
        reasonDetail: `导航树已变化（本地基于树版本 ${o.baseVersion.toString()}，服务端 ${e.currentVersion.toString()}）；请刷新导航树后人工解决`,
        serverVersion: e.currentVersion,
      });
    }
    abortFromWrite(e, o.clientOpId);
  }

  const r: PushResult = {
    clientOpId: o.clientOpId, status: "accepted",
    seq: ledger.seq, newVersion: ledger.newVersion, entityId: applied.entityId,
  };
  await recordIncomingTx(tx, o, clientId, null, userId, { ...r, serverVersion: undefined });
  return r;
}

/** 事务外读当前工作区树版本（供树冲突 resolve mine 取最新基线）。 */
export { readTreeVersion };

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
 * 幂等快查：sync_incoming 已终态 → 重建完全相同回执（accepted 回填 oplog 的
 * seq/newVersion/entityId；conflict 回填 serverVersion）；未命中 → null。
 * 正常回放与库门失败分流共用——同一 clientOpId 在任何裁决路径下都只回同一结果。
 */
async function lookupIdempotentReceipt(
  clientOpId: string,
  fallbackEntityId: string,
): Promise<PushResult | null> {
  const existing = await prisma.syncIncoming.findUnique({
    where: { clientOpId },
    select: {
      status: true, reasonCode: true, reasonDetail: true, serverVersion: true, entityId: true,
    },
  });
  if (!existing) return null;
  let opSeq: bigint | null = null;
  let opNewVersion: bigint | null = null;
  if (existing.status === "accepted") {
    const opLog = await prisma.syncOpLog.findUnique({
      where: { clientOpId },
      select: { seq: true, newVersion: true, entityId: true },
    });
    opSeq = opLog?.seq ?? null;
    opNewVersion = opLog?.newVersion ?? null;
    return idempotentReceipt(clientOpId, {
      status: existing.status, reasonCode: existing.reasonCode, reasonDetail: existing.reasonDetail,
      serverVersion: existing.serverVersion, opSeq, opNewVersion,
      opEntityId: opLog?.entityId ?? existing.entityId,
    });
  }
  return idempotentReceipt(clientOpId, {
    status: existing.status, reasonCode: existing.reasonCode, reasonDetail: existing.reasonDetail,
    serverVersion: existing.serverVersion, opSeq, opNewVersion,
    opEntityId: existing.entityId ?? fallbackEntityId,
  });
}

/**
 * 库门失败时对单条 op 的处理（§9.2）：
 *   - 先幂等：已终态 → 回同一结果（不重复隔离/不刷审计）；
 *   - everSubscribed（离线期间被移出 base/组织）→ quarantined，进隔离区不销毁，重授权可 retry；
 *   - 从未订阅的陌生主体 → rejected=PERMISSION_REVOKED，操作不生效。
 * 两种终态都只落 sync_incoming（独立短事务），绝不碰主数据/oplog/版本。
 */
async function replayGatedOut(
  userId: string,
  clientId: string,
  baseId: string | null,
  o: IncomingOp,
  everSubscribed: boolean,
): Promise<PushResult> {
  const prior = await lookupIdempotentReceipt(o.clientOpId, o.entityId);
  if (prior) return prior;
  if (everSubscribed) {
    return await commitTerminal(userId, clientId, baseId, o, {
      clientOpId: o.clientOpId, status: "quarantined", reasonCode: RC.QUARANTINED,
      reasonDetail: "你对该 Base 的成员关系在离线期间失效（被移出或账号停用）；改动已隔离，重新获得授权后可重试",
    });
  }
  return await commitTerminal(userId, clientId, baseId, o, {
    clientOpId: o.clientOpId, status: "rejected", reasonCode: RC.PERMISSION_REVOKED,
    reasonDetail: "无权向该 Base 写入（未订阅/无成员关系）",
  });
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
  const prior = await lookupIdempotentReceipt(o.clientOpId, o.entityId);
  if (prior) return prior;

  // ② 实体/操作白名单（不支持的操作明确拒绝、不静默；restore 随 YN5）。
  //    YN7：table/field/view 结构族【放行】进事务，由 replayOneTx 经 §20.1 注册表分派——
  //    具体 op 是否登记由注册表判定（未登记回 OP_UNSUPPORTED）；此处不能再用 record-only 闸门
  //    提前拦截，否则结构 op 永远到不了注册表。nav/menu（YN8）等未登记实体仍在此明确拒绝。
  const isRecordEntity = o.entityType === "record";
  const isStructureEntity = isStructureEntityType(o.entityType);
  if (!isStructureEntity && (!isRecordEntity || !SUPPORTED_RECORD_OPS.has(o.op))) {
    return await commitTerminal(userId, clientId, baseId, o, {
      clientOpId: o.clientOpId, status: "rejected",
      reasonCode: RC.OP_UNSUPPORTED,
      reasonDetail: !isRecordEntity
        ? `暂不支持实体类型 ${o.entityType}`
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
    // 引擎故障 fail-closed（enforceOrLegacy 抛 503）：绝不落 rejected 终态（否则不可重试、且会被
    // 误报成"无权"），直接冒泡由路由回 503——主数据/版本未动，客户端整批安全重试（§9.1 唯一裁决者）。
    if (e instanceof HttpError && e.status >= 500) throw e;
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
  baseId: string | null,
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
  // YN7 结构轨（table/field/view）：经 §20.1 注册表分派，引擎不写具体模块分支。
  if (isStructureEntityType(o.entityType)) {
    return await replayStructureTx(tx, userId, clientId, baseId, o);
  }
  if (o.entityType !== "record") {
    // 未登记实体（nav/menu 随 YN8；doc 走协同轨）→ 明确拒绝，不静默吞。
    return await terminalInTx(tx, userId, clientId, baseId, o, {
      clientOpId: o.clientOpId, status: "rejected", reasonCode: RC.OP_UNSUPPORTED,
      reasonDetail: `暂不支持实体类型 ${o.entityType}`,
    });
  }
  if (o.op === "create") return await replayCreateTx(tx, userId, clientId, baseId, access, o, idMap);
  if (o.op === "patch") return await replayPatchTx(tx, userId, clientId, baseId, access, o);
  if (o.op === "restore") return await replayRestoreTx(tx, userId, clientId, baseId, access, o);
  // delete
  return await replayDeleteTx(tx, userId, clientId, baseId, access, o);
}

/**
 * YN7 结构 op 回放（在 replayOneTx 的同一写事务内）：
 *   ① 查注册表拿处理器（未登记 → OP_UNSUPPORTED，明确拒绝）；
 *   ② 处理器 resolve（纯读：目标表归属）→ 对返回的 base/table 节点按【当前】角色裁决
 *      manage_schema/manage_table（§19.4，与在线 requireSchemaDesign/requireCreateTable 同动作词），
 *      403 → rejected=PERMISSION_REVOKED、引擎 503 冒泡 fail-closed；
 *   ③ apply 复用现有 tableServiceTx/fieldServiceTx/viewServiceTx 原语（跑现有校验/nav/mask），
 *      结构写失败可能毒化事务 → abortFromWrite 穿界，由外层新短事务落终态；
 *   ④ 同事务推进该表 table_schema 版本钟 + oplog（客户端 baseSchemaVersion 乐观断言）；版本分叉 →
 *      AbortReplay(conflict=STRUCTURE_CONFLICT) 穿界，外层落冲突终态、主数据随回滚不生效。
 */
async function replayStructureTx(
  tx: DbTx,
  userId: string,
  clientId: string,
  baseId: string,
  o: IncomingOp,
): Promise<PushResult> {
  const handler: StructureOpHandler | null = getStructureOpHandler(o.entityType, o.op);
  if (!handler) {
    return await terminalInTx(tx, userId, clientId, baseId, o, {
      clientOpId: o.clientOpId, status: "rejected", reasonCode: RC.OP_UNSUPPORTED,
      reasonDetail: `暂不支持结构操作 ${o.entityType}.${o.op}`,
    });
  }

  // ② 写前纯读：解析目标表/权限挂载点 + 当前权限裁决（只读，未毒化事务，可同事务落终态）。
  let resolution: StructureResolution;
  try {
    resolution = await handler.resolve(tx, baseId, o);
    const decided = await enforceOrLegacy({
      guard: `sync.push.${o.entityType}.${o.op}`,
      userId,
      action: resolution.action,
      legacyAllowed: false,
      ref: { resourceType: resolution.ref.resourceType, resourceId: resolution.ref.resourceId },
    });
    if (!decided.allowed) {
      throw new HttpError(403, "当前角色已无权修改该表结构（权限可能在离线期间被收回）", RC.PERMISSION_REVOKED);
    }
  } catch (e) {
    // §19.3-2 结构实体被对方软删（如离线 rename 的字段已删）→ 落【结构冲突】（带服务端结构快照），
    // 用户可复合 restore_field+alter_field；不走 classifyError（409 会被误归 NOT_UNIQUE rejected）。
    if (e instanceof HttpError && e.code === RC.ENTITY_DELETED) {
      const snap = await buildStructureSnapshot(baseId, o);
      const tableIdForVersion = await resolveStructureTableId(o);
      const serverVersion = tableIdForVersion ? await readSchemaVersion(tableIdForVersion) : 0n;
      return await terminalInTx(tx, userId, clientId, baseId, o, {
        clientOpId: o.clientOpId, status: "conflict", reasonCode: RC.ENTITY_DELETED,
        reasonDetail: e.message, serverVersion,
        _conflictServerPayload: snap,
      });
    }
    return await rejectFromPreflightTx(tx, userId, clientId, baseId, o, e);
  }

  // ③ 应用结构主写（复用现有事务体；内部失败可能已毒化 → 穿界由外层落终态）。
  let applied;
  try {
    applied = await handler.apply(tx, userId, baseId, o);
  } catch (e) {
    abortFromWrite(e, o.clientOpId);
  }

  // ④ 同事务结构版本钟 + oplog。
  //   普通结构 push：以 o.baseVersion 做乐观断言（分叉 → STRUCTURE_CONFLICT）；
  //   #788-D resolve 重放（mine/复合）：用户是在结构冲突面板基于【服务端当前结构】做的决定，期望基线
  //   必须对齐到重放前事务内读到的当前 schemaVersion（o.baseVersion 已由 resolveConflict 置为当前值），
  //   oplog 记 result=resolved/conflictOf 溯源（§19.3 统一形态）。
  let ledger: Awaited<ReturnType<typeof writeStructureOpTx>>;
  try {
    ledger = await writeStructureOpTx(
      tx,
      {
        entityType: applied.entityType,
        entityId: applied.entityId,
        tableId: applied.tableId,
        baseId,
        op: applied.op,
        actorId: userId,
        payload: applied.payload,
      },
      {
        clientId, clientOpId: o.clientOpId, clientBaseVersion: o.baseVersion,
        expectedBaseVersion: o.baseVersion,
        ...(o._resolveOf ? { result: "resolved" as const, conflictOf: o._resolveOf } : {}),
      },
    );
  } catch (e) {
    if (e instanceof SyncVersionConflictError) {
      // 结构版本分叉：回放事务已中止（主写随回滚）。结构快照只读、且必须在毒化事务外用 prisma 构建
      // （§19.3 conflictServerPayload=服务端当前结构快照，供结构冲突面板双版本展示）。
      const snap = await buildStructureSnapshot(baseId, o);
      throw new AbortReplayError({
        clientOpId: o.clientOpId,
        status: "conflict",
        reasonCode: RC.STRUCTURE_CONFLICT,
        reasonDetail: `表结构已变化（本地基于结构版本 ${o.baseVersion.toString()}，服务端 ${e.currentVersion.toString()}）；请刷新结构后人工解决`,
        serverVersion: e.currentVersion,
        _conflictServerPayload: snap,
      });
    }
    abortFromWrite(e, o.clientOpId);
  }

  const r: PushResult = {
    clientOpId: o.clientOpId, status: "accepted",
    seq: ledger.seq, newVersion: ledger.newVersion, entityId: applied.entityId,
  };
  await recordIncomingTx(tx, o, clientId, baseId, userId, { ...r, serverVersion: undefined });
  return r;
}

/** 冲突终态：构建按当前权限脱敏的服务端快照（YN6 双版本弹窗右侧）后只落 incoming。 */
async function conflictTerminalInTx(
  tx: DbTx,
  userId: string,
  clientId: string,
  baseId: string,
  o: IncomingOp,
  currentVersion: bigint,
): Promise<PushResult> {
  const snap = await buildConflictServerPayload(userId, baseId, o, currentVersion);
  return await terminalInTx(tx, userId, clientId, baseId, o, {
    clientOpId: o.clientOpId, status: "conflict", reasonCode: RC.VERSION_CONFLICT,
    reasonDetail: `记录版本已变化（本地基于 ${o.baseVersion.toString()}，服务端 ${currentVersion.toString()}）`,
    serverVersion: currentVersion, _conflictServerPayload: snap,
  });
}

/** 终结分支：在当前事务内只落 incoming（不写主数据），返回事务提交后即生效的回执。 */
async function terminalInTx(
  tx: DbTx,
  userId: string,
  clientId: string,
  baseId: string | null,
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

  // #788-A 结构依赖门（§19.2/§19.3-4）：先于任何记录版本/主写判定——结构未对齐或父表已删时挂起。
  const depConflict = await structureDependencyGateTx(tx, userId, clientId, baseId, o, tableId);
  if (depConflict) return depConflict;

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

  // #788-D 结构分叉解决后的按新结构核对重放（§19.3-3）：先于掩码/权限写闸——字段被对方删除或值
  // 无法转到新类型应落【数据冲突】（可弹窗改值/放弃），而不是被写闸归成 FIELD_FORBIDDEN 拒绝。
  if (o._reconcileSchema) {
    const liveFields = await loadTableFields(tableId);
    const why = reconcilePayloadToSchema(liveFields, payloadFields);
    if (why) {
      return await terminalInTx(tx, userId, clientId, baseId, o, {
        clientOpId: o.clientOpId, status: "conflict", reasonCode: RC.SCHEMA_REPLAY_VALUE,
        reasonDetail: why, serverVersion: await readSchemaVersionTx(tx, tableId),
      });
    }
  }

  // 事务前同构校验（读）：逐表【当前】c 权限重判 + 表归属 + 字段掩码写闸（§9.1）。
  let ctx: TableContext;
  try {
    await assertTableAction(userId, tableId, RECORD_OP_ACTION[o.op]!);
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
  if (rec.table.baseId !== baseId) {
    return await terminalInTx(tx, userId, clientId, baseId, o, {
      clientOpId: o.clientOpId, status: "rejected", reasonCode: RC.BAD_TABLE,
      reasonDetail: "记录不属于该 Base",
    });
  }
  // #788-A 结构依赖门【最优先】（§19.2/§19.3-4）：必须先于记录墓碑/版本判定——整表被对方软删时
  // 记录已随表级联成墓碑，若先走 ENTITY_DELETED 会把"等表恢复后整体重放"的离线改动误判成永久拒绝。
  const depConflict = await structureDependencyGateTx(tx, userId, clientId, baseId, o, rec.tableId);
  if (depConflict) return depConflict;
  if (rec.deletedAt || versionRow?.isDeleted) {
    return await terminalInTx(tx, userId, clientId, baseId, o, {
      clientOpId: o.clientOpId, status: "rejected", reasonCode: RC.ENTITY_DELETED,
      reasonDetail: "记录已被删除", serverVersion: versionRow?.version ?? 0n,
    });
  }
  const currentVersion = versionRow?.version ?? 0n;
  if (o.baseVersion !== currentVersion) {
    return await conflictTerminalInTx(tx, userId, clientId, baseId, o, currentVersion);
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

  // #788-D 结构分叉解决后的按新结构核对重放（§19.3-3）：先于版本/掩码闸（版本对齐由 _reconcileSchema
  // 放行），字段被删或值转不动 → 数据冲突弹窗，绝不静默写脏值或悄悄丢弃。
  if (o._reconcileSchema) {
    const liveFields = await loadTableFields(tableId);
    const why = reconcilePayloadToSchema(liveFields, patch);
    if (why) {
      return await terminalInTx(tx, userId, clientId, baseId, o, {
        clientOpId: o.clientOpId, status: "conflict", reasonCode: RC.SCHEMA_REPLAY_VALUE,
        reasonDetail: why, serverVersion: await readSchemaVersionTx(tx, tableId),
      });
    }
  }

  let ctx: TableContext;
  try {
    // 逐表【当前】u 权限重判（§9.1）+ 表归属/字段掩码写闸 + 行级 rowFilter（与在线 PATCH 同构）。
    await assertTableAction(userId, tableId, RECORD_OP_ACTION[o.op]!);
    ctx = await loadTableContext(userId, access, baseId, tableId, Object.keys(patch));
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
          // YN6：冲突人工解决的 resolve op → oplog result=resolved + conflictOf 溯源（§7.2）。
          ...(o._resolveOf ? { result: "resolved" as const, conflictOf: o._resolveOf } : {}),
        },
        // resolve 仍落结构化 patch（op=patch），只是 oplog 结果标记为 resolved。
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

  // #788-A（§19.3-4）：整表被对方软删时记录已级联成墓碑——必须在「墓碑幂等成功」之前判，
  // 否则离线 delete 会被误当成功而悄悄丢弃（用户期望 restore_table 后整体重放）。
  if (rec && rec.table.baseId === baseId) {
    const depConflict = await structureDependencyGateTx(tx, userId, clientId, baseId, o, rec.tableId);
    if (depConflict) return depConflict;
  }

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
    return await conflictTerminalInTx(tx, userId, clientId, baseId, o, currentVersion);
  }
  if (rec.table.baseId !== baseId) {
    return await terminalInTx(tx, userId, clientId, baseId, o, {
      clientOpId: o.clientOpId, status: "rejected", reasonCode: RC.BAD_TABLE,
      reasonDetail: "记录不属于该 Base",
    });
  }

  let ctx: TableContext;
  try {
    // 逐表【当前】d 权限重判（§9.1）；delete 无物理字段键，仍装载表上下文跑 rowFilter（同在线 DELETE）。
    await assertTableAction(userId, rec.tableId, RECORD_OP_ACTION[o.op]!);
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
        // YN6：冲突人工解决的 resolve 删除 → oplog result=resolved + conflictOf 溯源（§7.2）。
        ...(o._resolveOf ? { result: "resolved" as const, conflictOf: o._resolveOf } : {}),
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
 * restore 回放（YN5）：对已软删记录的回收站恢复。在线恢复走 table 节点 manage_table（高于
 * edit_data，普通编辑者不能恢复），回放按同一映射逐表重判 manage_table（§9.1）。
 * 规则：记录须存在且当前是墓碑；baseVersion 须等于服务端当前版本，否则 conflict；
 * 记录所属表须在本 base。应用复用与在线【完全相同】的 restoreRecordTx 事务体（撤墓碑 +
 * 回填关联 + sidecar 重建 + 变更历史 + outbox + restore oplog/版本推进）。
 */
async function replayRestoreTx(
  tx: DbTx,
  userId: string,
  clientId: string,
  baseId: string,
  _access: LibraryAccessDTO,
  o: IncomingOp,
): Promise<PushResult> {
  const rec = await tx.record.findUnique({
    where: { id: o.entityId },
    select: { id: true, tableId: true, deletedAt: true, table: { select: { baseId: true } } },
  });
  const versionRow = await tx.syncEntityVersion.findUnique({
    where: { id: o.entityId }, select: { version: true, isDeleted: true, lastSeq: true },
  });
  if (!rec) {
    return await terminalInTx(tx, userId, clientId, baseId, o, {
      clientOpId: o.clientOpId, status: "rejected", reasonCode: RC.ENTITY_NOT_FOUND,
      reasonDetail: "要恢复的记录不存在",
    });
  }
  if (rec.table.baseId !== baseId) {
    return await terminalInTx(tx, userId, clientId, baseId, o, {
      clientOpId: o.clientOpId, status: "rejected", reasonCode: RC.BAD_TABLE,
      reasonDetail: "记录不属于该 Base",
    });
  }
  // #788-A 结构依赖门（§19.2/§19.3-4）：父表已软删时恢复记录无意义（表级联墓碑），先挂起；
  // 结构版本落后同样挂起，等表恢复且结构分叉解决后整体重放。
  const depConflict = await structureDependencyGateTx(tx, userId, clientId, baseId, o, rec.tableId);
  if (depConflict) return depConflict;
  // 必须当前是墓碑（deletedAt 非空或版本行 isDeleted）；存活记录的 restore 按幂等 accepted 处理
  // （与 delete 对已删实体幂等同口径），不重复推进版本。
  const recIsTombstone = rec.deletedAt !== null || versionRow?.isDeleted === true;
  if (!recIsTombstone) {
    const r: PushResult = {
      clientOpId: o.clientOpId, status: "accepted",
      seq: versionRow?.lastSeq ?? 0n, newVersion: versionRow?.version ?? 0n, entityId: o.entityId,
    };
    await recordIncomingTx(tx, o, clientId, baseId, userId, r);
    return r;
  }
  const currentVersion = versionRow?.version ?? 0n;
  if (o.baseVersion !== currentVersion) {
    return await conflictTerminalInTx(tx, userId, clientId, baseId, o, currentVersion);
  }

  // 逐表【当前】manage_table 重判（§9.1，与在线 requireTableManage 同源）。纯读 preflight：
  // 无权 → rejected PERMISSION_REVOKED；引擎 5xx → 冒泡 fail-closed（rejectFromPreflightTx 处理）。
  try {
    await assertTableAction(userId, rec.tableId, RECORD_OP_ACTION[o.op]!);
  } catch (e) {
    return await rejectFromPreflightTx(tx, userId, clientId, baseId, o, e);
  }

  let applied: Awaited<ReturnType<typeof restoreRecordTx>>;
  try {
    applied = await restoreRecordTx(tx, o.entityId, rec.tableId, userId, {
      identity: {
        clientId, clientOpId: o.clientOpId,
        clientBaseVersion: o.baseVersion, expectedBaseVersion: currentVersion,
      },
      op: "restore",
    });
  } catch (e) {
    abortFromWrite(e, o.clientOpId);
  }

  // 与在线恢复同构：事务体内已完成 sidecar 重建/outbox upsert，事务后无默认值/序号补偿，
  // 故不设 _afterCommit（不触发 runPostCommitCompensation）。
  const r: PushResult = {
    clientOpId: o.clientOpId, status: "accepted",
    seq: applied.sync?.seq, newVersion: applied.sync?.newVersion, entityId: o.entityId,
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
      // 尊重已带原因码的拒绝：行失配 ROW_NOT_VISIBLE、表级权限收回 PERMISSION_REVOKED；
      // 其余无码 403（字段写闸/掩码写闸抛的"字段不可写"）才归 FIELD_FORBIDDEN。
      reasonCode = e.code === RC.ROW_NOT_VISIBLE
        ? RC.ROW_NOT_VISIBLE
        : e.code === RC.PERMISSION_REVOKED
          ? RC.PERMISSION_REVOKED
          : RC.FIELD_FORBIDDEN;
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
 * 【写前纯读校验】失败（表归属、字段掩码写闸、行级 rowFilter、逐表当前权限；均为只读，未执行
 * 任何变更语句，事务未被毒化）→ 4xx 在当前事务内只落 incoming 终态并正常提交，不影响批内其它 op；
 * 引擎故障 5xx 直接冒泡（fail-closed，不落 rejected、可整批重试），由 replayOne 转出 503。
 */
async function rejectFromPreflightTx(
  tx: DbTx,
  userId: string,
  clientId: string,
  baseId: string | null,
  o: IncomingOp,
  e: unknown,
): Promise<PushResult> {
  if (e instanceof HttpError && e.status >= 500) throw e;
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

// ───────────────────── 同步中心：隔离项重试（YN5 §9.2/§13） ─────────────────────

/**
 * 重新授权后重试一条【隔离中】的入站操作（同步中心"重试"按钮）。
 *
 * 语义（§9.2「quarantined …重新被授权后可一键重试」、§13 POST /incoming/:id/retry）：
 *   - 仅本人 actorId、且当前 status=quarantined 的行可重试；其它（含别人的项、accepted/
 *     conflict/rejected/dropped、不存在）一律 404/409，绝不越权重放别人的操作；
 *   - 复用【同一条 clientOpId】与原 payload/baseVersion——重放走 push 的完整当前权限裁决
 *     （库门 enter 探测 + 逐表 c/u/d/manage_table 重判 + 行/字段/掩码写闸），因此：
 *       · 重新获得授权 → accepted（写主数据/oplog/版本，与正常 push 逐字节同路径）；
 *       · 仍在库但某表动作仍被收回 → rejected=PERMISSION_REVOKED；
 *       · 仍被移出 base → 再次 quarantined（everSubscribed 恒真，因 sync_subscriptions 行还在）；
 *       · 期间记录又被改动致版本不符 → conflict（交 YN6 弹窗）；
 *   - 复用同一 sync_incoming 行：先条件删除旧隔离行（owner+quarantined 双条件，原子鉴权），
 *     重放的新终态以同一 clientOpId 落回（保持幂等键与审计连续），attempts 在旧值上 +1；
 *   - 引擎 503/任何重放异常：旧隔离行已在删除后——立即用原字段【原样恢复】隔离行再抛，
 *     保证"重试一个可重试错误绝不把用户的离线改动弄丢"（客户端 outbox 亦留存同一条）。
 *
 * 返回本条重放后的终态回执（带 _freshTerminal，路由层据此发 sync_push_* 审计）。
 */
export async function retryIncoming(
  userId: string,
  incomingId: string,
): Promise<PushResult & { attempts: number; baseId: string }> {
  // ① 读原隔离行（非事务，纯读）并做身份/状态校验。
  const row = await prisma.syncIncoming.findUnique({
    where: { id: incomingId },
  });
  if (!row || row.actorId !== userId) {
    // 不区分"不存在"与"别人的项"：统一 404，避免用重试端点探测他人操作是否存在。
    throw new HttpError(404, "隔离项不存在", RC.INCOMING_NOT_FOUND);
  }
  if (row.status !== "quarantined") {
    throw new HttpError(409, `当前状态为 ${row.status}，不能重试（仅隔离项可重试）`, RC.INCOMING_STATE);
  }
  const baseId = row.baseId;
  if (!baseId) {
    // 隔离行理论上必属某 base（push 都按 base）；兜底不当崩溃。
    throw new HttpError(409, "隔离项缺少 base 归属，无法重试", RC.INCOMING_STATE);
  }

  // 重建入站 op（payload 入库时为 JSON 字符串）。
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    throw new HttpError(409, "隔离项原始操作已损坏，无法重试（可放弃后在本地重新编辑）", RC.INCOMING_STATE);
  }
  const o: IncomingOp = {
    clientOpId: row.clientOpId,
    entityType: row.entityType,
    entityId: row.entityId,
    op: row.op,
    baseVersion: row.baseVersion,
    payload,
  };
  const prevAttempts = row.attempts;

  // ② 先按【当前】库门探测（这一步可能抛引擎 503；此时尚未删行，直接冒泡、隔离行原样保留）。
  const gate = await probeBaseEnter(userId, row.clientId, baseId);

  // ③ 条件删除旧隔离行：owner + quarantined 双条件兜底并发（别人/已被处理则 deleteCount=0）。
  const del = await prisma.syncIncoming.deleteMany({
    where: { id: incomingId, actorId: userId, status: "quarantined" },
  });
  if (del.count === 0) {
    throw new HttpError(409, "隔离项状态已变化，请刷新后重试", RC.INCOMING_STATE);
  }

  // ④ 走 push 的同一条单 op 裁决路径（含逐表当前权限重判/幂等/事务/补偿）。
  let result: PushResult;
  try {
    result = gate.allowed
      ? await replayOne(userId, row.clientId, baseId, gate.access, o, new Map())
      : await replayGatedOut(userId, row.clientId, baseId, o, gate.everSubscribed);
    if (result.status === "accepted" && result._afterCommit) {
      await runPostCommitCompensation(userId, result);
    }
  } catch (e) {
    // 重放异常（引擎 503 等）：旧隔离行已删——原样恢复（保留 attempts 与全部原字段），再抛。
    await prisma.syncIncoming.create({
      data: {
        id: row.id,
        clientId: row.clientId,
        clientOpId: row.clientOpId,
        workspaceId: row.workspaceId,
        baseId: row.baseId,
        entityType: row.entityType,
        entityId: row.entityId,
        op: row.op,
        payload: row.payload,
        baseVersion: row.baseVersion,
        actorId: row.actorId,
        status: row.status,
        reasonCode: row.reasonCode,
        reasonDetail: row.reasonDetail,
        serverVersion: row.serverVersion,
        conflictServerPayload: row.conflictServerPayload,
        reviewBaseId: row.reviewBaseId,
        decidedBy: row.decidedBy,
        decidedAt: row.decidedAt,
        attempts: row.attempts,
        createdAt: row.createdAt,
      },
    }).catch(() => {
      // 恢复撞唯一（理论不应发生）：不掩盖原始错误，仅留服务端日志。
      console.error("[sync.retry] failed to restore quarantined row:", row.clientOpId);
    });
    throw e;
  }

  // ⑤ 新终态行已由重放以 attempts=1 落回；把 attempts 校正为旧值 +1（本次重试计一次）。
  const nextAttempts = prevAttempts + 1;
  await prisma.syncIncoming.updateMany({
    where: { clientOpId: row.clientOpId },
    data: { attempts: nextAttempts },
  });
  return { ...result, attempts: nextAttempts, baseId };
}

// ───────────────────── YN6：冲突人工解决（mine/theirs/custom，§7.2/§12/§13） ─────────────────────

/** POST /resolve 的三种人工裁决。 */
export type ResolveDecision = "mine" | "theirs" | "custom";
/** 结构/数据依赖冲突在 record 三选一之外扩展的决定（§19.3，#788-D）。 */
export type StructureResolveDecision = ResolveDecision | "compound" | "replayData";
export interface ResolveConflictInput {
  /** 被解决的原始冲突操作的 clientOpId（sync_incoming 中 status=conflict 行）。 */
  resolveOf: string;
  /**
   * 裁决：record 冲突用 mine/theirs/custom；#788-D 结构冲突另支持 compound（原子多步）、
   * 数据依赖冲突用 replayData（按新结构核对重放）。
   */
  decision: StructureResolveDecision;
  /**
   * mine/custom 时新 resolve 操作的幂等键（客户端造，全局唯一）。缺省由服务端以 res- 前缀生成。
   * theirs 不产生新写操作，忽略此项。
   */
  clientOpId?: string;
  /** decision=custom：字段级挑选后拼出的 patch（形状同 push patch 的 payload，须含非空 changed）。 */
  patch?: Record<string, unknown>;
  /**
   * #788-D decision="compound"（结构冲突专用，§19.3-2 场景如「恢复字段并应用我的改名」）：
   * 一个原子事务内顺序应用多条结构 op（restore_field + alter_field 等）。每步都是已登记的
   * entityType/op + payload；全部成功才提交并把原冲突行置 resolved，任一步失败整体回滚、原行保留。
   * oplog 为每步各落一条 result=resolved/conflictOf=原 op 的结构事实。
   */
  compound?: {
    steps: Array<{ entityType: string; entityId: string; op: string; payload: Record<string, unknown> }>;
  };
  /**
   * #788-D decision="replayData"（结构分叉解决后）：把曾因结构依赖挂起（STRUCTURE_DEPENDENCY/
   * TABLE_DELETED）的【数据 op】按当前新结构核对重放（§19.3-3）。服务端按原 incoming 行的 op/payload
   * 重放（忽略客户端再造），仅内部置 _reconcileSchema：baseSchemaVersion 不再拦，逐字段值按当前类型
   * 核对（可转显式转型、不可转/字段已删 → 数据冲突，绝不静默丢）。
   */
  replayData?: boolean;
}

export interface ResolveConflictResult {
  resolveOf: string;
  decision: StructureResolveDecision;
  /** theirs=dropped；mine/custom 成功=accepted。 */
  status: PushResult["status"];
  baseId: string;
  entityId: string;
  /** mine/custom：新 resolve op 的幂等键（其 oplog result=resolved/conflictOf=resolveOf）。 */
  newClientOpId?: string;
  /** mine/custom 接受后的 seq/newVersion（字符串化由路由负责）。 */
  seq?: bigint;
  newVersion?: bigint;
  /**
   * 【内部，路由层不序列化】mine/custom 重放产生的新鲜终态（可能再次 rejected/conflict/quarantined）。
   * 仅当 accepted 才把原冲突行置 resolved；否则原冲突行保留，用户可改选 theirs 或重试。
   */
  replay?: PushResult;
  /**
   * 【内部，路由层不序列化】true＝本次是对【已解决冲突】的幂等回读（重发同一 resolveOf），
   * 未做任何新写；路由据此不重复发 sync_conflict_resolved 审计（§8.1/§9.5）。
   */
  _idempotent?: boolean;
}

/**
 * 解决一条 record 版本冲突（YN6 冲突弹窗，§7.2）。服务端不自动覆盖，一切由用户显式三选一：
 *
 *   - theirs（采用服务端）：放弃本地改动，原冲突行置 dropped 留痕（与同步中心 discard 同口径，
 *     不删行、decidedBy/decidedAt 记账），不产生新写、服务端数据不动。
 *   - mine（采用我的）：以原冲突 op 的 patch/delete 为内容，基于【服务端当前版本】重造一条新 op
 *     （新 clientOpId、baseVersion=current.version、_resolveOf=原 op），重走完整当前权限裁决；
 *   - custom（逐字段挑选）：用请求里的 patch 作为内容，其余同 mine。
 *
 * 安全顺序（绝不丢用户离线改动）：先重放新 resolve op，【只有 accepted】才条件删除原冲突行；
 * 重放若被当前权限 rejected、再次 conflict（版本又前进）或 quarantined，原冲突行原样保留，
 * 把新终态回执返回给客户端，用户可改选 theirs 或稍后重试。整个过程用户显式选择，系统不静默合并。
 *
 * 身份/状态：仅本人 actorId 且 status=conflict 的行可解决；别人的/不存在统一 404（不泄存在性）；
 * 非 conflict 态 409；custom 缺 changed/400；mine 要求原 op 是 patch/delete，否则 409。
 */
/**
 * 对一条【已是 resolve 终态】的原冲突行做幂等回读（§8.1：POST /resolve 网络超时重发不重复落地）。
 *   - 原行 status=dropped（themselves/theirs 放弃过）→ 回 dropped（theirs 语义）；
 *   - 原行 status=resolved（mine/custom 接受过）→ 从 sync_op_log 按 conflictOf 反查那条 resolve op，
 *     回 accepted + 首次的 newClientOpId/seq/newVersion；oplog 缺失（理论不应发生）按 accepted 回，
 *     绝不重放（重复重放会在已推进的版本上再造一次写）。
 * 回读结果不带 _freshTerminal，路由据此不重复发 sync_conflict_resolved 审计。
 */
async function readResolvedReceipt(
  row: { id: string; clientOpId: string; baseId: string | null; entityId: string; status: string; op: string },
  decision: StructureResolveDecision,
): Promise<ResolveConflictResult> {
  const baseId = row.baseId ?? "";
  if (row.status === "dropped") {
    return {
      resolveOf: row.clientOpId, decision: "theirs", status: "dropped",
      baseId, entityId: row.entityId, _idempotent: true,
    };
  }
  // resolved：反查首次 resolve op（result=resolved + conflictOf=原 clientOpId，取最早一条）。
  const opLog = await prisma.syncOpLog.findFirst({
    where: { conflictOf: row.clientOpId, result: "resolved" },
    orderBy: { seq: "asc" },
    select: { clientOpId: true, seq: true, newVersion: true },
  });
  return {
    resolveOf: row.clientOpId, decision, status: "accepted", baseId,
    entityId: row.entityId, _idempotent: true,
    ...(opLog ? { newClientOpId: opLog.clientOpId, seq: opLog.seq, newVersion: opLog.newVersion } : {}),
  };
}

/** resolveConflict 内传入的原冲突行所需字段（findUnique 全字段的结构化子集）。 */
interface ConflictRow {
  id: string;
  clientOpId: string;
  clientId: string;
  entityType: string;
  entityId: string;
  op: string;
  payload: string;
  baseVersion: bigint;
  baseId: string | null;
  reasonCode: string | null;
  serverVersion: bigint;
}

/** accepted 后把原冲突行条件置 resolved（owner+conflict 双条件）；并发已解则幂等返回不报错。 */
async function markOriginalResolved(row: ConflictRow, userId: string): Promise<void> {
  const upd = await prisma.syncIncoming.updateMany({
    where: { id: row.id, actorId: userId, status: "conflict" },
    data: { status: "resolved", decidedBy: userId, decidedAt: new Date() },
  });
  if (upd.count === 0) {
    // 并发下已被另一请求解决：本次重放确已 accepted，幂等返回即可（重复 resolveOf 走 readResolvedReceipt）。
    const fresh = await prisma.syncIncoming.findUnique({ where: { id: row.id } });
    if (fresh && (fresh.status === "resolved" || fresh.status === "dropped")) return;
    throw new HttpError(409, "冲突项状态已变化，请刷新后重试", RC.RESOLVE_NOT_CONFLICT);
  }
}

/**
 * #788-D 结构冲突 mine：以原结构 op 内容、基于【服务端当前 schemaVersion】重造一条 resolve op
 * （新 clientOpId、o.baseVersion=当前结构版本、_resolveOf=原 op），重走结构回放——注册表 resolve 按
 * 当前 manage_schema 裁决、apply 复用领域 *Tx、writeStructureOpTx 以当前版本为乐观基线，oplog 记
 * result=resolved/conflictOf。重放非 accepted（当前无权/校验不过/又分叉）则原冲突行保留。
 */
async function resolveStructureMine(
  userId: string,
  input: ResolveConflictInput,
  row: ConflictRow,
  baseId: string,
): Promise<ResolveConflictResult> {
  let origPayload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      origPayload = parsed as Record<string, unknown>;
    }
  } catch {
    throw new HttpError(409, "冲突项原始操作已损坏，无法按我的结构解决（可选择采用服务端）", RC.RESOLVE_NOT_CONFLICT);
  }

  const tableId = await resolveStructureTableId({
    clientOpId: row.clientOpId, entityType: row.entityType, entityId: row.entityId,
    op: row.op, baseVersion: row.baseVersion, payload: origPayload,
  });
  if (!tableId) {
    throw new HttpError(409, "无法定位该结构操作所属的数据表，不能重放", RC.RESOLVE_NOT_CONFLICT);
  }
  const currentSchemaVersion = await readSchemaVersion(tableId);

  const newClientOpId = input.clientOpId?.trim() || `res-${randomUUID()}`;
  if (newClientOpId === input.resolveOf) {
    throw new HttpError(400, "resolve 的 clientOpId 不能与原冲突操作相同", RC.RESOLVE_MALFORMED);
  }
  const resolveOp: IncomingOp = {
    clientOpId: newClientOpId,
    entityType: row.entityType,
    entityId: row.entityId,
    op: row.op,
    baseVersion: currentSchemaVersion,
    payload: origPayload,
    _resolveOf: input.resolveOf,
  };

  const gate = await probeBaseEnter(userId, row.clientId, baseId);
  const replay = gate.allowed
    ? await replayOne(userId, row.clientId, baseId, gate.access, resolveOp, new Map())
    : await replayGatedOut(userId, row.clientId, baseId, resolveOp, gate.everSubscribed);

  if (replay.status !== "accepted") {
    return {
      resolveOf: input.resolveOf, decision: "mine", status: replay.status, baseId,
      entityId: row.entityId, newClientOpId, replay,
    };
  }
  await markOriginalResolved(row, userId);
  return {
    resolveOf: input.resolveOf, decision: "mine", status: "accepted", baseId,
    entityId: row.entityId, newClientOpId,
    seq: replay.seq, newVersion: replay.newVersion, replay,
  };
}

/** 校验复合 resolve 的一步并返回规范化结构（非法即 400）。 */
function parseCompoundStep(raw: unknown, index: number): {
  entityType: string; entityId: string; op: string; payload: Record<string, unknown>;
} {
  const s = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  const entityType = typeof s?.entityType === "string" ? s.entityType.trim() : "";
  const entityId = typeof s?.entityId === "string" ? s.entityId.trim() : "";
  const op = typeof s?.op === "string" ? s.op.trim() : "";
  const payload = s?.payload && typeof s.payload === "object" && !Array.isArray(s.payload)
    ? s.payload as Record<string, unknown>
    : null;
  if (!entityType || !entityId || !op || !payload) {
    throw new HttpError(400, `复合解决第 ${index + 1} 步缺少 entityType/entityId/op/payload`, RC.RESOLVE_STEPS_MALFORMED);
  }
  if (!isStructureEntityType(entityType) || !getStructureOpHandler(entityType, op)) {
    throw new HttpError(400, `复合解决第 ${index + 1} 步是未登记的结构操作 ${entityType}.${op}`, RC.RESOLVE_STEPS_MALFORMED);
  }
  return { entityType, entityId, op, payload };
}

/**
 * #788-D 结构冲突 compound（§19.3-2）：在【一个】串行写事务内顺序应用多条结构 op（如先 restore_field
 * 再 alter_field）。每步都过注册表 resolve + 当前 manage_schema 裁决 + 领域 apply；每步在应用前于事务内
 * 读该表当前 schemaVersion 作为乐观基线（同一表多步连续 +1），各落一条 result=resolved/conflictOf=原 op
 * 的 oplog。任一步失败整体回滚（绝不留「字段恢复了但改名没落」的半成品），原冲突行保留。
 */
async function resolveStructureCompound(
  userId: string,
  input: ResolveConflictInput,
  row: ConflictRow,
  baseId: string,
): Promise<ResolveConflictResult> {
  const rawSteps = input.compound?.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0 || rawSteps.length > 10) {
    throw new HttpError(400, "compound 解决需提供 1–10 个结构步骤 steps", RC.RESOLVE_STEPS_MALFORMED);
  }
  const steps = rawSteps.map((s, i) => parseCompoundStep(s, i));
  const runId = input.clientOpId?.trim() || `res-${randomUUID()}`;
  if (runId === input.resolveOf) {
    throw new HttpError(400, "resolve 的 clientOpId 不能与原冲突操作相同", RC.RESOLVE_MALFORMED);
  }

  // 库门探测（与 mine 同款；未进库 → 不应用，走隔离/拒绝分流，原冲突行保留）。
  const gate = await probeBaseEnter(userId, row.clientId, baseId);
  if (!gate.allowed) {
    const first = steps[0]!;
    const probeOp: IncomingOp = {
      clientOpId: `${runId}-0`, entityType: first.entityType, entityId: first.entityId,
      op: first.op, baseVersion: 0n, payload: first.payload, _resolveOf: input.resolveOf,
    };
    const replay = await replayGatedOut(userId, row.clientId, baseId, probeOp, gate.everSubscribed);
    return {
      resolveOf: input.resolveOf, decision: "compound", status: replay.status, baseId,
      entityId: row.entityId, newClientOpId: runId, replay,
    };
  }

  let lastSeq: bigint | null = null;
  let lastVersion: bigint | null = null;
  const stepClientOpIds: string[] = [];
  try {
    await withWriteTx("sync.resolve.compound", async (tx) => {
      for (let i = 0; i < steps.length; i += 1) {
        const step = steps[i]!;
        const clientOpId = `${runId}-${i}`;
        stepClientOpIds.push(clientOpId);
        const o: IncomingOp = {
          clientOpId, entityType: step.entityType, entityId: step.entityId,
          op: step.op, baseVersion: 0n, payload: step.payload, _resolveOf: input.resolveOf,
        };
        const handler = getStructureOpHandler(step.entityType, step.op)!;
        // 当前权限裁决（只读；403/503 抛 → 整体回滚，外层归一终态）。
        const resolution = await handler.resolve(tx, baseId, o);
        const decided = await enforceOrLegacy({
          guard: `sync.resolve.${step.entityType}.${step.op}`,
          userId, action: resolution.action, legacyAllowed: false,
          ref: { resourceType: resolution.ref.resourceType, resourceId: resolution.ref.resourceId },
        });
        if (!decided.allowed) {
          throw new HttpError(403, "当前角色已无权修改该表结构（权限可能在离线期间被收回）", RC.PERMISSION_REVOKED);
        }
        const applied = await handler.apply(tx, userId, baseId, o);
        // 应用前事务内读当前结构版本作为乐观基线（同表多步连续 +1，故每步重读）。
        const expected = await readSchemaVersionTx(tx, applied.tableId);
        const ledger = await writeStructureOpTx(
          tx,
          {
            entityType: applied.entityType, entityId: applied.entityId, tableId: applied.tableId,
            baseId, op: applied.op, actorId: userId, payload: applied.payload,
          },
          {
            clientId: row.clientId, clientOpId, clientBaseVersion: expected,
            expectedBaseVersion: expected, result: "resolved", conflictOf: input.resolveOf,
          },
        );
        await recordIncomingTx(tx, o, row.clientId, baseId, userId, {
          clientOpId, status: "accepted", seq: ledger.seq,
          newVersion: ledger.newVersion, entityId: applied.entityId, serverVersion: undefined,
        });
        lastSeq = ledger.seq;
        lastVersion = ledger.newVersion;
      }
    });
  } catch (e) {
    if (e instanceof HttpError && e.status >= 500) throw e;
    // 4xx（含当前无权/结构校验不过）：整个复合未生效，原冲突行保留，回 rejected 供用户改选。
    const code = e instanceof HttpError ? (e.code || RC.VALIDATION) : RC.VALIDATION;
    const detail = e instanceof HttpError ? e.message : "复合结构解决应用失败";
    return {
      resolveOf: input.resolveOf, decision: "compound", status: "rejected", baseId,
      entityId: row.entityId, newClientOpId: runId,
      replay: { clientOpId: runId, status: "rejected", reasonCode: code, reasonDetail: detail },
    };
  }

  await markOriginalResolved(row, userId);
  return {
    resolveOf: input.resolveOf, decision: "compound", status: "accepted", baseId,
    entityId: row.entityId, newClientOpId: runId,
    ...(lastSeq !== null ? { seq: lastSeq } : {}),
    ...(lastVersion !== null ? { newVersion: lastVersion } : {}),
  };
}

export async function resolveConflict(
  userId: string,
  input: ResolveConflictInput,
): Promise<ResolveConflictResult> {
  const decision = input.decision;
  const allowedDecisions = new Set<string>(["mine", "theirs", "custom", "compound", "replayData"]);
  if (!allowedDecisions.has(decision)) {
    throw new HttpError(400, "decision 必须是 mine/theirs/custom/compound/replayData", RC.RESOLVE_BAD_DECISION);
  }

  // ① 读原冲突行并做身份/状态校验（非事务纯读）。
  const row = await prisma.syncIncoming.findUnique({
    where: { clientOpId: input.resolveOf },
  });
  if (!row || row.actorId !== userId) {
    throw new HttpError(404, "冲突项不存在", RC.INCOMING_NOT_FOUND);
  }
  // 幂等回读（§8.1）：该冲突项已被解决过（网络超时重发同一 resolveOf）→ 回首次结果，绝不重复落地。
  if (row.status === "resolved" || row.status === "dropped") {
    return await readResolvedReceipt(row, decision);
  }
  if (row.status !== "conflict") {
    throw new HttpError(409, `当前状态为 ${row.status}，不能解决（仅冲突项可解决）`, RC.RESOLVE_NOT_CONFLICT);
  }
  const baseId = row.baseId;
  if (!baseId) throw new HttpError(409, "冲突项缺少 base 归属，无法解决", RC.RESOLVE_NOT_CONFLICT);

  // ② theirs：放弃本地 → 原冲突行 dropped 留痕（不删行、不产生写）。
  if (decision === "theirs") {
    const upd = await prisma.syncIncoming.updateMany({
      where: { id: row.id, actorId: userId, status: "conflict" },
      data: { status: "dropped", decidedBy: userId, decidedAt: new Date() },
    });
    if (upd.count === 0) {
      throw new HttpError(409, "冲突项状态已变化，请刷新后重试", RC.RESOLVE_NOT_CONFLICT);
    }
    return {
      resolveOf: input.resolveOf, decision, status: "dropped",
      baseId, entityId: row.entityId,
    };
  }

  const isStructureConflict = isStructureEntityType(row.entityType);
  const isDataDependencyConflict = row.entityType === "record"
    && (row.reasonCode === RC.STRUCTURE_DEPENDENCY || row.reasonCode === RC.TABLE_DELETED);

  // ②' #788-D 结构冲突（table/field/view）：mine=基于当前 schemaVersion 重放原结构 op；
  //    compound=原子多步（如 restore_field+alter_field）。custom 是 record 专用，结构冲突不给用。
  if (isStructureConflict) {
    if (decision !== "mine" && decision !== "compound") {
      throw new HttpError(
        400,
        `结构冲突只支持 mine（采用我的结构）/theirs（采用服务端）/compound（组合操作），不支持 ${decision}`,
        RC.RESOLVE_BAD_DECISION,
      );
    }
    if (decision === "compound") {
      return await resolveStructureCompound(userId, input, row, baseId);
    }
    return await resolveStructureMine(userId, input, row, baseId);
  }

  // 数据依赖冲突（record 因结构版本落后/表软删挂起）：mine 等价于「结构已解决，按新结构核对重放」。
  const reconcileData = decision === "replayData" || (decision === "mine" && isDataDependencyConflict);
  if (decision === "replayData" && !isDataDependencyConflict) {
    throw new HttpError(400, "replayData 仅用于因表结构变化挂起的数据改动", RC.RESOLVE_BAD_DECISION);
  }

  // ③ mine/custom：解析要重放的内容。
  let origPayload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      origPayload = parsed as Record<string, unknown>;
    }
  } catch {
    throw new HttpError(409, "冲突项原始操作已损坏，无法按我的版本解决（可选择采用服务端）", RC.RESOLVE_NOT_CONFLICT);
  }

  let replayPayload: Record<string, unknown>;
  let replayOp: string;
  if (decision === "custom") {
    const patchPayload = asRecord(input.patch);
    const changed = patchPayload ? asRecord(patchPayload.changed) : null;
    if (!patchPayload || !changed || Object.keys(changed).length === 0) {
      throw new HttpError(400, "custom 解决需提供非空 patch.changed", RC.RESOLVE_MALFORMED);
    }
    // custom 一律是 patch；tableId 缺省沿用原 op（patch 必带或可由记录推出）。
    replayOp = "patch";
    replayPayload = {
      tableId: str(patchPayload.tableId) ?? str(origPayload.tableId) ?? undefined,
      changed,
    };
  } else {
    // mine：沿用原操作类型与内容（patch 重放我的字段改动；delete 重放删除）。
    // #788-D 数据依赖重放：原 op 可能是 create/patch/delete/restore，全部允许（按新结构核对）。
    if (!reconcileData && row.op !== "patch" && row.op !== "delete") {
      throw new HttpError(
        409,
        `原冲突操作是 ${row.op}，不能「采用我的」重放（请逐字段挑选或采用服务端）`,
        RC.RESOLVE_NOT_CONFLICT,
      );
    }
    replayOp = row.op;
    replayPayload = origPayload;
  }

  // 服务端当前版本＝新 resolve op 的 baseVersion（乐观锁从此对齐；原行 serverVersion 是冲突时快照）。
  // #788-D 数据依赖重放：结构变化不推进【记录】版本，忠实沿用原 op 的记录级 baseVersion——若离线期间
  // 该记录也被他人改过，重放会正常落记录版本冲突（交 YN6 弹窗），不覆盖。
  let currentVersion: bigint;
  if (reconcileData) {
    currentVersion = row.baseVersion;
  } else {
    const versionRow = await prisma.syncEntityVersion.findUnique({
      where: { id: row.entityId },
      select: { version: true },
    });
    currentVersion = versionRow?.version ?? row.serverVersion ?? 0n;
  }

  const newClientOpId = input.clientOpId?.trim() || `res-${randomUUID()}`;
  if (newClientOpId === input.resolveOf) {
    throw new HttpError(400, "resolve 的 clientOpId 不能与原冲突操作相同", RC.RESOLVE_MALFORMED);
  }

  const resolveOp: IncomingOp = {
    clientOpId: newClientOpId,
    entityType: row.entityType,
    entityId: row.entityId,
    op: replayOp,
    baseVersion: currentVersion,
    payload: replayPayload,
    _resolveOf: input.resolveOf,
    // #788-D 数据依赖重放：绕过结构版本门、改由逐字段按当前类型核对（§19.3-3）。
    ...(reconcileData ? { _reconcileSchema: true as const } : {}),
  };

  // ④ 当前库门探测（可能抛引擎 503 fail-closed；此时未删原冲突行，原样保留）。
  const gate = await probeBaseEnter(userId, row.clientId, baseId);

  // ⑤ 重放新 resolve op（同一条 push 裁决链：逐表当前权限重判 + 行/字段/掩码写闸 + 乐观锁）。
  const replay = gate.allowed
    ? await replayOne(userId, row.clientId, baseId, gate.access, resolveOp, new Map())
    : await replayGatedOut(userId, row.clientId, baseId, resolveOp, gate.everSubscribed);
  if (replay.status === "accepted" && replay._afterCommit) {
    await runPostCommitCompensation(userId, replay);
  }

  // ⑥ 只有 accepted 才把原冲突行置 resolved（只增状态、留痕不删行，owner+conflict 双条件）；
  //    其余终态（rejected/conflict/quarantined）保留原冲突行，用户可改选 theirs 或稍后重试。
  if (replay.status !== "accepted") {
    return {
      resolveOf: input.resolveOf, decision, status: replay.status, baseId,
      entityId: row.entityId, newClientOpId, replay,
    };
  }
  const upd = await prisma.syncIncoming.updateMany({
    where: { id: row.id, actorId: userId, status: "conflict" },
    data: { status: "resolved", decidedBy: userId, decidedAt: new Date() },
  });
  if (upd.count === 0) {
    // 并发下原冲突行已被另一请求解决：幂等回读其首次结果，不报错、不重复落地（§8.1）。
    const fresh = await prisma.syncIncoming.findUnique({ where: { id: row.id } });
    if (fresh && (fresh.status === "resolved" || fresh.status === "dropped")) {
      return await readResolvedReceipt(fresh, decision);
    }
    throw new HttpError(409, "冲突项状态已变化，请刷新后重试", RC.RESOLVE_NOT_CONFLICT);
  }

  return {
    resolveOf: input.resolveOf, decision, status: "accepted", baseId,
    entityId: row.entityId, newClientOpId,
    seq: replay.seq, newVersion: replay.newVersion, replay,
  };
}
