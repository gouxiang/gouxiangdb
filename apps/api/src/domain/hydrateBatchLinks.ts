// apps/api/src/domain/hydrateBatchLinks.ts
// M1/S5 BatchStore 的 linkRows 子加载器：维护 (linkFieldId,方向,rowId) -> rows 的请求级缓存，
// 并把逐行单点查询收敛为「每字段×方向一条 IN（bulk）」或「每字段整查一次（回退）」。
// 不含任何 cell 计算；只负责取数与分桶，供 hydrateBatch 预热与 hydrate.ts 单点回查共用。

import type { HydrateDeps, LinkBatchQuery, LinkRowRef } from "./hydrate.js";

/** linkRows 单键缓存：与 resolveForward/ReverseLinks 的单点查询形状严格对齐。 */
export function linkKey(linkFieldId: string, dir: "parent" | "child", rowId: string): string {
  return `${linkFieldId}|${dir}|${rowId}`;
}

/** 每层并发上限（常量，不随页内行数 N 增长）。 */
const CONCURRENCY = 8;

async function mapPool<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i]!);
    }
  });
  await Promise.all(workers);
}

export class LinkLoader {
  private readonly cache = new Map<string, LinkRowRef[]>();
  /** bulk 路径：每个 (fieldId|dir) 已 IN 查过的行 id（跨层增量，只查新行）。 */
  private readonly bulkQueried = new Map<string, Set<string>>();
  /** 无 bulk：按 linkFieldId 整查过的全量行（每字段一次，正/反方向共享）。 */
  private readonly wholeLoaded = new Map<string, LinkRowRef[]>();
  /** 无 bulk：同字段并发组共享的进行中整查 promise（消除同层并发竞态）。 */
  private readonly wholeLoading = new Map<string, Promise<LinkRowRef[]>>();

  constructor(private readonly deps: HydrateDeps) {}

  /** 单点取数（hydrate.ts resolveForward/ReverseLinks 走这里）：命中缓存不查库。 */
  async getLinkRows(q: {
    linkFieldId?: string;
    parentRowId?: string;
    childRowId?: string;
  }): Promise<LinkRowRef[]> {
    if (q.linkFieldId && q.parentRowId !== undefined) {
      return await this.single(q.linkFieldId, "parent", q.parentRowId);
    }
    if (q.linkFieldId && q.childRowId !== undefined) {
      return await this.single(q.linkFieldId, "child", q.childRowId);
    }
    return await this.deps.getLinkRows(q);
  }

  /** 读某行某方向已暖的桶（expandLevel 收集对端 id 用）。 */
  rowsFor(linkFieldId: string, dir: "parent" | "child", rowId: string): LinkRowRef[] {
    return this.cache.get(linkKey(linkFieldId, dir, rowId)) ?? [];
  }

  /** 批量预热多组（并发，组内去重）。 */
  async loadGroups(groups: LinkBatchQuery[]): Promise<void> {
    await mapPool(groups, (g) => this.loadGroup(g));
  }

  private async single(linkFieldId: string, dir: "parent" | "child", rowId: string): Promise<LinkRowRef[]> {
    const key = linkKey(linkFieldId, dir, rowId);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const rows = await this.deps.getLinkRows(
      dir === "parent" ? { linkFieldId, parentRowId: rowId } : { linkFieldId, childRowId: rowId },
    );
    this.cache.set(key, rows);
    return rows;
  }

  /**
   * 取一组并摊回单键缓存。常量化关键：
   *  - 有 getLinkRowsBulk：同一 (field,方向) 跨层只对【新增行】发增量 IN；
   *  - 无 bulk（注入计数 deps/内存夹具）：每 linkFieldId 整查一次存全量，跨层新行仅分桶、零查询。
   * 故 linkRows 查询数 = 出现过的 linkFieldId 数，是 schema 常量，与页内行数 N 无关。
   */
  private async loadGroup(g: LinkBatchQuery): Promise<void> {
    if (this.deps.getLinkRowsBulk) {
      const groupKey = `${g.linkFieldId}|${g.dir}`;
      const seen = this.bulkQueried.get(groupKey) ?? new Set<string>();
      const newRows = g.rowIds.filter((id) => !seen.has(id));
      for (const rowId of newRows) {
        seen.add(rowId);
        const key = linkKey(g.linkFieldId, g.dir, rowId);
        if (!this.cache.has(key)) this.cache.set(key, []);
      }
      this.bulkQueried.set(groupKey, seen);
      if (newRows.length === 0) return;
      const per = await this.deps.getLinkRowsBulk([{ ...g, rowIds: newRows }]);
      this.absorb(g, per[0] ?? []);
      return;
    }

    let all = this.wholeLoaded.get(g.linkFieldId);
    if (!all) {
      let loading = this.wholeLoading.get(g.linkFieldId);
      if (!loading) {
        loading = Promise.resolve(this.deps.getLinkRows({ linkFieldId: g.linkFieldId }));
        this.wholeLoading.set(g.linkFieldId, loading);
        const rows = await loading;
        this.wholeLoaded.set(g.linkFieldId, rows);
        all = rows;
      } else {
        all = await loading;
      }
    }
    for (const rowId of g.rowIds) {
      const key = linkKey(g.linkFieldId, g.dir, rowId);
      if (!this.cache.has(key)) this.cache.set(key, []);
    }
    this.absorb(g, all);
  }

  /** 把一批 linkRows 按组内行 + 方向摊入对应单键桶（去重）。 */
  private absorb(g: LinkBatchQuery, rows: LinkRowRef[]): void {
    for (const r of rows) {
      const rowId = g.dir === "parent" ? r.parentRowId : r.childRowId;
      if (!g.rowIds.includes(rowId)) continue; // 整查带回其它行/另一方向，按组过滤
      const key = linkKey(g.linkFieldId, g.dir, rowId);
      const bucket = this.cache.get(key) ?? [];
      if (!bucket.some((b) => b.id === r.id)) bucket.push(r);
      this.cache.set(key, bucket);
    }
  }
}
