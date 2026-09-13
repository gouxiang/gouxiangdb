// apps/api/src/domain/hydrateBatch.ts
// M1/S5 hydration 两阶段批量化的「取数编排层」。
//
// 唯一职责：把旧实现里逐行/逐字段的 N+1 单点查询（getRecordsByIds/getLinkRows/
// getFields/resolveUserName）收敛为「按 (linkFieldId,方向) 分组的 IN 批量 + 沿 links
// 依赖图的有限 BFS 预热」，并用请求级缓存去重。它【不计算任何 cell 值】——
// 第一轮/公式算法仍在 hydrate.ts 原封不动执行，本层只让那些算法触发的取数命中缓存。
// 故 cell 取值与旧串行实现逐值一致（S0 inline 快照锁死）。
//
// 正确性不依赖预热完整度：hydrate.ts 每个取数点都走 wrappedDeps，缓存未命中时
// 仍调用原单条 deps 查询（结果完全相同，仅不省查询）。环由「全局 visited 记录集合 +
// 深度上限 + hydrate.ts merging/stack 守卫」三重终止。record id 是全局唯一 cuid，
// 故记录缓存按 id 单键即可（跨表不撞），tableId 只在预热读字段元数据时需要。
//
// Deps 只增不改：getLinkRowsBulk/resolveUserNames 为可选；内存测试夹具不提供时，
// linkRows 退化为每字段整查一次（仍常量），records/users 回退逐条（值一致）。生产 prismaDeps
// 提供全部批量实现。linkRows 分桶细节见 hydrateBatchLinks.ts。

import type { FieldMeta, RawRecord } from "./types.js";
import type { HydrateDeps, LinkBatchQuery } from "./hydrate.js";
import { LinkLoader } from "./hydrateBatchLinks.js";

/** BFS 预热最大关联跳数（从页内根记录算起）；超出后靠 cache-miss 单条兜底，值仍正确。 */
const MAX_PREFETCH_DEPTH = 8;
/** 每层并发上限（常量，不随页内行数 N 增长）。 */
const CONCURRENCY = 8;

/** links/subtable 字段在「本行」视角下，数据实际挂载的（正向字段 id, 本行所在方向）。 */
function fieldOrientation(f: FieldMeta): { forwardId: string; dir: "parent" | "child" } | null {
  if (f.type !== "links" && f.type !== "subtable") return null;
  if (f.isReverse) {
    const forwardId = f.reverseFieldId ?? f.linkFieldId;
    if (!forwardId) return null;
    return { forwardId, dir: "child" };
  }
  return { forwardId: f.id, dir: "parent" };
}

async function mapPool<T>(items: T[], fn: (item: T) => Promise<unknown>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i]!);
    }
  });
  await Promise.all(workers);
}

/** 请求级批量缓存；生命周期 = 一次 hydrateRecords 调用（整批根记录共享）。 */
export class BatchStore {
  private readonly recordCache = new Map<string, RawRecord>(); // id -> RawRecord（cuid 全局唯一）
  private readonly fieldCache = new Map<string, FieldMeta[]>(); // tableId -> fields
  private readonly links: LinkLoader;
  private readonly userNameCache = new Map<string, string>(); // userId -> name
  private readonly pendingUserIds = new Set<string>(); // BFS 中收集、末了一次 IN
  private usersFlushed = false;

  constructor(private readonly deps: HydrateDeps) {
    this.links = new LinkLoader(deps);
  }

  seedFields(tableId: string, fields: FieldMeta[]): void {
    this.fieldCache.set(tableId, fields);
  }

  seedRecords(rows: RawRecord[]): void {
    for (const r of rows) if (!this.recordCache.has(r.id)) this.recordCache.set(r.id, r);
  }

  async getFields(tableId: string): Promise<FieldMeta[]> {
    const hit = this.fieldCache.get(tableId);
    if (hit) return hit;
    const fields = await this.deps.getFields(tableId);
    this.fieldCache.set(tableId, fields);
    return fields;
  }

  /** 按【请求 id 顺序】返回记录（buildLinkRefs 依赖该顺序还原 LinkRef 排列）；去重。 */
  async getRecordsByIds(ids: string[]): Promise<RawRecord[]> {
    const uniq = [...new Set(ids)];
    const out: RawRecord[] = [];
    const missing: string[] = [];
    for (const id of uniq) {
      const hit = this.recordCache.get(id);
      if (hit) out.push(hit);
      else missing.push(id);
    }
    if (missing.length === 0) return out;
    const fetched = await this.deps.getRecordsByIds(missing);
    for (const r of fetched) this.recordCache.set(r.id, r);
    // 按 uniq 顺序合并；底层查不到（软删/不存在）的 id 自然跳过（与旧实现一致）。
    const ordered: RawRecord[] = [];
    for (const id of uniq) {
      const r = this.recordCache.get(id);
      if (r && !ordered.some((o) => o.id === r.id)) ordered.push(r);
    }
    return ordered;
  }

