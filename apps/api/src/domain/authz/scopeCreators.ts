// M4/S4 visible-scope 的 createdBy 兜底批量解析。
//
// decide 单节点时 createdBy 由适配器按 resourceType 点查（一条）；scope 是批量形态，若逐节点点查
// 会变 N 次往返。这里用一条参数化 UNION ALL 把"目标用户创建的全部活资源"一次取回为
// `${resourceType}:${resourceId}` 集合，供逐节点 creator 兜底判定，与 decide 的 creator 兜底同语义。
//
// 纯数据访问：不读 members/kb_members/kb_doc_acls（授权三表），只读四实体表的 createdBy/删除标记。
// kb_docs 同时承载 doc/canvas，故 SELECT kind 作为类型前缀（'doc'|'canvas'）；view 无 createdBy 兜底。
// 全部值走绑定参数（userId 重复 4 次），无字符串内插，杜绝注入。

import type { AuthzClient } from "./types.js";

const CREATOR_UNION_SQL = `
SELECT 'base' AS t, "id" AS rid FROM "bases"
  WHERE "createdBy" = ? AND "deletedAt" IS NULL
UNION ALL
SELECT 'kb' AS t, "id" AS rid FROM "knowledge_bases"
  WHERE "createdBy" = ? AND "deletedAt" IS NULL
UNION ALL
SELECT "kind" AS t, "id" AS rid FROM "kb_docs"
  WHERE "createdBy" = ? AND "deletedAt" IS NULL
UNION ALL
SELECT 'table' AS t, "id" AS rid FROM "tables"
  WHERE "createdBy" = ? AND "deletedAt" IS NULL
`;

interface CreatorRow {
  t: string;
  rid: string;
}

/**
 * 取目标用户创建的全部活资源键集（`${resourceType}:${resourceId}`）。
 * 恒一条 SQL（UNION ALL，无子查询/无 SCAN，各实体 id/createdBy 均有索引或主键覆盖）。
 */
export async function creatorOwnedKeys(
  client: AuthzClient,
  userId: string,
): Promise<Set<string>> {
  const rows = await client.$queryRawUnsafe(CREATOR_UNION_SQL, userId, userId, userId, userId) as CreatorRow[];
  const keys = new Set<string>();
  for (const r of rows) {
    if ((r.t === "base" || r.t === "kb" || r.t === "doc" || r.t === "canvas" || r.t === "table") && r.rid) {
      keys.add(`${r.t}:${r.rid}`);
    }
  }
  return keys;
}
