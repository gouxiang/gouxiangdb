// apps/web/src/features/collab/lease-registry.ts
// 块级占用的**统一登记处**（DESIGN.md §5.2「单元占用租约」）。
//
// 为什么必须是模块级单例而不是组件 state：文档页面上存在多套编辑入口
// （正文块、折叠块 summary、callout 头、代码块等），组件各自维护一份就会出现
// 「入口 A 屏蔽了、入口 B 没屏蔽」的单边失效 —— 占用控制形同虚设。
// 单例保证：任意入口登记 → 所有入口同时看见。
//
// 三条释放路径（缺一就会出现幽灵锁）：
//   1. 显式释放：离开编辑 → release(unit)。
//   2. 超时释放：本地 30s 未续约即失效（本文件的 `sweep` / 读取时惰性清理）。
//   3. awareness 消失即释放：远端租约由 `syncRemote` **全量替换**，
//      某个 peer 从名单里掉了（关标签页 / 断线 / 服务端 30s ping 剔除），
//      它名下所有租约随之消失 —— 不需要服务端发任何「解锁」消息。
//
// 租约是**体验层软锁**，不承担数据安全职责（CRDT 自身会合并），见 §5.2「冲突回退」：
// 因此这里的判定即便被绕过也不会丢数据，可以做成纯客户端、无服务端裁决、零往返延迟。

import type { CollabPresenceEntry } from "@gx/shared-types";

/** 30s 未续约视为失效 —— §5.2「超时释放」；与服务端 30s ping 剔除构成双保险。 */
export const LEASE_TTL_MS = 30_000;
/** 编辑态持续期间每 5s 续约 —— §5.2「续约」。导出给调用方驱动续约定时器。 */
export const LEASE_RENEW_MS = 5_000;

export interface LeaseHolder {
  /** 占用单元；文档里就是块 id。 */
  unit: string;
  /** true = 本连接自己占着。自己的块永远对自己可编辑（本地优先，见 holderOf）。 */
  self: boolean;
  /** presence entry id（连接级）。 */
  id: string;
  nick: string;
  color: string;
  since: number;
  expiresAt: number;
}

export interface LeaseRegistry {
  /** 进入编辑即登记。幂等：重复调用只续期，不动 since（since 是裁决依据，必须稳定）。 */
  acquire(unit: string, now?: number): void;
  /** 离开编辑即释放。 */
  release(unit: string): void;
  /** 组件卸载 / 协同关闭时清空本地全部租约。 */
  releaseAll(): void;
  /** 用远端名单**全量替换**远端租约表；传入的 peers 必须已剔除自己（调用方先用 splitPresence）。 */
  syncRemote(peers: readonly CollabPresenceEntry[], now?: number): void;
  /** 清理所有过期租约；返回是否真的发生了变化（供 1s 兜底定时器决定是否通知）。 */
  sweep(now?: number): boolean;
  /** 某单元当前归谁；本地优先；无人占用 → null。 */
  holderOf(unit: string, now?: number): LeaseHolder | null;
  /** 全量快照 Map<unit, LeaseHolder>，本地优先覆盖远端。 */
  heldUnits(now?: number): Map<string, LeaseHolder>;
  /** 订阅变更；返回取消订阅函数。 */
  subscribe(listener: () => void): () => void;
}

interface RemoteEntry {
  id: string;
  nick: string;
  color: string;
  since: number;
  expiresAt: number;
}

function nowMs(now?: number): number {
  return typeof now === "number" ? now : Date.now();
}

/** 逐字段比对，用于判断远端表是否真的变了（避免无变化时通知订阅者导致渲染层空转）。 */
function sameRemote(a: RemoteEntry | undefined, b: RemoteEntry | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.id === b.id &&
    a.nick === b.nick &&
    a.color === b.color &&
    a.since === b.since &&
    a.expiresAt === b.expiresAt
  );
}

function toHolder(e: RemoteEntry, unit: string): LeaseHolder {
  return { unit, self: false, id: e.id, nick: e.nick, color: e.color, since: e.since, expiresAt: e.expiresAt };
}

