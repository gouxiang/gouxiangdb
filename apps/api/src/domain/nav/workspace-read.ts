// M3/S5 权威资源树读（GET /api/v1/workspaces/current/tree 的领域服务）。
//
// 10 万节点保护（计划 §4.5/§7-S5）：
//   - 普通登录用户：必须给 parentId（"root" 或空串 = L0 根层，不是全量），响应受
//     maxDepth 界（默认 2，最大 10）；不带 parentId 的全量请求 -> 400；
//   - 组织管理员（有效角色中持有任意 manage_* 动作）显式 all=1：返回含软删的全量节点，
//     不受界；非管理员 all=1 -> 403。
//   - kind 过滤对两种模式都生效。
// M3 零剪枝（裁决 1）：不按资源成员关系过滤节点。
// M4/S7（裁决 A-6）：仅当路由传入 prune 索引（on 态独立门）时，在三分支取到行之后、
//   toDto 之前做后置剪枝——无 r 资源节点连同子树裁剪、空容器隐藏/标灰；off/shadow 不剪。

import type { NavKind, NavNodeDTO, NavTreeDTO } from "@gx/shared-types";
import type { DbTx } from "../../db.js";
import { WS_ID } from "./backfill.js";
import { pruneTreeRows, type PruneIndex } from "./prune.js";

/** 普通分块读的默认/最大层级跨度。 */
const TREE_DEFAULT_MAX_DEPTH = 2;
const TREE_MAX_DEPTH_CAP = 10;

export interface TreeParams {
  parentId?: string;
  maxDepth?: number;
  kind?: NavKind;
  all?: boolean;
}

/** on 态剪枝入参（authz 层 buildNavVisibility 产物；缺省即 M3 零剪枝）。 */
type TreePrune = PruneIndex;

export class TreeQueryError extends Error {
  constructor(public status: 400 | 403, message: string) {
    super(message);
  }
}

interface TreeRow {
  id: string; workspaceId: string; parentId: string | null; kind: string;
  resourceType: string | null; resourceId: string | null; name: string; ord: number;
  path: string; depth: number; isSystem: number; iconName: string | null;
  createdAt: Date; updatedAt: Date | null; deletedAt: Date | null;
}

