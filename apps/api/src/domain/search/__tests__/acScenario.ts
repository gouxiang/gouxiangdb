// M5/S8 AC-M5-2 对抗测试共享场景：可控向量 cloud provider + 三类主体/资源（真迁移主库 + 真 vec0）。
//
// 资源（单一主体 U）：
//   - T_deny：U 无任何 r（表级越权）。record r_deny 含独有文本 DENY，identity 含独有表名，
//     用于 AC-M5-2a：三种 mode 下整实体（含 identity chunk）都必须缺席。
//   - T_mask：U 有 r 但 fieldMask 仅白名单 f_pub；主字段 f_secret 被 mask。r_mask 的
//       f_secret(密文 SECRET，向量与查询向量几乎重合=距离 0)、f_pub(白名单 PUBLIC，距离 0.632)、
//     identity(距离 1.414)。用于 AC-M5-2b：即使密文 chunk 是全局最近邻，KNN 也必须在扫描层
//     按 temp_field_grant 剔除它，召回/摘要只呈现白名单 chunk。
//   - T_ok：U 有 r 无 mask，r_ok 普通可见（对照 + decide 失配注入用）。
//
// 可控 provider 让"是否泄漏"不依赖距离侥幸：密文 chunk 向量 = 查询向量本身（全局最近），
// 一旦 rowid IN (allowed) 收敛失效，它必以距离 0 占首位并泄漏；正常则扫描层即排除。

import type { PrismaClient } from "@prisma/client";
import type { SearchStore } from "../searchStore.js";
import type { EmbeddingProvider } from "../embedding/types.js";
import { extractEntity } from "../entityExtract.js";
import { applyUpsert } from "../indexerDerive.js";
import { querySeed } from "./queryHarness.js";
import type { QueryHarness } from "./queryHarness.js";

export const DIM = 4;
export const U = "u_ac2";

export const T_DENY = "ac2_table_deny";
export const T_MASK = "ac2_table_mask";
export const T_OK = "ac2_table_ok";
export const N_DENY = `nav_table_${T_DENY}`;
export const N_MASK = `nav_table_${T_MASK}`;
export const N_OK = `nav_table_${T_OK}`;
export const R_DENY = "ac2_r_deny";
export const R_MASK = "ac2_r_mask";
export const R_OK = "ac2_r_ok";

export const F_DENY = "ac2_f_deny";
export const F_SECRET = "ac2_f_secret";
export const F_PUB = "ac2_f_pub";
export const F_OK = "ac2_f_ok";

/** 密文字段独有文本（长词走 FTS；向量距离 0）。 */
export const SECRET = "MASK_SECRET_ZX9 机密向量近邻密文";
/** 白名单字段独有文本（长词走 FTS；向量距离 0.632）。 */
export const PUBLIC = "PUBLIC_TOKEN_P7 公开白名单内容";
/** 越权表独有文本（字段值）。 */
export const DENY_FIELD = "拒权独有DENYX7_FIELD";
/** 越权表 identity 独有表名（验证 identity chunk 也被 temp_scope 剔除，与字段无关）。 */
export const DENY_TABLE = "拒权表DNX7_TABLE";
export const OK_TEXT = "普通对照可见OKX1_PUBLIC_REF";
/** 向量近义查询（与密文 chunk 向量重合；本身不含密文/FTS 词，纯语义路用）。 */
export const QTEXT = "VQ_NEAR_QUERY_9";

/** L2 归一化（给定向量已手工取单位长，这里仍显式归一以防笔误）。 */
function unit(v: number[]): Float32Array {
  const n = Math.hypot(...v) || 1;
  return Float32Array.from(v.map((x) => x / n));
}
export const QVEC = unit([1, 0, 0, 0]);
const PUB_VEC = unit([0.8, 0.6, 0, 0]); // 距 QVEC ≈ 0.632
const ID_VEC = unit([0, 0, 1, 0]); // 距 QVEC ≈ 1.414

export type ProviderRule = "controlled" | "fail" | "dimmismatch";

/** 可控 cloud provider。seed 用 controlled；查询期可换 fail/dimmismatch 验降级。 */
export function controlledProvider(rule: ProviderRule = "controlled"): EmbeddingProvider {
  return {
    mode: "cloud",
    model: "ac2-mock",
    dim: 0,
    batchSize: 64,
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      if (rule === "fail") throw new Error("mock cloud 503");
      if (rule === "dimmismatch") return texts.map(() => new Float32Array(999)); // 维度不符 -> dim_mismatch
      return texts.map((t) => {
        if (t.includes("MASK_SECRET_ZX9")) return Float32Array.from(QVEC);
        if (t.includes("PUBLIC_TOKEN_P7")) return Float32Array.from(PUB_VEC);
        if (t === QTEXT) return Float32Array.from(QVEC);
        return Float32Array.from(ID_VEC);
      });
    },
    async health() { return { ok: true }; },
    async dispose() { return undefined; },
  } as unknown as EmbeddingProvider;
}

