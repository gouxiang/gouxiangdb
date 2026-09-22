// apps/web/src/features/collab/useCollabLeases.ts
// 把 awareness 名单里的远端租约接到**模块级单例登记处**，并驱动 React 重渲染。
//
// 这一层只做「接线」，不含判定逻辑：所有权裁决、超时、仲裁全部在 lease-registry.ts。
// 这样划分的理由：登记表要保持单例且可被任意入口读写，判定逻辑一旦混进 hook，
// 就会出现「不同 hook 实例各有一套判定」的老问题。
//
// 另外三条约定（都关系正确性）：
//   1. 「awareness 消失即视为释放」由 syncRemote 的**全量替换**实现 —— 它每次都用最新名单
//      重建远端表，某 peer 掉了（关标签页 / 断线 / 服务端 30s ping 剔除），它的租约随之消失，
//      不需要服务端下发任何「解锁」消息。
//   2. 1s 的 sweep 定时器是**兜底**：对端断线且 awareness 尚未刷新到本地时，用 expiresAt
//      超时把它清掉。两条路径合起来消灭幽灵锁（DESIGN.md §5.2「双保险」）。
//   3. `enabled=false`（未启用协同）时不订阅、不灌数据、不起定时器 —— D6 要求单机行为
//      与引入前完全一致，空转的定时器也算行为差异。

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CollabPresenceEntry } from "@gx/shared-types";
import { splitPresence } from "./collab-peers";
import { getLeaseRegistry, type LeaseHolder, type LeaseRegistry } from "./lease-registry";

export interface UseCollabLeasesResult {
  registry: LeaseRegistry;
  /** 每次登记表变化都会自增，供上层作为 useMemo/渲染的依赖。 */
  version: number;
}

export function useCollabLeases(
  entries: readonly CollabPresenceEntry[],
  selfId: string | null,
  enabled = true,
): UseCollabLeasesResult {
  const registry = useMemo(() => getLeaseRegistry(), []);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = registry.subscribe(() => setVersion((v) => v + 1));
    registry.syncRemote(splitPresence(entries, selfId).peers);
    const timer = setInterval(() => registry.sweep(), 1_000);
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [enabled, entries, selfId, registry]);

  useEffect(() => {
    // enabled 由 true 变 false：协同被关掉，本地租约必须一并释放，否则它们会以幽灵状态
    // 一直挡住直到 TTL 到期。正常卸载**不**释放（遮罩卸载不该让别人能抢注）。
    if (!enabled) registry.releaseAll();
  }, [enabled, registry]);

  return { registry, version };
}

/** 单个单元的当前占用者。订阅变更自动重渲染；无人占用 → null。 */
export function useUnitLease(unit: string | null): LeaseHolder | null {
  const registry = useMemo(() => getLeaseRegistry(), []);
  const [holder, setHolder] = useState<LeaseHolder | null>(null);

  useEffect(() => {
    if (unit === null) {
      setHolder(null);
      return;
    }
    const read = (): void => setHolder(registry.holderOf(unit));
    read();
    return registry.subscribe(read);
  }, [registry, unit]);

  return holder;
}

/**
 * 本地写入口：进入编辑即 acquire，离开即 release。
 * 返回稳定引用的函数（依赖为空），避免挂在 onFocus/onBlur 上时每次渲染都换新函数。
 */
export function useLeaseWriter(): { acquire: (unit: string) => void; release: (unit: string) => void } {
  const registry = useMemo(() => getLeaseRegistry(), []);
  const acquire = useCallback((unit: string) => registry.acquire(unit), [registry]);
  const release = useCallback((unit: string) => registry.release(unit), [registry]);
  return { acquire, release };
}
