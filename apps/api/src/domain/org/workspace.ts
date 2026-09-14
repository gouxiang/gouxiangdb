// M2/S3 默认工作区解析：单工作区交付，固定 id ws_default（见 S1 手写迁移幂等种子）。
//
// 内存单例 Promise 缓存：进程内首次解析查库确认存在并返回固定 id，之后复用，避免每请求一查。
// 多工作区是 Out-of-Scope（M2 计划 §2.2），故此处不接受 workspaceId 入参；users.workspaceId
// 列只留口，不建 Prisma 关系/FK。若库异常缺行（理论上迁移保证），回退仍用固定 id 不阻塞业务。

import { prisma } from "../../db.js";

export const DEFAULT_WORKSPACE_ID = "ws_default";

let resolvedId: string | null = null;
let inflight: Promise<string> | null = null;

/**
 * 取默认工作区 id（内存单例）。查不到具体行时不抛错——单工作区固定 id 本身即契约，
 * 组织写路径以该 id 落库；迁移/种子负责保证 ws_default 物理存在。
 */
export function getDefaultWorkspaceId(): Promise<string> {
  if (resolvedId) return Promise.resolve(resolvedId);
  if (!inflight) {
    inflight = prisma.workspace
      .findUnique({ where: { id: DEFAULT_WORKSPACE_ID }, select: { id: true } })
      .then((row) => {
        resolvedId = row?.id ?? DEFAULT_WORKSPACE_ID;
        inflight = null;
        return resolvedId;
      })
      .catch(() => {
        // 只读探针失败不阻断组织面：回退固定 id（写库时若真缺表会在该处显式报错）。
        resolvedId = DEFAULT_WORKSPACE_ID;
        inflight = null;
        return resolvedId;
      });
  }
  return inflight;
}

/** 测试/切换环境时清掉缓存（正常业务不调用）。 */
export function resetDefaultWorkspaceCache(): void {
  resolvedId = null;
  inflight = null;
}
