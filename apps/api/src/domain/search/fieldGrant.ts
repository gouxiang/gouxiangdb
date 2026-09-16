// M5/S3 fieldMask 物理缺席的授权收敛纯函数层（零 IO，表驱动单测见 __tests__/fieldGrant.test.ts）。
//
// 权威依据：docs/planning/phase2/M5-implementation-plan.md §4.7
//   规则 4：对每个可见 table 节点，若在 maskedTableFields 中 -> 仅其中 fieldId 的 field chunk
//           可见；不在其中（无 mask）-> 该表全部 field chunk 可见。
//   规则 5：allowed = chunkKind='identity'
//           OR NOT EXISTS(该表任何授权行)   -- §4.5 步骤 3「空表代表无字段收窄」
//           OR EXISTS(白名单命中行)。
//   规则 7：表不在 scope -> identity 与 field 全部不可见（temp_scope INNER JOIN 落空）。
//
// 物化契约（S7 照此 INSERT temp_field_grant）：只物化【mask 表】的白名单行；
// 无 mask 的 scope 内表不插任何行，召回谓词以 NOT EXISTS 分支放行（queryPlan.allowed）。
//
// 输入全部由 M4 scope 契约 + 写入侧 field chunk 登记表提供；本文件不重算权限、不查库。

export type ChunkKind = "identity" | "field";

/** field chunk 登记表一行（§4.2：field_grant(chunkRowid,tableNodeId,fieldId) 同构登记）。 */
export interface FieldChunkRegistration {
  chunkRowid: bigint;
  tableNodeId: string;
  fieldId: string;
}

/** 待判定的任意 chunk：identity 恒可见（只要 nodeId 在 scope）；field 走字段授权。 */
export interface ChunkVisibilityInput {
  chunkRowid: bigint;
  nodeId: string;
  chunkKind: ChunkKind;
  /** field chunk 的所属表节点；缺省取 nodeId（record 二者相同）。 */
  tableNodeId?: string;
  fieldId?: string;
}

/** temp_field_grant 应物化的授权行（去重、确定性排序，供 S7 批量 INSERT）。 */
export interface FieldGrantRow {
  tableNodeId: string;
  fieldId: string;
}

export type ChunkVisibility = "visible" | "hidden";

export interface ChunkVisibilityResult {
  chunkRowid: bigint;
  visibility: ChunkVisibility;
  /** 不可见原因（纯诊断，不参与授权；identity 与通过项为 null）。 */
  reason: null | "table_out_of_scope" | "field_masked";
}

export interface FieldGrantResolution {
  /** (a) 该主体 temp_field_grant 应物化的授权行（仅 mask 表白名单；§4.5 步骤 3）。 */
  grantRows: FieldGrantRow[];
  /** (b) 每个登记 field chunk 的逐行可见判定（顺序与输入一致）。 */
  fieldChunkVisibility: ChunkVisibilityResult[];
}

/**
 * (c) 单 chunk allowed 判定纯函数（§4.7 规则 4/7）。
 *
 * @param nodeId         chunk 挂载节点（record=table 节点；doc/canvas=自身节点）
 * @param chunkKind      identity | field
 * @param fieldId        field chunk 的字段 id
 * @param scopeNodeIds   该主体可见 nodeId 集
 * @param maskedTables   tableNodeId -> allowFields（仅有 mask 的表；缺省 key=无收窄）
 */
export function isChunkAllowed(
  nodeId: string,
  chunkKind: ChunkKind,
  fieldId: string | null | undefined,
  scopeNodeIds: ReadonlySet<string>,
  maskedTables: Readonly<Record<string, readonly string[]>>,
): boolean {
  // 规则 7：节点不在 scope -> identity 与 field 全部不可见。
  if (!scopeNodeIds.has(nodeId)) return false;
  if (chunkKind === "identity") return true; // identity 恒可见（节点在 scope 即放行）。
  // 规则 4：scope 内且该表无 mask -> 全部 field 可见；有 mask -> 仅白名单字段可见。
  const allow = maskedTables[nodeId];
  if (allow === undefined) return true;
  return fieldId !== null && fieldId !== undefined && allow.includes(fieldId);
}

