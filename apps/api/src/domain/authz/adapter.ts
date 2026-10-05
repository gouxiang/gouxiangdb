// M4/S3 shadow 适配层组合缝：把守卫的旧资源引用（base/kb/doc/...）解析为 nav 节点，
// 跑一次新引擎 decide，供 shadow 对拍。仅在 GX_AUTHZ_ENGINE 生效为 shadow 时被守卫调用。
//
// 边界（M4 计划 §7-S3 行524/560）：
//   - 本模块是"适配层"，允许 import config/db 与引擎，但不 import Hono/guards（守卫 import 本层，反向禁止）；
//   - 引擎本身（engine/subjects/repository）不读旧三表；旧决策由守卫算出后传入 shadowCompare，
//     本层只为引擎侧提供"资源 -> nav nodeId"反查与主体展开；
//   - 任何错误都在 runShadowCheck 内吞掉并记 metric，绝不抛出影响旧守卫响应（fail-open 仅限观测层）。
//
// 客体点查：nav_nodes [workspaceId,resourceType,resourceId] 唯一索引（M3 已建），一次 findUnique。
// table 的视图/记录动作在守卫侧统一映射到其 base 节点（旧成员权限本就 base 级，沿 nav 祖先继承）。

import type { ResourceAction } from "@gx/shared-types";
import { prisma } from "../../db.js";
import { decide, type EngineDeps } from "./engine.js";
import { resolveSubject } from "./subjects.js";
import { shadowCompare, shadowReportError, driftRegistry, type ShadowCompareContext } from "./shadow.js";
import type { AuthzClient, AuthzNode, CreatedByResolver } from "./types.js";

export const DEFAULT_WORKSPACE = "ws_default";

/** 守卫旧资源引用 -> nav 资源坐标。family 决定 creator 兜底点查哪张实体表。 */
export interface ResourceRef {
  resourceType: "base" | "kb" | "doc" | "canvas" | "table";
  resourceId: string;
  workspaceId?: string;
}

// 会话内有界缓存：同一请求/进程内对同一资源不重复点查 nav 节点 / createdBy。
const nodeCache = new Map<string, string | null>();
const creatorCache = new Map<string, string | null>();
const NODE_CACHE_MAX = 2000;

function cacheGet<K, V>(map: Map<K, V>, key: K): V | undefined {
  return map.get(key);
}
function cacheSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  if (map.size >= max) map.delete(map.keys().next().value as K);
  map.set(key, value);
}

/** 资源 -> 活 nav 节点 id（唯一索引一次点查；软删/缺失返回 null）。 */
export async function resolveNodeId(
  ref: ResourceRef,
  client: AuthzClient = prisma,
): Promise<string | null> {
  const ws = ref.workspaceId ?? DEFAULT_WORKSPACE;
  const key = `${ws}:${ref.resourceType}:${ref.resourceId}`;
  const hit = cacheGet(nodeCache, key);
  if (hit !== undefined) return hit;
  const node = await client.navNode.findUnique({
    where: {
      workspaceId_resourceType_resourceId: {
        workspaceId: ws,
        resourceType: ref.resourceType,
        resourceId: ref.resourceId,
      },
    },
    select: { id: true, deletedAt: true },
  });
  const id = node && node.deletedAt === null ? node.id : null;
  cacheSet(nodeCache, key, id, NODE_CACHE_MAX);
  return id;
}

/**
 * 实体 createdBy 兜底解析（按 resourceType 点查对应实体表）。
 * view 无独立 createdBy 语义，旧成员权限 base 级，视图动作由守卫映射到 base，故此处不处理 view。
 * 导出供 scope 批量对拍/对拍测试复用同一兜底口径（禁止第二套 creator 解析）。
 */
export function makeCreatedByResolver(client: AuthzClient): CreatedByResolver {
  return async (node: AuthzNode): Promise<string | null> => {
    const rt = node.resourceType;
    const rid = node.resourceId;
    if (!rt || !rid) return null;
    if (rt === "group" || rt === "view") return null;
    const key = `${rt}:${rid}`;
    const hit = cacheGet(creatorCache, key);
    if (hit !== undefined) return hit;

    let createdBy: string | null = null;
    const select = { createdBy: true } as const;
    if (rt === "base") {
      createdBy = (await client.base.findUnique({ where: { id: rid }, select }))?.createdBy ?? null;
    } else if (rt === "kb") {
      createdBy = (await client.knowledgeBase.findUnique({ where: { id: rid }, select }))?.createdBy ?? null;
    } else if (rt === "doc" || rt === "canvas") {
      createdBy = (await client.kbDoc.findUnique({ where: { id: rid }, select }))?.createdBy ?? null;
    } else if (rt === "table") {
      createdBy = (await client.table.findUnique({ where: { id: rid }, select }))?.createdBy ?? null;
    }
    cacheSet(creatorCache, key, createdBy, NODE_CACHE_MAX);
    return createdBy;
  };
}

/** 引擎侧单资源单动作判定（不吞错；错误由 runShadowCheck 统一捕获）。 */
export async function engineDecideResource(
  userId: string,
  ref: ResourceRef,
  action: ResourceAction,
  client: AuthzClient = prisma,
): Promise<{ nodeId: string | null; engineAllowed: boolean }> {
  const nodeId = await resolveNodeId(ref, client);
  if (!nodeId) return { nodeId: null, engineAllowed: false };

  const subject = await resolveSubject(userId, client);
  const deps: EngineDeps = {
    client,
    workspaceId: ref.workspaceId ?? DEFAULT_WORKSPACE,
    resolveCreatedBy: makeCreatedByResolver(client),
  };
  const result = await decide(deps, subject, nodeId, action);
  return { nodeId, engineAllowed: result.decision.allowed };
}

/**
 * shadow 对拍总入口（守卫在旧决策落定后调用）：
 *   - 资源反查不到活节点 -> 计 UNRESOLVED_NODE，不做布尔对拍（数据问题归 M3 reconcile，不当权限漂移）；
 *   - 引擎抛错 -> shadowReportError 吞错记 metric，旧响应不受影响；
 *   - 正常 -> shadowCompare 分类计数/脱敏日志，返回 drift 类（一致为 null）。
 * 不返回也不抛授权结论：调用方永远以旧决策为准。
 */
export async function runShadowCheck(
  guard: string,
  userId: string,
  ref: ResourceRef,
  action: ResourceAction,
  oldAllowed: boolean,
  client: AuthzClient = prisma,
  semantics: "authority" | "conjunction" = "authority",
): Promise<void> {
  // conjunction：该动作只是借位的必要条件（如删库借 d），并不等于关卡真实裁决。
  // 拿它与旧决策布尔对拍会产生结构性噪声（内容持 d 的编辑者被判「删库 overallow」），
  // 故跳过对拍、不计数；on 态 conjunction 仍由 enforceWithEngine 只减不增地正确执法。
  if (semantics === "conjunction") return;
  const baseCtx: ShadowCompareContext = { guard, action, nodeId: null, userId };
  try {
    const { nodeId, engineAllowed } = await engineDecideResource(userId, ref, action, client);
    if (!nodeId) {
      driftRegistry.noteUnresolvedNode();
      return;
    }
    shadowCompare(oldAllowed, engineAllowed, { ...baseCtx, nodeId });
  } catch (error) {
    shadowReportError(baseCtx, error);
  }
}
