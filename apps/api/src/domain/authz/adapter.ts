// 引擎适配层：把守卫的资源引用（base/kb/doc/...）解析为 nav 节点，跑一次引擎 decide。
// 权限引擎永久单一化后，本层是引擎布尔裁决的唯一点查入口，无条件被守卫调用。
//
// 边界：
//   - 本模块是"适配层"，允许 import config/db 与引擎，但不 import Hono/guards（守卫 import 本层，反向禁止）；
//   - 引擎本身（engine/subjects/repository）不读旧三表；本层只提供"资源 -> nav nodeId"反查与主体展开；
//   - engineDecideResource 不吞错：错误由调用方（enforceGate）按 fail-closed 处理。
//
// 客体点查：nav_nodes [workspaceId,resourceType,resourceId] 唯一索引（M3 已建），一次 findUnique。
// table 的视图/记录动作在守卫侧统一映射到其 base 节点（沿 nav 祖先继承）。

import type { ResourceAction } from "@gx/shared-types";
import { prisma } from "../../db.js";
import { decide, type EngineDeps } from "./engine.js";
import { resolveSubject } from "./subjects.js";
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
async function resolveNodeId(
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

/** 引擎侧单资源单动作判定（不吞错；错误由调用方 enforceGate 按 fail-closed 处理）。 */
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