  async resolveUserName(userId: string): Promise<string> {
    const hit = this.userNameCache.get(userId);
    if (hit !== undefined) return hit;
    const name = await this.deps.resolveUserName(userId);
    this.userNameCache.set(userId, name);
    return name;
  }

  /** 沿 links 依赖图 BFS 预热（只暖缓存，不算值）。 */
  async prefetch(roots: RawRecord[]): Promise<void> {
    this.seedRecords(roots);
    await this.collectUsers(roots);

    const visited = new Set<string>(roots.map((r) => r.id));
    let frontier = roots;
    for (let depth = 0; depth < MAX_PREFETCH_DEPTH && frontier.length > 0; depth++) {
      frontier = await this.expandLevel(frontier, visited);
      await this.collectUsers(frontier);
    }
    await this.flushUsers();
  }

  /** 仅当记录所属表含 createdBy/lastModifiedBy 时才收集其 user id（对齐旧解析触发点）。 */
  private async collectUsers(rows: RawRecord[]): Promise<void> {
    if (rows.length === 0) return;
    const byTable = new Map<string, RawRecord[]>();
    for (const r of rows) {
      const arr = byTable.get(r.tableId) ?? [];
      arr.push(r);
      byTable.set(r.tableId, arr);
    }
    for (const [tableId, rs] of byTable) {
      const fields = await this.getFields(tableId);
      if (!fields.some((f) => f.type === "createdBy" || f.type === "lastModifiedBy")) continue;
      for (const r of rs) {
        if (r.createdBy) this.pendingUserIds.add(r.createdBy);
        if (r.updatedBy) this.pendingUserIds.add(r.updatedBy);
      }
    }
  }

  /** 页内去重 user id 一次 IN（无批量实现则逐条，值一致）。 */
  private async flushUsers(): Promise<void> {
    if (this.usersFlushed) return;
    this.usersFlushed = true;
    const ids = [...this.pendingUserIds].filter((id) => !this.userNameCache.has(id));
    if (ids.length === 0) return;
    if (this.deps.resolveUserNames) {
      const map = await this.deps.resolveUserNames(ids);
      for (const id of ids) this.userNameCache.set(id, map[id] ?? id);
    } else {
      await mapPool(ids, async (id) => this.userNameCache.set(id, await this.deps.resolveUserName(id)));
    }
  }

  /** 预热一层：每 (字段,方向) 一条批量 linkRows，再每对端表一条 IN 取记录。 */
  private async expandLevel(frontier: RawRecord[], visited: Set<string>): Promise<RawRecord[]> {
    const rowsByTable = new Map<string, Set<string>>();
    for (const r of frontier) {
      const s = rowsByTable.get(r.tableId) ?? new Set<string>();
      s.add(r.id);
      rowsByTable.set(r.tableId, s);
    }

    const groups: LinkBatchQuery[] = [];
    const fieldsByTable = new Map<string, FieldMeta[]>();
    for (const [tableId, rowIds] of rowsByTable) {
      const fields = await this.getFields(tableId);
      fieldsByTable.set(tableId, fields);
      for (const f of fields) {
        const o = fieldOrientation(f);
        if (o) groups.push({ linkFieldId: o.forwardId, dir: o.dir, rowIds: [...rowIds] });
      }
    }
    await this.links.loadGroups(groups);

    // 从已暖 link 缓存收集对端记录 id，按 relatedTableId 归表。
    const peerIdsByTable = new Map<string, Set<string>>();
    for (const [tableId, rowIds] of rowsByTable) {
      for (const f of fieldsByTable.get(tableId) ?? []) {
        const o = fieldOrientation(f);
        if (!o || !f.relatedTableId) continue;
        const set = peerIdsByTable.get(f.relatedTableId) ?? new Set<string>();
        for (const rowId of rowIds) {
          for (const r of this.links.rowsFor(o.forwardId, o.dir, rowId)) {
            set.add(o.dir === "parent" ? r.childRowId : r.parentRowId);
          }
        }
        peerIdsByTable.set(f.relatedTableId, set);
      }
    }

    // 每对端表一条 IN 拉未缓存记录，作为下一层 frontier（去环）。
    const fresh: RawRecord[] = [];
    await mapPool([...peerIdsByTable.values()], async (idSet) => {
      const ids = [...idSet].filter((id) => !this.recordCache.has(id));
      if (ids.length === 0) return;
      const fetched = await this.deps.getRecordsByIds(ids);
      for (const r of fetched) {
        this.recordCache.set(r.id, r);
        if (!visited.has(r.id)) {
          visited.add(r.id);
          fresh.push(r);
        }
      }
    });
    return fresh;
  }

  /** 包出缓存感知 deps（接口形状不变，hydrate.ts 算法零改动）。 */
  wrappedDeps(): HydrateDeps {
    return {
      ...this.deps,
      getFields: (tableId) => this.getFields(tableId),
      getRecordsByIds: (ids) => this.getRecordsByIds(ids),
      getLinkRows: (q) => this.links.getLinkRows(q),
      resolveUserName: (userId) => this.resolveUserName(userId),
    };
  }
}