async function mkTable(
  prisma: PrismaClient,
  tableId: string,
  primaryFieldId: string,
  fields: Array<[string, string, string]>,
): Promise<void> {
  await prisma.base.create({ data: { id: `${tableId}_b`, name: `${tableId} 库`, createdBy: "owner" } });
  await prisma.table.create({
    data: { id: tableId, baseId: `${tableId}_b`, name: tableId === T_DENY ? DENY_TABLE : `${tableId} 对抗表`,
      primaryFieldId, createdBy: "owner" },
  });
  for (let i = 0; i < fields.length; i += 1) {
    const [fid, name, type] = fields[i]!;
    await prisma.field.create({ data: { id: fid, tableId, name, type, order: i } });
  }
}

async function indexRecord(store: SearchStore, prisma: PrismaClient, recordId: string,
  cloud: boolean, provider: EmbeddingProvider | null): Promise<void> {
  const entity = await extractEntity(prisma, { entityType: "record", entityId: recordId, version: 1n }, 50);
  await applyUpsert(store, entity, {
    workspaceId: "ws_default", mode: cloud ? "cloud" : "off", provider: cloud ? provider : null,
  });
}

/**
 * 播种完整 AC-M5-2 场景到指定 store。
 * @param cloud true=用 controlled provider 写向量（vec0 库）；false=fts-only off 形态。
 */
export async function seedAcScenario(
  h: QueryHarness,
  store: SearchStore,
  cloud: boolean,
): Promise<{ provider: EmbeddingProvider | null }> {
  const provider = cloud ? controlledProvider("controlled") : null;
  const prisma = h.prisma;

  await querySeed.createUsers(prisma, [{ id: U }, { id: "owner", email: "ac2_owner@x.com" }]);

  await mkTable(prisma, T_DENY, F_DENY, [[F_DENY, "拒权字段", "longText"]]);
  await mkTable(prisma, T_MASK, F_SECRET, [
    [F_SECRET, "机密字段", "longText"],
    [F_PUB, "公开备注", "longText"],
  ]);
  await mkTable(prisma, T_OK, F_OK, [[F_OK, "客户名", "singleLineText"]]);

  await prisma.record.create({
    data: { id: R_DENY, tableId: T_DENY, createdBy: "owner", updatedBy: "owner",
      fields: JSON.stringify({ [F_DENY]: DENY_FIELD }) },
  });
  await prisma.record.create({
    data: { id: R_MASK, tableId: T_MASK, createdBy: "owner", updatedBy: "owner",
      fields: JSON.stringify({ [F_SECRET]: SECRET, [F_PUB]: PUBLIC }) },
  });
  await prisma.record.create({
    data: { id: R_OK, tableId: T_OK, createdBy: "owner", updatedBy: "owner",
      fields: JSON.stringify({ [F_OK]: OK_TEXT }) },
  });

  await querySeed.createNavNodes(prisma, [
    { id: `nav_base_${T_DENY}_b`, kind: "base", resourceType: "base", resourceId: `${T_DENY}_b`, parentId: null },
    { id: N_DENY, kind: "table", resourceType: "table", resourceId: T_DENY, parentId: `nav_base_${T_DENY}_b` },
    { id: `nav_base_${T_MASK}_b`, kind: "base", resourceType: "base", resourceId: `${T_MASK}_b`, parentId: null },
    { id: N_MASK, kind: "table", resourceType: "table", resourceId: T_MASK, parentId: `nav_base_${T_MASK}_b` },
    { id: `nav_base_${T_OK}_b`, kind: "base", resourceType: "base", resourceId: `${T_OK}_b`, parentId: null },
    { id: N_OK, kind: "table", resourceType: "table", resourceId: T_OK, parentId: `nav_base_${T_OK}_b` },
  ]);
  // T_deny 不给 U 任何策略；T_mask 仅白名单 f_pub；T_ok 直授 r 无 mask。
  await querySeed.createPolicies(prisma, [
    { id: "ac2_p_mask", nodeId: N_MASK, subjectType: "user", subjectId: U, actions: "r",
      fieldMask: '{"allowFields":["ac2_f_pub"]}' },
    { id: "ac2_p_ok", nodeId: N_OK, subjectType: "user", subjectId: U, actions: "r" },
  ]);

  for (const rid of [R_DENY, R_MASK, R_OK]) {
    await indexRecord(store, prisma, rid, cloud, provider);
  }
  return { provider };
}