function sortRows(rows: FieldGrantRow[]): FieldGrantRow[] {
  return rows.sort((a, b) =>
    a.tableNodeId < b.tableNodeId ? -1
      : a.tableNodeId > b.tableNodeId ? 1
        : a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0);
}

/**
 * (a) 该主体 temp_field_grant 应有授权行集合（§4.5 步骤 3 / §4.7 规则 4）：
 * 仅展开 scope 内 mask 表的白名单字段；scope 外表剔除；fieldId 去重；(table,field) 确定序。
 * scope 内无 mask 表不出行（空表=无字段收窄，召回谓词 NOT EXISTS 分支放行）。
 */
export function buildFieldGrantRows(
  scopeNodeIds: ReadonlySet<string>,
  maskedTableFields: Readonly<Record<string, readonly string[]>>,
): FieldGrantRow[] {
  const rows: FieldGrantRow[] = [];
  for (const tableNodeId of Object.keys(maskedTableFields)) {
    if (!scopeNodeIds.has(tableNodeId)) continue; // scope 外整表缺席（规则 7）
    const seen = new Set<string>();
    for (const fieldId of maskedTableFields[tableNodeId]) {
      if (seen.has(fieldId)) continue; // 并集去重（M4 已并集，这里幂等防重）
      seen.add(fieldId);
      rows.push({ tableNodeId, fieldId });
    }
  }
  return sortRows(rows);
}

/**
 * (a)+(b) 一次性解析：授权行集合 + 逐 field chunk 判定（顺序保留）。
 * identity chunk 无需登记，判定请直接用 isChunkAllowed / classifyChunks。
 */
export function resolveFieldGrants(
  scopeNodeIds: ReadonlySet<string>,
  maskedTableFields: Readonly<Record<string, readonly string[]>>,
  registrations: readonly FieldChunkRegistration[],
): FieldGrantResolution {
  const grantRows = buildFieldGrantRows(scopeNodeIds, maskedTableFields);
  const fieldChunkVisibility: ChunkVisibilityResult[] = registrations.map((reg) => {
    const visible = isChunkAllowed(reg.tableNodeId, "field", reg.fieldId, scopeNodeIds, maskedTableFields);
    let reason: ChunkVisibilityResult["reason"] = null;
    if (!visible) {
      reason = scopeNodeIds.has(reg.tableNodeId) ? "field_masked" : "table_out_of_scope";
    }
    return { chunkRowid: reg.chunkRowid, visibility: visible ? "visible" : "hidden", reason };
  });
  return { grantRows, fieldChunkVisibility };
}

/**
 * 混合 chunk 列表的批量判定（identity + field 混合输入，顺序保留）。
 * 供 S7 召回后二次校验/对拍使用；正常路径召回前已由 temp_scope/temp_field_grant 收敛。
 */
export function classifyChunks(
  chunks: readonly ChunkVisibilityInput[],
  scopeNodeIds: ReadonlySet<string>,
  maskedTableFields: Readonly<Record<string, readonly string[]>>,
): ChunkVisibilityResult[] {
  return chunks.map((c) => {
    const tableNodeId = c.tableNodeId ?? c.nodeId;
    const visible = isChunkAllowed(tableNodeId, c.chunkKind, c.fieldId, scopeNodeIds, maskedTableFields);
    let reason: ChunkVisibilityResult["reason"] = null;
    if (!visible) {
      if (!scopeNodeIds.has(tableNodeId)) reason = "table_out_of_scope";
      else if (c.chunkKind === "field") reason = "field_masked";
    }
    return { chunkRowid: c.chunkRowid, visibility: visible ? "visible" : "hidden", reason };
  });
}
