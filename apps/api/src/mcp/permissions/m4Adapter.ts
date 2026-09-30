// M6/S3 M4 适配层（薄封装，不复制引擎、不改 M4 文件）。
//
// 映射（M6-implementation-plan §3-2 / §4.4）：
//   listAccessibleResources(family) -> prepareScope + nodeVisibleInPrepared(act="r")，按 kind 归集 resourceId
//   can(action, resource)          -> 同一 PreparedScope 内定位 (resourceType,resourceId) 节点后 nodeVisibleInPrepared
//   fieldCapability(tableNodeId)   -> M4 decide(...,"r").capability（fieldCapability 纯函数的下游产物）
//
// 性能：PreparedScope **每请求只预取一次**（本端口实例按请求创建），后续判定零额外往返；
//   这是 §4.7「decide 客体 SQL 定数」在 MCP 侧的沿用（避免每次 can() 重算 scope）。
//
// 评审纪律（§3-3）：本文件是 mcp/** 内唯一的 M4 边界；只把 prisma 客户端**作为参数**传给 M4 函数，
// 自身不做资源裸查（无 `prisma.<model>` 调用）；资源判定全部经 M4。

import { canCreateLibraryNow } from "../../domain/org/createLibraryGuard.js";
import { prisma } from "../../db.js";
import type { AuthzClient } from "../../domain/authz/types.js";
import { nodeVisibleInPrepared, prepareScope, type PreparedScope } from "../../domain/authz/scope.js";
import { decide, collectScopedNodes } from "../../domain/authz/engine.js";
import { makeCreatedByResolver } from "../../domain/authz/adapter.js";
import { writeOnlyFieldCapability, syntheticWidePolicy } from "../../domain/authz/fieldMask.js";
import {
  FAMILY_KINDS, type AccessibleResources, type McpAction, type McpFieldCapability,
  type McpPermissionPort, type McpResource, type McpSubject, type McpWriteFieldCapability,
  type ResourceFamily,
} from "./types.js";

const WORKSPACE_ID = "ws_default";

/** 按请求构建的端口（内部惰性预取 scope，多次判定复用）。 */
export function createMcpPermissionPort(
  subject: McpSubject,
  client: AuthzClient = prisma,
): McpPermissionPort & { preload(): Promise<void> } {
  let preparedPromise: Promise<PreparedScope> | null = null;
  const prepared = (): Promise<PreparedScope> => {
    preparedPromise ??= prepareScope(client, subject.userId, { workspaceId: WORKSPACE_ID });
    return preparedPromise;
  };

  return {
    preload: async () => { await prepared(); },
    async listAccessibleResources(family: ResourceFamily, actions: McpAction[] = ["r"]): Promise<AccessibleResources> {
      const p = await prepared();
      // 动作敏感：任一所需动作可见即纳入该资源（缺省读动作，保持既有调用语义）
      const wanted = actions.length > 0 ? actions : (["r"] as McpAction[]);
      const kinds = new Set<string>(FAMILY_KINDS[family]);
      const byKind: Partial<Record<string, string[]>> = {};
      for (const node of p.nodes) {
        const kind = node.resourceType;
        if (!kind || !node.resourceId || !kinds.has(kind)) continue;
        if (!wanted.some((a) => nodeVisibleInPrepared(p, node, a))) continue;
        (byKind[kind] ??= []).push(node.resourceId);
      }
      for (const k of Object.keys(byKind)) byKind[k]!.sort();
      // budget 截断：scope 侧超预算时 resourceIdsByType 已按预算切齐，此处以「族内任一类被截」
      // 的保守口径表达（调用方据此退化 enum）。
      const truncated = p.nodes.length > 20_000;
      return { byKind: byKind as AccessibleResources["byKind"], truncated };
    },

    async can(action: McpAction, resource: McpResource): Promise<boolean> {
      const p = await prepared();
      const node = p.nodes.find((n) => n.resourceType === resource.kind && n.resourceId === resource.id);
      if (!node) return false; // 不存在 / 不可见：同口径 false（不泄漏存在性）
      return nodeVisibleInPrepared(p, node, action);
    },

    async fieldCapabilityOf(resource: McpResource): Promise<McpFieldCapability> {
      const p = await prepared();
      const node = p.nodes.find((n) => n.resourceType === resource.kind && n.resourceId === resource.id);
      if (!node) return { visible: false, visibleAll: false, visibleFields: null, writableAll: false };
      return this.fieldCapability(node.id);
    },

    async fieldCapability(tableNodeId: string): Promise<McpFieldCapability> {
      const p = await prepared();
      const node = p.byId.get(tableNodeId);
      if (!node) return { visible: false, visibleAll: false, visibleFields: null, writableAll: false };
      const { capability } = await decide({ client }, p.subject, tableNodeId, "r");
      return {
        visible: capability.visible,
        visibleAll: capability.visibleAll,
        visibleFields: capability.visibleFields ? [...capability.visibleFields].sort() : null,
        writableAll: capability.writableAll,
      };
    },

    async writeFieldCapabilityOf(resource: McpResource, action: "c" | "u"): Promise<McpWriteFieldCapability> {
      const p = await prepared();
      const node = p.nodes.find((n) => n.resourceType === resource.kind && n.resourceId === resource.id);
      if (!node) return { matched: false, writableAll: false, writableFields: [] };
      // 与 REST FieldMaskSession.forTable 同口径：collectScopedNodes + creator/owner 兜底宽来源。
      const deps = {
        client, workspaceId: WORKSPACE_ID,
        resolveCreatedBy: makeCreatedByResolver(client),
      };
      const { policies, node: hit } = await collectScopedNodes(deps, p.subject, node.id);
      const isCreator = (await deps.resolveCreatedBy?.(hit)) === subject.userId;
      const effective = isCreator || p.subject.isWorkspaceOwner
        ? [...policies, syntheticWidePolicy(subject.userId, hit.id)]
        : policies;
      const cap = writeOnlyFieldCapability(effective, action);
      return {
        matched: cap.writeMatched,
        writableAll: cap.writableAll,
        writableFields: [...cap.writableFields].sort(),
      };
    },

    async canCreateLibrary(): Promise<boolean> {
      // 与 REST createLibraryGuard 同一判定真源（含无授予实例兜底）
      return canCreateLibraryNow(subject.userId);
    },
  };
}

/** 端口工厂（mcpApp 每请求调用一次；subject 绑定后端口自持 scope 缓存）。 */
export function mcpPermissionPortFactory(subject: McpSubject): McpPermissionPort {
  return createMcpPermissionPort(subject);
}