function createRegistry(): LeaseRegistry {
  /** 本地自己占着的单元。 */
  const local = new Map<string, { since: number; expiresAt: number }>();
  /** 远端 peer 占着的单元，已裁决为唯一胜者。 */
  const remote = new Map<string, RemoteEntry>();
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const l of listeners) l();
  }

  /** 清掉本地过期项；返回是否清掉了东西。 */
  function dropExpiredLocal(now: number): boolean {
    let changed = false;
    for (const [unit, lease] of local) {
      if (lease.expiresAt <= now) {
        local.delete(unit);
        changed = true;
      }
    }
    return changed;
  }

  return {
    acquire(unit, now) {
      const t = nowMs(now);
      const existing = local.get(unit);
      const next = { since: existing ? existing.since : t, expiresAt: t + LEASE_TTL_MS };
      if (existing && existing.expiresAt === next.expiresAt && existing.since === next.since) return;
      local.set(unit, next);
      notify();
    },

    release(unit) {
      if (!local.delete(unit)) return;
      notify();
    },

    releaseAll() {
      if (local.size === 0) return;
      local.clear();
      notify();
    },

    syncRemote(peers, now) {
      const t = nowMs(now);
      const next = new Map<string, RemoteEntry>();
      for (const peer of peers) {
        for (const lease of peer.leases) {
          // 过期租约不参与：对方本地已超时但 awareness 还没刷新的窗口不必视为占用
          if (lease.expiresAt <= t) continue;
          const candidate: RemoteEntry = {
            id: peer.id,
            nick: peer.nick,
            color: peer.color,
            since: lease.since,
            expiresAt: lease.expiresAt,
          };
          const cur = next.get(lease.unit);
          if (!cur || winsOver(candidate, cur)) next.set(lease.unit, candidate);
        }
      }

      let changed = remote.size !== next.size;
      if (!changed) {
        for (const [unit, entry] of next) {
          if (!sameRemote(remote.get(unit), entry)) {
            changed = true;
            break;
          }
        }
      }
      if (!changed) return;
      remote.clear();
      for (const [unit, entry] of next) remote.set(unit, entry);
      notify();
    },

    sweep(now) {
      const t = nowMs(now);
      let changed = dropExpiredLocal(t);
      for (const [unit, entry] of remote) {
        if (entry.expiresAt <= t) {
          remote.delete(unit);
          changed = true;
        }
      }
      if (changed) notify();
      return changed;
    },

    holderOf(unit, now) {
      const t = nowMs(now);
      const mine = local.get(unit);
      if (mine && mine.expiresAt > t) {
        return { unit, self: true, id: "", nick: "", color: "", since: mine.since, expiresAt: mine.expiresAt };
      }
      if (mine) {
        local.delete(unit);
        notify();
      }
      const other = remote.get(unit);
      if (!other) return null;
      if (other.expiresAt <= t) {
        remote.delete(unit);
        notify();
        return null;
      }
      return toHolder(other, unit);
    },

    heldUnits(now) {
      const t = nowMs(now);
      if (dropExpiredLocal(t)) notify();
      const out = new Map<string, LeaseHolder>();
      for (const [unit, entry] of remote) {
        if (entry.expiresAt <= t) continue;
        out.set(unit, toHolder(entry, unit));
      }
      // 本地优先覆写：自己正编辑的块不能被自己遮住，哪怕远端也声明了同一单元
      for (const [unit, lease] of local) {
        if (lease.expiresAt <= t) continue;
        out.set(unit, {
          unit,
          self: true,
          id: "",
          nick: "",
          color: "",
          since: lease.since,
          expiresAt: lease.expiresAt,
        });
      }
      return out;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * §5.2「同一单元出现多个 lease 时按 clientID 升序 / 首次声明时间戳确定性裁决，保证两端看到同一个胜者」。
 * 先比 since（早声明者胜），再比 id 字典序（纯确定性兜底，无需时钟同步）。
 */
function winsOver(a: RemoteEntry, b: RemoteEntry): boolean {
  if (a.since !== b.since) return a.since < b.since;
  return a.id < b.id;
}

let instance: LeaseRegistry | null = null;

export function getLeaseRegistry(): LeaseRegistry {
  instance ??= createRegistry();
  return instance;
}

/** 仅供单测：丢弃单例重建，避免用例之间互相污染（它是模块级全局状态）。 */
export function resetLeaseRegistry(): void {
  instance = null;
}