function toDto(row: TreeRow, dimmed: boolean | undefined): NavNodeDTO {
  const dto: NavNodeDTO = {
    id: row.id,
    workspaceId: row.workspaceId,
    parentId: row.parentId,
    kind: row.kind as NavKind,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    name: row.name,
    ord: row.ord,
    path: row.path,
    depth: row.depth,
    isSystem: row.isSystem === 1,
    iconName: row.iconName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
  // off/shadow（dimmed=undefined）不下发 dimmed 键，与 M3 金标准字节一致。
  if (dimmed) dto.dimmed = true;
  return dto;
}

function parseMaxDepth(raw: number | undefined): number {
  if (raw === undefined) return TREE_DEFAULT_MAX_DEPTH;
  if (!Number.isInteger(raw) || raw < 1) {
    throw new TreeQueryError(400, "maxDepth 必须为不小于 1 的整数");
  }
  return Math.min(raw, TREE_MAX_DEPTH_CAP);
}

/** 管理全量读：含软删的全量节点（10 万节点保护的管理员例外通道），不做权限剪枝。 */
async function readAll(tx: DbTx, kind: NavKind | undefined): Promise<{ rows: TreeRow[]; navVersion: number }> {
  const rows = await tx.navNode.findMany({
    where: kind ? { workspaceId: WS_ID, kind } : { workspaceId: WS_ID },
    orderBy: [{ depth: "asc" }, { ord: "asc" }, { id: "asc" }],
  });
  return { rows: rows as TreeRow[], navVersion: await navVersionOf(tx) };
}

/** 根层分块：L0（parentId IS NULL）起最多 maxDepth 层。 */
async function readRootChunk(
  tx: DbTx, maxDepth: number, kind: NavKind | undefined,
): Promise<{ rows: TreeRow[]; navVersion: number }> {
  const rows = await tx.navNode.findMany({
    where: {
      workspaceId: WS_ID, deletedAt: null, depth: { gte: 1, lte: maxDepth },
      ...(kind ? { kind } : {}),
    },
    orderBy: [{ depth: "asc" }, { ord: "asc" }, { id: "asc" }],
  });
  return { rows: rows as TreeRow[], navVersion: await navVersionOf(tx) };
}

/** 子树分块：锚点节点（须活）起最多 maxDepth 层，沿物化 path 前缀取。 */
async function readSubtree(
  tx: DbTx, parentId: string, maxDepth: number, kind: NavKind | undefined,
): Promise<{ rows: TreeRow[]; navVersion: number }> {
  const anchor = await tx.navNode.findFirst({
    where: { id: parentId, workspaceId: WS_ID, deletedAt: null },
  });
  if (!anchor) throw new TreeQueryError(400, "parentId 对应的活节点不存在");
  const rows = await tx.navNode.findMany({
    where: {
      workspaceId: WS_ID, deletedAt: null,
      path: { startsWith: anchor.path },
      depth: { lte: anchor.depth + maxDepth - 1 },
      ...(kind ? { kind } : {}),
    },
    orderBy: [{ depth: "asc" }, { ord: "asc" }, { id: "asc" }],
  });
  return { rows: rows as TreeRow[], navVersion: await navVersionOf(tx) };
}

export async function navVersionOf(tx: DbTx): Promise<number> {
  const ws = await tx.workspace.findUnique({ where: { id: WS_ID }, select: { navVersion: true } });
  return ws?.navVersion ?? 0;
}

/**
 * tree 读编排。all 模式的管理员判定在控制器侧完成（hasAnyManageAction），
 * 本函数通过 isAdmin 参数注入，保持领域服务零 HTTP 依赖。
 * prune 仅在 on 态由路由注入（同 tx 内构造，含工作区全量活节点结构）。
 */
export async function readNavTree(
  tx: DbTx,
  params: TreeParams,
  isAdmin: boolean,
  prune?: TreePrune,
): Promise<NavTreeDTO> {
  let fetched: { rows: TreeRow[]; navVersion: number };
  if (params.all) {
    if (!isAdmin) throw new TreeQueryError(403, "仅组织管理员可使用 all=1 全量读取");
    fetched = await readAll(tx, params.kind);
    // 管理全量读保留软删/全节点，不做权限剪枝（与 M3 管理通道语义一致）。
    return {
      workspaceId: WS_ID,
      navVersion: fetched.navVersion,
      items: fetched.rows.map((r) => toDto(r, undefined)),
      truncated: false,
    };
  }
  const maxDepth = parseMaxDepth(params.maxDepth);
  if (params.parentId === undefined) {
    throw new TreeQueryError(400, "全量请求受 10 万节点保护限制：请指定 parentId（根层用 root）或由管理员显式 all=1");
  }
  if (params.parentId === "" || params.parentId === "root") {
    fetched = await readRootChunk(tx, maxDepth, params.kind);
  } else {
    fetched = await readSubtree(tx, params.parentId, maxDepth, params.kind);
  }

  let items: NavNodeDTO[];
  if (prune) {
    // allNodes 由 authz 层在构造索引时随 scope 预取（工作区全量活节点），此处不再二次查询。
    const kept = pruneTreeRows(fetched.rows, prune);
    // 防存在性探测：锚点自身（子树读）在剪枝后不可见 -> 403，不返回空壳 200。
    if (params.parentId !== "" && params.parentId !== "root" && !kept.some((k) => k.row.id === params.parentId)) {
      throw new TreeQueryError(403, "无权查看该节点或其已删除");
    }
    items = kept.map(({ row, dimmed }) => toDto(row, dimmed || undefined));
  } else {
    items = fetched.rows.map((r) => toDto(r, undefined));
  }
  return { workspaceId: WS_ID, navVersion: fetched.navVersion, items, truncated: false };
}
