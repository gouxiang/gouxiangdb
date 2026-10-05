// M2/S2 鉴权用户状态缓存（仅 GX_AUTH_STATE_TTL_MS>0 时启用，默认 0=完全旁路）。
//
// 单实例纪律（计划 §5-D.2）：默认零缓存，鉴权每请求一次 users 主键点查，严格保证
// "停用后下一次请求即 401"。只有显式配置正 TTL 才使用本缓存；停用/reactivate 在同进程
// 事务提交后必须调 invalidate(userId)，使即使开了短缓存也在下一次请求失效（TTL 仅兜底）。
//
// 实现：Map 插入序 LRU，容量上限 5000；每条带到期时间戳。不引依赖、不做后台定时器
// （过期项在读路径惰性淘汰；超容量在 set 时淘汰最旧）。多实例/PG 的失效广播属 ADR-0008 议题。

export interface AuthStateRow {
  userId: string;
  status: string;
  tokenVersion: number;
  workspaceId: string | null;
  mustChangePassword: boolean;
}

interface Entry extends AuthStateRow {
  expiresAt: number;
}

const MAX_ENTRIES = 5000;

interface AuthStateCache {
  get(userId: string): AuthStateRow | null;
  set(row: AuthStateRow, ttlMs: number): void;
  invalidate(userId: string): void;
  clear(): void;
  readonly size: number;
}

export function createAuthStateCache(): AuthStateCache {
  const map = new Map<string, Entry>();

  function get(userId: string): AuthStateRow | null {
    const e = map.get(userId);
    if (!e) return null;
    if (e.expiresAt <= Date.now()) {
      map.delete(userId);
      return null;
    }
    // 命中提升为最近使用（Map 删除再置末尾）。
    map.delete(userId);
    map.set(userId, e);
    return {
      userId: e.userId,
      status: e.status,
      tokenVersion: e.tokenVersion,
      workspaceId: e.workspaceId,
      mustChangePassword: e.mustChangePassword,
    };
  }

  function set(row: AuthStateRow, ttlMs: number): void {
    if (ttlMs <= 0) return;
    if (map.has(row.userId)) map.delete(row.userId);
    map.set(row.userId, { ...row, expiresAt: Date.now() + ttlMs });
    while (map.size > MAX_ENTRIES) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  function invalidate(userId: string): void {
    map.delete(userId);
  }

  function clear(): void {
    map.clear();
  }

  return { get, set, invalidate, clear, get size() { return map.size; } };
}
